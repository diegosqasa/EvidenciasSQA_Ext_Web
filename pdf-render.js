// Evidencias SQA — pdf-render.js
// Offscreen document (MV3) que renderiza documentos PDF completos vía pdf.js.
// El service worker le pide renderizar un PDF (action 'renderPdf') y este
// documento entrega el PNG resultante en slices binarios (action 'pdfRenderBlobChunk').

import { getDocument, GlobalWorkerOptions } from './lib/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const TARGET_WIDTH = 1500;          // ancho objetivo en px (A4 ≈ 2x)
const MAX_CANVAS_HEIGHT = 30000;    // límite de altura del canvas (Chrome: 32767)
const SLICE_BYTES = 1500000;        // ~1.5MB binario por mensaje (D2: sin base64)

function sendToSw(message) {
    try { chrome.runtime.sendMessage(message); } catch (e) {}
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
        useSystemFonts: true
    }).promise;

    const prTFetch = performance.now();
    try { console.log('[PDF_ROUTE]', JSON.stringify({ t: Date.now(), event: 'render-start', tabId, numPages: pdf.numPages, source: message.data ? 'local-buffer' : 'fetch-url' })); } catch (e) {}
    const prTDoc = performance.now();
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
    for (const { page, w, h } of pages) {
        const viewport = page.getViewport({ scale });
        const pageCanvas = new OffscreenCanvas(Math.ceil(w * scale), Math.ceil(h * scale));
        await page.render({ canvasContext: pageCanvas.getContext('2d', { alpha: false }), viewport }).promise;
        ctx.drawImage(pageCanvas, 0, y);
        y += Math.ceil(h * scale);
        pageCanvas.width = 0;
        pageCanvas.height = 0;
        try { page.cleanup(); } catch (e) {}
        rendered++;
        sendProgress(tabId, 50 + Math.round((y / H) * 30), rendered, pages.length);
    }

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

    for (let i = 0; i < total; i++) {
        sendToSw({
            action: 'pdfRenderBlobChunk',
            tabId,
            index: i,
            total,
            blob: blob.slice(i * SLICE_BYTES, (i + 1) * SLICE_BYTES, 'image/png')
        });
    }

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
            console.error('[pdf-render] Error:', err && err.message ? err.message : err);
            sendToSw({ action: 'pdfRenderError', tabId: message.tabId, error: String((err && err.message) || err) });
        });
    return false;
});
