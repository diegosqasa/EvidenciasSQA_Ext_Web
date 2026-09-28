(function () {
	// Compatibilidad multiplataforma
	if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
		window.chrome = browser;
	}

	let contextInvalidated = false;
	let _lastBrowserInfo = { browserName: "N/A", fullVersion: "N/A" };
	let _lastOS = "N/A";
	// PERF-10: caché de 1 valor para el ID de evidencia (evita await de red en el header).
	let _evidenceIdCache = null;

	// ===== PERF-03 (auditoría _002): canal binario content → SW =====
	// Un Blob sobrevive chrome.runtime.sendMessage solo con el opt-in de manifest
	// "message_serialization": "structured_clone" (Chrome >= 148). Detectamos la
	// capacidad 1 vez por documento (probe) y hacemos fallback a dataURL.
	let _stitchProbeDone = false;
	let _stitchBinaryOK = false;
	function stitchBinaryProbe(cb) {
		if (_stitchProbeDone) { cb(_stitchBinaryOK); return; }
		_stitchProbeDone = true;
		let settled = false;
		const finish = function (ok) {
			if (settled) return;
			settled = true;
			_stitchBinaryOK = !!ok;
			try { console.log('[FEATURE_RUNTIME]', 'BinaryChannelProbe result=' + (ok ? 'structured-clone' : 'json-fallback')); } catch (e) {}
			cb(_stitchBinaryOK);
		};
		try {
			chrome.runtime.sendMessage({ action: 'stitchBinaryProbe', marker: new Blob([1]) }, function (resp) {
				const err = chrome.runtime.lastError;
				finish(!err && !!resp && resp.ok === true);
			});
		} catch (e) { finish(false); }
	}
	// Envía blob en slices de 1.5MB con ack por chunk (patrón pdfRenderBlobChunk).
	// onSuccess: entrega binaria completa. onFail: fallback dataURL del llamador.
	function sendFinalBlobBinary(blob, meta, onFail, tag) {
		if (!(blob instanceof Blob) || typeof OffscreenCanvas === 'undefined') { onFail(); return; }
		stitchBinaryProbe(function (ok) {
			if (!ok) { onFail(); return; }
		const SLICE = 1536 * 1024;
		const total = Math.max(1, Math.ceil(blob.size / SLICE));
		let aborted = false;
		const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
		try { console.log('[FEATURE_RUNTIME]', 'BinaryChannelStart tag=' + (tag || 'stitch') + ' chunks=' + total + ' bytes=' + blob.size); } catch (e) {}
			const sendNext = function (i) {
				if (aborted) return;
				if (i >= total) {
					try { chrome.runtime.sendMessage({ action: 'stitchBinaryComplete', total: total }); } catch (e) {}
					try { console.log('[FEATURE_RUNTIME]', 'WireStats via=binary chunks=' + total + ' bytes=' + blob.size + ' base64Bytes=0 ms=' + Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0) + ' tag=' + (tag || 'stitch')); } catch (e) {}
					return;
				}
				let slice;
				try { slice = blob.slice(i * SLICE, Math.min((i + 1) * SLICE, blob.size), 'application/octet-stream'); }
				catch (e) { aborted = true; onFail(); return; }
				let msg;
				try { msg = { action: 'stitchBinaryChunk', index: i, total: total, blob: slice, meta: (i === 0 ? meta : null) }; }
				catch (e) { aborted = true; onFail(); return; }
				try {
					chrome.runtime.sendMessage(msg, function (resp) {
						if (aborted) return;
						const err = chrome.runtime.lastError;
						if (err || !resp || resp.rtn !== 1) {
							aborted = true;
							try { console.warn('[FEATURE_RUNTIME]', 'BinaryChannelFallback reason=' + (err ? err.message : ('ack-malformed index=' + i))); } catch (e) {}
							onFail();
							return;
						}
						try { console.log('[FEATURE_RUNTIME]', 'BinaryChunkAck index=' + i); } catch (e) {}
						sendNext(i + 1);
					});
				} catch (e) {
					aborted = true; onFail();
				}
			};
			sendNext(0);
		});
	}
	// ===== fin PERF-03 =====

	// ===== PERF-04 (auditoría _002): captura por página inline =====
	// Contadores de ruta para validación FEATURE_RUNTIME (PageShotSource).
	let _pageShotBlobPages = 0;
	let _pageShotDataUrlPages = 0;
	// ===== fin PERF-04 =====

	if (window.hasInjectedContentScript) {
		try {
			chrome.runtime.getURL('');
		} catch (e) {
			contextInvalidated = true;
		}
	}

	if (!window.hasInjectedContentScript || contextInvalidated) {
		window.hasInjectedContentScript = true;

		function createUniversalCanvas(width, height) {
			const isOffscreen = typeof OffscreenCanvas !== 'undefined';
			if (isOffscreen) {
				const canvas = new OffscreenCanvas(width, height);
				return {
					canvas,
					context: canvas.getContext('2d'),
					isOffscreen: true,
					toBlob: function (callback, mimeType = 'image/png') {
						canvas.convertToBlob({ type: mimeType })
							.then(callback)
							.catch(err => {
								console.error("Error converting OffscreenCanvas to Blob:", err);
								callback(null);
							});
					},
					toDataURL: function (mimeType = 'image/png') {
						const tempCanvas = document.createElement('canvas');
						tempCanvas.width = width;
						tempCanvas.height = height;
						const tempCtx = tempCanvas.getContext('2d');
						tempCtx.drawImage(canvas, 0, 0);
						return tempCanvas.toDataURL(mimeType);
					}
				};
			} else {
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				return {
					canvas,
					context: canvas.getContext('2d'),
					isOffscreen: false,
					toBlob: function (callback, mimeType = 'image/png') {
						canvas.toBlob(callback, mimeType);
					},
					toDataURL: function (mimeType = 'image/png') {
						return canvas.toDataURL(mimeType);
					}
				};
			}
		}

		// Utility functions for headers (moved to shared top-level scope)
		function pad(n) { return String(n).padStart(2, "0"); }
		function formateaFechaHora(date) {
			let h = date.getHours(), m = date.getMinutes(), s = date.getSeconds();
			let ampm = h >= 12 ? "p.m." : "a.m.";
			let h12 = h % 12; if (h12 === 0) h12 = 12;
			return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${h12}:${pad(m)}:${pad(s)} ${ampm}`;
		}
		function recortaUrl(url) {
			if (url.length > 150) return url.substring(0, 147) + "...";
			return url;
		}
		function wrapTextAnywhere(ctx, text, maxWidth) {
			const chars = Array.from(text);
			const lines = [];
			let currentLine = "";
			for (let i = 0; i < chars.length; i++) {
				const char = chars[i];
				const testLine = currentLine + char;
				const testWidth = ctx.measureText(testLine).width;
				if (testWidth > maxWidth && currentLine.length > 0) {
					lines.push(currentLine);
					currentLine = char;
				} else {
					currentLine = testLine;
				}
			}
			if (currentLine.length > 0) {
				lines.push(currentLine);
			}
			return lines;
		}
		function permTrace(action, detail){ try{console.log('[PERMISSION_TRACE] '+action+' '+ (typeof detail==='string'?detail:JSON.stringify(detail).slice(0,300)) +' URL='+location.href);}catch{} }
		// BUG_PDF_WORKER_001_CAPTURE: reenvía las trazas al SW para verlas en una sola consola.
		function wtrace(msg) {
			try {
				var args = Array.prototype.slice.call(arguments, 1);
				console.log.apply(console, ['[PDF_WORKER_TRACE] ' + msg].concat(args));
				try { chrome.runtime.sendMessage({ action: 'pdfWorkerTrace', text: '[PDF_WORKER_TRACE] ' + msg + ' ' + args.map(function (a) { try { return String(a); } catch (e) { return '?'; } }).join(' ') }); } catch (e) {}
			} catch (e) {}
		}
		// BUG_PDF_ROUTING_001: misma etiqueta que el SW para medir cobertura real (solo consola).
		function pdfRouteLog(event, info) {
			try {
				var base = { t: Date.now(), event: event, contentType: document.contentType, href: window.location.href.slice(0, 200), title: document.title.slice(0, 120) };
				for (var k in (info || {})) base[k] = info[k];
				console.log('[PDF_ROUTE]', JSON.stringify(base));
			} catch (e) {}
		}
		async function getBrowserVersion() {
			let browserName = "N/A", fullVersion = "N/A", ua = navigator.userAgent;
			try {
				// Intentar primero con high entropy (datos precisos)
				if (navigator.userAgentData?.getHighEntropyValues) {
					const uaData = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
					const brands = uaData.fullVersionList || [];
					// BUG_HEADER_BROWSER_REGRESSION_001: el orden de fullVersionList NO está
					// garantizado (GREASE de UA-CH puede anteponer "Chromium" a "Microsoft Edge").
					// El find anterior devolvía Chromium → etiquetaba "Chrome" en Edge.
					// Fix: buscar marcas Edge primero (orden-independiente), luego Chrome.
					const info = brands.find(b => b.brand === "Microsoft Edge" || b.brand === "Edge")
						|| brands.find(b => b.brand === "Google Chrome" || b.brand === "Chromium" || b.brand === "HeadlessChrome");
					if (info) {
						browserName = info.brand.includes("Edge") ? "Edge" : "Chrome";
						fullVersion = info.version;
						return { browserName, fullVersion };
					}
				}
				// Fallback a userAgent string
				if (ua.indexOf("Edg/") !== -1) {
					browserName = "Edge";
					fullVersion = ua.split("Edg/")[1].split(" ")[0];
				} else if (ua.indexOf("Firefox/") !== -1) {
					browserName = "Firefox";
					fullVersion = ua.split("Firefox/")[1].split(" ")[0];
				} else if (ua.indexOf("Chrome/") !== -1) {
					browserName = "Chrome";
					fullVersion = ua.split("Chrome/")[1].split(" ")[0];
				}
			} catch (e) { }
			return { browserName, fullVersion };
		}
		async function obtenOS() {
			const userAgent = window.navigator.userAgent;
			let platform = window.navigator.platform;
			let os = "N/A";

			if (navigator.userAgentData?.platform) {
				platform = navigator.userAgentData.platform;
			}

			const macosPlatforms = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'];
			const windowsPlatforms = ['Win32', 'Win64', 'Windows', 'WinCE'];
			const iosPlatforms = ['iPhone', 'iPad', 'iPod'];

			if (macosPlatforms.indexOf(platform) !== -1) {
				os = 'macOS';
			} else if (iosPlatforms.indexOf(platform) !== -1) {
				os = 'iOS';
			} else if (windowsPlatforms.indexOf(platform) !== -1) {
				os = 'Windows';
				try {
					if (navigator.userAgentData?.getHighEntropyValues) {
						const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
						const platVer = uaData.platformVersion || '';
						const parts = platVer.split('.');
						const major = parseInt(parts[0] || '0', 10);
						const build = parseInt(parts[2] || '0', 10);
						if (major >= 14 || build >= 22000) os = 'Windows 11';
						else os = 'Windows 10';
					}
				} catch (e) { }
			} else if (/Android/.test(userAgent)) {
				os = 'Android';
			} else if (/Linux/.test(platform) || /Linux/.test(userAgent)) {
				os = 'Linux';
			}
			return os;
		}
		async function fetchNextEvidenceId() {
			// BUG_PDF_CORS_001: fetch directo al visor desde content script (origen null en
			// file://) muere con CORS — el visor no manda Access-Control-Allow-Origin. Se
			// enruta por el SW (host_permissions <all_urls> → sin CORS). Fallback silencioso.
			// PERF-10: caché de 1 valor — el primer header lanza la consulta y los
			// siguientes reutilizan el resultado (cero esperas de red en el camino crítico).
			if (_evidenceIdCache !== null) {
				try { console.log('[FEATURE_RUNTIME]', 'EvidenceIdCacheHit label=' + _evidenceIdCache); } catch (e) {}
				return _evidenceIdCache;
			}
			try {
				const resp = await new Promise((resolve, reject) => {
					try {
						chrome.runtime.sendMessage({ action: 'peekNextEvidenceId' }, (r) => {
							if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
							resolve(r || null);
						});
					} catch (e) { reject(e); }
				});
				if (resp && resp.label) {
					_evidenceIdCache = resp.label;
					try { console.log('[FEATURE_RUNTIME]', 'EvidenceIdCacheSet label=' + _evidenceIdCache); } catch (e) {}
					return _evidenceIdCache;
				}
				return null;
			} catch (e) {
				return null;
			}
		}
		// BUG_PDF_FILE_001: lee los bytes del PDF local (file://) y los envía al SW
		// en chunks base64. Requiere "Permitir acceso a URLs de archivo" (el SW lo verifica).
		async function readLocalPdfAndStream() {
			try {
				const resp = await fetch(window.location.href);
				if (!resp.ok) throw new Error('HTTP ' + resp.status);
				const buf = await resp.arrayBuffer();
				const bytes = new Uint8Array(buf);
				let bin = '';
				const STEP = 32768;
				for (let i = 0; i < bytes.length; i += STEP) {
					bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
				}
				const b64 = btoa(bin);
				const SIZE = 1500000;
				const total = Math.max(1, Math.ceil(b64.length / SIZE));
				for (let i = 0; i < total; i++) {
					try {
						chrome.runtime.sendMessage({ action: 'pdfLocalPdfChunk', index: i, total: total, data: b64.slice(i * SIZE, (i + 1) * SIZE) });
					} catch (e) {}
				}
			} catch (e) {
				try { chrome.runtime.sendMessage({ action: 'pdfLocalPdfError', error: e.message }); } catch (_) {}
			}
		}
		// BUG_PDF_FILE_001c: render pdf.js UMD dentro de la página (canvas DOM), sin
		// offscreen. El worker real puede no existir aquí: el build cae solo a fake
		// worker (main thread). Progreso vía setProgress; resultado vía processFinalImageBlob.
		async function renderPdfInPage(b64, workerBlob) {
			const inpageT0 = Date.now();
			try {
				const lib = window.pdfjsLib;
				// BUG_PDF_WORKER_001: trazas de diagnóstico del worker (ver Root Cause).
				// Q6 (instancia única): sello persistente sobre el objeto lib.
				try {
					if (lib && !lib.__sqaStamp) { try { lib.__sqaStamp = Math.random().toString(36).slice(2, 10); } catch (e) {} }
					wtrace('pdfjsLib', typeof lib, !!(lib && lib.getDocument));
				} catch (e) {}
				try { wtrace('lib stamp', lib && lib.__sqaStamp); } catch (e) {}
				try { wtrace('worker before', lib && lib.GlobalWorkerOptions && lib.GlobalWorkerOptions.workerSrc); } catch (e) {}
				try { wtrace('blobUrl cached', !!window.__sqaPdfWorkerUrl); } catch (e) {}
				if (!lib || !lib.getDocument) throw new Error('pdf.js no cargado en página');
				// BUG_PDF_FILE_001c: este build exige workerSrc (sin fake automático).
				// BUG_PDF_WORKER_001: dos modos de worker. 1) worker real por URL de
				// extensión (patrón válido desde content scripts); 2) Blob URL con el
				// texto provisto por el SW. Solo errores de worker reintentan; un PDF
				// corrupto se reporta de inmediato sin segundo intento.
				async function openPdfDocument(data) {
					try {
						lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
						try { wtrace('worker mode', 'ext-url'); } catch (e) {}
						return await lib.getDocument({ data: data, isEvalSupported: false, useSystemFonts: true }).promise;
					} catch (e) {
						const msg = (e && e.message) || String(e);
						try { wtrace('worker ext-url FAILED', msg.slice(0, 160)); } catch (_) {}
						if (!/worker|script|establish|load/i.test(msg)) throw e;
					}
					try {
						if (!window.__sqaPdfWorkerUrl) {
							// El SW adjunta workerText porque el fetch propio
							// muere en file:// (origen opaco). Solo como último recurso se intenta local.
							let wsrc = (workerBlob instanceof Blob && workerBlob.size > 100000) ? workerBlob : null;
							if (!wsrc) {
							throw new Error('Worker blob not provided by SW');
					}
							try { wtrace('worker text length', wsrc && wsrc.length); } catch (e) {}
							window.__sqaPdfWorkerUrl = URL.createObjectURL(wsrc);
							try { wtrace('blobUrl created', window.__sqaPdfWorkerUrl); } catch (e) {}
						}
						lib.GlobalWorkerOptions.workerSrc = window.__sqaPdfWorkerUrl;
					} catch (e) {
						try { wtrace('worker setup FAILED', e.message); } catch (_) {}
					}
					try { wtrace('worker after', lib.GlobalWorkerOptions.workerSrc); } catch (e) {}
					// MEM-04: el blob URL del worker ya no se necesita una vez que
					// getDocument cargó el PDF — revocarlo libera el recurso retenido.
					try { if (window.__sqaPdfWorkerUrl) { URL.revokeObjectURL(window.__sqaPdfWorkerUrl); window.__sqaPdfWorkerUrl = null; try { wtrace('blobUrl revoked post-getDocument'); } catch (_) {} } } catch (e) {}
				}
				const raw = atob(b64);
				const u8 = new Uint8Array(raw.length);
				for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
				try { wtrace('before getDocument', lib.GlobalWorkerOptions.workerSrc); } catch (e) {}
				const pdf = await openPdfDocument(u8.buffer);
				pdfRouteLog('render-start', { numPages: pdf.numPages, via: 'inpage' });
				const TARGET_W = 1500, MAX_H = 30000;
				const infos = [];
				let maxW = 0, totalH = 0;
				for (let i = 1; i <= pdf.numPages; i++) {
					const page = await pdf.getPage(i);
					const vp = page.getViewport({ scale: 1 });
					infos.push({ page: page, w: vp.width, h: vp.height });
					if (vp.width > maxW) maxW = vp.width;
					totalH += vp.height;
					try { chrome.runtime.sendMessage({ action: 'setProgress', progress: Math.round(15 + (i / pdf.numPages) * 35), current: i, total: pdf.numPages }); } catch (e) {}
				}
				if (infos.length === 0) throw new Error('PDF sin páginas');
				let scale = Math.min(TARGET_W / maxW, MAX_H / totalH);
				if (!isFinite(scale) || scale <= 0) scale = 1;
				if (scale > 3) scale = 3;
				const W = Math.ceil(maxW * scale);
				const H = Math.ceil(totalH * scale);
				const canvas = document.createElement('canvas');
				canvas.width = W;
				canvas.height = H;
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, W, H);
				let y = 0;
				let rendered = 0;
				for (const it of infos) {
					const viewport = it.page.getViewport({ scale: scale });
					const pc = document.createElement('canvas');
					pc.width = Math.ceil(it.w * scale);
					pc.height = Math.ceil(it.h * scale);
					await it.page.render({ canvasContext: pc.getContext('2d'), viewport: viewport }).promise;
					ctx.drawImage(pc, 0, y);
					y += Math.ceil(it.h * scale);
					try { it.page.cleanup(); } catch (e) {}
					rendered++;
					try { chrome.runtime.sendMessage({ action: 'setProgress', progress: Math.round(50 + (y / H) * 40), current: rendered, total: infos.length }); } catch (e) {}
				}
				try { await pdf.destroy(); } catch (e) {}
				pdfRouteLog('render-complete', { pages: infos.length, via: 'inpage' });
				canvas.toBlob(function (blob) {
					if (!blob) {
						try { chrome.runtime.sendMessage({ action: 'pdfInPageError', error: 'toBlob nulo' }); } catch (e) {}
						return;
					}
					// PERF-03: el PNG del render en página viaja por el canal binario
					// (Blob sobrevive con el opt-in structured_clone de manifest.json,
					// Chrome >= 148); fallback dataURL legacy (JSON-safe) si el probe o
					// algún chunk fallan. convMs/convBytes conservan la métrica D2.
					const metaDD = { renderMs: Date.now() - inpageT0 };
					sendFinalBlobBinary(blob, metaDD, function () {
						var frT0dd = Date.now();
						var frdd = new FileReader();
						frdd.onload = function () {
							try { chrome.runtime.sendMessage({ action: 'processFinalImageBlob', imageBlob: frdd.result, renderMs: Date.now() - inpageT0, convMs: Date.now() - frT0dd, convBytes: blob.size, convOut: (frdd.result && frdd.result.length) || 0 }); } catch (e) {}
						};
						frdd.onerror = function () {
							try { chrome.runtime.sendMessage({ action: 'pdfInPageError', error: 'FileReader fallo al convertir PNG en pagina' }); } catch (e) {}
						};
						frdd.readAsDataURL(blob);
					}, 'pdf-inpage');
				}, 'image/png');
			} catch (e) {
				try { chrome.runtime.sendMessage({ action: 'pdfInPageError', error: e.message }); } catch (_) {}
			}
		}
		async function drawEvidenceHeader(ctx, canvasWidth, headerHeight, evidenceId) {
			return new Promise(resolve => {
				let h = headerHeight;
				ctx.save();

				// Fondo azul oscuro sólido y nítido
				ctx.fillStyle = "#002b55"; 
				ctx.fillRect(0, 0, canvasWidth, h);

				// Línea inferior de acento (SQA Orange)
				ctx.fillStyle = "#FF6B00";
				ctx.fillRect(0, h - 4, canvasWidth, 4);

				// Timeout de seguridad: si la imagen no carga en 5s, dibujamos sin logo
				let resolved = false;
				const safeResolve = () => { if (!resolved) { resolved = true; finHeader(); } };
				const timer =					// PERF-09: ventana del transform 80 → 40 ms (el observer de crecimiento
					// y los reflows del sitio son la señal real, no el sleep fijo).
					setTimeout(() => {
						try { console.log('[FEATURE_RUNTIME]', 'ScrollTransformWait ms=40'); } catch (e) {} safeResolve(); }, 5000);

				async function finHeader() {
					try {
						ctx.textBaseline = "top";

						// SQA logo a la izquierda del encabezado
						if (logoImg && logoImg.width > 0) {
							const logoW = 100;
							const logoH = Math.round(logoW * (logoImg.height / logoImg.width));
							ctx.drawImage(logoImg, 12, 8, logoW, logoH);
						}

						ctx.font = "bold 32px Segoe UI, Roboto, sans-serif";
						ctx.fillStyle = "#ffffff";
						ctx.fillText("Evidencia de prueba QA", 125, 12);

						const urlCompleta = window.location.href;
						ctx.font = "600 20px Segoe UI, Roboto, sans-serif";
						const urlLines = wrapTextAnywhere(ctx, "URL: " + urlCompleta, canvasWidth - 155);
						ctx.fillStyle = "#ffffff";
						for (let i = 0; i < urlLines.length; i++) {
							ctx.fillText(urlLines[i], 125, 46 + i * 24);
						}

						ctx.font = "italic 18px Segoe UI, Roboto, sans-serif";
						ctx.fillStyle = "#cbd5e0";
						let brow = { browserName: "N/A", fullVersion: "N/A" };
						let os = "N/A";
						try { brow = await getBrowserVersion(); } catch (_) {}
						try { os = await obtenOS(); } catch (_) {}
						_lastBrowserInfo = brow;
						_lastOS = os;
						const evLabel = evidenceId ? `ID: ${evidenceId} | ` : '';
						const metaY = 74 + (urlLines.length - 1) * 24;
						ctx.fillText(`${evLabel}📅 ${formateaFechaHora(new Date())}    💻 ${brow.browserName} ${brow.fullVersion}    🌐 ${os}`, 125, metaY);
					} catch (_) {}
					ctx.restore();
					resolve();
				}

				const logoImg = new window.Image();
				logoImg.onload = function () { clearTimeout(timer); safeResolve(); };
				logoImg.onerror = function () { clearTimeout(timer); safeResolve(); };
				logoImg.src = chrome.runtime.getURL('Media/SQA-128.png');
			});
		}

		let capturex_snap_mergedImage_array = [];
		let capturex_snap_mergedImage_index = 0;
		let capturex_capture_top;
		let capturex_capture_bottom;
		let capturex_capture_left;
		let capturex_capture_right;
		let capturex_capture_array = [];
		let capturex_capture_array_width = [];
		let capturex_capture_array_height = [];
		let capturex_capture_array_splicing_index = 0;
		let capturex_canvas_browserMaxHeight_sys = 32767; //Chrome
		let capturex_canvas_browserMaxArea_sys = 268435456;
		let capturex_canvas_browserMaxHeight = capturex_canvas_browserMaxHeight_sys;
		let capturex_capture_max_height = 90000;
		let capturex_capture_truncated = false;

		let capturex_alert_msg_content;
		let capturex_alert_msg_title;
		let capturex_scrollPosition;
		let capturex_contentEle; //real content element
		let capturex_contentEle_over_top;
		let capturex_contentEle_over_bottom;
		let capturex_contentEleRectLeft, capturex_contentEleRectTop, capturex_contentEleRectRight, capturex_contentEleRectBottom;
		let capturex_contentEleIframe; //real content element
		let capturex_documentHeight_o; //original documentHeight before scrolling
		let capturex_documentHeight;
		let capturex_documentWdith;
		let capturex_onePageHeight;
		let capturex_onePageOverlap; //scroll overlap height
		let capturex_contentPageCrollTop;
		let capturex_nowRealPageCrollTop;
		let capturex_preRealPageCrollTop;
		let capturex_scrollbarWidth;
		let capturex_changStyleForShotTimes = 0;

		// Micro‑opt: bounding rect cache (WeakMap)
		let _bboxCache = new WeakMap();
		// PERF-07: caché del rect visible compuesto (1 cálculo por elemento y captura).
		let _visibleRectCache = new WeakMap();
		// PERF-06: prefijos de alturas — prefix[k] = suma de heights[0..k-1] (O(1) por consulta).
		function buildHeightPrefix(heights) {
			if (!heights || heights.length === 0) return null;
			const prefix = new Array(heights.length + 1);
			prefix[0] = 0;
			for (let k = 0; k < heights.length; k++) prefix[k + 1] = prefix[k] + heights[k];
			return prefix;
		}
		function _getCachedRect(el) {
			let r = _bboxCache.get(el);
			if (!r) { r = el.getBoundingClientRect(); _bboxCache.set(el, r); }
			return r;
		}
		function _clearBBoxCache() { _bboxCache = new WeakMap(); _visibleRectCache = new WeakMap(); }

		// Micro‑opt: scroll dedup set
		let capturex_capturedScrollTops = null;

		// STITCH_DUPLICATED_VIEWPORT_REGRESSION_001: posiciones REALES ya capturadas
		// (evidencia: entre viewports consecutivos nunca debe repetirse actualY).
		let capturex_capturedRealTops = [];

		// LOG-01: compuerta de verbosidad para los ticks por frame. Los resúmenes
		// por viewport (ViewportTarget/Actual/Delta/Capture, ViewportStabilize,
		// ViewportRescroll) SIEMPRE se emiten (evidencia obligatoria); los ticks
		// intermedios se silencian con window.__SQA_QUIET_RUNTIME=true o
		// localStorage.sqaQuietRuntime=1. Por defecto todo sigue visible.
		function sqaFrTick(msg) {
			try {
				if (window.__SQA_QUIET_RUNTIME === true) return;
				try { if (typeof localStorage !== 'undefined' && localStorage.getItem('sqaQuietRuntime') === '1') return; } catch (e) {}
				console.log('[FEATURE_RUNTIME]', msg);
			} catch (e) {}
		}

		// Estabilización pre-captura (antes vivía solo dentro de captureVisiblePageScreenshot;
		// captureSelectAllPageScreenshot quedó con una referencia huérfana → ReferenceError).
		function sqaAfterFrameStable(fn, targetY, vpIndex) {
			let frames = 0;
			const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			let lastTop = capturex_com_saveAction.getPageScrollTop();
			function tick() {
				frames++;
				const top = capturex_com_saveAction.getPageScrollTop();
				if (targetY != null) { sqaFrTick('ScrollStableCheck phase=pre index=' + vpIndex + ' target=' + targetY + ' actual=' + top + ' delta=' + (top - targetY) + ' frames=' + frames); }
				if ((top === lastTop && frames >= 1) || frames >= 3) {
					try { console.log('[FEATURE_RUNTIME]', 'ViewportStabilize frames=' + frames + ' ms=' + Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0)); } catch (e) {}
					fn(); return;
				}
				lastTop = top;
				requestAnimationFrame(function(){ setTimeout(tick, 0); });
			}
			requestAnimationFrame(function(){ setTimeout(tick, 0); });
		}

		// Verificación POST-scroll: confirma que la posición real llegó al objetivo ANTES
		// de pedir el screenshot. Causa raíz del viewport duplicado (AvalPay): la captura
		// salía con el frame presentado del scroll ANTERIOR cuando el compositor no
		// alcanzaba a pintar el nuevo scroll (la estabilidad se medía ANTES de aplicar
		// el scroll, así que no decía nada de la posición nueva).
		function sqaAfterScrollApplied(targetY, vpIndex, cb) {
			let frames = 0;
			let rounds = 0;
			const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			function resolve(top) {
				const delta = top - targetY;
				try { console.log('[FEATURE_RUNTIME]', 'ViewportActual index=' + vpIndex + ' actualY=' + top + ' delta=' + delta + ' frames=' + frames + ' ms=' + Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0)); } catch (e) {}
				try { console.log('[FEATURE_RUNTIME]', 'ViewportDelta index=' + vpIndex + ' delta=' + delta); } catch (e) {}
				let dup = false;
				for (let k = 0; k < capturex_capturedRealTops.length; k++) { if (Math.abs(capturex_capturedRealTops[k] - top) <= 2) { dup = true; break; } }
				capturex_capturedRealTops.push(top);
				if (dup) { try { console.log('[FEATURE_RUNTIME]', 'ViewportDuplicateDetected index=' + vpIndex + ' actualY=' + top); } catch (e) {} }
				try { console.log('[FEATURE_RUNTIME]', 'ViewportCapture index=' + vpIndex + ' y=' + top); } catch (e) {}
				cb();
			}
			function tick() {
				frames++;
				const top = capturex_com_saveAction.getPageScrollTop();
				sqaFrTick('ScrollStableCheck phase=post index=' + vpIndex + ' target=' + targetY + ' actual=' + top + ' delta=' + (top - targetY) + ' frames=' + frames);
				if (Math.abs(top - targetY) <= 2) {
					// Scroll asentado: 1 rAF extra para que el compositor presente el
					// frame nuevo antes del captureVisibleTab (evita capturar el frame anterior).
					requestAnimationFrame(function(){ setTimeout(function(){ resolve(capturex_com_saveAction.getPageScrollTop()); }, 0); });
					return;
				}
				if (frames >= 3) {
					// H1 (AvalPay / scroll-behavior:smooth o compositor lento): el layout
					// dice que el scroll no llego. Re-aplicar instant y reintentar (acotado:
					// max 3 rondas ~= 9-12 frames, sin sleeps fijos -> PERF-09 intacto).
					if (rounds < 3) {
						rounds++;
						try { console.log('[FEATURE_RUNTIME]', 'ViewportRescroll index=' + vpIndex + ' round=' + rounds + ' target=' + targetY + ' actual=' + top); } catch (e) {}
						try { capturex_com_saveAction.scrollTopForCapture(targetY); } catch (e) {}
						frames = 0;
						requestAnimationFrame(function(){ setTimeout(tick, 0); });
						return;
					}
					resolve(top); return;
				}
				requestAnimationFrame(function(){ setTimeout(tick, 0); });
			}
			const top0 = capturex_com_saveAction.getPageScrollTop();
			if (Math.abs(top0 - targetY) <= 2) {
				// Scroll ya aplicado (instant): 1 rAF para que el frame con el nuevo scroll
				// llegue a presentar antes del captureVisibleTab (PERF-09 intacto: sin esperas fijas).
				try { console.log('[FEATURE_RUNTIME]', 'ScrollStableCheck phase=post index=' + vpIndex + ' target=' + targetY + ' actual=' + top0 + ' delta=0 frames=0 fast-path'); } catch (e) {}
				requestAnimationFrame(function(){ setTimeout(function(){ resolve(capturex_com_saveAction.getPageScrollTop()); }, 0); });
				return;
			}
			requestAnimationFrame(function(){ setTimeout(tick, 0); });
		}


		// PERF-01 FASE 5: clasificación única del fallback. Se construye UNA vez por
		// captura (primer viewport que entra al fallback) y los viewports siguientes
		// reutilizan la lista — en vez de querySelectorAll(':not(...)+getComputedStyle')
		// O(N) en cada página.
		let _fallbackClassified = null;
		function _classifyOnceForFallback() {
			if (_fallbackClassified) {
				try { console.log('[FEATURE_RUNTIME] ClassificationCacheUsed path=fallback nodes=' + _fallbackClassified.length + ' ClassificationCacheHit'); } catch (e) {}
				return _fallbackClassified;
			}
			try { console.log('[FEATURE_RUNTIME] StyleClassificationStart path=fallback'); } catch (e) {}
			const t0 = performance.now();
			const scope = capturex_contentEle || document;
			const all = scope.querySelectorAll('*');
			const result = [];
			for (let i = 0; i < all.length; i++) {
				const el = all[i];
				if (!(el instanceof Element)) continue;
				let cs;
				try { cs = getComputedStyle(el); } catch (e) { continue; }
				const pos = cs.position;
				// Solo conservamos los nodos que el loop de estilo puede modificar:
				// sticky, fixed y los 'absolute' candidatos a changStyleForFullShot.
				if (pos === 'sticky' || pos === 'fixed' || pos === 'absolute') result.push({ el, pos });
				continue;
			}
			try { console.log('[FEATURE_RUNTIME] ClassifiedNodes=' + all.length); } catch (e) {}
			try { console.log('[FEATURE_RUNTIME] FixedElementsDetected=' + result.filter(r => r.pos === 'fixed').length); } catch (e) {}
			try { console.log('[FEATURE_RUNTIME] StickyElementsDetected=' + result.filter(r => r.pos === 'sticky').length); } catch (e) {}
			try { console.log('[FEATURE_RUNTIME] FloatingElementsDetected=' + result.length); } catch (e) {}
			try { console.log('[FEATURE_RUNTIME] StyleClassificationCompleted path=fallback timeMs=' + Math.round(performance.now() - t0) + ' kept=' + result.length); } catch (e) {}
			try { console.log('[FEATURE_RUNTIME] ClassificationCacheCreated path=fallback'); } catch (e) {}
			_fallbackClassified = result;
			return result;
		}
		function _resetFallbackClassification() {
			if (_fallbackClassified) {
				try { console.log('[FEATURE_RUNTIME] ClassificationCacheInvalidated reason=CAPTURE_RESET'); } catch (e) {}
			}
			_fallbackClassified = null;
		}

		// ========================================================================
		// PERF-02/MEM-01: Bitmap Streaming (ventana deslizante).
		// Sustituye a `Promise.all(items.map(createImageBitmap))`, que decodificaba
		// TODOS los cortes simultáneamente (≈18 MB/página a DPR 2 → pico >500 MB en
		// capturas de 30 páginas). Mantiene ≤ BITMAP_WINDOW bitmaps vivos, dibuja en
		// orden y hace close() inmediato tras drawImage(). Resultado visual idéntico.
		// ========================================================================
		const BITMAP_WINDOW = 4;
		function bitmapFrLog(msg) { try { console.log('[FEATURE_RUNTIME] ' + msg); } catch (e) {} }

		async function decodeBitmapStreaming(sources, onItem) {
			const total = sources.length;
			bitmapFrLog('StitchMemoryMode=STREAMING');
			bitmapFrLog('BitmapWindowStart segments=' + total);
			bitmapFrLog('BitmapWindowSize=' + BITMAP_WINDOW);
			let open = 0;    // bitmaps decodificados aún vivos (sin close())
			let maxOpen = 0;
			let cursor = 0;  // próximo índice por decodificar
			const inflight = [];
			// Errores diferidos: si un decode falla, se reporta al llegar a su índice
			// (mismo resultado que Promise.all, pero sin unhandled rejections).
			const decodeOne = async (idx) => {
				try {
					const item = sources[idx];
					let bmp;
					if (item instanceof Blob) {
						bmp = await createImageBitmap(item);
					} else {
						const resp = await fetch(item);
						bmp = await createImageBitmap(await resp.blob());
					}
					open++;
					if (open > maxOpen) maxOpen = open;
					bitmapFrLog('BitmapDecoded index=' + (idx + 1) + '/' + total + ' open=' + open);
					return bmp;
				} catch (err) {
					return { __bitmapError: err };
				}
			};
			const fill = () => {
				while (open + inflight.length < BITMAP_WINDOW && cursor < total) {
					inflight.push(decodeOne(cursor++));
				}
			};
			for (let i = 0; i < total; i++) {
				fill();
				const bmp = await inflight.shift();
				if (bmp && bmp.__bitmapError) throw bmp.__bitmapError;
				await onItem(bmp, i);
				bitmapFrLog('BitmapDrawn index=' + (i + 1) + '/' + total);
				try { bmp.close(); } catch (e) {}
				open--;
				bitmapFrLog('BitmapClosed index=' + (i + 1) + ' open=' + open + ' max=' + maxOpen);
			}
			bitmapFrLog('MaxBitmapsOpen=' + maxOpen);
			return maxOpen;
		}

		let capturex_setChildScrollableHeight = 0;
		let capturex_fullpage = 0;

		let capturex_scrollableEles = [];

		let capturex_startX, capturex_startY, capturex_endX, capturex_endY;
		let capturex_isSelecting = false;
		let capturex_overScrollTop = 0;
		let capture_working = 0;

		function releaseCaptureBuffers() {
			capturex_snap_mergedImage_array = [];
			capturex_capture_array = [];
			capturex_capture_array_width = [];
			capturex_capture_array_height = [];
			capturex_capture_top = null;
			capturex_capture_bottom = null;
			capturex_capture_left = null;
			capturex_capture_right = null;
			capturex_capture_array_splicing_index = 0;
			capturex_snap_mergedImage_index = 0;
			capture_working = 0;
		}

		var capturex_com_tools = {
			isInElement: function (parentElement, childElement) {
				if (!parentElement || !childElement || !(parentElement instanceof Element) || !(childElement instanceof Element)) {
					return false;
				}
				let currentParent = childElement.parentElement;
				while (currentParent) {
					if (currentParent === parentElement) {
						return true;
					}
					currentParent = currentParent.parentElement;
				}
				return false;
			},
			isVerticallyScrollable: function (element, threshold = 2) {
				const scrollHeight = element.scrollHeight;
				const clientHeight = element.clientHeight;
				const computedStyle = window.getComputedStyle(element);
				const overflowY = computedStyle.getPropertyValue('overflow-y');

				let isOver = 0;
				if (element.tagName.toLowerCase() == 'html' && (clientHeight > window.innerHeight || scrollHeight > clientHeight + threshold)) {
					isOver = 1;
				}
				else if (scrollHeight > clientHeight + threshold) {
					isOver = 1;
				}

				if (element.tagName.toLowerCase() == 'html')
					return isOver == 1 && (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'visible');
				
				// Para otros elementos, verificamos overflow y si realmente hay contenido desplazable
				const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll' || (overflowY === 'hidden' && element.classList.toString().toLowerCase().indexOf('scroll') > -1);
				return isOver == 1 && isScrollableStyle;
			},
			isVerticallyScrollableFrame: function (element) {
				if ((element.tagName == 'IFRAME' || element.tagName == 'FRAME')) {
					if (capturex_com_tools.iframeIsSameOrigin(element)) {
						const iframeDocument = element.contentDocument || element.contentWindow.document;
						const documentHeight = iframeDocument.body.scrollHeight;
						const windowHeight = element.contentWindow.innerHeight;
						return documentHeight > windowHeight;
					}
					else
						return false;
				}
				else
					return false;
			},
			_visibleRectComputeUncached: function (element) {
				let rect = element.getBoundingClientRect();
				let ancestor = element.parentElement;
				// PERF-07: profundidad acotada y rects de ancestros desde la caché de bbox.
				let depth = 0;

				while (ancestor && depth < 15) {
					depth++;
					const ancestorRect = _getCachedRect(ancestor);
					rect = {
						top: Math.max(rect.top, ancestorRect.top),
						left: Math.max(rect.left, ancestorRect.left),
						bottom: Math.min(rect.bottom, ancestorRect.bottom),
						right: Math.min(rect.right, ancestorRect.right),
						width: Math.min(rect.right, ancestorRect.right) - Math.max(rect.left, ancestorRect.left),
						height: Math.min(rect.bottom, ancestorRect.bottom) - Math.max(rect.top, ancestorRect.top)
					};
					if (rect.top >= rect.bottom || rect.left >= rect.right) {
						return null;
					}

					ancestor = ancestor.parentElement;
				}
				return rect;
			},
			// PERF-07: wrapper con caché (WeakMap; se invalida con _clearBBoxCache).
			getVisibleBoundingRect: function (element) {
				if (_visibleRectCache.has(element)) return _visibleRectCache.get(element);
				const result = capturex_com_tools._visibleRectComputeUncached(element);
				_visibleRectCache.set(element, result);
				try { console.log('[FEATURE_RUNTIME]', 'VisibleRect height=' + Math.round(result.bottom - result.top) + ' top=' + Math.round(result.top) + ' bottom=' + Math.round(result.bottom)); } catch (e) {}
				return result;
			},
			iframeIsSameOrigin: function (iframe) {
				const currentOrigin = window.location.origin;
				const iframeSrc = iframe.src;
				try {
					const iframeUrl = new URL(iframeSrc);
					const iframeOrigin = iframeUrl.origin;
					return currentOrigin === iframeOrigin;
				} catch (error) {
					return false;
				}
			},
			getScrollbarWidth2: function (element) { //Get the scrollbar width of a element
				if (element.tagName == 'IFRAME' || element.tagName == 'FRAME') {
					const iframeDocument = element.contentDocument || element.contentWindow.document;
					const outer = iframeDocument.createElement('div');
					outer.style.visibility = 'hidden';
					outer.style.overflow = 'scroll';
					outer.style.msOverflowStyle = 'scrollbar';
					iframeDocument.body.appendChild(outer);
					const inner = iframeDocument.createElement('div');
					outer.appendChild(inner);

					const computedStyle = window.getComputedStyle(element);
					const paddingLeft = parseFloat(computedStyle.paddingLeft);
					const paddingRight = parseFloat(computedStyle.paddingRight);

					let scrollbarWidth = outer.offsetWidth - inner.offsetWidth - paddingLeft - paddingRight;
					outer.parentNode.removeChild(outer);
					if (scrollbarWidth > 30 || scrollbarWidth < 0)
						scrollbarWidth = 0;

					return scrollbarWidth;
				}
				else {
					const originalOverflow = element.style.overflow;
					element.style.overflow = 'scroll';
					const withScroll = element.offsetWidth;
					const inner = document.createElement('div');
					inner.style.width = '100%';
					element.appendChild(inner);

					const computedStyle = window.getComputedStyle(element);
					const paddingLeft = parseFloat(computedStyle.paddingLeft);
					const paddingRight = parseFloat(computedStyle.paddingRight);

					const withoutScroll = inner.offsetWidth;

					element.removeChild(inner);

					element.style.overflow = originalOverflow;

					let scrollbarWidth = withScroll - withoutScroll - paddingLeft - paddingRight;
					if (scrollbarWidth > 30 || scrollbarWidth < 0)
						scrollbarWidth = 0;

					if (computedStyle.scrollbarWidth && computedStyle.scrollbarWidth == 'thin')
						scrollbarWidth = 10;

					return scrollbarWidth;
				}
			},
			getScrollbarWidth: function () { //Get the scrollbar width of page
				const outer = document.createElement('div');
				outer.style.visibility = 'hidden';
				outer.style.overflow = 'scroll';
				outer.style.msOverflowStyle = 'scrollbar';
				document.body.appendChild(outer);
				const inner = document.createElement('div');
				outer.appendChild(inner);
				let scrollbarWidth = outer.offsetWidth - inner.offsetWidth;
				outer.parentNode.removeChild(outer);
				if (scrollbarWidth > 50 || scrollbarWidth < 0)
					scrollbarWidth = 0;
				return scrollbarWidth;
			},
			withoutInlineStyleImportant: function (element) {
				const inlineStyle = element.style.cssText;
				if (inlineStyle.includes('opacity') && inlineStyle.includes('!important')) {
					const match = inlineStyle.match(/opacity:\s*([\d.]+)\s*!important/);
					if (match) {
						const opacityValue = match[1];
						const newStyle = inlineStyle.replace(/opacity:\s*([\d.]+)\s*!important/, `opacity: ${opacityValue}`);
						element.style.cssText = newStyle;
					}
				}
				if (inlineStyle.includes('transition') && element.classList.toString().indexOf('adsbygoogle') > -1) {
					const newStyleWithoutTransition = element.style.cssText.replace(/transition:[^;]+;/g, '');
					element.style.cssText = newStyleWithoutTransition;
				}
			},
			isScrollLoadedElement: async function (targetElement, timeout = 400) {
				const initialScrollHeight = targetElement.scrollHeight;
				const initialChildCount = targetElement.childElementCount;
				const originalScrollTop = targetElement.scrollTop;

				const checkContentGrowth = () => {
					return targetElement.scrollHeight > initialScrollHeight + 40 || targetElement.childElementCount > initialChildCount;
				};

				return new Promise(resolve => {
					const observer = new MutationObserver(() => {
						if (checkContentGrowth()) {
							cleanup();
							resolve(true);
						}
					});

					const timeoutId =					// PERF-09: ventana del transform 80 → 40 ms (el observer de crecimiento
					// y los reflows del sitio son la señal real, no el sleep fijo).
					setTimeout(() => {
						try { console.log('[FEATURE_RUNTIME]', 'ScrollTransformWait ms=40'); } catch (e) {}
						cleanup();
						resolve(checkContentGrowth());
					}, timeout);

					const cleanup = () => {
						observer.disconnect();
						targetElement.scrollTop = originalScrollTop;
						clearTimeout(timeoutId);
					};

					observer.observe(targetElement, {
						childList: true,
						subtree: true,
						attributes: false,
						characterData: false
					});
				});
			},
			isElementOccluded: function (el) { //Determine if it is obstructed
				const rect = _getCachedRect(el);
				const centerX = rect.left + rect.width / 2;
				const centerY = rect.top + rect.height / 2;
				const elementAtPoint = document.elementFromPoint(centerX, centerY);
				return elementAtPoint !== el && !el.contains(elementAtPoint);
			},

			copyImageToClipboard: async function (imageData, mimeType = 'image/png') {
				try {
					if (!navigator.clipboard) {
						capturex_com_saveAction.showTip('Copiar no está soportado');
						throw new Error('Clipboard API Error');
					}
					let blob;

					if (typeof imageData === 'string' && imageData.startsWith('data:')) {
						const base64Str = imageData.replace(/^data:image\/\w+;base64,/, '');
						const byteCharacters = atob(base64Str);
						const byteArrays = [];

						for (let offset = 0; offset < byteCharacters.length; offset += 512) {
							const slice = byteCharacters.slice(offset, offset + 512);
							const byteNumbers = new Array(slice.length);

							for (let i = 0; i < slice.length; i++) {
								byteNumbers[i] = slice.charCodeAt(i);
							}

							byteArrays.push(new Uint8Array(byteNumbers));
						}
						blob = new Blob(byteArrays, { type: mimeType });
					}
					else if (imageData instanceof Blob) {
						blob = imageData;
					}
					else {
						throw new Error('Data Error');
					}

					try{ console.log('[PERMISSION_TRACE] API=navigator.clipboard.write URL='+location.href+' Action=capture:clipboard'); }catch{}
					await navigator.clipboard.write([
						new ClipboardItem({
							[mimeType]: blob
						})
					]);
					capturex_com_saveAction.showTip('Imagen copiada al portapapeles');
					return true;
				} catch (error) {
					capturex_com_saveAction.showTip('Error al copiar imagen');
					return false;
				}
			}
		};

		var capturex_com_saveAction = {
			contentjsIsLoad: function () {
				chrome.runtime.sendMessage({ action: "contentjsIsLoad" });
			},
			setCanvasMaxHeight: function (width) {
				//count capturex_canvas_browserMaxHeight
				if (width > 0) {
					const maxArea = capturex_canvas_browserMaxArea_sys; //Chrome 73+
					let maxHeight = Math.floor(maxArea / width);
					if (maxHeight < capturex_canvas_browserMaxHeight_sys)
						capturex_canvas_browserMaxHeight = maxHeight;
				}
			},
			reSetCaptureXData: function () {
				//Reset global variables
				capturex_scrollPosition = 0;
				capturex_contentEle = undefined;
				capturex_contentEleIframe = undefined;
				capturex_contentEle_over_top = 0;
				capturex_contentEle_over_bottom = 0;
				capturex_documentHeight_o = 0;
				capturex_documentHeight = 0;
				capturex_documentWdith = 0;
				capturex_onePageHeight = 0;
				capturex_onePageOverlap = 0;
				capturex_contentPageCrollTop = 0;
				// PERF-05: invalida el walk único y la caché de rects (la página pudo cambiar).
				capturex_com_saveAction._preScanInvalidate();
				try { _clearBBoxCache(); } catch (e) {}
				capturex_nowRealPageCrollTop = 0;
				capturex_preRealPageCrollTop = 0;
				capturex_scrollbarWidth = 0;
				capturex_changStyleForShotTimes = 0;
				_resetFallbackClassification();
				capturex_capture_truncated = false;
				capturex_snap_mergedImage_array = [];
				capturex_snap_mergedImage_index = 0;
				_clearBBoxCache();
				capturex_capturedScrollTops = new Set();
				capturex_capturedRealTops = [];
				capturex_capture_top = undefined;
				capturex_capture_bottom = undefined;
				capturex_capture_left = undefined;
				capturex_capture_right = undefined;
				capturex_capture_array = [];
				capturex_capture_array_width = [];
				capturex_capture_array_height = [];
				capturex_capture_array_splicing_index = 0;
				capturex_overScrollTop = 0;
				capture_working = 0;
				capturex_scrollableEles = [];
				capturex_setChildScrollableHeight = 0;
				capturex_fullpage = 0;
			},
			captureSelectionEdit: function () {
				clearSelectionDiv();

				var docHeight = Math.max(
					document.body.scrollHeight, document.documentElement.scrollHeight,
					document.body.offsetHeight, document.documentElement.offsetHeight,
					document.body.clientHeight, document.documentElement.clientHeight
				);

				var docWidth = Math.max(
					document.body.scrollWidth, document.documentElement.scrollWidth,
					document.body.offsetWidth, document.documentElement.offsetWidth,
					document.body.clientWidth, document.documentElement.clientWidth
				);

				var capturex_overlay_0 = document.createElement("div");
				capturex_overlay_0.style.cssText = "position: absolute; left: 0px; top: 0px; opacity: 0; cursor: crosshair; z-index: 2147483640; display: block !important; width: " + docWidth + "px; height: " + docHeight + "px;";
				capturex_overlay_0.id = "capturex_overlay_0";
				document.body.appendChild(capturex_overlay_0);

				var capturex_overlay_1 = document.createElement("div");
				capturex_overlay_1.style.cssText = "position: absolute; background: rgb(0, 0, 0); opacity: 0.3; z-index: 2147483639; cursor: crosshair; display: block !important; left: 0px; top: 0px; width: " + docWidth + "px; height: 0px;";
				capturex_overlay_1.id = "capturex_overlay_1";
				document.body.appendChild(capturex_overlay_1);

				var capturex_overlay_2 = document.createElement("div");
				capturex_overlay_2.style.cssText = "position: absolute; background: rgb(0, 0, 0); opacity: 0.3; z-index: 2147483639; cursor: crosshair; display: block !important; left: 0px; top: 0px; width: " + docWidth + "px; height: " + docHeight + "px;";
				capturex_overlay_2.id = "capturex_overlay_2";
				document.body.appendChild(capturex_overlay_2);

				var capturex_overlay_3 = document.createElement("div");
				capturex_overlay_3.style.cssText = "position: absolute; background: rgb(0, 0, 0); opacity: 0.3; z-index: 2147483639; cursor: crosshair; display: block !important; left: 0px; top: 0px; width: 0px; height: 0px;";
				capturex_overlay_3.id = "capturex_overlay_3";
				document.body.appendChild(capturex_overlay_3);

				var capturex_overlay_4 = document.createElement("div");
				capturex_overlay_4.style.cssText = "position: absolute; background: rgb(0, 0, 0); opacity: 0.3; z-index: 2147483639; cursor: crosshair; display: block !important; left: 0px; top: 0px; width: " + docWidth + "px; height: 0px;";
				capturex_overlay_4.id = "capturex_overlay_4";
				document.body.appendChild(capturex_overlay_4);

				var capturex_slection_area = document.createElement("div");
				capturex_slection_area.style.cssText = "position: absolute; left: 0px; top: 0px; width: 0px; height: 0px; z-index: 2147483639; cursor: crosshair; display: block !important;";
				capturex_slection_area.id = "capturex_slection_area";

				var capturex_slection_area_div0 = document.createElement("div");
				capturex_slection_area_div0.style.cssText = 'background: url("data:image/gif;base64,R0lGODlhAQAGAKEAAP///wAAADY2Nv///yH/C05FVFNDQVBFMi4wAwEAAAAh/hpDcmVhdGVkIHdpdGggYWpheGxvYWQuaW5mbwAh+QQACgD/ACwAAAAAAQAGAAACAxQuUgAh+QQBCgADACwAAAAAAQAGAAACA5SAUgAh+QQBCgADACwAAAAAAQAGAAACA5SBBQAh+QQBCgADACwAAAAAAQAGAAACA4QOUAAh+QQBCgADACwAAAAAAQAGAAACAwSEUAAh+QQBCgADACwAAAAAAQAGAAACA4SFBQA7") left top repeat-y; opacity: 0.5; position: absolute; cursor: crosshair; display: block !important; inset: 0px;';
				capturex_slection_area.appendChild(capturex_slection_area_div0);

				var capturex_slection_area_div1 = document.createElement("div");
				capturex_slection_area_div1.style.cssText = 'background: url("data:image/gif;base64,R0lGODlhBgABAKEAAP///wAAADY2Nv///yH/C05FVFNDQVBFMi4wAwEAAAAh/hpDcmVhdGVkIHdpdGggYWpheGxvYWQuaW5mbwAh+QQACgD/ACwAAAAABgABAAACAxQuUgAh+QQBCgADACwAAAAABgABAAACA5SAUgAh+QQBCgADACwAAAAABgABAAACA5SBBQAh+QQBCgADACwAAAAABgABAAACA4QOUAAh+QQBCgADACwAAAAABgABAAACAwSEUAAh+QQBCgADACwAAAAABgABAAACA4SFBQA7") left top repeat-x; opacity: 0.5; position: absolute; cursor: crosshair; display: block !important; inset: 0px;';
				capturex_slection_area.appendChild(capturex_slection_area_div1);

				var capturex_slection_area_div2 = document.createElement("div");
				capturex_slection_area_div2.style.cssText = 'background: url("data:image/gif;base64,R0lGODlhAQAGAKEAAP///wAAADY2Nv///yH/C05FVFNDQVBFMi4wAwEAAAAh/hpDcmVhdGVkIHdpdGggYWpheGxvYWQuaW5mbwAh+QQACgD/ACwAAAAAAQAGAAACAxQuUgAh+QQBCgADACwAAAAAAQAGAAACA5SAUgAh+QQBCgADACwAAAAAAQAGAAACA5SBBQAh+QQBCgADACwAAAAAAQAGAAACA4QOUAAh+QQBCgADACwAAAAAAQAGAAACAwSEUAAh+QQBCgADACwAAAAAAQAGAAACA4SFBQA7") right top repeat-y; opacity: 0.5; position: absolute; cursor: crosshair; display: block !important; inset: 0px;';
				capturex_slection_area.appendChild(capturex_slection_area_div2);

				var capturex_slection_area_div3 = document.createElement("div");
				capturex_slection_area_div3.style.cssText = 'background: url("data:image/gif;base64,R0lGODlhBgABAKEAAP///wAAADY2Nv///yH/C05FVFNDQVBFMi4wAwEAAAAh/hpDcmVhdGVkIHdpdGggYWpheGxvYWQuaW5mbwAh+QQACgD/ACwAAAAABgABAAACAxQuUgAh+QQBCgADACwAAAAABgABAAACA5SAUgAh+QQBCgADACwAAAAABgABAAACA5SBBQAh+QQBCgADACwAAAAABgABAAACA4QOUAAh+QQBCgADACwAAAAABgABAAACAwSEUAAh+QQBCgADACwAAAAABgABAAACA4SFBQA7") left bottom repeat-x; opacity: 0.5; position: absolute; cursor: crosshair; display: block !important; inset: 0px;';
				capturex_slection_area.appendChild(capturex_slection_area_div3);

				var capturex_slection_area_txt = document.createElement("div");
				capturex_slection_area_txt.id = "capturex_slection_area_txt";
				capturex_slection_area_txt.style.cssText = "font-family: Tahoma, Helvetica, Arial; font-size: 14px; color: rgb(255, 255, 255); width: auto; height: auto; padding: 3px; background: rgb(0, 0, 0); opacity: 0.9; position: absolute; border: 1px solid rgb(51, 51, 51); cursor: crosshair; display: block !important; visibility: hidden; bottom: 10px; right: 10px;";
				capturex_slection_area_txt.innerText = "0 x 0";
				capturex_slection_area.appendChild(capturex_slection_area_txt);

				document.body.appendChild(capturex_slection_area);

				let originalUserSelect = document.body.style.userSelect;
				function handleMousedown(e) {
					e.preventDefault();
					originalUserSelect = document.body.style.userSelect;
					document.body.style.userSelect = 'none';

					capturex_scrollPosition = document.documentElement.scrollTop || document.body.scrollTop;
					capturex_startX = e.clientX;
					capturex_startY = e.clientY + capturex_scrollPosition;
					capturex_overlay_1.style.height = capturex_startY + "px";
					capturex_overlay_3.style.top = capturex_startY + "px";
					capturex_overlay_3.style.width = capturex_startX + "px";
					capturex_isSelecting = true;
				}
				document.addEventListener('mousedown', handleMousedown);
				let ticking = false;
				function updateOverlayStyles() {
					if (!capturex_isSelecting) {
						ticking = false;
						return;
					}

					//top shadow
					if (capturex_endY - capturex_startY > 0)
						capturex_overlay_1.style.height = capturex_startY + "px";
					else
						capturex_overlay_1.style.height = capturex_endY + "px";
					//bottom shadow	
					if (capturex_endY - capturex_startY > 0)
						capturex_overlay_2.style.top = capturex_endY + "px";
					else
						capturex_overlay_2.style.top = capturex_startY + "px";

					if (capturex_endY - capturex_startY > 0)
						capturex_overlay_2.style.height = docHeight - capturex_endY + "px";
					else
						capturex_overlay_2.style.height = docHeight - capturex_startY + "px";
					//left shadow
					if (capturex_endY - capturex_startY > 0)
						capturex_overlay_3.style.top = capturex_startY + "px";
					else
						capturex_overlay_3.style.top = capturex_endY + "px";

					if (capturex_endX - capturex_startX > 0)
						capturex_overlay_3.style.width = capturex_startX + "px";
					else
						capturex_overlay_3.style.width = capturex_endX + "px";

					capturex_overlay_3.style.height = Math.abs(capturex_endY - capturex_startY) + "px";
					//right shadow
					if (capturex_endX > capturex_startX)
						capturex_overlay_4.style.left = capturex_endX + "px";
					else
						capturex_overlay_4.style.left = capturex_startX + "px";

					if (capturex_endY > capturex_startY)
						capturex_overlay_4.style.top = capturex_startY + "px";
					else
						capturex_overlay_4.style.top = capturex_endY + "px";

					capturex_overlay_4.style.height = Math.abs(capturex_endY - capturex_startY) + "px";

					if (capturex_endX > capturex_startX)
						capturex_overlay_4.style.width = (docWidth - capturex_endX) + "px";
					else
						capturex_overlay_4.style.width = (docWidth - capturex_startX) + "px";
					//selection
					if (capturex_endX > capturex_startX)
						capturex_slection_area.style.left = capturex_startX + "px";
					else
						capturex_slection_area.style.left = capturex_endX + "px";

					if (capturex_endY > capturex_startY)
						capturex_slection_area.style.top = capturex_startY + "px";
					else
						capturex_slection_area.style.top = capturex_endY + "px";
					capturex_slection_area.style.width = Math.abs(capturex_endX - capturex_startX) + "px";
					capturex_slection_area.style.height = Math.abs(capturex_endY - capturex_startY) + "px";

					ticking = false;
				}

				function handleMousemove(e) {
					if (capturex_isSelecting) {
						let limitedX = Math.max(0, Math.min(e.clientX, window.innerWidth));
						let limitedY = Math.max(0, Math.min(e.clientY, window.innerHeight));

						capturex_endX = limitedX;
						capturex_endY = limitedY + capturex_scrollPosition;

						if (!ticking) {
							window.requestAnimationFrame(updateOverlayStyles);
							ticking = true;
						}
					}
				}
				document.addEventListener('mousemove', handleMousemove);

				function handleMouseup(e) {
					capturex_isSelecting = false;
					ticking = false;

					let limitedX = Math.max(0, Math.min(e.clientX, window.innerWidth));
					let limitedY = Math.max(0, Math.min(e.clientY, window.innerHeight));

					capturex_endX = limitedX;
					capturex_endY = limitedY + capturex_scrollPosition;

					document.body.style.userSelect = originalUserSelect;

					document.removeEventListener('mousedown', handleMousedown);
					document.removeEventListener('mousemove', handleMousemove);
					document.removeEventListener('mouseup', handleMouseup);
				// Keep keydown active so Esc can cancel the action when area is selected:


					var capturex_selection_save_div = document.createElement("div");
					capturex_selection_save_div.id = "capturex_selection_save_div";
					var selectBtnHtml = '';
					selectBtnHtml += '<span id="capturex_selection_copyButton" style="cursor:pointer;font-size:13px;font-weight:600;font-family:\'Segoe UI\', -apple-system, BlinkMacSystemFont, sans-serif;padding:8px 16px;border-radius:10px 0px 0px 10px;background-color:#ffffff;color:#003060;border:1px solid #d1d9e2;display:inline-block;box-sizing:border-box;user-select:none;z-index:2147483647 !important;transition:all 0.15s ease;">Copiar</span>';
					selectBtnHtml += '<span id="capturex_selection_editButton" style="cursor:pointer;font-size:13px;font-weight:600;font-family:\'Segoe UI\', -apple-system, BlinkMacSystemFont, sans-serif;padding:8px 16px;border-radius:0px;background-color:#ffffff;color:#003060;border:1px solid #d1d9e2;border-left:none;display:inline-block;box-sizing:border-box;user-select:none;z-index:2147483647 !important;transition:all 0.15s ease;">Confirmar</span>';
					selectBtnHtml += '<span id="capturex_selection_cancelButton" style="cursor:pointer;font-size:13px;font-weight:600;font-family:\'Segoe UI\', -apple-system, BlinkMacSystemFont, sans-serif;padding:8px 16px;border-radius:0px 10px 10px 0px;background-color:#ffffff;color:#dc3545;border:1px solid #d1d9e2;border-left:none;display:inline-block;box-sizing:border-box;user-select:none;z-index:2147483647 !important;transition:all 0.15s ease;">Cancelar</span>';
					capturex_selection_save_div.innerHTML = selectBtnHtml;
					capturex_selection_save_div.style.width = 'auto';
					capturex_selection_save_div.style.position = 'absolute';
					capturex_selection_save_div.style.zIndex = 2147483641;
					capturex_selection_save_div.style.boxShadow = '0 4px 15px rgba(0,0,0,0.15)';
					capturex_selection_save_div.style.borderRadius = '10px';

					var capturex_scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
					document.body.appendChild(capturex_selection_save_div);
					var element_slection_area = document.getElementById('capturex_slection_area');
					var element_slection_area_rect = element_slection_area.getBoundingClientRect();
					capturex_selection_save_div.style.left = (element_slection_area_rect.right - capturex_selection_save_div.offsetWidth - 2) + 'px';
					capturex_selection_save_div.style.top = (element_slection_area_rect.bottom + capturex_scrollTop - capturex_selection_save_div.offsetHeight - 2) + 'px';

					const copyButton = document.getElementById('capturex_selection_copyButton');
					const editButton = document.getElementById('capturex_selection_editButton');
					const cancelButton = document.getElementById('capturex_selection_cancelButton');
					copyButton.addEventListener('mouseover', function () {
						this.style.backgroundColor = '#003060';
						this.style.color = '#ffffff';
						this.style.borderColor = '#003060';
					});
					copyButton.addEventListener('mouseout', function () {
						this.style.backgroundColor = '#ffffff';
						this.style.color = '#003060';
						this.style.borderColor = '#d1d9e2';
					});
					editButton.addEventListener('mouseover', function () {
						this.style.backgroundColor = '#003060';
						this.style.color = '#ffffff';
						this.style.borderColor = '#003060';
					});
					editButton.addEventListener('mouseout', function () {
						this.style.backgroundColor = '#ffffff';
						this.style.color = '#003060';
						this.style.borderColor = '#d1d9e2';
					});
					cancelButton.addEventListener('mouseover', function () {
						this.style.backgroundColor = '#003060';
						this.style.color = '#ffffff';
						this.style.borderColor = '#003060';
					});
					cancelButton.addEventListener('mouseout', function () {
						this.style.backgroundColor = '#ffffff';
						this.style.color = '#dc3545';
						this.style.borderColor = '#d1d9e2';
					});

					copyButton.addEventListener('click', handleCopyBtnClick);
					editButton.addEventListener('click', handleEditBtnClick);
					cancelButton.addEventListener('click', handleCancelBtnClick);
					function handleEditBtnClick(event) {
						handleCancelBtnClick(event, false);
						setTimeout(function () {
							chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot4Selection" });
						}, 20);
					}
					function handleCancelBtnClick(event, shouldReset = true) {
						clearSelectionDiv();
						if (shouldReset) {
							chrome.runtime.sendMessage({ action: "RESET_CAPTURE_STATUS" });
						}
					}
					function handleCopyBtnClick(event) {
						handleCancelBtnClick(event, false);
						setTimeout(function () {
							chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot4SelectionCopy" });
						}, 20);
					}
				}
				document.addEventListener('mouseup', handleMouseup);

				function clearSelectionDiv() {
					let element_0 = document.getElementById('capturex_overlay_0');
					if (element_0) document.body.removeChild(element_0);
					let element_1 = document.getElementById('capturex_overlay_1');
					if (element_1) document.body.removeChild(element_1);
					let element_2 = document.getElementById('capturex_overlay_2');
					if (element_2) document.body.removeChild(element_2);
					let element_3 = document.getElementById('capturex_overlay_3');
					if (element_3) document.body.removeChild(element_3);
					let element_4 = document.getElementById('capturex_overlay_4');
					if (element_4) document.body.removeChild(element_4);
					let element_slection_area = document.getElementById('capturex_slection_area');
					if (element_slection_area) document.body.removeChild(element_slection_area);
					let capturex_selection_save_div = document.getElementById('capturex_selection_save_div');
					if (capturex_selection_save_div) document.body.removeChild(capturex_selection_save_div);
					document.removeEventListener('keydown', handleKeyDown);
				}

				document.addEventListener('keydown', handleKeyDown);
				function handleKeyDown(e) {
					const key = e ? e.key : (typeof event !== 'undefined' ? event.key : null);
					if (key === 'Escape' || key === 'Esc') {
						clearSelectionDiv();
						document.removeEventListener('mousedown', handleMousedown);
						document.removeEventListener('mousemove', handleMousemove);
						document.removeEventListener('mouseup', handleMouseup);
						document.removeEventListener('keydown', handleKeyDown);
						chrome.runtime.sendMessage({ action: "RESET_CAPTURE_STATUS" });
					}
				}
			},
			cropRangeImage: function (imageDataUrl) {
				if (capturex_contentEleRectTop > 0 || (capturex_contentEleRectBottom - 20) < window.innerHeight) {
					const image = new Image();
					image.src = imageDataUrl;
					image.onload = function () {

						var zoomLevel = window.devicePixelRatio;
						if (capturex_contentEleRectTop > 0) //get capturex_capture_top 
						{
							const cropWidth = window.innerWidth * zoomLevel;
							const cropHeight = capturex_contentEleRectTop * zoomLevel;

							const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
							let canvas = canvasWrapper.canvas;
							const context = canvasWrapper.context;

							context.drawImage(image, 0, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

							canvasWrapper.toBlob(blob => { capturex_capture_top = blob; }, 'image/png');
							canvas = null;
						}

						if (capturex_contentEleRectBottom < window.innerHeight) {
							const cropWidth = window.innerWidth * zoomLevel;
							const cropHeight = Math.abs(window.innerHeight - capturex_contentEleRectBottom) * zoomLevel;

							const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
							let canvas = canvasWrapper.canvas;
							const context = canvasWrapper.context;

							context.drawImage(image, 0, capturex_contentEleRectBottom * zoomLevel, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

							canvasWrapper.toBlob(blob => { capturex_capture_bottom = blob; }, 'image/png');
							canvas = null;
						}

						if (capturex_contentEleRectLeft > 0) {
							const cropWidth = capturex_contentEleRectLeft * zoomLevel;
							const cropHeight = window.innerHeight * zoomLevel;

							const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
							let canvas = canvasWrapper.canvas;
							const context = canvasWrapper.context;

							context.drawImage(image, 0, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

							canvasWrapper.toBlob(blob => { capturex_capture_left = blob; }, 'image/png');
							canvas = null;
						}

						if (capturex_contentEleRectRight < window.innerWidth) {
							const cropWidth = (window.innerWidth - capturex_contentEleRectRight) * zoomLevel;
							const cropHeight = window.innerHeight * zoomLevel;

							const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
							let canvas = canvasWrapper.canvas;
							const context = canvasWrapper.context;

							context.drawImage(image, capturex_contentEleRectRight * zoomLevel, 0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

							canvasWrapper.toBlob(blob => { capturex_capture_right = blob; }, 'image/png');
							canvas = null;
						}

					};
				}
			},
			cropImageContent: function (imageDataUrl, pageType = 0) {
				return new Promise((resolve, reject) => {
					let startX = capturex_contentEleRectLeft;
					let startY = capturex_contentEleRectTop + capturex_contentEle_over_top;
					let endX = capturex_contentEleRectRight;
					let endY = capturex_contentEleRectBottom - capturex_contentEle_over_bottom;

					if (capturex_contentEle.style.transform) {
						startX = capturex_contentEleRectLeft;
						startY = capturex_contentEleRectTop - capturex_contentEle_over_top;
						endX = capturex_contentEleRectRight;
						endY = capturex_contentEleRectBottom - capturex_contentEle_over_bottom;
					}

					var pageScrollPosition = 0;
					if (capturex_scrollableEles.length == 0)
						pageScrollPosition = document.documentElement.scrollTop || document.body.scrollTop;

					const zoomLevel = window.devicePixelRatio;
					let _startX = startX * zoomLevel;
					let _startY = (startY - pageScrollPosition) * zoomLevel;
					let _endX = endX * zoomLevel;
					let _endY = (endY - pageScrollPosition) * zoomLevel;

					if (capturex_scrollbarWidth > 0)
						_endX = _endX - capturex_scrollbarWidth * zoomLevel;

					if (capturex_onePageOverlap > 0) {
						var capturex_onePageOverlap_half = capturex_onePageOverlap / 2 * zoomLevel;
						if (pageType == 0) {
							_endY = _endY - Math.floor(capturex_onePageOverlap_half);
						}
						else if (pageType == 1) {
							_startY = _startY + Math.ceil(capturex_onePageOverlap_half);
							_endY = _endY - Math.floor(capturex_onePageOverlap_half);
						}
						else if (pageType == 2) {
						}
					}

					if (pageType == 0 && capturex_fullpage == 1) {
						capturex_com_saveAction.cropRangeImage(imageDataUrl);
					}

					capturex_startX = 0;
					capturex_startY = 0;
					capturex_endX = 0;
					capturex_endY = 0;

					const image = new Image();
					image.src = imageDataUrl;
					image.onload = function () {
						const cropWidth = Math.abs(_endX - _startX);
						const cropHeight = Math.abs(_endY - _startY);
						const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
						let canvas = canvasWrapper.canvas;
						const context = canvasWrapper.context;

						context.drawImage(image, Math.min(_startX, _endX), Math.min(_startY, _endY), cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

						// Crop optimized to PNG Blob
						capturex_capture_array_width.push(canvas.width);
						capturex_capture_array_height.push(canvas.height);
						canvasWrapper.toBlob(blob => resolve(blob), 'image/png');
						canvas = null;
					};

					image.onerror = function (err) {
						reject(new Error("Image failed to load"));
					};
				});
			},
			cropImage: function (imageDataUrl, startX, startY, endX, endY, forCopy = 0) {
				var zoomLevel = window.devicePixelRatio;
				var _startX = startX * zoomLevel;
				var _startY = (startY - capturex_scrollPosition) * zoomLevel;
				var _endX = endX * zoomLevel;
				var _endY = (endY - capturex_scrollPosition) * zoomLevel;

				capturex_startX = 0;
				capturex_startY = 0;
				capturex_endX = 0;
				capturex_endY = 0;
				capturex_scrollPosition = 0;

				var image = new Image();
				image.src = imageDataUrl;
				image.onload = async function () {
					var cropWidth = Math.abs(_endX - _startX);
					var cropHeight = Math.abs(_endY - _startY);

					if (forCopy == 0) {
						// Medimos la altura necesaria para el encabezado con respecto al ancho de la imagen recortada
						const tempCanvas = document.createElement('canvas');
						const tempCtx = tempCanvas.getContext('2d');
						tempCtx.font = "600 20px Segoe UI, Roboto, sans-serif";
						const textWrapWidth = Math.max(400, cropWidth) - 155;
						const urlLines = wrapTextAnywhere(tempCtx, "URL: " + window.location.href, textWrapWidth);
						const HEADER_HEIGHT = 100 + (urlLines.length - 1) * 24;

						const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight + HEADER_HEIGHT);
						let canvas = canvasWrapper.canvas;
						const context = canvasWrapper.context;

						// Primero pintamos el encabezado corporativo
						const evId = await fetchNextEvidenceId();
						await drawEvidenceHeader(context, canvas.width, HEADER_HEIGHT, evId);

						// Pintamos el fondo blanco de respaldo bajo la captura
						context.save();
						context.fillStyle = "#ffffff";
						context.fillRect(0, HEADER_HEIGHT, canvas.width, canvas.height - HEADER_HEIGHT);
						context.restore();

						// Dibujamos la captura recortada en la sección inferior
						context.drawImage(image, Math.min(_startX, _endX), Math.min(_startY, _endY), cropWidth, cropHeight, 0, HEADER_HEIGHT, cropWidth, cropHeight);
						
						canvasWrapper.toBlob(blob => {
							const cropImageDataUrl = canvasWrapper.toDataURL('image/png');
							chrome.runtime.sendMessage({ action: "setSelectionCaptureData", dataUrl: cropImageDataUrl });
							canvas = null;
						}, 'image/png');
					} else {
						// Para copiado común al portapapeles mantenemos el recorte exacto sin encabezado
						const canvasWrapper = createUniversalCanvas(cropWidth, cropHeight);
						let canvas = canvasWrapper.canvas;
						const context = canvasWrapper.context;
						context.drawImage(image, Math.min(_startX, _endX), Math.min(_startY, _endY), cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
						canvasWrapper.toBlob(blob => {
							capturex_com_tools.copyImageToClipboard(blob, 'image/png').finally(() => {
								try { chrome.runtime.sendMessage({ action: "RESET_CAPTURE_STATUS" }); } catch (e) {}
							});
							canvas = null;
						}, 'image/png');
					}
				};
			},
			getNewDocHeight: function () {
				var newDocHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

				if (capturex_contentEle) {
					newDocHeight = capturex_contentEle.scrollHeight;
					if ((capturex_contentEle.tagName == 'IFRAME' || capturex_contentEle.tagName == 'FRAME') && capturex_com_tools.iframeIsSameOrigin(capturex_contentEle)) {
						const iframeDocument = capturex_contentEle.contentDocument || capturex_contentEle.contentWindow.document;
						newDocHeight = iframeDocument.body.scrollHeight;
					}
				}

				return newDocHeight;
			},
			// ===== PERF-05 (auditoría _002): un solo recorrido DOM pre-captura =====
			// preScanDocument hace UN walk DFS que recolecta: candidatos scrollables
			// (pre-filtro barato sin getComputedStyle), todos los iframes/frames y el
			// snapshot de candidatos de contenido (childElementCount/textContent —
			// cero innerHTML). Consumidores: findScrollableElements, el loop de
			// iframes de captureAllPageScreenshot y applyPreScanContentRules.
			_preScanCache: null,
			_preScanInvalidate: function () {
				this._preScanCache = null;
			},
			preScanDocument: function () {
				if (this._preScanCache) {
					try { console.log('[FEATURE_RUNTIME]', 'PreScanCacheUsed'); } catch (e) {}
					return this._preScanCache;
				}
				const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
				const acc = { nodes: 0, maxScroll: 0, scrollableRaw: [], frames: [], contentCandidates: [] };
				const walk = function (element, depth) {
					acc.nodes++;
					const tag = element.tagName;
					if (depth <= 20) {
						// Equivalente al valor de retorno del getMaxHeight original:
						// max scrollHeight del subárbol del body con profundidad <= 20.
						// En frames same-origin el internal document reemplaza la medida
						// (igual que hacía la línea maxHeight = iframeDocument...).
						let sh = element.scrollHeight;
						if (tag == 'IFRAME' || tag == 'FRAME') {
							try {
								if (capturex_com_tools.iframeIsSameOrigin(element)) {
									const fd = element.contentDocument || (element.contentWindow && element.contentWindow.document);
									if (fd && fd.body) sh = fd.body.scrollHeight;
								}
							} catch (e) {}
						}
						if (sh > acc.maxScroll) acc.maxScroll = sh;
					}
					if (tag != 'BODY' && tag != 'HTML') {
						if (tag == 'IFRAME' || tag == 'FRAME') {
							// Los frames siempre entran: isVerticallyScrollableFrame los
							// evalúa por documento interno (el pre-filtro no aplica).
							acc.frames.push(element);
							acc.scrollableRaw.push(element);
						}
						else if (element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2) {
							// Mismo umbral que el primer chequeo de isVerticallyScrollable
							// (más contrapartida horizontal para no perder scrollables en X
							// frente al walk completo histórico de ScrollFinder — PERF-06b;
							// el loop legacy sigue filtrando en vertical, sin cambios).
							acc.scrollableRaw.push(element);
						}
						if (depth <= 20) {
							// Snapshot de contenido SIN innerHTML (PERF-05/QW-06):
							// childElementCount/textContent no serializan el subárbol.
							let contentOK = element.childElementCount > 0;
							if (!contentOK) {
								try { contentOK = (element.textContent || '').length > 100; } catch (e) { contentOK = false; }
							}
							acc.contentCandidates.push({ el: element, contentOK: contentOK });
						}
					}
					const children = element.children;
					for (let i = 0; i < children.length; i++) walk(children[i], depth + 1);
				};
				if (document.body) walk(document.body, 0);
				this._preScanCache = acc;
				const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
				try { console.log('[FEATURE_RUNTIME]', 'PreScanWalk nodes=' + acc.nodes + ' scrollableCandidates=' + acc.scrollableRaw.length + ' framesDetected=' + acc.frames.length + ' contentCandidates=' + acc.contentCandidates.length + ' ms=' + ms); } catch (e) {}
				return acc;
			},
			// Reglas de selección de contenido (antes getMaxHeight) sobre el snapshot:
			// mismas condiciones y mismo orden; devuelve el max scrollHeight (old _docHeight).
			applyPreScanContentRules: function () {
				const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
				const scan = this.preScanDocument();
				const winHalf = window.innerHeight / 2;
				const docW = capturex_documentWdith || document.documentElement.clientWidth;
				const docUnscrollable = (document.documentElement.scrollHeight == document.documentElement.clientHeight);
				for (let i = 0; i < scan.contentCandidates.length; i++) {
					const item = scan.contentCandidates[i];
					const element = item.el;
					const tag = element.tagName;
					const isFrame = (tag == 'IFRAME' || tag == 'FRAME');
					if (isFrame) {
						const rectF = _getCachedRect(element);
						const widthF = rectF.width;
						const sameOriginF = capturex_com_tools.iframeIsSameOrigin(element);
						let ownMaxF = element.scrollHeight;
						if (sameOriginF) {
							try {
								const fd = element.contentDocument || (element.contentWindow && element.contentWindow.document);
								if (fd && fd.body) ownMaxF = fd.body.scrollHeight;
							} catch (e) {}
						}
						// Regla capturex_contentEleIframe (iframe cross-origin grande): en el
						// original corría para TODO iframe, sin condición de contenido.
						if (tag == 'IFRAME' && widthF > docW - 100 && rectF.top < winHalf && ownMaxF > capturex_documentHeight / 2) {
							const srcF = element.src || '';
							if (srcF.indexOf('http') == 0 && !sameOriginF) capturex_contentEleIframe = element;
						}
						// Regla 3: mismo origen, documento interno más alto que el actual.
						if (element.src && sameOriginF && ownMaxF > capturex_documentHeight && (widthF > 500 || widthF > docW / 2) && docUnscrollable) {
							capturex_documentHeight = ownMaxF;
							capturex_contentEle = element;
						}
						continue;
					}
					if (!item.contentOK) continue;
					const rect = _getCachedRect(element);
					if (!(rect.top < winHalf && rect.width > 0)) continue;
					const width = rect.width;
					const ownMax = element.scrollHeight;
					const cs = window.getComputedStyle(element);
					if (cs.overflowY == 'scroll' || cs.overflowY == 'auto') {
						// Regla 1 (div scrollable con contenido). Nota: el reemplazo
						// innerHTML→childElementCount/textContent prescrito por la auditoría
						// es levemente más permisivo con nodos de markup mínimo; las demás
						// condiciones (overflow, posición, ancho, scroll real) dominan.
						if (rect.top < winHalf && ownMax > capturex_documentHeight && (width > 500 || width > docW / 2)) {
							if (element.scrollHeight > element.clientHeight) {
								capturex_documentHeight = ownMax;
								capturex_contentEle = element;
							}
						}
					}
					else if (cs.transform && cs.transform != 'none' && capturex_documentHeight < window.innerHeight * 1.5) {
						// Regla 2 (transform): se preserva VERBATIM la condición original
						// element.parentElement.transform (propiedad inexistente → siempre
						// falsa) para no alterar el comportamiento histórico.
						if (element.parentElement.transform == 'none' && rect.top < winHalf && ownMax > capturex_documentHeight && (width > 500 || width > docW / 2)) {
							capturex_documentHeight = ownMax;
							capturex_contentEle = element;
						}
					}
				}
				const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
				try { console.log('[FEATURE_RUNTIME]', 'MaxHeightScan nodes=' + scan.contentCandidates.length + ' innerHtmlCalls=0 ms=' + ms); } catch (e) {}
				return scan.maxScroll;
			},
			captureVisibleOnly: function () {
				capturex_com_saveAction.reSetCaptureXData();
				capture_working = 1;

				capturex_documentHeight = window.innerHeight;
				capturex_documentHeight_o = window.innerHeight;
				capturex_onePageHeight = window.innerHeight;

				setTimeout(function () {						chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot", y1: 0, y2: 0 });
					}, 60); // PERF-09: 100 → 60 ms (rAF del SW ya estabiliza el frame)
			},
			captureAllPageScreenshot: function (nowTop = 0) {
				// Detectar PDF: render full-page vía pdf.js (offscreen document)
				// BUG_PDF_001: criterio amplio (contentType + blob con título .pdf), paridad con background
				if (document.contentType === 'application/pdf' || (/\.pdf($|[?#])/i).test(window.location.href) || (window.location.href.startsWith('blob:') && /\.pdf/i.test(document.title))) {
					console.info('[SQA] PDF detectado — capturando documento completo vía pdf.js');
					pdfRouteLog('detect-content', { match: document.contentType === 'application/pdf' ? 'content-type-pdf' : 'url-or-blob-pdf', route: 'pdfCaptureRequest' });
					capturex_com_saveAction.reSetCaptureXData();
					chrome.runtime.sendMessage({ action: 'pdfCaptureRequest' }, () => {});
					return;
				}
				// AUDIT_EXTWEB_REAL_PERF_001: inicio del stitching completo (se publica en splitSendImgData).
				try { window.__sqaPerfStitchStart = Date.now(); } catch (e) {}
				capturex_com_saveAction.reSetCaptureXData();
				capture_working = 1;
				capturex_fullpage = 1;

				const capturex_win_save_div = document.getElementById('capturex_win_save_div');
				if (capturex_win_save_div)
					document.body.removeChild(capturex_win_save_div);

				let scrollableElements = capturex_com_saveAction.findScrollableElements();

				var docHeight = Math.max(
					document.body.scrollHeight, document.documentElement.scrollHeight
				);
				
				// Elegir el mejor elemento para capturar
				let mainScrollableElement = null;
				let maxScrollContent = 0;
				
				// Si el documento principal tiene scroll significativo, es el candidato base
				if (docHeight > window.innerHeight + 100) {
					maxScrollContent = docHeight - window.innerHeight;
				}

				if (scrollableElements && scrollableElements.length > 0) {
					for (const element of scrollableElements) {
						const rect = element.getBoundingClientRect();
						const scrollContent = element.scrollHeight - element.clientHeight;
						
						// Priorizamos elementos que tengan más contenido "oculto" por scroll
						// y que ocupen un área razonable de la pantalla
						if (scrollContent > maxScrollContent && rect.width > window.innerWidth * 0.4 && rect.height > window.innerHeight * 0.4) {
							maxScrollContent = scrollContent;
							mainScrollableElement = element;
						}
					}
				}

				// PERF-05: iframes ya recolectados por el walk único (cero querySelectorAll).
				const preScanFrames = capturex_com_saveAction.preScanDocument().frames;
				try { console.log('[FEATURE_RUNTIME]', 'FrameScan merged=true candidates=' + preScanFrames.length); } catch (e) {}
				for (let i = 0; i < preScanFrames.length; i++) {
					const element = preScanFrames[i];
					const rect = _getCachedRect(element);
					if (rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.7 && !capturex_com_tools.iframeIsSameOrigin(element) && !capturex_com_tools.isElementOccluded(element)) {
						capturex_com_saveAction.captureSelectAllPageScreenshot(null, 1);
						return;
					}
				}

				if (mainScrollableElement) {
					if (mainScrollableElement.tagName == 'IFRAME' || mainScrollableElement.tagName == 'FRAME') {
						capturex_com_saveAction.captureSelectAllPageScreenshot(mainScrollableElement, 1, nowTop);
						return;
					}

					capturex_com_tools.isScrollLoadedElement(mainScrollableElement).then(isLazy => {
						if (!isLazy) {
							capturex_com_saveAction.captureSelectAllPageScreenshot(mainScrollableElement, 1, nowTop);
						} else {
							getFullPageAction(0);
						}
					});
				}
				else {
					capturex_scrollPosition = document.documentElement.scrollTop || document.body.scrollTop;
					getFullPageAction(nowTop == 0 ? 0 : capturex_scrollPosition);
				}

				function getFullPageAction(top = 0) {
					if (scrollableElements && scrollableElements.length > 0) {
						capturex_setChildScrollableHeight = 1;
						for (let i = scrollableElements.length - 1; i >= 0; i--) {
							capturex_com_saveAction.changStyleForFullShot(scrollableElements[i]);
						}
					}

					capturex_documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
					capturex_documentHeight_o = capturex_documentHeight;
					capturex_onePageHeight = window.innerHeight;

					// PERF-09: un solo timer de preparación (60/0 ms, antes 150/30 + dos
					// setTimeout anidados de 10 ms). La estabilidad real la dan los rAF
					// de sqaAfterFrameStable dentro de captureVisiblePageScreenshot.
					const prepareTime = (scrollableElements && scrollableElements.length > 0) ? 60 : 0;
					try { console.log('[FEATURE_RUNTIME]', 'PrepDelay ms=' + prepareTime + ' scrollables=' + ((scrollableElements && scrollableElements.length) || 0)); } catch (e) {}
					setTimeout(function () {
						if (top == 0) window.scrollTo({ top: 0 });
						if (capturex_setChildScrollableHeight == 1) capturex_com_saveAction.changStyleForFullShot(document.body);
						capturex_com_saveAction.changStyleForShot();
						capturex_com_saveAction.captureVisiblePageScreenshot(capturex_documentHeight, top, capturex_onePageHeight, 0, 0);
					}, prepareTime);
				}
			},
			captureSelectAllPageScreenshot: function (selectElement, fullPage, nowTop = 0) {

				capturex_com_saveAction.reSetCaptureXData();
				if (fullPage) capturex_fullpage = 1;
				if (selectElement) capturex_scrollableEles.push(selectElement);

				capture_working = 1;

				const capturex_win_save_div = document.getElementById('capturex_win_save_div');
				if (capturex_win_save_div)
					document.body.removeChild(capturex_win_save_div);

				var docHeight = Math.max(
					document.body.scrollHeight, document.documentElement.scrollHeight,
					document.body.offsetHeight, document.documentElement.offsetHeight,
					document.body.clientHeight, document.documentElement.clientHeight
				);
				var windowInnerHeight = window.innerHeight;
				capturex_documentWdith = document.documentElement.clientWidth;

				if (selectElement) {
					capturex_contentEle = selectElement;

					// Expandir otros elementos con scroll internos si es captura de página completa
					if (fullPage) {
						let scrollableElements = capturex_com_saveAction.findScrollableElements();
						scrollableElements.forEach(el => {
							if (el !== selectElement) {
								capturex_com_saveAction.changStyleForFullShot(el);
							}
						});
					}

					if ((capturex_contentEle.tagName == 'IFRAME' || capturex_contentEle.tagName == 'FRAME') && capturex_com_tools.iframeIsSameOrigin(capturex_contentEle)) {
						const iframeDocument = capturex_contentEle.contentDocument || capturex_contentEle.contentWindow.document;
						docHeight = iframeDocument.body.scrollHeight;
					}
					else {
						docHeight = Math.max(
							capturex_contentEle.scrollHeight,
							capturex_contentEle.offsetHeight,
							capturex_contentEle.clientHeight
						);
					}

					capturex_documentHeight = docHeight;
					capturex_documentHeight_o = capturex_documentHeight;

				}
				else {
					capturex_documentHeight = docHeight;

					// PERF-05: reglas de contenido sobre el snapshot del walk único
					// (un solo recorrido DOM; cero innerHTML).
					var _docHeight = capturex_com_saveAction.applyPreScanContentRules();
					if (capturex_contentEleIframe) {
						capture_working = 0;
						alert('No se pueden capturar iframes de diferente origen');
						chrome.runtime.sendMessage({ action: "openNewTab", url: capturex_contentEleIframe.src });
						return;
					}


					if (_docHeight && _docHeight > docHeight && capturex_contentEle) {
						docHeight = capturex_documentHeight;
					}
					else {
						capturex_contentEle = undefined;
					}
					capturex_documentHeight_o = capturex_documentHeight;
				}

				if (capturex_contentEle) {
					// Si es un elemento interno (no body/html), intentamos que esté visible en el viewport
					if (capturex_contentEle.tagName !== 'HTML' && capturex_contentEle.tagName !== 'BODY') {
						const r = capturex_contentEle.getBoundingClientRect();
						if (r.top < 0 || r.bottom > window.innerHeight) {
							window.scrollTo({
								top: window.scrollY + r.top - Math.max(0, (window.innerHeight - r.height) / 2),
								behavior: 'instant'
							});
						}
					}
					
					const rect_capturex_contentEle = capturex_contentEle.getBoundingClientRect();

					const computedStyle = window.getComputedStyle(capturex_contentEle);
					const borderLeftWidth = parseFloat(computedStyle.borderLeftWidth);
					const borderRightWidth = parseFloat(computedStyle.borderRightWidth);
					const borderTopWidth = parseFloat(computedStyle.borderTopWidth);
					const borderBottomWidth = parseFloat(computedStyle.borderBottomWidth);

					capturex_contentEleRectLeft = rect_capturex_contentEle.left + borderLeftWidth;
					capturex_contentEleRectTop = rect_capturex_contentEle.top + borderTopWidth;
					capturex_contentEleRectRight = rect_capturex_contentEle.right - borderRightWidth;
					capturex_contentEleRectBottom = rect_capturex_contentEle.bottom - borderBottomWidth;

					if (capturex_contentEleRectTop < 0)
						capturex_contentEle_over_top = Math.abs(capturex_contentEleRectTop);
					if (capturex_contentEleRectBottom > window.innerHeight)
						capturex_contentEle_over_bottom = capturex_contentEleRectBottom - window.innerHeight;

					if (capturex_contentEle_over_top > 0 || capturex_contentEle_over_bottom > 0) {
						docHeight = docHeight - capturex_contentEle_over_top - capturex_contentEle_over_bottom;
						capturex_documentHeight = docHeight;
						capturex_documentHeight_o = capturex_documentHeight;
					}
				}

				if (capturex_contentEle) {
					if (capturex_contentEle.tagName == 'IFRAME' || capturex_contentEle.tagName == 'FRAME') {
						const iframeDocument = capturex_contentEle.contentDocument || capturex_contentEle.contentWindow.document;
						capturex_scrollPosition = iframeDocument.documentElement.scrollTop;
						capturex_scrollbarWidth = capturex_com_tools.getScrollbarWidth2(capturex_contentEle);
					}
					else if (capturex_contentEle.style.transform) {
						capturex_scrollPosition = 0;
						capturex_com_saveAction.simulateScroll(0 - capturex_documentHeight, capturex_contentEle);
					}
					else {
						capturex_scrollPosition = capturex_contentEle.scrollTop;
						capturex_scrollbarWidth = capturex_com_tools.getScrollbarWidth2(capturex_contentEle);
					}
				}
				else {
					capturex_scrollPosition = document.documentElement.scrollTop || document.body.scrollTop;
				}


				var scrollPosition = window.scrollY || document.documentElement.scrollTop;
				if (scrollPosition > 0 && !selectElement) {
					window.scrollTo({ top: 0 });
				}

				capturex_onePageHeight = windowInnerHeight;
				if (capturex_contentEle) {
					capturex_onePageHeight = capturex_contentEle.clientHeight - capturex_contentEle_over_top - capturex_contentEle_over_bottom;
					if (capturex_onePageHeight < 0)
						capturex_onePageHeight = capturex_contentEle.clientHeight;

					if (capturex_onePageHeight >= 800)
						capturex_onePageOverlap = 80;
					else if (capturex_onePageHeight >= 600 && capturex_onePageHeight < 800)
						capturex_onePageOverlap = 50;
					else if (capturex_onePageHeight >= 400 && capturex_onePageHeight < 600)
						capturex_onePageOverlap = 30;
					else if (capturex_onePageHeight < 400)
						capturex_onePageOverlap = Math.max(10, Math.ceil(capturex_onePageHeight / 12) * 2);

					if (capturex_onePageHeight > windowInnerHeight || capturex_contentEle.style.transform) {
						let _rect = capturex_com_tools.getVisibleBoundingRect(capturex_contentEle)
						if (!_rect)
							_rect = capturex_contentEle.parentElement.getBoundingClientRect();
						capturex_onePageHeight = _rect.bottom - _rect.top - 200;
					}
				}
				else {
					if (capturex_com_tools.isVerticallyScrollable(document.documentElement)) {
					}
					else if (capturex_com_tools.isVerticallyScrollable(document.body)) {
						if (!document.body.classList.contains('capturex_temp_scroll_auto')) {
							document.body.classList.add('capturex_temp_scroll_auto');
							document.body.classList.add('capturex_temp_shot_noscrollbar');
						}
						document.body.scrollTop = 0;
					}
				}

				if (capturex_documentHeight > capturex_onePageHeight && capturex_scrollableEles.length == 0) {
					setTimeout(function () {
						capturex_com_saveAction.changStyleForShot();
						window.scrollTo({ top: 0 });
					}, 20);
				}

				if (capturex_contentEle) {
					capturex_contentEle.scrollTop = 0 - capturex_contentEle.scrollHeight;
					let measuredScrollTop = capturex_contentEle.scrollTop;
					if (measuredScrollTop < 0) {
						capturex_overScrollTop = Math.abs(measuredScrollTop);
					}
				}

				sqaAfterFrameStable(function () {
					if (nowTop > 0 && capturex_contentEle) {
						var fistTop = capturex_scrollPosition + capturex_overScrollTop;
						capturex_com_saveAction.captureVisiblePageScreenshot(capturex_documentHeight, fistTop, capturex_onePageHeight, 0, 0);
					}
					else
						capturex_com_saveAction.captureVisiblePageScreenshot(capturex_documentHeight, 0, capturex_onePageHeight, 0, 0);
				});
			},
				simulateScroll: function (deltaY, element, scrollTop) {
				const _o_style = window.getComputedStyle(capturex_contentEle);
				const transform_o = _o_style.transform;

				// TEMPORAL AISLAMIENTO: WheelEvent sintético deshabilitado para confirmar disparador del diálogo
				// BEFORE: const event = new WheelEvent("wheel",{deltaY,bubbles:true,cancelable:true,view:window}); element.dispatchEvent(event);
				try{ permTrace('simulateScroll:Before DOM modification', {deltaY, tag:element?.tagName, hasTransform:!!transform_o}); }catch{}
				// const event = new WheelEvent("wheel", { deltaY: deltaY, bubbles: false, cancelable: false, view: window });
				// element.dispatchEvent(event);
				try{ permTrace('simulateScroll:After DOM modification', {dispatched:true}); }catch{}

				setTimeout(() => {
					const _n_style = window.getComputedStyle(capturex_contentEle);
					const transform_n = _n_style.transform;
					if (transform_o == transform_n) {
						const _style = window.getComputedStyle(capturex_contentEle);
						const transform = _style.transform;
						const matrix = transform.match(/^matrix\((.+)\)$/);
						if (matrix) {
							const values = matrix[1].split(', ');
							const translateY = scrollTop;
							capturex_contentEle.style.transform = `matrix(${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${values[4]}, -${translateY})`;
						}
					}
				}, 80);
			},
			getPageClientHeight: function () {
				let pageClientHeight = window.innerHeight;
				if (capturex_contentEle) {
					pageClientHeight = capturex_contentEle.clientHeight;
				}
				return pageClientHeight;
			},
			getPageScrollTop: function () {
				if (capturex_contentEle) {
					if (capturex_contentEle.tagName == 'IFRAME' || capturex_contentEle.tagName == 'FRAME') {
						const iframeWindow = capturex_contentEle.contentWindow;
						const scrollTop = iframeWindow.pageYOffset || iframeWindow.document.documentElement.scrollTop || iframeWindow.document.body.scrollTop;
						return scrollTop;
					}
					else {
						return capturex_contentEle.scrollTop;
					}
				}
				else {
					if (document.body && document.body.classList.contains('capturex_temp_scroll_auto')) {
						return document.body.scrollTop;
					}
					else {
						if (document.documentElement.scrollTop == 0 && document.body.scrollTop > 0)
							return document.body.scrollTop;
						else
							return window.pageYOffset || document.documentElement.scrollTop;
					}
				}
			},
			scrollTopForCapture: function (scrollTop) {
				// STITCH_DUPLICATED_VIEWPORT_REGRESSION_001 (H1): forzar scroll INSTANT.
				// window.scrollTo({top}) respeta el CSS scroll-behavior:smooth del sitio
				// (AvalPay) y anima ~300-500ms: la captura salia con el frame anterior.
				// behavior:'instant' + asignacion directa = doble garantia, sin sleeps.
				if (capturex_contentEle) {
					if (capturex_contentEle.tagName == 'IFRAME' || capturex_contentEle.tagName == 'FRAME') {
						const iframeWindow = capturex_contentEle.contentWindow;
						try { iframeWindow.scrollTo({ top: scrollTop, left: 0, behavior: 'instant' }); } catch (e) { try { iframeWindow.scrollTo(0, scrollTop); } catch (e2) {} }
						try { iframeWindow.document.documentElement.scrollTop = scrollTop; } catch (e) {}
						try { iframeWindow.document.body.scrollTop = scrollTop; } catch (e) {}
					}
					else {
						if (capturex_contentEle.style.transform) {
							capturex_com_saveAction.simulateScroll(scrollTop - capturex_contentPageCrollTop, capturex_contentEle, scrollTop);
						}
						else {
							capturex_contentEle.scrollTop = scrollTop - capturex_overScrollTop;
						}
					}
				}
				else {
					if (document.body && document.body.classList.contains('capturex_temp_scroll_auto')) {
						document.body.scrollTop = scrollTop;
					}
					else {
						try { window.scrollTo({ top: scrollTop, left: 0, behavior: 'instant' }); } catch (e) { try { window.scrollTo({ top: scrollTop, left: 0, behavior: 'auto' }); } catch (e2) { window.scrollTo(0, scrollTop); } }
						try { document.documentElement.scrollTop = scrollTop; } catch (e) {}
						try { document.body.scrollTop = scrollTop; } catch (e) {}
					}
				}
			},
			captureVisiblePageScreenshot: function (docHeight, scrollTop, windowInnerHeight, _y1, _y2) {
				// STITCH_DUPLICATED_VIEWPORT_REGRESSION_001: instrumentación por viewport
				const vpIndex0 = capturex_capture_array.length;
				try { console.log('[FEATURE_RUNTIME]', 'ViewportTarget index=' + vpIndex0 + ' targetY=' + scrollTop + ' docHeight=' + docHeight); } catch (e) {}
			// Skip if already captured at this scroll position
			if (capturex_capturedScrollTops && capturex_capturedScrollTops.has(scrollTop)) { try { console.log('[FEATURE_RUNTIME]', 'ViewportSkippedRepeatTarget index=' + vpIndex0 + ' targetY=' + scrollTop); } catch (e) {} return; }
				if (capturex_capturedScrollTops) capturex_capturedScrollTops.add(scrollTop);

				capturex_contentPageCrollTop = scrollTop;
				capturex_preRealPageCrollTop = capturex_com_saveAction.getPageScrollTop();
				capturex_com_saveAction.scrollTopForCapture(scrollTop);
				var self = this;

				function waitForFrame(cb) { requestAnimationFrame(function(){ setTimeout(cb, 0); }); }

				// PERF_CAPTURE_FULL_001 D1 + PERF-09 + STITCH_DUPLICATED_VIEWPORT_REGRESSION_001:
				// la estabilización (sqaAfterFrameStable) y la verificación post-scroll
				// (sqaAfterScrollApplied) viven a nivel de módulo; la copia local que estaba
				// aquí dejaba a captureSelectAllPageScreenshot con una referencia huérfana.
				function afterScroll() {
					capturex_com_saveAction.changStyleForShot(capturex_contentEle);
					capturex_nowRealPageCrollTop = capturex_com_saveAction.getPageScrollTop();
					afterStyles();
				}

				function afterStyles() {
					var newDocHeight = capturex_com_saveAction.getNewDocHeight();

					if (newDocHeight > docHeight) {
						docHeight = newDocHeight;
						capturex_documentHeight = docHeight;
						if (!capturex_contentEle && capturex_setChildScrollableHeight == 1)
							capturex_com_saveAction.changStyleForFullShot(document.body);
					}
					else if (newDocHeight < docHeight) {
						let reduceHeight = docHeight - newDocHeight;
						docHeight = newDocHeight;
						capturex_documentHeight = docHeight;
						if (scrollTop > 0 && (scrollTop - reduceHeight) > 0) {
							if (!capturex_contentEle && capturex_setChildScrollableHeight == 1)
								capturex_com_saveAction.changStyleForFullShot(document.body);
							scrollTop = scrollTop - reduceHeight;
							capturex_contentPageCrollTop = scrollTop;
							capturex_com_saveAction.scrollTopForCapture(scrollTop);
						}
					}

					let pageClientHeight = capturex_com_saveAction.getPageClientHeight();
					if (capture_working == 0) {
						sqaAfterFrameStable(function () {
							var y1 = 0, y2 = 0;
							if (scrollTop > 0) {
								y1 = capturex_onePageHeight - (capturex_nowRealPageCrollTop - capturex_preRealPageCrollTop) - Math.floor(capturex_onePageOverlap / 2);
								y2 = capturex_onePageHeight;
							}
							sqaAfterScrollApplied(scrollTop, vpIndex0, function () {
								chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot", y1: y1, y2: y2 });
							});
						});
					}
					else if ((scrollTop + pageClientHeight) < docHeight && scrollTop < capturex_capture_max_height) {
						var nextScrollTop = scrollTop + capturex_onePageHeight - capturex_onePageOverlap;
						var nextPageData = { docHeight: docHeight, nextScrollTop: nextScrollTop, windowInnerHeight: capturex_onePageHeight, y1: 0, y2: 0 };
						sqaAfterFrameStable(function () {
							capturex_com_saveAction.scrollTopForCapture(scrollTop);
							sqaAfterScrollApplied(scrollTop, vpIndex0, function () {
								chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot", y1: _y1, y2: _y2, nextPageData: nextPageData });
							});
						});
					}
					else {
						sqaAfterFrameStable(function () {
							capturex_com_saveAction.scrollTopForCapture(scrollTop);
							sqaAfterFrameStable(function () {
								let _newDocHeight = capturex_com_saveAction.getNewDocHeight();
								if (_newDocHeight > docHeight) {
									docHeight = _newDocHeight;
									capturex_documentHeight = docHeight;
								}
								if ((scrollTop + pageClientHeight) < docHeight && scrollTop < capturex_capture_max_height) {
									var nextScrollTop = scrollTop + capturex_onePageHeight - capturex_onePageOverlap;
									var nextPageData = { docHeight: docHeight, nextScrollTop: nextScrollTop, windowInnerHeight: capturex_onePageHeight, y1: 0, y2: 0 };
									sqaAfterScrollApplied(scrollTop, vpIndex0, function () {
										chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot", y1: _y1, y2: _y2, nextPageData: nextPageData });
									});
								}
								else {
									if ((scrollTop + pageClientHeight) < docHeight) capturex_capture_truncated = true;
									capturex_nowRealPageCrollTop = capturex_com_saveAction.getPageScrollTop();
									var y1 = 0, y2 = 0;
									if (scrollTop > 0) {
										y1 = capturex_onePageHeight - (capturex_nowRealPageCrollTop - capturex_preRealPageCrollTop) - Math.floor(capturex_onePageOverlap / 2);
										y2 = capturex_onePageHeight;
										if (y1 < 0) y1 = 0;
									}
									sqaAfterScrollApplied(scrollTop, vpIndex0, function () {
										chrome.runtime.sendMessage({ action: "captureVisiblePageScreenshot", y1: y1, y2: y2 });
									});
								}
							});
						});
					}
				}

				if (scrollTop > 0) { waitForFrame(afterScroll); } else { afterStyles(); }
			},
			showTip: function (txt) {
				var capturex_win_tip_div = document.createElement("div");
				capturex_win_tip_div.id = "capturex_win_tip_div";

				var tipDiv = document.createElement("div");
				tipDiv.style.cssText = "z-index: 2147483647; width: auto; height: auto; position:fixed; top:50%; left:50%; transform: translate(-50%, -50%); background-color: #000; opacity:0.7; padding: 10px 15px 10px 15px; border-radius: 4px; text-align: center; font-size:20px; color:#fff;";
				tipDiv.innerText = txt;

				capturex_win_tip_div.appendChild(tipDiv);
				document.body.appendChild(capturex_win_tip_div);
				setTimeout(function () {
					document.body.removeChild(document.getElementById('capturex_win_tip_div'));
				}, 1500);
			},
			setStyleForShot: function (element, className, styleText) {
				if (element.classList.toString().indexOf('capturex_temp_shot') == -1) {
					element.setAttribute('capturex_o_style', element.style.cssText);
				}

				let o_style = element.style.cssText;
				if (element.hasAttribute('capturex_o_style'))
					o_style = element.getAttribute('capturex_o_style');

				if (element.classList.toString().indexOf(className) == -1) {
					element.classList.add(className);
				}
				element.style.cssText = o_style + ';' + styleText;
			},
			changStyleForFullShot: function (element, minHeight) {
				let elementHeight = element.scrollHeight;
				if (minHeight && minHeight > 0 && elementHeight < minHeight)
					elementHeight = minHeight;

				var body_styleContent_class = 'capturex_temp_shot_body';
				var body_styleContent = 'transform: translateZ(0px); min-height: ' + capturex_documentHeight + 'px !important; overflow: hidden !important; position: absolute; top: 0px; left: 0px; right: 0px;';

				var item_styleContent_class = 'capturex_temp_shot_item';
				var item_styleContent = 'overflow-y: visible; min-height: ' + elementHeight + 'px !important;';
				if (minHeight && minHeight > 0)
					item_styleContent = 'min-height: ' + elementHeight + 'px !important;';
				if (element.tagName == 'BODY' || element.tagName == 'HTML') {
					capturex_com_saveAction.setStyleForShot(document.body, body_styleContent_class, body_styleContent);
				}
				else {
					capturex_com_saveAction.setStyleForShot(element, item_styleContent_class, item_styleContent);
					let parentElement = element.parentElement;
					if (parentElement && parentElement.tagName != 'BODY') {
						const elementStyle = window.getComputedStyle(parentElement);
						if (elementStyle.position == 'static' || elementStyle.position == 'relative')
							capturex_com_saveAction.changStyleForFullShot(parentElement, elementHeight);
						else if (elementStyle.position == 'absolute') {
							let rect = parentElement.getBoundingClientRect();
							if (rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.7) {
								capturex_com_saveAction.changStyleForFullShot(parentElement, elementHeight);
							}
						}
					}
				}
			},
			changStyleForShot: function (contentElement) {
				// SQA StylesManager: comprehensive fixed/sticky/transition handling
				const SM = window.__sqaStylesManager;
				if (SM) {
					// PERF-01: primer viewport de la captura → estado limpio garantizado
					// (protege contra capturas abortadas sin restoreAll).
					if (capturex_changStyleForShotTimes === 0 && SM.beginCapture) SM.beginCapture();
					SM.init();
					const fullH = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
					const fullW = Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement.scrollWidth);
					SM.updateFixed(fullH, fullW, capturex_capture_array.length === 0);
					// REGRESSION_001: trazabilidad del ajuste sticky por viewport
					try { const _sc = (typeof SM._getClassificationCache === 'function') ? SM._getClassificationCache() : null; console.log('[FEATURE_RUNTIME]', 'StickyAdjustment index=' + capturex_capture_array.length + ' value=' + ((_sc && _sc.stickyElts) ? _sc.stickyElts.length : 'n/a')); } catch (e) {}
					capturex_changStyleForShotTimes++;
					return;
				}
				// Fallback: original approach

				// Micro‑opt: hint browser for smoother scroll repaint
				if (document.body) document.body.style.willChange = 'transform';

				var fixed_styleContent_class = 'capturex_temp_shot_fixed';
				var fixed_styleContent = 'opacity:0 !important;z-index: -1 !important; animation: unset !important; transition-duration: 0s !important;';

				var fixed2absolute_styleContent_class = 'capturex_temp_shot_fixed2absolute';
				var fixed2absolute_styleContent = 'position: absolute !important; transition: none !important;';

				var sticky_styleContent_class = 'capturex_temp_shot_sticky';
				var sticky_styleContent = 'position:relative !important; inset: auto !important;';

				var content_styleContent_class = 'capturex_temp_shot_content';
				var content_styleContent = 'overflow-x: hidden !important; overflow-y: auto; z-index: 2147483647 !important;opacity:1 !important;';

				var html_styleContent_class = 'capturex_temp_shot_html';
				var html_styleContent = 'scrollbar-width: none; scroll-behavior: unset !important;';

				var styleTag = document.getElementById('capturex_temp_shot');
				if (!styleTag) {
					var styleTag = document.createElement('style');
					styleTag.id = 'capturex_temp_shot';

					var _capturex_temp_shot_noscrollbar = '.capturex_temp_shot_noscrollbar {scrollbar-width: none;} .capturex_temp_shot_noscrollbar::-webkit-scrollbar {display: none;}';
					styleTag.appendChild(document.createTextNode(_capturex_temp_shot_noscrollbar));

					var _fixed_styleContent = '.capturex_temp_shot_fixed {opacity:0 !important;z-index: -1 !important; animation: unset !important; transition-duration: 0s !important;}';
					styleTag.appendChild(document.createTextNode(_fixed_styleContent));

					var _fixed2absolute_styleContent = '.capturex_temp_shot_fixed2absolute {position: absolute !important; transition: none !important;}';
					styleTag.appendChild(document.createTextNode(_fixed2absolute_styleContent));

					var _sticky_styleContent = '.capturex_temp_shot_sticky {position:relative !important; inset: auto !important;}';
					styleTag.appendChild(document.createTextNode(_sticky_styleContent));

					var _content_styleContent = '.capturex_temp_shot_content {overflow-x: hidden !important; overflow-y: auto; z-index: 2147483647 !important;opacity:1 !important; scroll-behavior:auto !important;}';
					styleTag.appendChild(document.createTextNode(_content_styleContent));

					var _hide_styleContent = '.capturex_temp_shot_hide {opacity:0 !important;z-index: -1 !important;}';
					styleTag.appendChild(document.createTextNode(_hide_styleContent));

					document.head.appendChild(styleTag);

					var htmlElement = document.documentElement;
					capturex_com_saveAction.setStyleForShot(htmlElement, html_styleContent_class, html_styleContent);
				}

				if (contentElement) {
					capturex_com_saveAction.setStyleForShot(contentElement, content_styleContent_class, content_styleContent);
				}

				// PERF-01 FASE 5: NADA de querySelectorAll(':not(...)') + getComputedStyle
				// por viewport. La lista de candidatos (sticky/fixed/absolute) se clasifica
				// UNA vez por captura y aquí solo se re-evalúa el estado ACTUAL de esos
				// pocos candidatos (los ya procesados se saltan dentro de setStyleForShot).
				const elements = _classifyOnceForFallback();

				for (let i = 0, len = elements.length; i < len; i++) {
					const element = elements[i].el;
					const elementStyle = window.getComputedStyle(element);
					if (elementStyle.position === 'sticky') {
						capturex_com_saveAction.setStyleForShot(element, sticky_styleContent_class, sticky_styleContent);
					}
					else if (elementStyle.position === 'fixed' && !capturex_com_tools.isInElement(element, capturex_contentEle)) {
						if (capturex_capture_array.length == 0) {
							let rect = _getCachedRect(element);
							if (rect.top > 200 && ((rect.left > window.innerWidth * 1 / 4 && rect.left < window.innerWidth * 3 / 4) || rect.width > window.innerWidth / 4)) {
								capturex_com_tools.withoutInlineStyleImportant(element);
								capturex_com_saveAction.setStyleForShot(element, fixed_styleContent_class, fixed_styleContent);
							}
							else if (element.parentElement && element.parentElement.tagName.toLowerCase() == 'html' && element.classList.toString().indexOf('adsbygoogle') > -1) {
								capturex_com_tools.withoutInlineStyleImportant(element);
								capturex_com_saveAction.setStyleForShot(element, fixed_styleContent_class, fixed_styleContent);
							}
						}
						else if (capturex_capture_array.length == 1) {
							let rect = _getCachedRect(element);

							if (rect.top < 100 && rect.height > 300 && rect.width > 100) {
								capturex_com_tools.withoutInlineStyleImportant(element);
								capturex_com_saveAction.setStyleForShot(element, fixed2absolute_styleContent_class, fixed2absolute_styleContent);
							}
							else {
								capturex_com_tools.withoutInlineStyleImportant(element);
								capturex_com_saveAction.setStyleForShot(element, fixed_styleContent_class, fixed_styleContent);
							}
						}
						else {
							element.classList.remove('capturex_temp_shot_fixed2absolute');
							capturex_com_tools.withoutInlineStyleImportant(element);
							capturex_com_saveAction.setStyleForShot(element, fixed_styleContent_class, fixed_styleContent);
						}
					}
				}
				capturex_changStyleForShotTimes++;
			},
			restoreStyleForShot: function () {
				capturex_com_saveAction.scrollTopForCapture(capturex_scrollPosition);
				capturex_changStyleForShotTimes = 0;
				_clearBBoxCache();
				// PERF-01 FASE 5: libera la clasificación única del fallback.
				_resetFallbackClassification();
				// SQA StylesManager: restore all overrides
				const SM = window.__sqaStylesManager;
				if (SM) {
					SM.restoreAll();
				}
				// Fallback: original approach
				capturex_com_saveAction.scrollTopForCapture(capturex_scrollPosition);
				capturex_changStyleForShotTimes = 0;
				_clearBBoxCache();
				if (document.body) document.body.style.willChange = '';

				document.documentElement.classList.remove('capturex_temp_scroll_auto');
				document.body.classList.remove('capturex_temp_scroll_auto');

				const shotClasses = ['capturex_temp_shot_body','capturex_temp_shot_item','capturex_temp_shot_html','capturex_temp_shot_content','capturex_temp_shot_noscrollbar','capturex_temp_shot_noscrollbar_x','capturex_temp_shot_fixed','capturex_temp_shot_fixed2absolute','capturex_temp_shot_sticky'];
				const all = document.querySelectorAll('[class*="capturex_temp_shot"]');
				for (let i = 0, len = all.length; i < len; i++) {
					const element = all[i];
					for (let j = 0; j < shotClasses.length; j++) {
						if (element.classList.contains(shotClasses[j])) {
							element.classList.remove(shotClasses[j]);
						}
					}
					if (element.hasAttribute('capturex_o_style')) {
						element.style.cssText = element.getAttribute('capturex_o_style');
						element.removeAttribute('capturex_o_style');
					}
				}

				var styleTag = document.getElementById('capturex_temp_shot');
				if (styleTag)
					styleTag.remove();
			},
			splicingImagesAndSendAction: function (imageWidth, imageHeight, y1, y2) {
				if (capturex_capture_array_splicing_index > 0) {
					capturex_com_saveAction.splicingImagesAarrayLast(imageWidth, imageHeight, y1, y2)
						.then(mergedImage => {
							capturex_snap_mergedImage_array.push(mergedImage);
							capturex_snap_mergedImage_index++;

							if (capturex_capture_array_splicing_index < (capturex_capture_array.length - 1)) {
								capturex_com_saveAction.splicingImagesAndSendAction(imageWidth, imageHeight, y1, y2);
							}
							else {
								capturex_com_saveAction.splitSendImgData();
							}
						})
						.catch(error => {
							console.error('Error merging images ' + capturex_snap_mergedImage_index, error);
							chrome.runtime.sendMessage({ action: "captureError", message: "Error al fusionar imágenes (Último): " + error.message });
						});
				}
				else {
					capturex_com_saveAction.splicingImagesAarray(imageWidth, imageHeight, y1, y2)
						.then(mergedImage => {
							capturex_snap_mergedImage_array.push(mergedImage);

							capturex_snap_mergedImage_index++;

							if (capturex_capture_array_splicing_index < (capturex_capture_array.length - 1)) {
								capturex_com_saveAction.splicingImagesAndSendAction(imageWidth, imageHeight, y1, y2);
							}
							else {
								capturex_com_saveAction.splitSendImgData();
							}
						})
						.catch(error => {
							console.error('Error merging images ' + capturex_snap_mergedImage_index, error);
							chrome.runtime.sendMessage({ action: "captureError", message: "Error al fusionar imágenes (Base): " + error.message });
						});
				}
			},
			splicingImagesAarray: async function (width, height, y1, y2) {

				// ----- HEADER PATCH -----
				let HEADER_HEIGHT = 100;
				// ----- FIN HEADER PATCH -----

				let totalWidth = width;
				let n_y = 0;
				if (y1 > 0 && y2 > 0) n_y = Math.floor(height / y2 * y1);

				let totalHeight = 0;
				let end_index = capturex_capture_array.length - 1;
				if (capturex_capture_array_height && capturex_capture_array_height.length > 0) {
					let last_height = capturex_capture_array_height[capturex_capture_array_height.length - 1];
					if (y1 > 0 && y2 > 0) n_y = Math.floor(last_height / y2 * y1);

					totalHeight = 0;
					capturex_capture_array_height.forEach(function (number) {
						totalHeight += number;
					});
					if (y1 > 0 && y2 > 0)
						totalHeight = totalHeight - n_y;
				}
				else {
					totalHeight = height * (capturex_capture_array.length - 1) + (height - n_y);
				}
				capturex_com_saveAction.setCanvasMaxHeight(width);

				if (totalHeight > capturex_canvas_browserMaxHeight) {
					capturex_capture_truncated = true;
					var _totalHeight = 0;
					// PERF-06: prefijos acumulados (O(N) en vez de O(N²)).
					const _prefixA = buildHeightPrefix(capturex_capture_array_height);
					for (let i = 0; i < capturex_capture_array.length; i++) {
						let dtotalHeight = 0;
						if (_prefixA)
							dtotalHeight = _prefixA[i] + capturex_capture_array_height[i];
						else
							dtotalHeight = (i + 1) * height;
						if (dtotalHeight > capturex_canvas_browserMaxHeight)
							break;
						else {
							end_index = i;
							_totalHeight = dtotalHeight;
						}
					}
					totalHeight = _totalHeight;
					if (end_index == capturex_capture_array.length - 2) {
						if (capturex_capture_array_height && capturex_capture_array_height.length > 0)
							totalHeight = totalHeight - capturex_capture_array_height[end_index];
						else
							totalHeight = end_index * height;
						end_index = end_index - 1;
					}
				}

				var zoomLevel = window.devicePixelRatio;
				if (capturex_capture_top || capturex_capture_bottom || capturex_capture_right || capturex_capture_left)
					totalWidth = window.innerWidth * zoomLevel;

				if (capturex_capture_top) totalHeight = totalHeight + capturex_contentEleRectTop * zoomLevel;
				if (capturex_capture_bottom && capturex_capture_array.length > 1 && end_index == capturex_capture_array.length - 1)
					totalHeight = totalHeight + (window.innerHeight - capturex_contentEleRectBottom) * zoomLevel;

				// =========== CREA EL CANVAS FINAL (AÑADE HEADER)
				const tempCanvas = document.createElement('canvas');
				const tempCtx = tempCanvas.getContext('2d');
				tempCtx.font = "600 20px Segoe UI, Roboto, sans-serif";
				const urlLines = wrapTextAnywhere(tempCtx, "URL: " + window.location.href, totalWidth - 155);
				HEADER_HEIGHT = 100 + (urlLines.length - 1) * 24;

				const canvasWrapper = createUniversalCanvas(totalWidth, totalHeight + HEADER_HEIGHT);
				let canvas = canvasWrapper.canvas;
				const context = canvasWrapper.context;
				const evId = await fetchNextEvidenceId();
				await drawEvidenceHeader(context, canvas.width, HEADER_HEIGHT, evId);

				// Fondo blanco debajo:
				context.save();
				context.fillStyle = "#fff";
				context.fillRect(0, HEADER_HEIGHT, canvas.width, canvas.height - HEADER_HEIGHT);
				context.restore();

				let top_image_height = 0;
				if (capturex_capture_top) {
					const image = new Image();
					const objectUrlTop = capturex_capture_top instanceof Blob ? URL.createObjectURL(capturex_capture_top) : capturex_capture_top;
					image.src = objectUrlTop;
					await new Promise(resolve => {
						image.onload = () => {
							if (capturex_capture_top instanceof Blob) URL.revokeObjectURL(objectUrlTop);
							top_image_height = image.naturalHeight;
							context.drawImage(image, 0, HEADER_HEIGHT, image.naturalWidth, image.naturalHeight);
							resolve();
						};
					});
				}
				let left_image_width = 0;
				if (capturex_capture_left) {
					const image = new Image();
					const objectUrlLeft = capturex_capture_left instanceof Blob ? URL.createObjectURL(capturex_capture_left) : capturex_capture_left;
					image.src = objectUrlLeft;
					await new Promise(resolve => {
						image.onload = () => {
							if (capturex_capture_left instanceof Blob) URL.revokeObjectURL(objectUrlLeft);
							left_image_width = image.naturalWidth;
							let dheight = 0;
							if (capturex_contentEleRectBottom < window.innerHeight)
								dheight = (window.innerHeight - capturex_contentEleRectBottom) * zoomLevel;
							context.drawImage(image, 0, HEADER_HEIGHT, image.naturalWidth, image.naturalHeight - dheight, 0, HEADER_HEIGHT, image.naturalWidth, image.naturalHeight - dheight);
							resolve();
						};
					});
				}
				if (capturex_capture_right) {
					const image = new Image();
					const objectUrlRight = capturex_capture_right instanceof Blob ? URL.createObjectURL(capturex_capture_right) : capturex_capture_right;
					image.src = objectUrlRight;
					await new Promise(resolve => {
						image.onload = () => {
							if (capturex_capture_right instanceof Blob) URL.revokeObjectURL(objectUrlRight);
							let dheight = 0;
							if (capturex_contentEleRectBottom < window.innerHeight)
								dheight = (window.innerHeight - capturex_contentEleRectBottom) * zoomLevel;
							context.drawImage(image, 0, HEADER_HEIGHT, image.naturalWidth, image.naturalHeight - dheight, totalWidth - image.naturalWidth, HEADER_HEIGHT, image.naturalWidth, image.naturalHeight - dheight);
							resolve();
						};
					});
				}

				// PERF-02/MEM-01: Bitmap Streaming — antes `Promise.all` decodificaba TODOS
				// los cortes a la vez (≈18 MB/página a DPR 2 → pico >500 MB en 30 páginas).
				// Ahora una ventana deslizante mantiene ≤4 bitmaps vivos, dibuja en orden
				// y hace close() inmediato tras drawImage(). Resultado visual idéntico.
				const endIdx = Math.min(end_index, capturex_capture_array.length - 1);
				const sources = new Array(endIdx + 1);
				for (let k = 0; k <= endIdx; k++) sources[k] = capturex_capture_array[k];					// PERF-06: prefijos acumulados (O(N) en vez de O(N²) por página).
					const _prefixC = buildHeightPrefix(capturex_capture_array_height);
					await decodeBitmapStreaming(sources, async (image, i) => {
						capturex_capture_array_splicing_index = i;
						if (i == (capturex_capture_array.length - 1) && y1 > 0 && y2 > 0) {
							if (_prefixC) {
								context.drawImage(image, 0, n_y, width, capturex_capture_array_height[i] - n_y, 0 + left_image_width, _prefixC[i] + top_image_height + HEADER_HEIGHT, width, capturex_capture_array_height[i] - n_y);
								try { console.log('[FEATURE_RUNTIME]', 'StitchDraw index=' + i + ' drawY=' + Math.round(_prefixC[i] + top_image_height + HEADER_HEIGHT) + ' h=' + Math.round(capturex_capture_array_height[i] - n_y) + ' mode=last-ny'); } catch (e) {}
							}
							else {
								context.drawImage(image, 0, n_y, width, height - n_y, 0 + left_image_width, height * i + top_image_height + HEADER_HEIGHT, width, height - n_y);
							}
						}
						else {
							if (_prefixC) {
								context.drawImage(image, 0 + left_image_width, _prefixC[i] + top_image_height + HEADER_HEIGHT, width, capturex_capture_array_height[i]);
								try { console.log('[FEATURE_RUNTIME]', 'StitchDraw index=' + i + ' drawY=' + Math.round(_prefixC[i] + top_image_height + HEADER_HEIGHT) + ' h=' + Math.round(capturex_capture_array_height[i])); } catch (e) {}
							}
						else {
							context.drawImage(image, 0 + left_image_width, i * height + top_image_height + HEADER_HEIGHT, width, height);
						}
					}
				});
				if (capturex_capture_bottom && capturex_capture_array_splicing_index == (capturex_capture_array.length - 1)) {
					const image = new Image();
					const objectUrlBottom = capturex_capture_bottom instanceof Blob ? URL.createObjectURL(capturex_capture_bottom) : capturex_capture_bottom;
					image.src = objectUrlBottom;
					await new Promise(resolve => {
						image.onload = () => {
							if (capturex_capture_bottom instanceof Blob) URL.revokeObjectURL(objectUrlBottom);
							left_image_width = image.naturalWidth;
							context.drawImage(image, 0, (canvas.height - image.naturalHeight), image.naturalWidth, image.naturalHeight);
							resolve();
						};
					});
				}
				// ================ FIN HEADER

				return new Promise(resolve => {
					canvasWrapper.toBlob(blob => {
						resolve(blob);
					}, 'image/png');
					// Help GC by nullifying canvas reference
					canvas = null;
				});
			}, // <-- NO OLVIDES la coma si hay más métodos abajo en el objeto

			splicingImagesAarrayLast: async function (width, height, y1, y2) {
				let start_index = capturex_capture_array_splicing_index + 1;
				let totalWidth = width;

				let n_y = 0;
				if (y1 > 0 && y2 > 0) n_y = Math.floor(height / y2 * y1);

				let totalHeight = 0;
				let end_index = capturex_capture_array.length - 1;
				if (capturex_capture_array_height && capturex_capture_array_height.length > 0) {
					let last_height = capturex_capture_array_height[capturex_capture_array_height.length - 1];
					if (y1 > 0 && y2 > 0) n_y = Math.floor(last_height / y2 * y1);

					totalHeight = 0;
					for (var i = start_index; i < capturex_capture_array_height.length; i++) {
						totalHeight += capturex_capture_array_height[i];
					}
					if (y1 > 0 && y2 > 0)
						totalHeight = totalHeight - n_y;
				}
				else {
					totalHeight = height * ((capturex_capture_array.length - start_index) - 1) + (height - n_y);
				}

				if (totalHeight > capturex_canvas_browserMaxHeight) {
					capturex_capture_truncated = true;
					var _totalHeight = 0;
					// PERF-06: prefijos acumulados relativos a start_index (O(N) en vez de O(N²)).
					const _hB = capturex_capture_array_height;
					const _prefixB = (_hB && _hB.length > 0 && start_index < _hB.length)
						? buildHeightPrefix(_hB.slice(start_index)) : null;
					for (let i = start_index; i < capturex_capture_array.length; i++) {
						let dtotalHeight = 0;
						if (_prefixB)
							dtotalHeight = _prefixB[i - start_index] + capturex_capture_array_height[i];
						else
							dtotalHeight = (i - start_index + 1) * height;

						if (dtotalHeight > capturex_canvas_browserMaxHeight) {
							break;
						}
						else {
							end_index = i;
							_totalHeight = dtotalHeight;
						}
					}
					totalHeight = _totalHeight;
				}

				var zoomLevel = window.devicePixelRatio;
				if (capturex_capture_top || capturex_capture_bottom || capturex_capture_right || capturex_capture_left)
					totalWidth = window.innerWidth * zoomLevel;

				if (capturex_capture_bottom && capturex_capture_array.length > 1 && end_index == capturex_capture_array.length - 1) {
					totalHeight = totalHeight + (window.innerHeight - capturex_contentEleRectBottom) * zoomLevel;
				}

				let left_image_width = 0;
				if (capturex_capture_left) {
					left_image_width = capturex_contentEleRectLeft * zoomLevel;
				}

				const canvasWrapper = createUniversalCanvas(totalWidth, totalHeight);
				let canvas = canvasWrapper.canvas;
				const context = canvasWrapper.context;
				let bgColor = 'rgb(255, 255, 255)';
				if (document.body) bgColor = window.getComputedStyle(document.body).backgroundColor;
				if (bgColor == 'rgba(0, 0, 0, 0)' || bgColor == 'transparent') bgColor = 'rgb(255, 255, 255)';
				context.fillStyle = bgColor;
				context.fillRect(0, 0, canvas.width, canvas.height);

				// PERF-02/MEM-01: mismo streaming con ventana deslizante (≤4 bitmaps vivos,
				// close() inmediato tras cada drawImage).
				const endIdx2 = Math.min(end_index, capturex_capture_array.length - 1);
				const sources2 = new Array(endIdx2 - start_index + 1);
				for (let k = start_index; k <= endIdx2; k++) sources2[k - start_index] = capturex_capture_array[k];
				// PERF-06: prefijos acumulados relativos a start_index (O(N) en vez de O(N²)).
				const _hD = capturex_capture_array_height;
				const _prefixD = (_hD && _hD.length > 0 && start_index < _hD.length)
					? buildHeightPrefix(_hD.slice(start_index)) : null;
				await decodeBitmapStreaming(sources2, async (image, idx) => {
					const i = start_index + idx;
					capturex_capture_array_splicing_index = i;
					if (i == (capturex_capture_array.length - 1) && y1 > 0 && y2 > 0) {
						if (_prefixD) {
							context.drawImage(image, 0, n_y, width, capturex_capture_array_height[i] - n_y, 0 + left_image_width, _prefixD[idx], width, capturex_capture_array_height[i] - n_y);
							try { console.log('[FEATURE_RUNTIME]', 'StitchDraw index=' + i + ' drawY=' + Math.round(_prefixD[idx]) + ' h=' + Math.round(capturex_capture_array_height[i] - n_y) + ' mode=last-ny'); } catch (e) {}
						}
						else {
							context.drawImage(image, 0, n_y, width, height - n_y, 0 + left_image_width, height * (i - start_index), width, height - n_y);
						}
					}
					else {
						if (_prefixD) {
							context.drawImage(image, 0 + left_image_width, _prefixD[idx], width, capturex_capture_array_height[i]);
							try { console.log('[FEATURE_RUNTIME]', 'StitchDraw index=' + i + ' drawY=' + Math.round(_prefixD[idx]) + ' h=' + Math.round(capturex_capture_array_height[i])); } catch (e) {}
						}
						else {
							context.drawImage(image, 0 + left_image_width, (i - start_index) * height, width, height + 1);
						}
					}
				});

				if (capturex_capture_bottom && capturex_capture_array_splicing_index == (capturex_capture_array.length - 1)) {
					const image = new Image();
					const objectUrlBottom = capturex_capture_bottom instanceof Blob ? URL.createObjectURL(capturex_capture_bottom) : capturex_capture_bottom;
					image.src = objectUrlBottom;
					await new Promise(resolve => {
						image.onload = () => {
							if (capturex_capture_bottom instanceof Blob) URL.revokeObjectURL(objectUrlBottom);
							left_image_width = image.naturalWidth;
							context.drawImage(image, 0, (totalHeight - image.naturalHeight), image.naturalWidth, image.naturalHeight);
							resolve();
						};
					});
				}

				return new Promise(resolve => {
					canvasWrapper.toBlob(blob => {
						resolve(blob);
					}, 'image/png');
					// Help GC by nullifying canvas reference
					canvas = null;
				});
			},
			splitSendImgData: function () {
				if (capturex_snap_mergedImage_array && capturex_snap_mergedImage_array.length > 0) {
					for (let k = 0; k < capturex_snap_mergedImage_array.length; k++) {
						const blob = capturex_snap_mergedImage_array[k];
						if (blob) {
							// PERF-03: canal binario (chunks 1.5MB con ack) — cero FileReader/base64.
							var stitchMs2 = null;
							try { stitchMs2 = window.__sqaPerfStitchStart ? (Date.now() - window.__sqaPerfStitchStart) : null; } catch (e) {}
							sendFinalBlobBinary(blob, {
								browserName: _lastBrowserInfo.browserName,
								browserVersion: _lastBrowserInfo.fullVersion,
								os: _lastOS,
								stitchMs: stitchMs2
							}, function () {
								// Fallback legacy: FileReader → dataURL (+33% wire), ruta sin opt-in.
								const reader = new FileReader();
								// PERF_CAPTURE_FULL_D2_EVALUATION: mide FileReader (se publica vía convMs).
								const frT02 = Date.now();
								const frBytes2 = (blob && blob.size) || 0;
								reader.onloadend = function () {
									// AUDIT_EXTWEB_REAL_PERF_001: stitchMs lo mide el SW (ver handler).
									var stitchMs = null;
									try { stitchMs = window.__sqaPerfStitchStart ? (Date.now() - window.__sqaPerfStitchStart) : null; } catch (e) {}
									chrome.runtime.sendMessage({ action: 'processFinalImageBlob', imageBlob: reader.result, browserName: _lastBrowserInfo.browserName, browserVersion: _lastBrowserInfo.fullVersion, os: _lastOS, stitchMs: stitchMs, convMs: Date.now() - frT02, convBytes: frBytes2, convOut: (reader.result && reader.result.length) || 0 });
								};
								reader.readAsDataURL(blob);
							}, 'stitch');
						}
						capturex_snap_mergedImage_array[k] = null;
					}
				}
				releaseCaptureBuffers();
				if (capturex_capture_truncated) {
					capturex_capture_truncated = false;
					try { capturex_com_saveAction.showTip('Captura parcial: la página supera el límite de tamaño.'); } catch (e) {}
					try { chrome.runtime.sendMessage({ action: "captureWarning", message: "TRUNCATED_LIMIT" }); } catch (e) {}
				}
			},
			showTip: function (msg) {
				let tip = document.getElementById('sqa_tip_msg');
				if (!tip) {
					tip = document.createElement('div');
					tip.id = 'sqa_tip_msg';
					tip.style.cssText = [
						'position:fixed',
						'bottom:24px',
						'left:50%',
						'transform:translateX(-50%)',
						'background:#27ae60',
						'color:#fff',
						'font-family:Segoe UI,Arial,sans-serif',
						'font-size:13px',
						'font-weight:600',
						'padding:10px 22px',
						'border-radius:50px',
						'z-index:2147483647',
						'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
						'pointer-events:none',
						'transition:opacity 0.4s ease'
					].join(';');
					document.body.appendChild(tip);
				}
				tip.textContent = msg;
				tip.style.opacity = '1';
				clearTimeout(tip._hideTimer);
				tip._hideTimer =					// PERF-09: ventana del transform 80 → 40 ms (el observer de crecimiento
					// y los reflows del sitio son la señal real, no el sleep fijo).
					setTimeout(() => {
						try { console.log('[FEATURE_RUNTIME]', 'ScrollTransformWait ms=40'); } catch (e) {} tip.style.opacity = '0'; }, 2500);
			},
			// ── END PROGRESS OVERLAY ───────────────────────────────────

		findScrollableElements: function () {
			// PERF-06b: recorrido UNICO compartido. El walk barato (preScanDocument,
			// sin getComputedStyle, cacheado) corre primero; el ScrollFinder evalua
			// SOLO esos candidatos (findFromCandidates: estilos por candidato, sin
			// BFS completo ni querySelectorAll). Sin SF, el mismo scan alimenta el
			// loop legacy. Un solo walk por captura en todos los casos.
			const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			const scan = this.preScanDocument();
			const raw = scan.scrollableRaw;
			const SF = window.__sqaScrollFinder;
			if (SF && typeof SF.findFromCandidates === 'function') {
				let res = null;
				try { res = SF.findFromCandidates(raw, scan.frames, window.innerWidth, window.innerHeight); } catch (e) { res = null; }
				const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
				if (res && res.type === 'elt' && res.elt) {
					try { console.log('[FEATURE_RUNTIME]', 'ScrollDetect detector=finder prefiltered=' + raw.length + ' nodes=' + scan.nodes + ' ms=' + ms); } catch (e) {}
					return [res.elt];
				}
				if (res && res.type === 'frame' && res.frame) {
					try { console.log('[FEATURE_RUNTIME]', 'ScrollDetect detector=finder prefiltered=' + raw.length + ' nodes=' + scan.nodes + ' ms=' + ms); } catch (e) {}
					return [res.frame];
				}
				// Sin ganador SF: el loop legacy abajo reutiliza el MISMO scan (sin
				// walk extra). Se registra igual para trazabilidad de la ruta real.
				try { console.log('[FEATURE_RUNTIME]', 'ScrollDetect detector=finder prefiltered=' + raw.length + ' nodes=' + scan.nodes + ' ms=' + ms + ' fallthrough=legacy'); } catch (e) {}
			}
			else if (SF) {
				// Módulo SF desactualizado (sin findFromCandidates): ruta histórica.
				const fullW = Math.max(document.body ? document.body.scrollWidth : 0, document.documentElement.scrollWidth);
				const fullH = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
				const result = SF.find(window.innerWidth, window.innerHeight, fullW, fullH);
				const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
				try { console.log('[FEATURE_RUNTIME]', 'ScrollDetect detector=finder prefiltered=0 nodes=' + scan.nodes + ' ms=' + ms + ' mode=legacy-sf-walk'); } catch (e) {}
				if (result && result.type === 'elt' && result.elt) return [result.elt];
				if (result && result.type === 'frame' && result.frame) return [result.frame];
			}
			// PERF-05: fallback sobre candidatos del walk único (pre-filtro de overflow
			// ya aplicado) — ya no querySelectorAll('*') con getComputedStyle por nodo.
			const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
			const scrollableElements = [];
			for (let i = 0; i < raw.length; i++) {
				const element = raw[i];
				if (capturex_com_tools.isVerticallyScrollable(element)) {
					const rect = _getCachedRect(element);
					const scrollHeight = element.scrollHeight;
					if (rect.height > 30 && rect.width > 30 && scrollHeight > rect.height * 1.1) {
						if (!capturex_com_tools.isElementOccluded(element))
							scrollableElements.push(element);
					}
				} else if (capturex_com_tools.isVerticallyScrollableFrame(element)) {
					scrollableElements.push(element);
				}
			}
			try { console.log('[FEATURE_RUNTIME]', 'ScrollDetect detector=legacy prefiltered=' + raw.length + ' nodes=' + scan.nodes + ' ms=' + Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t1)); } catch (e) {}
			return scrollableElements;
		}
		};

		capturex_com_saveAction.contentjsIsLoad();

		//receive messages
		chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
			// P1-2: solo mensajes de la propia extensión.
			if (sender && sender.id && sender.id !== chrome.runtime.id) {
				try { console.warn('[SECURITY_TRACE] Mensaje descartado en content.js:', sender.id, request && request.action); } catch (e) {}
				return;
			}
			if (request.action === "checkContentLoaded") {
				sendResponse({ loaded: true });
			}
			else if (request.action === 'showTip') {
				capturex_com_saveAction.showTip(request.msg);
			}
			else if (request.action === 'captureAllPageScreenshot') {
				capturex_com_saveAction.captureAllPageScreenshot();
				sendResponse({ started: true });
			}
			else if (request.action === 'captureVisibleOnly') {
				capturex_com_saveAction.captureVisibleOnly();
				sendResponse({ started: true });
			}
			else if (request.action === 'captureSelectionEdit') {
				capturex_com_saveAction.captureSelectionEdit();
				sendResponse({ started: true });
			}
			else if (request.action === 'readLocalPdfBytes') {
				readLocalPdfAndStream();
				sendResponse({ started: true });
			}
			else if (request.action === 'renderPdfInPage') {
				// FUNC-07: el SW envía workerBlob (Blob), no workerText — la propiedad
				// que se leía aquí nunca existía y el fallback de worker moría.
				renderPdfInPage(request.data, request.workerBlob);
				sendResponse({ started: true });
			}
			else if (request.action === 'croppedImageResult') {
				capturex_com_saveAction.cropImage(request.dataUrl, capturex_startX, capturex_startY, capturex_endX, capturex_endY, request.forCopy);
				sendResponse({ ok: true });
			}
			else if (request.action === 'getNowShotImgData') {
				sendResponse({ started: true });
				// PERF-04: el SW adjunta el screenshot como Blob en el propio mensaje
				// (structured_clone, manifest.json) y desaparece el round-trip legacy
				// requestCaptureScreenshot con 2-8 MB de dataURL por viewport.
				const processShot = function (shotSrc, y1, y2) {
					// PERF-04b: ruta Blob-only. La rama legacy-dataurl y el pull
					// requestCaptureScreenshot (2-8 MB por viewport) están eliminados:
					// sin Blob no hay imagen que coser y se reporta fallo visible
					// (captureWarning) en vez de un stall silencioso o un pull.
					if (!shotSrc || !(shotSrc instanceof Blob)) {
						try { console.log('[FEATURE_RUNTIME]', 'PageShotSource route=missing-blob blobPages=' + _pageShotBlobPages + ' dataUrlPages=' + _pageShotDataUrlPages); } catch (e) {}
						try { console.error('[SQA] getNowShotImgData sin shotBlob: viewport no capturado (PERF-04b, sin pull legacy).'); } catch (e) {}
						try { chrome.runtime.sendMessage({ action: 'captureWarning' }); } catch (e) {}
						return;
					}
					let shotUrl = shotSrc;
					// Cero conversión: el Image dibuja directo desde el objectURL.
					shotUrl = URL.createObjectURL(shotSrc);
					setTimeout(function () { try { URL.revokeObjectURL(shotUrl); } catch (e) {} }, 30000);
					_pageShotBlobPages++;
					try { console.log('[FEATURE_RUNTIME]', 'PageShotSource route=inline-blob blobPages=' + _pageShotBlobPages + ' dataUrlPages=' + _pageShotDataUrlPages); } catch (e) {}
					if (capturex_contentEle) {
						let pageType = 0;
							if (request.y1 == 0 && request.y2 == 0 && capturex_capture_array.length == 0)
								pageType = 0;
							else if (request.y1 == 0 && request.y2 == 0 && capturex_capture_array.length > 0)
								pageType = 1;
							else if (request.y1 > 0 || request.y2 > 0)
								pageType = 2;

							capturex_com_saveAction.cropImageContent(shotUrl, pageType)
								.then(croppedImageUrl => {
									capturex_capture_array.push(croppedImageUrl);
									if (request.nextPageData) {
										capturex_com_saveAction.captureVisiblePageScreenshot(request.nextPageData.docHeight, request.nextPageData.nextScrollTop, request.nextPageData.windowInnerHeight, request.nextPageData.y1, request.nextPageData.y2);
									}
									else {
										capturex_com_saveAction.restoreStyleForShot();

										let img_first = new Image();
										const firstItem = capturex_capture_array[0];
										const objectUrlFirst = firstItem instanceof Blob ? URL.createObjectURL(firstItem) : firstItem;
										img_first.onload = function () {
											if (firstItem instanceof Blob) URL.revokeObjectURL(objectUrlFirst);
											let imageWidth = img_first.width;
											let imageHeight = img_first.height;
											capturex_com_saveAction.splicingImagesAndSendAction(imageWidth, imageHeight, y1, y2);
										};
										img_first.src = objectUrlFirst;
									}
								})
								.catch(error => {
									console.error('Error cropping image:', error);
									chrome.runtime.sendMessage({ action: "captureError", message: "Error al recortar la imagen: " + error.message });
								});
						}
					else {
						// El array admite Blob (cropImageContent resuelve con Blob); push del
						// Blob evita que el objectURL caduque antes del stitching.
						capturex_capture_array.push(shotSrc instanceof Blob ? shotSrc : shotUrl);
						if (request.nextPageData) {
								capturex_com_saveAction.captureVisiblePageScreenshot(request.nextPageData.docHeight, request.nextPageData.nextScrollTop, request.nextPageData.windowInnerHeight, request.nextPageData.y1, request.nextPageData.y2);
							}
							else {
								capturex_com_saveAction.restoreStyleForShot();

								let img_first = new Image();
								const firstItem = capturex_capture_array[0];
								const objectUrlFirst = firstItem instanceof Blob ? URL.createObjectURL(firstItem) : firstItem;
								img_first.onload = function () {
									if (firstItem instanceof Blob) URL.revokeObjectURL(objectUrlFirst);
									let imageWidth = img_first.width;
									let imageHeight = img_first.height;

									capturex_com_saveAction.splicingImagesAndSendAction(imageWidth, imageHeight, y1, y2);
								};
								img_first.src = objectUrlFirst;
							}
					}
				};
				// PERF-04b: el SW siempre adjunta shotBlob inline (BinaryChannel). Sin
				// pull legacy: processShot reporta el faltante como fallo visible.
				processShot(request.shotBlob, request.y1, request.y2);
				return true;
			}
		});


	} else {
		return;
	}
})();





