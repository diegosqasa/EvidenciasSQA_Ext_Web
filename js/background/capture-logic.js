/**
 * Evidencias SQA — background/capture-logic.js
 * Lógica de captura y procesamiento de fragmentos.
 */

import { workerState, captureStatus, captureInProgress } from './state.js';
import { updateCaptureStatus, markCaptureCompleted, markCaptureError, pdfRouteLog, pdfUrlInfo } from './utils.js';
import { CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS } from './constants.js';
import { getAuthHeaders } from './auth.js';

// ============================================================================
// ERROR BUFFER CIRCULAR (para diagnóstico post-mortem)
// ============================================================================
const ERROR_BUFFER_SIZE = 50;
const errorBuffer = [];
let errorBufferIndex = 0;

function logErrorToBuffer(error, context) {
    const entry = {
        timestamp: Date.now(),
        context,
        message: error?.message || String(error),
        stack: error?.stack || null
    };
    errorBuffer[errorBufferIndex] = entry;
    errorBufferIndex = (errorBufferIndex + 1) % ERROR_BUFFER_SIZE;
}

export function getErrorBuffer() {
    return [...errorBuffer];
}

// ============================================================================
// CLASIFICACIÓN DE ERRORES
// ============================================================================
const CRITICAL_ERRORS = [
    'tab was closed',
    'No tab with id',
    'cannot access contents',
    'extensions gallery cannot be scripted'
];

const EXPECTED_ERRORS = [
    'frame with id 0 is showing error page',
    'showing error page',
    'Failed to fetch'
];

function classifyError(error) {
    const message = (error?.message || String(error)).toLowerCase();
    if (CRITICAL_ERRORS.some(err => message.includes(err))) {
        return 'critical';
    }
    if (EXPECTED_ERRORS.some(err => message.includes(err))) {
        return 'expected';
    }
    return 'unknown';
}

// ============================================================================
// TIMEOUTS CONTROLADOS
// ============================================================================
const DEFAULT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, context = 'operation') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            logErrorToBuffer(new Error(`Timeout after ${ms}ms in ${context}`), context);
            reject(new Error(`Timeout: ${context}`));
        }, ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise
    ]);
}

// ============================================================================
// DETECCIÓN DE PDF (full-page vía pdf.js)
// ============================================================================

