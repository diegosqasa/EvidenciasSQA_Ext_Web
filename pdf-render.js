// Evidencias SQA — pdf-render.js
// Offscreen document (MV3) que renderiza documentos PDF completos vía pdf.js.
// El service worker le pide renderizar un PDF (action 'renderPdf') y este
// documento entrega el PNG resultante en slices binarios (action 'pdfRenderBlobChunk').

import { getDocument, GlobalWorkerOptions } from './lib/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const TARGET_WIDTH = 1500;          // ancho objetivo en px (A4 ≈ 2x)
const MAX_CANVAS_HEIGHT = 30000;    // límite de altura del canvas (Chrome: 32767)
const SLICE_BYTES = 1500000;        // ~1.5MB binario por mensaje (D2: sin base64)

// BUG_PDF_STALL_001: el sendToSw original ignoraba lastError; si el SW se suspende
// entre fases, el render sigue vivo en offscreen pero el SW nunca ve nada — y el
// usuario no percibe nada hasta el timeout de 90s. Loguear el error revela la fase.
function reportToSwConsole(message, level = 'log') {
    try { chrome.runtime.sendMessage({ action: 'pdfWorkerTrace', text: message }); } catch (e) {}
    try {
        if (level === 'error') console.error(message);
        else console.log(message);
    } catch (e) {}
}