// BUG_PDF_ROUTING_001: devuelve el motivo de match (o null). isPdfPageTab conserva firma.
function pdfRouteReason(tab) {
    if (!tab || !tab.url) return null;
    const url = tab.url || '';
    // Chrome PDF viewer: chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/... o viewer con .pdf
    if (url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) return 'chrome-extension-viewer';
    if (/\.pdf($|[?#])/i.test(url)) return 'url-pdf-ext';
    if (/application\/pdf/i.test(url)) return 'url-has-pdf-mime';
    // Título termina en .pdf (Chrome muestra "doc.pdf")
    if (tab.title && /\.pdf($|[?#])/i.test(tab.title)) return 'title-pdf-ext';
    // BUG_PDF_001: blob: con título .pdf + contentType (paridad con service-worker)
    if (url.startsWith('blob:') && tab.title && tab.title.toLowerCase().includes('.pdf')) return 'blob-title-pdf';
    if (tab.contentType === 'application/pdf') return 'tab-content-type-pdf';
    return null;
}

function isPdfPageTab(tab) {
    return !!pdfRouteReason(tab);
}

// ============================================================================
// CLEANUP DE EVENT LISTENERS
// ============================================================================
let _healingCleanup = null;
export function setHealingCleanup(fn) { _healingCleanup = fn; }

function cleanupListeners(tabId) {
    try {
        if (_healingCleanup) _healingCleanup();
    } catch (e) {
        console.warn('[cleanup] Error:', e.message);
    }
}


/**
 * Fast path P0 para captura visible.
 *
 * IMPORTANTE:
 * - No usa content.js.
 * - Full-page via content script stitching.
 * - No espera artificialmente.
 * - Conserva el data URL original solo para operaciones de preview/clipboard.
 * - El upload viaja como Blob binario directamente al endpoint existente.
 */
async function captureVisibleFastPath(tab) {
    const tabId = tab?.id;
    const totalStart = performance.now();
    const captureStart = performance.now();
    console.debug('[CAPTURE_PERF] VisibleCapture Start', { tabId });
    console.debug('[CAPTURE_PERF] ContentScript Injected', 'skipped (visible fast path)');

    // Arrancamos la información de entorno en paralelo con la captura para no
    // añadir latencia al camino crítico.
    const browserInfoPromise = _getBrowserInfo().catch(() => ({ name: 'N/A', version: '', os: 'N/A' }));

    try {
        const dataUrl = await withTimeout(
            new Promise((resolve, reject) => {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (data) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(data);
                    }
                });
            }),
            DEFAULT_TIMEOUT_MS,
            'captureVisibleTab'
        );

        const captureTabMs = performance.now() - captureStart;
        console.debug('[CAPTURE_PERF] CaptureVisibleTab Time', `${captureTabMs.toFixed(1)}ms`);

        if (!dataUrl) {
            throw new Error('No se pudo capturar la página.');
        }

        // Chrome entrega captureVisibleTab como data URL. Esta es la ÚNICA
        // conversión dataURL -> Blob de la ruta rápida.
        const blobStart = performance.now();
        const blob = await fetch(dataUrl).then(r => r.blob());
        console.debug('[CAPTURE_PERF] Blob Conversion Time', `${(performance.now() - blobStart).toFixed(1)}ms`);

        const browserInfo = await browserInfoPromise;
        const browserLabel = browserInfo?.name && browserInfo?.version
            ? `${browserInfo.name} v${browserInfo.version}`
            : (await _detectBrowser());
        const osLabel = browserInfo?.os || (await _detectOS());

        // BUG_HEADER_BROWSER_001: Log headers before send
        console.debug('[BUG_HEADER_BROWSER_001] service-worker → X-SQA-Browser:', browserLabel, '| X-SQA-OS:', osLabel);

        const postStart = performance.now();
        const apiResp = await fetch('http://127.0.0.1:3000/api/capture-binary', {
            method: 'POST',
            headers: await getAuthHeaders({
                'Content-Type': blob.type || 'image/png',
                'X-SQA-Url': encodeURIComponent(tab.url || ''),
                'X-SQA-Timestamp': new Date().toISOString(),
                'X-SQA-Browser': encodeURIComponent(browserLabel),
                'X-SQA-OS': encodeURIComponent(osLabel),
                'X-SQA-Has-Header': 'false'
            }),
            body: blob
        });
        console.debug('[CAPTURE_PERF] PostBinary Time', `${(performance.now() - postStart).toFixed(1)}ms`);

        if (!apiResp.ok) {
            captureInProgress.delete(tabId);
            markCaptureError(`Error al enviar captura (HTTP ${apiResp.status})`, tabId);
            return;
        }

        let autoCopyOnCapture = null;
        try {
            const apiJson = await apiResp.clone().json();
            autoCopyOnCapture = apiJson && apiJson.autoCopyOnCapture;
        } catch (_) {}

        // La captura visible ya no inyecta content.js. Si el content script
        // estaba presente por otra operación, el thumbnail puede reutilizarlo;
        // nunca se fuerza su inyección en este fast path.
        // [REMOVED] floating thumbnail - Windows 11 Toast only

        console.debug('[CAPTURE_PERF] Total Capture Time', `${(performance.now() - totalStart).toFixed(1)}ms`);
        captureInProgress.delete(tabId);
        markCaptureCompleted('Captura completada.');
    } catch (err) {
        captureInProgress.delete(tabId);
        console.warn('[capture-logic] Visible fast path falló:', err.message);
        markCaptureError(err.message, tabId);
    } finally {
        cleanupListeners(tabId);
    }
}

// [REMOVED] _sendThumbnail - no floating UI

export async function executeCapture(tab, actionName) {
    const tabUrl = tab.url || '';
    if (
        !tabUrl ||
        tabUrl.startsWith("chrome://") ||
        tabUrl.startsWith("chrome-error://") ||
        tabUrl.startsWith("edge://") ||
        tabUrl.startsWith("about:") ||
        tabUrl.startsWith("chrome-extension://") ||
        tabUrl.includes("chrome.google.com/webstore") ||
        tabUrl.includes("chromewebstore.google.com")
    ) {
        markCaptureError("Captura no permitida", tab.id);
        return;
    }

    if (captureInProgress.has(tab.id)) {
        updateCaptureStatus({ active: true, message: 'Ya hay una captura en curso.', tabId: tab.id });
        return;
    }

    captureInProgress.add(tab.id);
    workerState.activeTab = tab;

    updateCaptureStatus({
        active: true,
        mode: actionName === "captureAllPageScreenshot" ? 'full' : (actionName === "captureSelectionEdit" ? 'area' : 'visible'),
        progress: actionName === "captureAllPageScreenshot" ? 5 : 10,
        phase: 'starting',
        message: actionName === "captureSelectionEdit" ? 'Iniciando selección de área...' : 'Preparando captura...',
        error: '',
        tabId: tab.id
    });

    // P0-001: captura visible directa. No pasa por content.js, debugger ni fallback.
    if (actionName === "captureVisibleOnly") {
        await captureVisibleFastPath(tab);
        return;
    }

    // Ruta PDF full-page: desviar a pdf.js (offscreen) antes del fast-path debugger.
    // El PDF viewer (OOPIF) no expone scroll DOM, así que se renderiza el documento
    // completo vía pdf.js y se entrega la imagen resultante por el flujo normal.
    // BUG_PDF_ROUTING_001: se registra la decisión con motivo para medir cobertura real.
    const pdfReason = (actionName === "captureAllPageScreenshot") ? pdfRouteReason(tab) : null;
    if (actionName === "captureAllPageScreenshot") {
        pdfRouteLog('detect', Object.assign(pdfUrlInfo(tab), { match: pdfReason || 'none', route: pdfReason ? 'pdf-pipeline' : 'content-stitching' }));
    }
    if (pdfReason) {
        console.log('[capture-logic] PDF detectado, desviando a pdf.js offscreen', tab.url, tab.title);
        captureInProgress.delete(tab.id);
        // MV3 SW: runtime.sendMessage a sí mismo no es fiable → intentar directo via global expuesto por service-worker
        if (typeof globalThis !== 'undefined' && typeof globalThis.__sqaStartPdfCapture === 'function') {
            try { globalThis.__sqaStartPdfCapture(tab); } catch (e) { console.warn('[capture-logic] direct startPdfCapture failed', e.message); }
        } else {
            chrome.runtime.sendMessage({ action: 'pdfCaptureRequest', tabId: tab.id }).catch(() => {});
        }
        return;
    }

    // Full-page: content script stitching (scroll + captureVisibleTab + merge)
    // Chrome.debugger removed — all full-page captures use content script stitching.
    try {
        const isLoaded = await withTimeout(checkContentScript(tab.id), 3000, 'checkContentScript');
        if (!isLoaded) {
            try { console.log('[PERMISSION_TRACE] API=chrome.scripting.executeScript TabId=' + tab.id + ' Files=content.js Action=capture:fallback-inject'); } catch {}                const execT0 = performance.now();
            await withTimeout(
                    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["js/sqa-scroll-finder.js", "js/sqa-styles.js", "content.js"] }),
                5000,
                'executeScript content.js'
            );
            // AUDIT_EXTWEB_REAL_PERF_001: tiempo real de inyección.
            try { console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId: tab.id, op: 'executeScript', ms: Math.round(performance.now() - execT0) })); } catch (e) {}
            await new Promise(r => setTimeout(r, 150));
        }

        const sent = await retrySendMessage(tab.id, { action: actionName });
        if (!sent) {
            captureInProgress.delete(tab.id);
            markCaptureError("No se pudo iniciar la captura.", tab.id);
        }
    } catch (err) {
        const errorClass = classifyError(err);
        logErrorToBuffer(err, 'content-script-fallback');
        if (err.message && err.message.includes('cannot be scripted')) {
            console.warn('[capture-logic] Content script blocked, fallback a captura directa');
            captureDirectCapture(tab);
        } else {
            captureInProgress.delete(tab.id);
            if (errorClass === 'critical') {
                console.error('[capture-logic] Error crítico en content script:', err.message);
            } else {
                console.warn('[capture-logic] Error en content script:', err.message);
            }
            markCaptureError(err.message, tab.id);
        }
    }
}


async function _detectOS() {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const buildNum = parseInt((uaData.platformVersion || '').split('.')[2] || '0', 10);
                return buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            }
        } catch {}
        return /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
    }
    if (/Mac/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'N/A';
}

async function _detectBrowser() {
    const ua = navigator.userAgent;
    if (ua.includes('Edg')) return 'Edge v' + (ua.match(/Edg\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Chrome')) return 'Chrome v' + (ua.match(/Chrome\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Firefox')) return 'Firefox v' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '');
    return 'N/A';
}

async function _getBrowserInfo() {
    const ua = navigator.userAgent;
    let name = 'N/A', version = '', os = 'N/A';
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    if (chromeMatch && !ua.includes('Edg')) {
        name = 'Chrome'; version = chromeMatch[1];
    } else if (ua.includes('Edg')) {
        name = 'Edge'; const m = ua.match(/Edg\/([\d.]+)/); if (m) version = m[1];
    } else if (ua.includes('Firefox')) {
        name = 'Firefox'; const m = ua.match(/Firefox\/([\d.]+)/); if (m) version = m[1];
    }
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const buildNum = parseInt((uaData.platformVersion || '').split('.')[2] || '0', 10);
                os = buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            } else { os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows'; }
        } catch { os = 'Windows'; }
    } else if (/Mac/.test(ua)) { os = 'macOS'; }
    else if (/Linux/.test(ua)) { os = 'Linux'; }
    return { name, version, os };
}