function sendToSw(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            // BUG_PDF_STALL_001: ignorar lastError provocaba silencio total si el SW
            // se suspendía entre fases (render vivo, SW sordo). Registrar la fase.
            if (chrome.runtime.lastError) {
                console.warn('[pdf-render] sendToSw fallo (' + (message && message.action) + '):', chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn('[pdf-render] sendToSw excepción (' + (message && message.action) + '):', e.message);
    }
}

// BUG_PDF_STALL_001: vigilante por fase. Si una fase (parse, getDocument, render
// de página, encode) se queda sin progreso, se reporta y despierta al SW para que
// el pipeline de failover (timeout → fallback parcial) tenga datos y canal vivo.
const PHASE_TIMEOUT_MS = 45000; // pdf.js puede tardar en PDFs complejos; < timeout SW (90s)
let phaseTimer = null;
let lastPhase = '';

function cancelCurrentPhaseTimer() {
    if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
}

function markPhase(tabId, phase) {
    lastPhase = phase;
    cancelCurrentPhaseTimer();
    phaseTimer = setTimeout(() => {
        // BUG_PDF_STALL_002: el estancamiento ahora es ACCIONABLE — se envía
        // pdfRenderError para que el SW reintente en página (tiene los bytes) en vez
        // de colgar al usuario hasta el timeout de 90s.
        reportToSwConsole('[PDF_TRACE] PDF_RENDER_STALLED phase=' + phase + ' tabId=' + tabId, 'error');
        try { chrome.runtime.sendMessage({ action: 'pdfRenderError', tabId, error: 'Render estancado en fase ' + phase + ' (sin progreso ' + Math.round(PHASE_TIMEOUT_MS / 1000) + 's)' }); } catch (e) {}
    }, PHASE_TIMEOUT_MS);
}

function sendProgress(tabId, progress, current, total) {
    // FEATURE_PDF_UX_001: current/total opcionales ("Página X de N").
    const msg = { action: 'pdfRenderProgress', tabId, progress };
    if (typeof current === 'number' && typeof total === 'number') {
        msg.current = current;
        msg.total = total;
    }
    sendToSw(msg);
}

// PERF_PDF_D2_IMPLEMENTATION: blobToDataUrl eliminado (D2: Blob directo SW-bound).
// Ver pdfRenderBlobChunk en service-worker.js.

async function renderPdf(message) {
    const { pdfUrl, tabId } = message;
    // AUDIT_EXTWEB_REAL_PERF_001: marcas por fase (se publican al final vía pdfPerf).
    const prT0 = performance.now();
    markPhase(tabId, 'parse'); // BUG_PDF_STALL_001
    console.log('[PDF_TRACE] PDF_RENDER_START', { pdfUrl: (pdfUrl || '(local buffer)').slice(0, 120), tabId });
    console.log('[pdf-render] renderPdf iniciado', { pdfUrl: (pdfUrl || '(local buffer)').slice(0, 120), tabId });
    let buffer;
    if (message.data) {
        // BUG_PDF_FILE_001: bytes del PDF local (file://) enviados por el SW;
        // se evita el fetch, bloqueado para file: unique origin.
        try {
            const raw = atob(message.data);
            const u8 = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
            buffer = u8.buffer;
        } catch (e) {
            throw new Error('Buffer local inválido: ' + e.message);
        }
        console.log('[PDF_TRACE] PDF_BUFFER_READY (local)', buffer.byteLength, 'bytes');
    } else {
        let resp;
        try {
            resp = await fetch(pdfUrl);
        } catch (e) {
            console.error('[pdf-render] fetch failed', pdfUrl, e.message);
            // file:// requiere "Permitir acceso a URL de archivo" en chrome://extensions
            if (pdfUrl.startsWith('file://')) throw new Error(`No se pudo leer file:// — activa "Permitir acceso a URLs de archivo" en chrome://extensions → Evidencias SQA → Detalles. Detalle: ${e.message}`);
            throw new Error(`Fetch PDF falló: ${e.message}`);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status} al obtener el PDF`);
        buffer = await resp.arrayBuffer();
        console.log('[PDF_TRACE] PDF_BUFFER_READY', buffer.byteLength, 'bytes');
        console.log('[pdf-render] PDF buffer', buffer.byteLength, 'bytes');
    }

    const pdf = await getDocument({
        data: buffer,
        isEvalSupported: false,
        useSystemFonts: true,
        // BUG_PDF_STALL_002/003: el render se colgaba en page.render() dentro del
        // documento offscreen. disableFontFace NO lo eliminó (3 corridas con stall),
        // así que la causa no era FontFace. Siguiente candidato: la decodificación de
        // imágenes vía OffscreenCanvas/createImageBitmap (el PDF de prueba tiene logo),
        // que dentro de un offscreen document puede no resolver. Se desactiva; si aun
        // así se cuelga, el timeout por página (8s) + reintento en página lo cubren.
        disableFontFace: true,
        isOffscreenCanvasSupported: false
    }).promise;

    const prTFetch = performance.now();
    try { console.log('[PDF_ROUTE]', JSON.stringify({ t: Date.now(), event: 'render-start', tabId, numPages: pdf.numPages, source: message.data ? 'local-buffer' : 'fetch-url' })); } catch (e) {}
    const prTDoc = performance.now();
    markPhase(tabId, 'pages'); // BUG_PDF_STALL_001: vigilar bucle getPage/viewport
    sendProgress(tabId, 15);

    const pages = [];
    let maxW = 0;
    let totalH = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        pages.push({ page, w: vp.width, h: vp.height });
        if (vp.width > maxW) maxW = vp.width;
        totalH += vp.height;
        if (i % 5 === 0) {
            sendProgress(tabId, 15 + Math.round((i / pdf.numPages) * 35), i, pdf.numPages);
        }
    }

    if (pages.length === 0) throw new Error('El PDF no contiene páginas');
    const prTInfo = performance.now();

    let scale = Math.min(TARGET_WIDTH / maxW, MAX_CANVAS_HEIGHT / totalH);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    if (scale > 3) scale = 3; // nunca ampliar más de 3x

    const W = Math.ceil(maxW * scale);
    const H = Math.ceil(totalH * scale);

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    let y = 0;
    let rendered = 0;
    markPhase(tabId, 'render'); // BUG_PDF_STALL_001: info de páginas lista — vigilar render de páginas
    // BUG_PDF_STALL_002: timeout por página. Si un page.render() no resuelve,
    // se cancela la tarea y se aborta TODO el render con el número de página —
    // el SW lo reencamina a render en página con los bytes ya leídos.
    const PAGE_RENDER_TIMEOUT_MS = 8000; // BUG_PDF_STALL_003: 25s→8s — fallar rápido y ceder al render en página (que hace el trabajo en ~220ms)
    for (const { page, w, h } of pages) {
        const viewport = page.getViewport({ scale });
        const pageCanvas = new OffscreenCanvas(Math.ceil(w * scale), Math.ceil(h * scale));
        const renderTask = page.render({ canvasContext: pageCanvas.getContext('2d', { alpha: false }), viewport });
        let pageTimer = null;
        try {
            await Promise.race([
                renderTask.promise,
                new Promise((_, reject) => {
                    pageTimer = setTimeout(() => reject(new Error('Render de página estancado (timeout ' + Math.round(PAGE_RENDER_TIMEOUT_MS / 1000) + 's)')), PAGE_RENDER_TIMEOUT_MS);
                })
            ]);
            clearTimeout(pageTimer);
        } catch (err) {
            clearTimeout(pageTimer);
            try { renderTask.cancel(); } catch (e) {}
            pageCanvas.width = 0;
            pageCanvas.height = 0;
            try { page.cleanup(); } catch (e) {}
            const detail = (err && err.message) ? err.message : String(err);
            throw new Error(detail + ' [página ' + (rendered + 1) + ']');
        }
        ctx.drawImage(pageCanvas, 0, y);
        y += Math.ceil(h * scale);
        pageCanvas.width = 0;
        pageCanvas.height = 0;
        try { page.cleanup(); } catch (e) {}
        rendered++;
        sendProgress(tabId, 50 + Math.round((y / H) * 30), rendered, pages.length);
    }

    markPhase(tabId, 'blob'); // BUG_PDF_STALL_001: render completo — vigilar encode
    sendProgress(tabId, 82);
    const prTRender = performance.now();
    console.log('[PDF_TRACE] PDF_CANVAS_RENDERED', {W, H, pages: pages.length});
    try { console.log('[PDF_ROUTE]', JSON.stringify({ t: Date.now(), event: 'render-complete', tabId, pages: pages.length, W, H })); } catch (e) {}

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const prTBlob = performance.now();
    console.log('[PDF_TRACE] PDF_BLOB_CREATED', {size: blob.size, type: blob.type});
    // PERF_PDF_D2_IMPLEMENTATION: slices binarios directos (sin base64). D2 solo PDF:
    // el SW ensambla con new Blob() en pdfRenderBlobChunk. Ahorra FileReader +33% wire + atob.
    const total = Math.max(1, Math.ceil(blob.size / SLICE_BYTES));

    // BUG_PDF_STALL_001: confirmación por chunk del SW (rtn:1). Si un slice no llegó
    // (SW suspendido en MV3 entre mensajes), se reenvía hasta 3 veces; si el SW
    // confirma index >= total (ensamblado ya completado), se aborta el reenvío.
    // La versión anterior ignoraba la respuesta: un solo slice perdido dejaba la
    // captura muerta en silencio hasta el timeout de 90s.
    const MAX_CHUNK_ATTEMPTS = 3;
    const sendChunkWithAck = (chunkMsg, attempt = 1) => new Promise((resolve) => {
        let settled = false;
        const to = setTimeout(() => {
            if (settled) return;
            settled = true;
            reportToSwConsole('[PDF_TRACE] PDF_CHUNK_NO_ACK idx=' + chunkMsg.index + ' attempt=' + attempt, 'warn');
            if (attempt < MAX_CHUNK_ATTEMPTS) resolve(sendChunkWithAck(chunkMsg, attempt + 1));
            else resolve(true); // continuar con el resto; el ensamblador es tolerante
        }, 8000);
        try {
            chrome.runtime.sendMessage(chunkMsg, (resp) => {
                if (settled) return;
                settled = true;
                clearTimeout(to);
                const lastErr = chrome.runtime.lastError;
                if (lastErr) {
                    reportToSwConsole('[PDF_TRACE] PDF_CHUNK_ERR idx=' + chunkMsg.index + ' attempt=' + attempt + ' ' + lastErr.message, 'warn');
                    if (attempt < MAX_CHUNK_ATTEMPTS) resolve(sendChunkWithAck(chunkMsg, attempt + 1));
                    else resolve(true);
                    return;
                }
                if (resp && resp.rtn === 1) {
                    // index >= total ⇒ el SW ensambló y ya procesó la captura: abortar reenvío.
                    if (resp.index >= chunkMsg.total) resolve(false);
                    else resolve(true);
                } else {
                    // rtn:0 ⇒ slice rechazado (p.ej. blob no clonado): reenviar este index.
                    reportToSwConsole('[PDF_TRACE] PDF_CHUNK_REJECTED idx=' + chunkMsg.index + ' attempt=' + attempt, 'warn');
                    if (attempt < MAX_CHUNK_ATTEMPTS) resolve(sendChunkWithAck(chunkMsg, attempt + 1));
                    else resolve(true);
                }
            });
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(to);
            reportToSwConsole('[PDF_TRACE] PDF_CHUNK_EXC idx=' + chunkMsg.index + ' attempt=' + attempt + ' ' + e.message, 'warn');
            if (attempt < MAX_CHUNK_ATTEMPTS) resolve(sendChunkWithAck(chunkMsg, attempt + 1));
            else resolve(true);
        }
    });

    for (let i = 0; i < total; i++) {
        const chunkMsg = {
            action: 'pdfRenderBlobChunk',
            tabId,
            index: i,
            total,
            blob: blob.slice(i * SLICE_BYTES, (i + 1) * SLICE_BYTES, 'image/png')
        };
        const keepGoing = await sendChunkWithAck(chunkMsg);
        if (!keepGoing) { lastPhase = 'done'; cancelCurrentPhaseTimer(); return; }
    }

    cancelCurrentPhaseTimer(); // BUG_PDF_STALL_001: todo entregado — apagar watchdog
    lastPhase = 'done';

    try { await pdf.destroy(); } catch (e) {}
    const prTSent = performance.now();
    sendToSw({ action: 'pdfPerf', tabId, marks: { fetchMs: Math.round(prTFetch - prT0), docMs: Math.round(prTDoc - prTFetch), infoMs: Math.round(prTInfo - prTDoc), renderMs: Math.round(prTRender - prTInfo), blobMs: Math.round(prTBlob - prTRender), dataUrlMs: 0, chunkMs: Math.round(prTSent - prTBlob), pages: pages.length, W, H, bytes: blob.size } });
    sendProgress(tabId, 100);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Prueba de vida para el SW (verifica offscreen vivo + listener registrado).
    if (message && message.action === 'sqaPing') {
        try { sendResponse({ alive: true, pdf: true }); } catch (e) {}
        return true;
    }
    if (!message || message.action !== 'renderPdf') return false;
    // P1-2: solo el SW propio puede pedir renders (evita SSRF vía mensajes forjados).
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
        try { console.warn('[SECURITY_TRACE] renderPdf descartado: sender no confiable', sender.id); } catch {}
        return false;
    }
    // Responder sincrónicamente para evitar "message channel closed" (SW no necesita esperar render)
    try { sendResponse({ received: true }); } catch {}
    renderPdf(message)
        .catch((err) => {
            cancelCurrentPhaseTimer();
            const detail = String((err && err.message) || err);
            console.error('[pdf-render] Error:', detail);
            // BUG_PDF_STALL_001: anexar la fase donde murió (parse/pages/render/blob)
            sendToSw({ action: 'pdfRenderError', tabId: message.tabId, error: lastPhase ? detail + ' [fase: ' + lastPhase + ']' : detail });
        });
    return false;
});