async function captureDirectCapture(tab) {
    const tabId = tab?.id;
    try {
        const dataUrl = await withTimeout(
            new Promise((resolve, reject) => {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (data) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(data);
                });
            }),
            8000,
            'captureVisibleTab'
        );
        if (dataUrl) {
            // Validación de dimensiones antes de enviar
            try {
                const testBlob = await fetch(dataUrl).then(r => r.blob());
                const bitmap = await createImageBitmap(testBlob);
                if (bitmap.width < 100 || bitmap.height < 100) {
                    bitmap.close();
                    throw new Error('Captura directa inválida: dimensiones demasiado pequeñas');
                }
                bitmap.close();
            } catch (dimErr) {
                console.warn('[capture-logic] Validación de dimensiones en captura directa falló:', dimErr.message);
                logErrorToBuffer(dimErr, 'direct-capture-validation');
                throw dimErr;
            }

            const blob = await (await fetch(dataUrl)).blob();
            const captureTitle = tab && tab.title ? tab.title : 'Captura SQA';
            const url = tab && tab.url ? tab.url : '';
            const timestamp = new Date().toISOString();
            const browserInfo2 = await _getBrowserInfo().catch(()=>({name:'N/A',version:'',os:'N/A'}));
            const resp = await fetch('http://127.0.0.1:3000/api/capture-binary', {
                method: 'POST',
                headers: await getAuthHeaders({
                    'Content-Type': blob.type || 'image/png',
                    'X-SQA-Url': encodeURIComponent(url),
                    'X-SQA-Title': encodeURIComponent(captureTitle),
                    'X-SQA-Timestamp': timestamp,
                    'X-SQA-Browser': encodeURIComponent(browserInfo2.name + (browserInfo2.version?' v'+browserInfo2.version:'')),
                    'X-SQA-OS': encodeURIComponent(browserInfo2.os),
                    'X-SQA-Has-Header': 'false'
                }),
                body: blob,
            });
            if (resp.ok) {
                markCaptureCompleted('Captura directa completada.');
            } else {
                markCaptureError(`Visor rechazó la captura (HTTP ${resp.status})`, tabId);
            }
        } else {
            markCaptureError('No se pudo capturar la página.', tabId);
        }
    } catch (e) {
        logErrorToBuffer(e, 'direct-capture');
        const errorClass = classifyError(e);
        if (e.message && e.message.includes('Failed to fetch')) {
            markCaptureError('App de escritorio no disponible. Inicia Evidencias SQA Desktop.', tabId);
        } else {
            if (errorClass === 'critical') {
                console.error('[capture-logic] Error crítico en captura directa:', e.message);
            } else {
                console.warn('[capture-logic] Error en captura directa:', e.message);
            }
            markCaptureError(e.message, tabId);
        }
    } finally {
        captureInProgress.delete(tabId);
        cleanupListeners(tabId);
    }
}

async function checkContentScript(tabId) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            logErrorToBuffer(new Error('Timeout en checkContentLoaded'), 'checkContentScript-timeout');
            resolve(false);
        }, 2500);
        chrome.tabs.sendMessage(tabId, { action: "checkContentLoaded" }, (res) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError || !res || !res.loaded) resolve(false);
            else resolve(true);
        });
    });
}

async function retrySendMessage(tabId, msg, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        const success = await new Promise(resolve => {
            const timeoutId = setTimeout(() => {
                logErrorToBuffer(new Error(`Timeout en intento ${i} de sendMessage`), 'sendMessage-timeout');
                resolve(false);
            }, 2000);
            chrome.tabs.sendMessage(tabId, msg, () => {
                clearTimeout(timeoutId);
                if (chrome.runtime.lastError) resolve(false);
                else resolve(true);
            });
        });
        if (success) return true;
        await new Promise(r => setTimeout(r, 150 * i));
    }
    logErrorToBuffer(new Error(`Fallo después de ${retries} intentos`), 'sendMessage-all-retries-failed');
    return false;
}



export async function waitForCaptureQuota() {
    const elapsed = Date.now() - workerState.lastCaptureVisibleTabAt;
    const waitMs = Math.max(0, CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS - elapsed);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    workerState.lastCaptureVisibleTabAt = Date.now();
}

