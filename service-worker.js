/**
 * Evidencias SQA — service-worker.js
 * Entry point del Service Worker modularizado.
 */

import { ACTIONS } from './js/background/constants.js';
import { workerState, captureStatus, captureInProgress } from './js/background/state.js';
import { updateCaptureStatus, markCaptureCompleted, markCaptureError, pdfRouteLog, pdfUrlInfo, showPdfPageProgress } from './js/background/utils.js';
import { executeCapture, waitForCaptureQuota, setHealingCleanup } from './js/background/capture-logic.js';
import { getAuthHeaders, invalidateToken } from './js/background/auth.js';
import * as OfflineDB from './js/background/offline-db.js';

const TEMP_IMAGE_STORAGE_TTL_MS = 60000;
const CHUNK_TIMEOUT_MS = 30000;
const CAPTURE_IMAGE_FORMAT = 'png';
const VIEWER_API_BASE_URL = 'http://127.0.0.1:3000';

const pdfCaptureChunks = new Map();
// BUG_PDF_FILE_001: ensamblaje de bytes de PDF local (file://) leídos por el
// content script. Al completarse se reenvían al offscreen vía beginOffscreenPdfRender.
const pdfLocalBuffers = new Map();
// BUG_PDF_FILE_001c: timers del render en página (sin offscreen). Se limpian al
// llegar el PNG (processFinalImageBlob), al cerrar el tab o al fallar.
const pdfInPageTimerById = new Map();
// BUG_PDF_WORKER_001: texto del worker clásico cacheado (el SW sí puede leerlo).
let sqaPdfWorkerTextCache = null;
// BUG_PDF_001: tabs cuyo PDF degradó a captura visible (parcial). Se consume en _finalizeCapture
// porque el markCaptureError previo queda sobrescrito por el éxito del fallback.
const pdfPartialFallback = new Set();

async function swGetSystemInfo() {
    const ua = navigator.userAgent;
    let browser = 'N/A', browserVersion = '';
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    if (chromeMatch && !ua.includes('Edg')) {
        browser = 'Chrome';
        browserVersion = chromeMatch[1];
    } else if (ua.includes('Firefox')) {
        browser = 'Firefox';
        const m = ua.match(/Firefox\/([\d.]+)/);
        if (m) browserVersion = m[1];
    } else if (ua.includes('Edg')) {
        browser = 'Edge';
        const m = ua.match(/Edg\/([\d.]+)/);
        if (m) browserVersion = m[1];
    }
    let os = 'N/A';
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const platVer = uaData.platformVersion || '';
                const buildNum = parseInt(platVer.split('.')[2] || '0', 10);
                os = buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            } else {
                os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
            }
        } catch (e) {
            os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
        }
    } else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    const browserLabel = browserVersion ? `${browser} v${browserVersion}` : browser;
    return { browser: browserLabel, os };
}
const capturePerfByTab = new Map();
const tempImageStorage = new Map();
const captureImageDataByTab = new Map();

setHealingCleanup(() => clearHealingInterval());

function log({ stage, status, durationMs, error, metadata }) {
  const entry = { t: Date.now(), s: stage, st: status };
  if (durationMs != null) entry.d = durationMs;
  if (error) entry.err = error;
  if (metadata) entry.m = metadata;
  (error ? console.error : console.log)('[sq]', JSON.stringify(entry));
}

// --- Inicialización ---

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
    validarIconos();
    setupKeepAlive();
});

chrome.runtime.onStartup.addListener(() => {
    validarIconos();
    setupKeepAlive();
});

chrome.runtime.onConnect.addListener((port) => {
    if (port && port.name === 'sqa-keepalive') {
        port.onMessage.addListener(() => {});
    }
});

let _offscreenReadyPromise = null;
async function setupKeepAlive() {
    // BUG_PDF_FILE_001c: sin API offscreen (navegador antiguo o restringido) el render
    // PDF usa la vía en página (renderInPageFallback). Diagnóstico claro, sin crash.
    if (typeof chrome === 'undefined' || !chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
        console.warn('[offscreen] API chrome.offscreen no disponible en este navegador — PDF usará render en página');
        return null;
    }
    // Singleton con lock para evitar carrera con ensurePdfRenderDoc
    if (_offscreenReadyPromise) return _offscreenReadyPromise;
    _offscreenReadyPromise = (async () => {
        try {
            if (typeof chrome.runtime.getContexts === 'function') {
                const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
                if (contexts.length > 0) {
                    // Forzar recreación una vez para asegurar offscreen.html multipropósito (con pdf-render.js)
                    // El viejo offscreen (solo keepalive) no tiene pdf-render listener
                    try { await chrome.offscreen.closeDocument(); } catch {}
                    await new Promise(r => setTimeout(r, 400));
                }
            }
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['WORKERS'],
                justification: 'Keepalive + render PDF (único Offscreen multipropósito MV3).'
            });
            console.log('[offscreen] keepalive multipropósito creado');
            await new Promise(r => setTimeout(r, 500)); // margen para que offscreen.js + pdf-render.js registren listeners
        } catch (e) {
            if (!String(e.message).includes('Only a single')) console.warn('[offscreen] setupKeepAlive', e.message);
            else console.log('[offscreen] ya existe (carrera), reuso');
        }
    })();
    return _offscreenReadyPromise;
}

setupKeepAlive();

// --- Gestión de Icono y Tema ---

// Cache de iconos para evitar recargar rutas cada vez
const ICON_CACHE = {
  dark: {
    "16": "Media/SQA-16.png",
    "32": "Media/SQA-32.png",
    "48": "Media/SQA-48.png",
    "128": "Media/SQA-128.png"
  },
  light: {
    "16": "Media/SQA1-16.png",
    "32": "Media/SQA1-32.png",
    "48": "Media/SQA1-48.png",
    "128": "Media/SQA1-128.png"
  }
};

let iconCacheValid = false;

/**
 * Valida que los iconos existan y sean accesibles
 * Se ejecuta una vez al iniciar la extensión
 */
async function validarIconos() {
  try {
    const allIcons = [...Object.values(ICON_CACHE.dark), ...Object.values(ICON_CACHE.light)];
    const validationPromises = allIcons.map(async (iconPath) => {
      try {
        const response = await fetch(chrome.runtime.getURL(iconPath), { method: 'HEAD' });
        if (!response.ok) {
          console.warn(`[SQA] Icono no encontrado o inaccesible: ${iconPath}`);
          return false;
        }
        return true;
      } catch (e) {
        console.warn(`[SQA] Error validando icono ${iconPath}:`, e.message);
        return false;
      }
    });
    
    const results = await Promise.all(validationPromises);
    iconCacheValid = results.every(r => r);
    
    if (!iconCacheValid) {
      console.error('[SQA] Algunos iconos no están disponibles. Verifica el directorio Media/');
    } else {
      console.log('[SQA] Validación de iconos completada exitosamente');
    }
  } catch (e) {
    console.error('[SQA] Error durante validación de iconos:', e.message);
    iconCacheValid = false;
  }
}

/**
 * Actualiza el icono de la extensión según el tema
 * @param {string} theme - 'dark' o 'light'
 */
function actualizarIcono(theme) {
  try {
    const isDark = theme === 'dark';
    const iconPaths = isDark ? ICON_CACHE.dark : ICON_CACHE.light;

    chrome.action.setIcon({ path: iconPaths }, () => {
      if (chrome.runtime.lastError) {
        console.error('[SQA] Error aplicando icono:', chrome.runtime.lastError.message);
      } else {
        console.debug(`[SQA] Icono actualizado a tema: ${theme}`);
      }
    });
  } catch (e) {
    console.error('[SQA] Error inesperado en actualizarIcono:', e.message);
  }
}

chrome.tabs.onActivated.addListener((info) => {
    chrome.tabs.get(info.tabId, (tab) => { if (tab) workerState.activeTab = tab; });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (workerState.activeTab && workerState.activeTab.id === tabId) workerState.activeTab = tab;
});

// --- Comandos ---

chrome.commands.onCommand.addListener((command) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        if (command === 'capture-all') executeCapture(tabs[0], "captureAllPageScreenshot");
        else if (command === 'capture-visible') executeCapture(tabs[0], "captureVisibleOnly");
        else if (command === 'capture-area') executeCapture(tabs[0], "captureSelectionEdit");
        else if (command === 'open-viewer') focusDesktopViewer();
    });
});

// --- Mensajes ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || !message.action) return;
    // P1-2: solo mensajes de la propia extensión (misma id). Sin externally_connectable
    // la superficie ya es interna; esto endurece contra spoofing entre contextos.
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
      try { console.warn('[SECURITY_TRACE] Mensaje descartado: sender no confiable', sender.id, message.action); } catch (e) {}
      try { sendResponse({ error: 'unauthorized sender' }); } catch (e) {}
      return;
    }
    
    const handlers = {
      'themeChanged': () => {
        actualizarIcono(message.theme);
        // PERF_POPUP_STARTUP_001: ack con timestamp — la latencia percibida por el
        // popup entre ThemeMessageSent y ThemeMessageAck mide el wake del SW.
        sendResponse({ ok: true, t: Date.now() });
      },
        [ACTIONS.captureAll]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureAllPageScreenshot"));
            else if (message.tab) executeCapture(message.tab, "captureAllPageScreenshot");
            sendResponse({ started: true });
        },
        [ACTIONS.captureVisible]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureVisibleOnly"));
            else if (message.tab) executeCapture(message.tab, "captureVisibleOnly");
            sendResponse({ started: true });
        },
        [ACTIONS.captureArea]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureSelectionEdit"));
            else if (message.tab) executeCapture(message.tab, "captureSelectionEdit");
            sendResponse({ started: true });
        },
        [ACTIONS.openViewer]: () => {
            focusDesktopViewer();
            sendResponse({ ok: true });
        },
        [ACTIONS.getCaptureStatus]: () => {
            sendResponse({ status: { ...captureStatus } });
        },
        [ACTIONS.resetCaptureStatus]: () => {
            const tid = (sender && sender.tab) ? sender.tab.id : captureStatus.tabId;
            if (tid) captureInProgress.delete(tid);
            clearHealingInterval();
            updateCaptureStatus({ active: false, mode: null, progress: 0, phase: 'idle', message: '', error: '', tabId: null });
            log({ stage: 'capture-flow', status: 'completed', metadata: { action: 'reset', tabId: tid } });
            sendResponse({ ok: true });
        },
        [ACTIONS.setProgress]: () => {
            const tid = sender.tab ? sender.tab.id : captureStatus.tabId;
            touchHeartbeat();
            // FEATURE_PDF_UX_001: badge X/N solo si el modo activo es PDF.
            // Visible/completa/área/clipboard conservan su mensaje genérico.
            let statusMsg = message.progress >= 100 ? 'Procesando...' : 'Capturando...';
            if (captureStatus.mode === 'pdf') {
                const pageMsg = showPdfPageProgress(message.current, message.total);
                if (pageMsg) statusMsg = pageMsg;
            }
            updateCaptureStatus({
                active: true, progress: message.progress,
                phase: message.progress >= 100 ? 'processing' : 'capturing',
                message: statusMsg,
                tabId: tid
            });
        },
        "captureWarning": () => {
            const tid = (sender && sender.tab) ? sender.tab.id : captureStatus.tabId;
            touchHeartbeat();
            updateCaptureStatus({
                active: true, progress: 99,
                phase: 'capturing',
                message: 'Captura parcial: límite de tamaño superado.',
                tabId: tid
            });
        },
        "captureVisiblePageScreenshot": () => {
            handleVisibleCaptureRequest(message, sender);
        },
        "requestCaptureScreenshot": () => {
            const tabId = sender.tab ? sender.tab.id : workerState.activeTab?.id;
            const imageData = tabId ? captureImageDataByTab.get(tabId) : workerState.nowShotImgData;
            sendResponse({ imageData, y1: message.y1, y2: message.y2 });
            if (tabId) captureImageDataByTab.delete(tabId);
            else workerState.nowShotImgData = '';
            return true;
        },
        "captureVisiblePageScreenshot4Selection": () => {
            handleVisibleCaptureForSelectionRequest(message, sender, false);
        },
        "captureVisiblePageScreenshot4SelectionCopy": () => {
            handleVisibleCaptureForSelectionRequest(message, sender, true);
        },
        "setSelectionCaptureData": () => {
            processFinalImage(message.dataUrl, sender.tab);
            sendResponse({ started: true });
        },
        "pdfCaptureRequest": () => {
            console.log('[pdf] pdfCaptureRequest recibido', { tabId: message.tabId, senderTab: sender.tab && sender.tab.id });
            const targetTab = message.tabId ? null : (sender.tab || workerState.activeTab);
            if (targetTab) {
                captureInProgress.delete(targetTab.id);
                console.log('[pdf] startPdfCapture via targetTab', targetTab.id, targetTab.url);
                startPdfCapture(targetTab);
                sendResponse({ started: true });
            } else if (message.tabId) {
                captureInProgress.delete(message.tabId);
                chrome.tabs.get(message.tabId, (tab) => {
                    if (chrome.runtime.lastError) {
                        console.error('[pdf] tabs.get failed', chrome.runtime.lastError.message);
                        log({ stage: 'pdf', status: 'failed', error: chrome.runtime.lastError.message });
                        return;
                    }
                    if (!tab) { console.error('[pdf] tab not found', message.tabId); return; }
                    console.log('[pdf] startPdfCapture via tabs.get', tab.id, tab.url);
                    startPdfCapture(tab);
                });
                sendResponse({ started: true });
            } else {
                console.warn('[pdf] pdfCaptureRequest sin tabId');
                sendResponse({ started: false });
            }
        },
        "pdfRenderProgress": () => {
            touchHeartbeat();
            const tid = message.tabId || (sender && sender.tab && sender.tab.id);
            // FEATURE_PDF_UX_001: "Página X de N" (offscreen manda current/total).
            const pageMsg = showPdfPageProgress(message.current, message.total);
            updateCaptureStatus({
                active: true, mode: 'pdf', progress: message.progress,
                phase: message.progress >= 100 ? 'processing' : 'capturing',
                message: pageMsg || 'Renderizando PDF...',
                tabId: tid
            });
        },
        // AUDIT_EXTWEB_REAL_PERF_001: breakdown del render offscreen (lo mide pdf-render.js).
        "pdfPerf": () => {
            try { console.log('[PERF]', JSON.stringify(Object.assign({ t: Date.now(), tabId: message.tabId || null, source: 'offscreen' }, message.marks || {}))); } catch (e) {}
            try { sendResponse({ ok: true }); } catch (e) {}
        },
        // PERF_PDF_D2_IMPLEMENTATION: ensamblaje binario (slices Blob, sin base64).
        // Reemplaza a pdfRenderChunk (base64). D2 solo PDF; el resto de flujos intacto.
        "pdfRenderBlobChunk": () => {
            const tabId = message.tabId;
            if (!tabId) { sendResponse({ rtn: 0 }); return; }
            const entry = pdfCaptureChunks.get(tabId);
            if (!entry) { sendResponse({ rtn: 0 }); return; }
            if (!entry.chunks[message.index]) {
                entry.chunks[message.index] = message.blob;
                entry.received++;
            }
            if (!entry.total && message.total) entry.total = message.total;
            if (entry.total > 0 && entry.received === entry.total && allChunksPresent(entry.chunks)) {
                const finalBlob = new Blob(entry.chunks, { type: 'image/png' });
                const activeTab = entry.tab;
                finishPdfCaptureCleanup(tabId);
                touchHeartbeat();
                try { console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId, op: 'pdf-blob-assembled', bytes: finalBlob.size, chunks: entry.total })); } catch (e) {}
                console.log('[PDF_TRACE] PROCESS_FINAL_IMAGE_START', { tabId, bytes: finalBlob.size });
                processFinalImageBlob(finalBlob, activeTab, null);
                console.log('[PDF_TRACE] PROCESS_FINAL_IMAGE_END dispatched', { tabId });
            }
            sendResponse({ rtn: 1, index: message.index });
        },
        "pdfRenderError": () => {
            const tabId = message.tabId;
            pdfCaptureChunks.delete(tabId);
            if (tabId) captureInProgress.delete(tabId);
            log({ stage: 'pdf', status: 'failed', error: message.error || 'unknown pdf error' });
            finishPdfCaptureCleanup(tabId);
            markCaptureError(message.error || 'Error al renderizar PDF.', tabId);
            if (tabId) { pdfPartialFallback.add(tabId); sendPdfVisibleFallback(tabId); }
            sendResponse({ ok: true });
        },
        // BUG_PDF_FILE_001: chunks con los BYTES del PDF local (base64) leídos por el
        // content script en file://. Al completarse se reenvían al offscreen como `data`.
        "pdfLocalPdfChunk": () => {
            const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
            if (!tabId || typeof message.index !== 'number') { try { sendResponse({ rtn: 0 }); } catch (e) {} return; }
            const entry = pdfLocalBuffers.get(tabId);
            if (!entry) { try { sendResponse({ rtn: 0 }); } catch (e) {} return; }
            if (!entry.chunks[message.index]) {
                entry.chunks[message.index] = message.data;
                entry.received++;
            }
            if (!entry.total && message.total) entry.total = message.total;
            touchHeartbeat();
            if (entry.total && entry.received === entry.total && allChunksPresent(entry.chunks)) {
                clearTimeout(entry.timer);
                const b64 = entry.chunks.join('');
                const tab = entry.tab;
                pdfLocalBuffers.delete(tabId);
                console.log('[PDF_TRACE] PDF_LOCAL_BUFFER_COMPLETE', { tabId, length: b64.length });
                pdfRouteLog('route', { tabId, route: 'offscreen-render', via: 'content-relay', bytes: b64.length });
                // Límite práctico de mensaje único al offscreen: si excede, parcial marcado.
                if (b64.length > 40000000) {
                    log({ stage: 'pdf-local', status: 'too-large', tabId });
                    if (tabId) captureInProgress.delete(tabId);
                    finishCapturePerf(tabId);
                    markCaptureError('PDF local demasiado grande para render completo.', tabId);
                    pdfPartialFallback.add(tabId);
                    sendPdfVisibleFallback(tabId);
                } else {
                    markCapturePerf(tabId, 'local-bytes-received', { length: b64.length });
                    beginOffscreenPdfRender(tabId, tab, { data: b64, fileName: (tab && tab.title) || '' });
                }
            }
            try { sendResponse({ rtn: 1, index: message.index }); } catch (e) {}
        },
        "pdfLocalPdfError": () => {
            const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
            const entry = tabId ? pdfLocalBuffers.get(tabId) : null;
            if (entry) clearTimeout(entry.timer);
            if (tabId) pdfLocalBuffers.delete(tabId);
            log({ stage: 'pdf-local', status: 'failed', error: message.error || 'read error' });
            if (tabId) captureInProgress.delete(tabId);
            if (tabId) finishCapturePerf(tabId);
            markCaptureError('No se pudo leer el PDF local: ' + (message.error || 'error') + '.', tabId);
            if (tabId) { pdfPartialFallback.add(tabId); sendPdfVisibleFallback(tabId); }
            try { sendResponse({ ok: true }); } catch (e) {}
        },
        "pdfInPageError": () => {
            const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
            const t = tabId ? pdfInPageTimerById.get(tabId) : null;
            if (t) clearTimeout(t);
            if (tabId) pdfInPageTimerById.delete(tabId);
            failPdfRender(tabId, 'Render en página: ' + (message.error || 'error'));
            try { sendResponse({ ok: true }); } catch (e) {}
        },
        // BUG_PDF_WORKER_001_CAPTURE: refleja trazas del content en la consola del SW.
        "pdfWorkerTrace": () => {
            try { console.log(String(message.text || '[PDF_WORKER_TRACE] (vacío)').slice(0, 500)); } catch (e) {}
            try { sendResponse({ ok: true }); } catch (e) {}
        }
    };

    if (message.action === 'processFinalImageBlob') {
        // AUDIT_EXTWEB_REAL_PERF_001: stitchMs (página completa) y renderMs (PDF en
        // página) los mide el content; aquí se publican en la consola del SW.
        try {
            const tid = (sender && sender.tab) ? sender.tab.id : null;
            if (message.stitchMs != null) console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId: tid, op: 'stitching-total', ms: message.stitchMs }));
            if (message.renderMs != null) console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId: tid, op: 'inpage-render-total', ms: message.renderMs }));
            // PERF_CAPTURE_FULL_D2_EVALUATION: conversión FileReader medida en content.
            if (message.convMs != null) console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId: tid, op: 'content-FileReader', ms: message.convMs, bytes: message.convBytes || 0, outLen: message.convOut || 0 }));
        } catch (e) {}
        processFinalImageBlob(message.imageBlob, sender.tab, sendResponse, message.browserName, message.browserVersion, message.os);
        return true;
    }

    if (message.action.startsWith('imgDataChunk')) {
        handleImageChunk(message, sender, sendResponse);
        return true;
    }

    if (handlers[message.action]) {
        log({ stage: 'capture', status: 'start', metadata: { action: message.action } });
        armHealingInterval();
        touchHeartbeat();
        return handlers[message.action]();
    }
  } catch (e) {
    console.error('[SQA] Error manejando mensaje:', message?.action, e.message);
    sendResponse({ error: e.message });
  }
});

function scheduleTempImageCleanup(chunkId) {
    const storage = tempImageStorage.get(chunkId);
    if (!storage) return;
    if (storage.cleanupTimer) clearTimeout(storage.cleanupTimer);
    storage.cleanupTimer = setTimeout(() => {
        tempImageStorage.delete(chunkId);
    }, TEMP_IMAGE_STORAGE_TTL_MS);
}

function clearTempImageCleanup(chunkId) {
    const storage = tempImageStorage.get(chunkId);
    if (storage && storage.cleanupTimer) clearTimeout(storage.cleanupTimer);
}

function destroyChunkStorage(chunkId) {
    clearTempImageCleanup(chunkId);
    tempImageStorage.delete(chunkId);
}

function startCapturePerf(tabId, mode) {
    if (!tabId) return;
    const now = performance.now();
    capturePerfByTab.set(tabId, {
        mode,
        startedAt: now,
        lastMarkAt: now,
        marks: []
    });
}

function markCapturePerf(tabId, stage, extra = {}) {
    const entry = capturePerfByTab.get(tabId);
    if (!entry) return;
    const now = performance.now();
    entry.marks.push({
        stage,
        elapsedMs: Math.round(now - entry.startedAt),
        deltaMs: Math.round(now - entry.lastMarkAt),
        ...extra
    });
    entry.lastMarkAt = now;
}

function finishCapturePerf(tabId) {
    const entry = capturePerfByTab.get(tabId);
    if (!entry) return;
    // AUDIT_EXTWEB_REAL_PERF_001: vuelca la tabla de marcas (tiempos reales por etapa).
    try {
        console.log('[PERF]', JSON.stringify({ t: Date.now(), tabId, mode: entry.mode, totalMs: Math.round(performance.now() - entry.startedAt), marks: entry.marks }));
    } catch (e) {}
    capturePerfByTab.delete(tabId);
}

function permTrace(api, url, action){ try{ console.log(`[PERMISSION_TRACE] API=${api} URL=${url} Action=${action} Origin=sqasa.co`); }catch{} }
async function focusDesktopViewer() {
    permTrace('fetch','http://127.0.0.1:3000/api/show','focusDesktopViewer:fetch');
    for (let attempt = 0; attempt < 5; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 800);
        try {
            const resp = await fetch(VIEWER_API_BASE_URL + '/api/show', { signal: controller.signal });
            clearTimeout(timeoutId);
            if (resp.ok) return;
        } catch (e) {
            clearTimeout(timeoutId);
            if (attempt < 4) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
    }

    // QW: protocolo eliminado del flujo automático — solo warning, sin prompt
    console.warn('[focusDesktopViewer] Viewer no disponible en /api/show tras 5 intentos — sin protocolo, captura continúa');
    permTrace('fetch-failed','http://127.0.0.1:3000/api/show','focusDesktopViewer:warning-sin-protocolo');
}

async function sendTabMessage(tabId, message) {
    return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}


// PERF_CAPTURE_FULL_D2_EVALUATION: heap JS en MB (null si no disponible).
function heapMB() {
    try { return (performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; }
    catch (e) { return null; }
}

async function blobToDataUrl(blob) {
    // PERF_CAPTURE_FULL_D2_EVALUATION: medición Blob→DataURL (no cambia el flujo).
    const t0 = performance.now();
    const h0 = heapMB();
    const bytes = (blob && blob.size) || 0;
    try {
        const out = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('No se pudo leer el blob'));
            reader.readAsDataURL(blob);
        });
        try { console.log('[PERF]', JSON.stringify({ t: Date.now(), op: 'blob-to-dataURL-sw', ms: Math.round(performance.now() - t0), bytes, outLen: (out && out.length) || 0, heapBefore: h0, heapAfter: heapMB() })); } catch (e) {}
        return out;
    } catch (e) {
        try { console.log('[PERF]', JSON.stringify({ t: Date.now(), op: 'blob-to-dataURL-sw', failed: true, ms: Math.round(performance.now() - t0), bytes })); } catch (_) {}
        throw e;
    }
}

async function uploadCaptureBinary(blob, tab, browserName, browserVersion, os) {
    if (!(blob instanceof Blob)) {
        throw new Error('uploadCaptureBinary: blob is not a Blob');
    }

    const captureTitle = tab && tab.title ? tab.title : 'Captura SQA';
    const url = tab && tab.url ? tab.url : '';
    const timestamp = new Date().toISOString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const sysInfo = browserName ? { browser: `${browserName} v${browserVersion}`, os: os || 'N/A' } : await swGetSystemInfo();
    try {
        const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-binary', {
            method: 'POST',
            headers: await getAuthHeaders({
                'Content-Type': blob.type || 'image/png',
                'X-SQA-Url': encodeURIComponent(url),
                'X-SQA-Title': encodeURIComponent(captureTitle),
                'X-SQA-Timestamp': timestamp,
                'X-SQA-Browser': encodeURIComponent(sysInfo.browser),
                'X-SQA-OS': encodeURIComponent(sysInfo.os),
                'X-SQA-Has-Header': 'false'
            }),
            body: blob,
            signal: controller.signal
        });
        let autoCopyOnCapture = null;
        try {
            const apiJson = await resp.clone().json();
            autoCopyOnCapture = apiJson && apiJson.autoCopyOnCapture;
        } catch (e) {}
        resp._autoCopyOnCapture = autoCopyOnCapture;
        return resp;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function getBlobFromDataUrl(dataUrl, tag) {
    // PERF_CAPTURE_FULL_D2_EVALUATION: medición DataURL→Blob (no cambia el flujo).
    const t0 = performance.now();
    const h0 = heapMB();
    const inLen = (dataUrl && dataUrl.length) || 0;
    const done = (blob, via) => {
        try { console.log('[PERF]', JSON.stringify({ t: Date.now(), op: 'dataURL-to-blob-sw', tag: tag || null, ms: Math.round(performance.now() - t0), inLen, bytes: (blob && blob.size) || 0, via, heapBefore: h0, heapAfter: heapMB() })); } catch (e) {}
        return blob;
    };
    try {
        const commaIdx = dataUrl.indexOf(',');
        const mimeMatch = dataUrl.substring(0, commaIdx).match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const raw = atob(dataUrl.substring(commaIdx + 1));
        const len = raw.length;
        const u8arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8arr[i] = raw.charCodeAt(i);
        return done(new Blob([u8arr], { type: mime }), 'atob-loop');
    } catch (e) {
        try {
            const response = await fetch(dataUrl);
            return done(await response.blob(), 'fetch-fallback');
        } catch (e2) {
            try { console.log('[PERF]', JSON.stringify({ t: Date.now(), op: 'dataURL-to-blob-sw', tag: tag || null, failed: true, ms: Math.round(performance.now() - t0), inLen })); } catch (_) {}
            return null;
        }
    }
}


// =========================================================================
// LÓGICA DE CAPTURA FULL-PAGE DE PDF (pdf.js + offscreen document)
// =========================================================================

async function ensurePdfRenderDoc() {
    // Reusar el singleton creado por setupKeepAlive; esperar su lock si está en creación
    if (_offscreenReadyPromise) await _offscreenReadyPromise.catch(() => {});
    if (typeof chrome.runtime.getContexts === 'function') {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (contexts.length > 0) {
            console.log('[pdf] offscreen ya existe, reuso', contexts[0].documentUrl);
            return true;
        }
    }
    console.log('[pdf] creando offscreen multipropósito (ensurePdfRenderDoc fallback)');
    await setupKeepAlive();
    return true;
}

function finishPdfCaptureCleanup(tabId) {
    clearTimeout(pdfCaptureTimerById && pdfCaptureTimerById.get(tabId));
    if (pdfCaptureTimerById) pdfCaptureTimerById.delete(tabId);
    pdfCaptureChunks.delete(tabId);
}

const pdfCaptureTimerById = new Map();

function isPdfPageTab(tab) {
    if (!tab || !tab.url) return false;
    const url = tab.url || '';
    if (url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) return true;
    if (/\.pdf(\?.*)?(#.*)?$/i.test(url) || /application\/pdf/i.test(url)) return true;
    if (tab.title && /\.pdf($|[?#])/i.test(tab.title)) return true;
    // Fallback: si la pestaña es PDF viewer sin .pdf en URL (blob: con content-type)
    if (url.startsWith('blob:') && tab.title && tab.title.toLowerCase().includes('.pdf')) return true;
    return false;
}

async function sendPdfVisibleFallback(tabId) {
    try {
        const tab = await new Promise((resolve) => {
            chrome.tabs.get(tabId, (t) => { if (chrome.runtime.lastError) resolve(null); else resolve(t); });
        });
        if (!tab) return;
        pdfRouteLog('fallback-visible-requested', pdfUrlInfo(tab));
        captureInProgress.add(tabId);
        const isLoaded = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'checkContentLoaded' }, (res) => {
                if (chrome.runtime.lastError || !res || !res.loaded) resolve(false);
                else resolve(true);
            });
        });
        if (!isLoaded) {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => null);
            await new Promise(r => setTimeout(r, 150));
        }
        chrome.tabs.sendMessage(tabId, { action: 'captureVisibleOnly' }, () => {});
    } catch (e) {
        log({ stage: 'pdf-fallback', status: 'failed', error: e.message });
    }
}

// Monta el ensamblaje de chunks PNG, arma el timeout de 90s y despacha el render
// al offscreen con retry. `extra` permite adjuntar `data` (bytes locales file://).
// BUG_PDF_FILE_001: extraído de startPdfCapture para reutilizar en la ruta local.
// BUG_PDF_001c: el dispatch a offscreen puede fallar con "Receiving end does not
// exist" (documento cerrado tras suspensión del SW o módulo sin listener).
// Ping de vida + recreación + fallo con fallback parcial (nunca colgado en silencio).
function pingOffscreenPdf(timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 2500);
        try {
            chrome.runtime.sendMessage({ action: 'sqaPing' }, (resp) => {
                if (done) return;
                done = true;
                clearTimeout(to);
                if (chrome.runtime.lastError) resolve(null);
                else resolve(resp || null);
            });
        } catch (e) {
            if (!done) { done = true; clearTimeout(to); resolve(null); }
        }
    });
}

async function ensurePdfRenderAlive() {
    if (typeof chrome === 'undefined' || !chrome.offscreen) return false;
    let pong = await pingOffscreenPdf(2500);
    if (pong && pong.pdf) return true;
    console.warn('[pdf] offscreen sin respuesta — recreando documento');
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
    try { _offscreenReadyPromise = null; } catch (e) {}
    try { await setupKeepAlive(); } catch (e) {}
    await new Promise(r => setTimeout(r, 800));
    pong = await pingOffscreenPdf(2500);
    return !!(pong && pong.pdf);
}

function failPdfRender(tabId, reason) {
    pdfRouteLog('fallback-visible', { tabId: tabId || null, reason: reason || 'unspecified' });
    try { finishPdfCaptureCleanup(tabId); } catch (e) {}
    if (tabId && pdfInPageTimerById.has(tabId)) {
        try { clearTimeout(pdfInPageTimerById.get(tabId)); } catch (e) {}
        pdfInPageTimerById.delete(tabId);
    }
    if (tabId) captureInProgress.delete(tabId);
    try { finishCapturePerf(tabId); } catch (e) {}
    log({ stage: 'pdf', status: 'failed', error: reason || 'offscreen unavailable' });
    try { markCaptureError(reason || 'No se pudo renderizar el PDF.', tabId); } catch (e) {}
    if (tabId) { pdfPartialFallback.add(tabId); try { sendPdfVisibleFallback(tabId); } catch (e) {} }
}

// BUG_PDF_FILE_001c: render pdf.js con la build UMD dentro del content script
// (canvas DOM), sin depender del documento offscreen. `dataB64` son los bytes del
// PDF en base64 (ruta local) o null (se descargan aquí, con permiso <all_urls>).
async function renderInPageFallback(tabId, tab, dataB64) {
    try { finishPdfCaptureCleanup(tabId); } catch (e) {}
    pdfRouteLog('route', Object.assign(pdfUrlInfo(tab), { route: 'inpage-render', hasData: !!dataB64 }));
    try {
        if (!tabId || !tab || !tab.url) throw new Error('Tab no válido para render en página');
        let b64 = dataB64 || null;
        if (!b64) {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 60000);
            try {
                const resp = await fetch(tab.url, { signal: ctrl.signal });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const buf = await resp.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
                b64 = btoa(bin);
            } finally {
                clearTimeout(to);
            }
        }
        if (!b64) throw new Error('Sin datos PDF');
        if (b64.length > 40000000) throw new Error('PDF demasiado grande para render en página');
        // lib UMD siempre (idempotente); content solo si falta (guard anti re-inyección).
        await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/pdf.min.js'] }).catch(() => null);
        const isLoaded = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'checkContentLoaded' }, (res) => {
                if (chrome.runtime.lastError || !res || !res.loaded) resolve(false);
                else resolve(true);
            });
        });
        if (!isLoaded) {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => null);
            await new Promise(r => setTimeout(r, 300));
        }
        updateCaptureStatus({ active: true, mode: 'pdf', progress: 12, phase: 'capturing', message: 'Renderizando PDF en página...', error: '', tabId });
        touchHeartbeat();
        pdfInPageTimerById.set(tabId, setTimeout(() => {
            pdfInPageTimerById.delete(tabId);
            failPdfRender(tabId, 'Tiempo agotado en render en página.');
        }, CHUNK_TIMEOUT_MS * 3));
        markCapturePerf(tabId, 'inpage-dispatched');
        // BUG_PDF_WORKER_001: el content en file:// tiene origen opaco y su fetch del
        // worker muere con "Failed to fetch". El SW (origen extensión) lo lee y lo adjunta.
        let workerText = sqaPdfWorkerTextCache;
        if (!workerText) {
            try {
                const wresp = await fetch(chrome.runtime.getURL('lib/pdf.worker.min.js'));
                if (wresp.ok) {
                    workerText = await wresp.text();
                    if (workerText && workerText.length > 100000) sqaPdfWorkerTextCache = workerText;
                    else workerText = null;
                }
} catch (e) {
            log({ stage: 'pdf', status: 'worker-text-failed', error: e.message });
            workerText = null;
        }
    }
    // BUG_PDF_FILE_001: enviar el Blob del worker (no el texto) para que el
    // content script cree blob:chrome-extension://... en lugar de blob:null/...
    let workerBlob = null;
    if (workerText) {
        workerBlob = new Blob([workerText], { type: 'text/javascript' });
    }
    chrome.tabs.sendMessage(tabId, { action: 'renderPdfInPage', data: b64, workerBlob }, () => {
            if (chrome.runtime.lastError) {
                const t = pdfInPageTimerById.get(tabId);
                if (t) clearTimeout(t);
                pdfInPageTimerById.delete(tabId);
                failPdfRender(tabId, 'No se pudo iniciar render en página: ' + chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        failPdfRender(tabId, (e && e.message) || 'renderInPageFallback');
    }
}

async function beginOffscreenPdfRender(tabId, tab, extra) {
    try {
    pdfCaptureChunks.set(tabId, { chunks: [], received: 0, total: null, tab });
    const timer = setTimeout(() => {
        if (!pdfCaptureChunks.has(tabId)) return;
        finishPdfCaptureCleanup(tabId);
        log({ stage: 'pdf', status: 'timeout', tabId });
        if (tabId) captureInProgress.delete(tabId);
        finishCapturePerf(tabId);
        markCaptureError('Tiempo agotado al renderizar el PDF.', tabId);
        pdfPartialFallback.add(tabId);
        sendPdfVisibleFallback(tabId);
    }, CHUNK_TIMEOUT_MS * 3);
    pdfCaptureTimerById.set(tabId, timer);

    // Puerta de vida: si el offscreen no responde (suspendido/sin listener),
    // recrearlo antes de despachar; si sigue muerto, fallo con fallback parcial.
    const alive = await ensurePdfRenderAlive();
    if (!alive) {
        console.warn('[pdf] offscreen no disponible — fallback a render en página');
        await renderInPageFallback(tabId, tab, (extra && extra.data) || null);
        return;
    }
    pdfRouteLog('route', Object.assign(pdfUrlInfo(tab), { route: 'offscreen-render', via: (extra && extra.data) ? 'with-data' : 'fetch-url' }));

    // Enviar con retry + log para diagnosticar offscreen singleton
    const sendPdfRender = (attempt = 1) => {
        try {
            chrome.runtime.sendMessage(Object.assign({
                action: 'renderPdf',
                pdfUrl: tab.url,
                tabId,
                url: tab.url,
                title: tab.title || ''
            }, extra || {}), (resp) => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[pdf] sendMessage attempt ${attempt} failed: ${chrome.runtime.lastError.message}`);
                        if (attempt < 3) setTimeout(() => sendPdfRender(attempt + 1), 500);
                        else { renderInPageFallback(tabId, tab, (extra && extra.data) || null); }
                    } else {
                    console.log(`[pdf] renderPdf dispatched to offscreen (attempt ${attempt})`, resp);
                }
            });
        } catch (e) {
            console.warn('[pdf] sendMessage exception', e.message);
            log({ stage: 'pdf', status: 'failed', error: e.message });
        }
    };
    sendPdfRender();
    touchHeartbeat(); // asegurar watchdog no dispare prematuramente
    markCapturePerf(tabId, 'render-request-sent');
    } catch (e) {
        failPdfRender(tabId, (e && e.message) || 'beginOffscreenPdfRender');
    }
}

async function startPdfCapture(tab) {
    const tabId = tab && tab.id;
    if (!tabId || !tab.url) return;
    if (captureInProgress.has(tabId)) return;
    console.log('[pdf] startPdfCapture invoked', tabId, tab.url);
    pdfRouteLog('start', Object.assign(pdfUrlInfo(tab), { contentType: tab.contentType || null }));
    // BUG_PDF_FILE_001: file:// no se puede leer desde offscreen/SW sin el toggle
    // "Permitir acceso a URLs de archivo". Con el toggle ON, el content script
    // (inyectado en file://) sí puede leer los bytes y enviarlos al pipeline pdf.js.
    if (tab.url.startsWith('file://')) {
        updateCaptureStatus({ active: true, mode: 'pdf', progress: 5, phase: 'starting', message: 'PDF local — leyendo archivo...', error: '', tabId });
        armHealingInterval();
        touchHeartbeat();
        let fileAccess = false;
        try {
            fileAccess = await new Promise((resolve) => {
                try { chrome.extension.isAllowedFileSchemeAccess(resolve); }
                catch (e) { resolve(false); }
            });
        } catch (e) { fileAccess = false; }
        if (!fileAccess) {
            console.warn('[pdf] file:// sin acceso a URLs de archivo — fallback a visible parcial');
            pdfRouteLog('route', Object.assign(pdfUrlInfo(tab), { route: 'fallback-visible', reason: 'no-file-access' }));
            updateCaptureStatus({ active: true, mode: 'pdf', progress: 10, phase: 'capturing', message: 'Activa "Permitir acceso a URLs de archivo" en chrome://extensions para capturar el PDF completo.', error: '', tabId });
            pdfPartialFallback.add(tabId);
            setTimeout(() => sendPdfVisibleFallback(tabId), 300);
            return;
        }
        captureInProgress.add(tabId);
        workerState.activeTab = tab;
        startCapturePerf(tabId, 'pdf-local');
        markCapturePerf(tabId, 'started', { url: tab.url });
        // Intento 1 (BUG_PDF_FILE_001b): fetch directo desde el SW. El content script
        // hereda el origen file: opaco y su fetch muere con "unique security origins"
        // aunque el toggle esté ON; el SW tiene origen chrome-extension:// y con el
        // toggle "Permitir acceso a URLs de archivo" el fetch sí está permitido.
        try {
            updateCaptureStatus({ active: true, mode: 'pdf', progress: 10, phase: 'capturing', message: 'Leyendo PDF local...', error: '', tabId });
            touchHeartbeat();
            const ctrl = new AbortController();
            const ctrlTimer = setTimeout(() => ctrl.abort(), 60000);
            let b64 = '';
            try {
                const resp = await fetch(tab.url, { signal: ctrl.signal });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const buf = await resp.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let bin = '';
                for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
                b64 = btoa(bin);
            } finally {
                clearTimeout(ctrlTimer);
            }
            if (!b64 || b64.length === 0) throw new Error('Archivo vacío');
            if (b64.length > 40000000) {
                log({ stage: 'pdf-local', status: 'too-large', tabId });
                if (tabId) captureInProgress.delete(tabId);
                finishCapturePerf(tabId);
                markCaptureError('PDF local demasiado grande para render completo.', tabId);
                pdfPartialFallback.add(tabId);
                sendPdfVisibleFallback(tabId);
                return;
            }
            markCapturePerf(tabId, 'local-bytes-read', { length: b64.length });
            pdfRouteLog('route', Object.assign(pdfUrlInfo(tab), { route: 'offscreen-render', via: 'sw-fetch', bytes: b64.length }));
            touchHeartbeat();
            beginOffscreenPdfRender(tabId, tab, { data: b64, fileName: tab.title || '' });
            return;
        } catch (swErr) {
            log({ stage: 'pdf-local', status: 'sw-fetch-failed', error: swErr && swErr.message });
            // Intento 2: relay vía content script (inyectable con el toggle ON).
        }
        try {
            const isLoaded = await new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, { action: 'checkContentLoaded' }, (res) => {
                    if (chrome.runtime.lastError || !res || !res.loaded) resolve(false);
                    else resolve(true);
                });
            });
            if (!isLoaded) {
                await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => null);
                await new Promise(r => setTimeout(r, 200));
            }
            updateCaptureStatus({ active: true, mode: 'pdf', progress: 10, phase: 'capturing', message: 'Leyendo PDF local...', error: '', tabId });
            touchHeartbeat();
            pdfLocalBuffers.set(tabId, {
                chunks: [], received: 0, total: null, tab,
                timer: setTimeout(() => {
                    if (!pdfLocalBuffers.has(tabId)) return;
                    const entry = pdfLocalBuffers.get(tabId);
                    if (entry) clearTimeout(entry.timer);
                    pdfLocalBuffers.delete(tabId);
                    log({ stage: 'pdf-local', status: 'timeout', tabId });
                    if (tabId) captureInProgress.delete(tabId);
                    finishCapturePerf(tabId);
                    markCaptureError('Tiempo agotado al leer el PDF local.', tabId);
                    pdfPartialFallback.add(tabId);
                    sendPdfVisibleFallback(tabId);
                }, CHUNK_TIMEOUT_MS * 3)
            });
            markCapturePerf(tabId, 'local-bytes-requested');
            chrome.tabs.sendMessage(tabId, { action: 'readLocalPdfBytes' }, () => {
                if (chrome.runtime.lastError) {
                    const entry = pdfLocalBuffers.get(tabId);
                    if (entry) clearTimeout(entry.timer);
                    pdfLocalBuffers.delete(tabId);
                    log({ stage: 'pdf-local', status: 'failed', error: chrome.runtime.lastError.message });
                    if (tabId) captureInProgress.delete(tabId);
                    finishCapturePerf(tabId);
                    markCaptureError('No se pudo leer el PDF local: ' + chrome.runtime.lastError.message, tabId);
                    pdfPartialFallback.add(tabId);
                    sendPdfVisibleFallback(tabId);
                }
            });
        } catch (e) {
            const entry = pdfLocalBuffers.get(tabId);
            if (entry) clearTimeout(entry.timer);
            pdfLocalBuffers.delete(tabId);
            log({ stage: 'pdf-local', status: 'failed', error: e.message });
            if (tabId) captureInProgress.delete(tabId);
            finishCapturePerf(tabId);
            markCaptureError('No se pudo leer el PDF local: ' + e.message, tabId);
            pdfPartialFallback.add(tabId);
            sendPdfVisibleFallback(tabId);
        }
        return;
    }

    captureInProgress.add(tabId);
    workerState.activeTab = tab;
    startCapturePerf(tabId, 'pdf-capture');
    markCapturePerf(tabId, 'started', { url: tab.url });

    updateCaptureStatus({
        active: true, mode: 'pdf', progress: 5, phase: 'starting',
        message: 'Renderizando documento PDF...', error: '', tabId
    });
    armHealingInterval();
    touchHeartbeat();

    try {
        await ensurePdfRenderDoc();
        // Esperar a que el offscreen multipropósito esté realmente listo (scripts cargados)
        for (let i = 0; i < 5; i++) {
            const ctxs = typeof chrome.runtime.getContexts === 'function' ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
            if (ctxs.length > 0) break;
            await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 300)); // margen para que pdf-render.js registre onMessage
        beginOffscreenPdfRender(tabId, tab, {});
    } catch (err) {
        finishPdfCaptureCleanup(tabId);
        log({ stage: 'pdf', status: 'failed', error: err.message });
        if (tabId) captureInProgress.delete(tabId);
        finishCapturePerf(tabId);
        markCaptureError('No se pudo inicializar el render de PDF: ' + err.message, tabId);
        pdfPartialFallback.add(tabId);
        sendPdfVisibleFallback(tabId);
    }
}
// Exponer para capture-logic direct call (MV3 SW runtime.sendMessage a sí mismo no fiable)
if (typeof globalThis !== 'undefined') globalThis.__sqaStartPdfCapture = startPdfCapture;

// --- Lógica de Captura Visible Avanzada ---

function isBlankImageData(dataUrl) {
    try {
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx === -1) return false;
        const raw = atob(dataUrl.substring(commaIdx + 1));
        if (raw.length < 100) return true;
        const sample = raw.charCodeAt(0);
        for (let i = 1; i < Math.min(raw.length, 200); i++) {
            if (raw.charCodeAt(i) !== sample) return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function handleVisibleCaptureRequest(message, sender) {
    const targetTabId = sender.tab ? sender.tab.id : (workerState.activeTab ? workerState.activeTab.id : null);
    if (!targetTabId) return;

    try {
        startCapturePerf(targetTabId, 'visible-capture');
        markCapturePerf(targetTabId, 'capture-format-selected', { format: CAPTURE_IMAGE_FORMAT });
        const checkTab = await new Promise(resolve => {
            chrome.tabs.get(targetTabId, (tab) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(tab);
            });
        });
        if (!checkTab) {
            finishCapturePerf(targetTabId, 'tab-not-found');
            return;
        }

        // [REMOVED] waitForThumbnailHidden - no floating UI
        markCapturePerf(targetTabId, 'thumbnail-hidden');

        const windowId = checkTab.windowId;

        let attempt = 0;
        const MAX = 10;
        
        const tryCapture = async () => {
            attempt++;
            await waitForCaptureQuota();
            chrome.tabs.captureVisibleTab(windowId, { format: CAPTURE_IMAGE_FORMAT }, (data) => {
                if (chrome.runtime.lastError) {
                    if (attempt < MAX) setTimeout(tryCapture, 150);
                    else {
                        finishCapturePerf(targetTabId, 'capture-error', { message: chrome.runtime.lastError.message });
                        markCaptureError(chrome.runtime.lastError.message, targetTabId);
                    }
                    return;
                }
                
                if (isBlankImageData(data)) {
                    if (attempt < MAX) {
                        const backoff = 150 + attempt * 100;
                        console.warn(`[SQA] Captura en blanco detectada (intento ${attempt}), reintentando en ${backoff}ms...`);
                        setTimeout(tryCapture, backoff);
                    } else {
                        finishCapturePerf(targetTabId, 'blank-capture', { attempt });
                    }
                    return;
                }
                
                captureImageDataByTab.set(targetTabId, data);
                markCapturePerf(targetTabId, 'visible-captured', { attempt });
                chrome.tabs.sendMessage(targetTabId, {
                    action: 'getNowShotImgData',
                    y1: message.y1, y2: message.y2,
                    nextPageData: message.nextPageData
                }, () => {
                    if (chrome.runtime.lastError) {
                        finishCapturePerf(targetTabId, 'content-bridge-error', { message: chrome.runtime.lastError.message });
                        markCaptureError(chrome.runtime.lastError.message, targetTabId);
                    } else {
                        markCapturePerf(targetTabId, 'content-bridge-dispatched');
                    }
                });
            });
        };
        tryCapture();
    } catch (e) {
        finishCapturePerf(targetTabId, 'exception', { message: e.message });
        markCaptureError(e.message, targetTabId);
    }
}

async function handleVisibleCaptureForSelectionRequest(message, sender, forCopy = false) {
    const targetTabId = sender.tab ? sender.tab.id : (workerState.activeTab ? workerState.activeTab.id : null);
    if (!targetTabId) return;

    try {
        const checkTab = await new Promise(resolve => {
            chrome.tabs.get(targetTabId, (tab) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(tab);
            });
        });
        if (!checkTab) return;

        // [REMOVED] waitForThumbnailHidden - no floating UI

        const windowId = checkTab.windowId;
        chrome.tabs.captureVisibleTab(windowId, { format: CAPTURE_IMAGE_FORMAT }, (data) => {
            if (chrome.runtime.lastError) {
                console.error("Selection capture error:", chrome.runtime.lastError.message);
                return;
            }
            
            chrome.tabs.sendMessage(targetTabId, {
                action: 'croppedImageResult',
                dataUrl: data,
                forCopy: forCopy ? 1 : 0
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending croppedImageResult back:", chrome.runtime.lastError.message);
                }
            });
        });
    } catch (e) {
        console.error("Exception in handleVisibleCaptureForSelectionRequest:", e);
    }
}

// --- Manejo de Chunks de Imagen Optimizado ---

function allChunksPresent(storage) {
    for (let i = 0; i < storage.chunks.length; i++) {
        if (storage.chunks[i] === undefined || storage.chunks[i] === null) return false;
    }
    return true;
}

function handleImageChunk(message, sender, sendResponse) {
    const chunkId = message.action;

    if (!message || typeof message.dataIndex !== 'number' || typeof message.dataLength !== 'number') {
        sendResponse({ rtn: 0, error: 'invalid chunk message' });
        return;
    }

    if (message.dataIndex === 0 && !tempImageStorage.has(chunkId)) {
        tempImageStorage.set(chunkId, {
            chunks: new Array(message.dataLength),
            receivedCount: 0,
            cleanupTimer: null,
            captureTimeout: setTimeout(() => {
                destroyChunkStorage(chunkId);
            }, CHUNK_TIMEOUT_MS)
        });
    }

    const storage = tempImageStorage.get(chunkId);
    if (!storage) {
        sendResponse({ rtn: 1, index: message.dataIndex });
        return;
    }

    if (storage.chunks[message.dataIndex] === undefined) {
        storage.chunks[message.dataIndex] = message.dataItem;
        storage.receivedCount++;
    }
    scheduleTempImageCleanup(chunkId);

    if (storage.receivedCount === message.dataLength && allChunksPresent(storage)) {
        clearTimeout(storage.captureTimeout);
        if (sender.tab && sender.tab.id) {
            markCapturePerf(sender.tab.id, 'all-chunks-received', { totalChunks: message.dataLength });
        }
        log({ stage: 'capture', status: 'success', metadata: { totalChunks: message.dataLength } });
        touchHeartbeat();
        const fullData = storage.chunks.join('');
        destroyChunkStorage(chunkId);
        processFinalImage(fullData, sender.tab);
    }
    sendResponse({ rtn: 1, index: message.dataIndex });
}

async function processFinalImage(imageData, tab) {
    console.log('[PDF_TRACE] PROCESS_FINAL_IMAGE_START', {tabId: tab?.id, length: imageData?.length});
    if (!imageData || typeof imageData !== 'string') {
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        return;
    }
    const blob = await getBlobFromDataUrl(imageData, 'processFinalImage');
    if (!blob) {
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        return;
    }
    const dataUrl = imageData;
    console.log('[PDF_TRACE] PROCESS_FINAL_IMAGE_END pre-finalize', {tabId: tab?.id});
    await _finalizeCapture(blob, dataUrl, tab);
    console.log('[PDF_TRACE] PROCESS_FINAL_IMAGE_END post-finalize', {tabId: tab?.id});
}

async function processFinalImageBlob(imageBlobOrData, tab, sendResponse, browserName, browserVersion, os) {
    // BUG_PDF_FILE_001c: si el PNG viene del render en página, su timer ya cumplió.
    if (tab && tab.id && pdfInPageTimerById.has(tab.id)) {
        try { clearTimeout(pdfInPageTimerById.get(tab.id)); } catch (e) {}
        pdfInPageTimerById.delete(tab.id);
    }
    let imageBlob = imageBlobOrData;
    let imageDataUrl = '';

    if (typeof imageBlobOrData === 'string' && imageBlobOrData.startsWith('data:')) {
        imageDataUrl = imageBlobOrData;
        imageBlob = await getBlobFromDataUrl(imageBlobOrData, 'finalize-blob-dataURL');
    }

    if (!(imageBlob instanceof Blob) && imageDataUrl) {
        imageBlob = await getBlobFromDataUrl(imageDataUrl, 'finalize-blob-lazy');
    }

    if (!(imageBlob instanceof Blob)) {
        // BUG_PDF_DD_001: visibilidad del fallo de deserialización (Blob -> {}).
        try { console.error('[PDF_TRACE] PROCESS_FINAL_IMAGE_BLOB_INVALID', { tabId: tab && tab.id, type: typeof imageBlobOrData, ctor: imageBlobOrData && imageBlobOrData.constructor && imageBlobOrData.constructor.name }); } catch (e) {}
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        if (sendResponse) sendResponse({ ok: false });
        return;
    }

    // PERF_PDF_D2_IMPLEMENTATION: entrada Blob (solo rutas PDF) → sin DataURL aquí;
    // _finalizeCapture lo deriva perezosamente solo si el upload binario falla.
    const inputWasBlob = (imageBlob instanceof Blob) && !(typeof imageBlobOrData === 'string');
    if (!imageDataUrl && !inputWasBlob) imageDataUrl = await blobToDataUrl(imageBlob);
    await _finalizeCapture(imageBlob, imageDataUrl, tab, browserName, browserVersion, os);
    if (sendResponse) { try { sendResponse({ ok: true }); } catch (e) {} }
}

async function _finalizeCapture(imageBlob, imageDataUrl, tab, browserName, browserVersion, os) {
    const tabId = tab && tab.id ? tab.id : null;
    const startMs = performance.now();
    let uploadOk = false;
    let uploadResp = null;

    console.log('[PDF_TRACE] UPLOAD_START', {tabId, size: imageBlob?.size});
    try { console.log('[PDF_VIEWER_TRACE]', JSON.stringify({ t: Date.now(), event: 'pre-upload', tabId, bytes: imageBlob?.size || 0, hasDataUrl: !!imageDataUrl })); } catch (e) {}
    try {
        if (tabId) markCapturePerf(tabId, 'binary-upload-start');
        const resp = await uploadCaptureBinary(imageBlob, tab, browserName, browserVersion, os);
        uploadResp = resp;
        if (!resp.ok) {
            if (tabId) markCapturePerf(tabId, 'binary-upload-rejected', { status: resp.status });
            throw new Error('Visor rechazo captura binaria: ' + resp.status);
        }
        uploadOk = true;
        console.log('[PDF_TRACE] UPLOAD_SUCCESS', {tabId, status: resp.status});
        try { console.log('[PDF_VIEWER_TRACE]', JSON.stringify({ t: Date.now(), event: 'post-upload', tabId, status: resp.status, autoCopy: resp._autoCopyOnCapture ?? null })); } catch (e) {}
        if (tabId) markCapturePerf(tabId, 'binary-upload-complete', { status: resp.status });
    } catch (error) {
        console.log('[PDF_TRACE] UPLOAD_ERROR', {tabId, error: error.message});
        if (tabId) markCapturePerf(tabId, 'binary-upload-fallback', { message: error.message });
        if (tab && (imageDataUrl || imageBlob instanceof Blob)) {
            // PERF_PDF_D2_IMPLEMENTATION: DataURL perezoso (único consumidor: fallback JSON).
            if (!imageDataUrl) imageDataUrl = await blobToDataUrl(imageBlob);
            const url = tab.url || '';
            try {
                const fbBrowser = browserName && browserVersion ? `${browserName} v${browserVersion}` : (await swGetSystemInfo()).browser;
                const fallbackResp = await fetch(VIEWER_API_BASE_URL + '/api/capture', {
                    method: 'POST',
                    headers: await getAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        dataUrl: imageDataUrl,
                        url: url,
                        title: tab.title || 'Captura SQA',
                        timestamp: new Date().toISOString(),
                        browser: fbBrowser,
                        os: os || (await swGetSystemInfo()).os
                    })
                });
                if (fallbackResp.ok) {
                    uploadOk = true;
                } else {
                    throw new Error('Fallo envío JSON fallback: ' + fallbackResp.status);
                }
            } catch (fallbackError) {
                console.warn('[SQA Sync] Ambos envíos inmediatos fallaron (app cerrada). Guardando en cola local:', fallbackError.message);
                await savePendingCapture(imageBlob, imageDataUrl, tab);
            }
        }
    }

    log({
        stage: 'upload',
        status: uploadOk ? 'success' : 'fail',
        durationMs: Math.round(performance.now() - startMs),
        error: uploadOk ? undefined : 'upload failed'
    });

    // [REMOVED] floating thumbnail preview — Windows 11 Toast only
    if (tab && tab.id) captureInProgress.delete(tab.id);
    if (tabId) {
        markCapturePerf(tabId, 'completed', { totalMs: Math.round(performance.now() - startMs) });
        finishCapturePerf(tabId);
    }
    clearHealingInterval();
    // BUG_PDF_001: si el PDF degradó a vista visible, el estado final debe decirlo.
    if (tabId && pdfPartialFallback.has(tabId)) {
        pdfPartialFallback.delete(tabId);
        markCaptureCompleted('Captura parcial: solo la vista visible del PDF.');
    } else {
        markCaptureCompleted();
    }
    imageBlob = null; imageDataUrl = null;
}

// ── Self-healing: watchdog automático de estado de captura ──

const WATCHDOG_INTERVAL_MS = 3000;
const MAX_CAPTURE_TIME_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 8000;

let captureStartTime = 0;
let lastCaptureActivity = 0;
let healingInterval = null;

function touchHeartbeat() {
    lastCaptureActivity = Date.now();
}

function isCaptureHealthy() {
    if (!captureStatus.active) return true;
    if (tempImageStorage.size > 0) return true;

    const now = Date.now();
    const elapsed = now - captureStartTime;

    // PDF render puede tardar >15s en documentos grandes/muchas páginas
    const isPdf = captureStatus.mode === 'pdf';
    const maxMs = isPdf ? 60000 : MAX_CAPTURE_TIME_MS;
    const hbMs = isPdf ? 30000 : HEARTBEAT_TIMEOUT_MS;

    if (elapsed < maxMs) return true;
    if (now - lastCaptureActivity < hbMs) return true;

    return false;
}

function triggerSelfHealing(reason) {
    const elapsedMs = captureStartTime ? Date.now() - captureStartTime : 0;
    log({ stage: 'self-healing', status: 'triggered', reason, durationMs: elapsedMs });

    captureInProgress.activeTabs.clear();
    tempImageStorage.clear();
    capturePerfByTab.clear();
    captureStartTime = 0;
    lastCaptureActivity = 0;
    updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    clearHealingInterval();
}

function armHealingInterval() {
    captureStartTime = Date.now();
    touchHeartbeat();
    clearHealingInterval();
    healingInterval = setInterval(() => {
        if (!isCaptureHealthy()) {
            triggerSelfHealing('stuck-detected');
        }
    }, WATCHDOG_INTERVAL_MS);
}

function clearHealingInterval() {
    if (healingInterval !== null) {
        clearInterval(healingInterval);
        healingInterval = null;
    }
    captureStartTime = 0;
    lastCaptureActivity = 0;
}

chrome.tabs.onRemoved.addListener((tabId) => {
    const localEntry = pdfLocalBuffers.get(tabId);
    if (localEntry) clearTimeout(localEntry.timer);
    pdfLocalBuffers.delete(tabId);
    if (pdfInPageTimerById.has(tabId)) {
        try { clearTimeout(pdfInPageTimerById.get(tabId)); } catch (e) {}
        pdfInPageTimerById.delete(tabId);
    }
    if (captureInProgress.has(tabId)) {
        clearHealingInterval();
        captureInProgress.delete(tabId);
        capturePerfByTab.delete(tabId);
        updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    }
});

self.addEventListener('message', (event) => {
    if (event.data === 'cancel-all-captures') {
        clearHealingInterval();
        captureInProgress.activeTabs.clear();
        capturePerfByTab.clear();
        updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    }
});

// =========================================================================
// SISTEMA DE SINCRONIZACIÓN EN SEGUNDO PLANO - PERSISTENCIA OFFLINE
// IndexedDB (SQAOfflineDB) — reemplaza storage.local base64 (~33% overhead)
// =========================================================================

// Migración best-effort legacy storage.local -> IndexedDB (una vez)
(async () => {
    try { await OfflineDB.migrateFromStorageLocal(getBlobFromDataUrl); } catch {}
})();

async function savePendingCapture(blob, dataUrl, tab) {
    try {
        const url = tab && tab.url ? tab.url : '';
        const title = tab && tab.title ? tab.title : 'Captura SQA';
        const timestamp = new Date().toISOString();
        // Preferir blob binario (evita base64 +33%). Fallback a dataUrl si blob nulo (PDF fallback)
        let storeBlob = blob;
        if (!(storeBlob instanceof Blob) && dataUrl) {
            storeBlob = await getBlobFromDataUrl(dataUrl);
        }
        if (!(storeBlob instanceof Blob)) {
            console.error('[SQA Sync] savePendingCapture: blob inválido');
            return;
        }
        const sys = await swGetSystemInfo().catch(() => ({ browser: 'N/A', os: 'N/A' }));
        const id = await OfflineDB.addPendingCapture({
            blob: storeBlob,
            url, title, timestamp,
            browser: sys.browser || '', os: sys.os || '', hasHeader: false
        });
        const count = await OfflineDB.countPendingCaptures().catch(() => 0);
        console.log(`[SQA Sync] Captura offline persistida (IndexedDB): ${id}. Total pendientes: ${count}`);
        scheduleAutoSync(4000);
    } catch (err) {
        console.error('[SQA Sync] Error al guardar captura pendiente offline (IndexedDB):', err);
    }
}

let isSyncing = false;
async function trySyncPendingCaptures() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const pending = await OfflineDB.getAllPendingCaptures();
        if (!pending || pending.length === 0) {
            isSyncing = false;
            return;
        }
        console.log(`[SQA Sync] Procesando cola offline IndexedDB: ${pending.length} capturas pendientes.`);
        let stillPending = pending;
        if (pending.length >= 2) {
            stillPending = await tryBatchSync(pending);
            // tryBatchSync ya borra exitosos de IndexedDB; recargar restantes
            if (stillPending.length !== pending.length) {
                // sincronizar estado: los que quedaron son los fallidos
            }
        }
        if (stillPending.length > 0) {
            stillPending = await tryIndividualSync(stillPending);
        }
        // tryIndividualSync ya borra exitosos individualmente; no hace falta set global
        const remaining = await OfflineDB.countPendingCaptures().catch(() => stillPending.length);
        console.log(`[SQA Sync] Cola IndexedDB restantes: ${remaining}`);
        if (remaining > 0) scheduleAutoSync(30000);
    } catch (globalErr) {
        console.error('[SQA Sync] Error en bucle principal offline (IndexedDB):', globalErr);
    } finally {
        isSyncing = false;
    }
}

async function tryBatchSync(pending) {
    try {
        // Convertir blobs a dataUrl solo para el payload JSON batch (batch API espera dataUrl)
        const caps = [];
        for (const cap of pending) {
            let dataUrl = cap.dataUrl || null;
            if (!dataUrl && cap.blob) dataUrl = await blobToDataUrl(cap.blob).catch(() => null);
            else if (cap.blob && !dataUrl) dataUrl = await blobToDataUrl(cap.blob).catch(() => null);
            // Fallback: si cap ya es legacy con dataUrl
            if (!dataUrl) continue;
            caps.push({ id: cap.id, dataUrl, url: cap.url || '', title: cap.title || 'Captura SQA', timestamp: cap.timestamp || new Date().toISOString() });
        }
        if (caps.length === 0) return pending;
        const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-batch', {
            method: 'POST',
            headers: await getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ captures: caps })
        });
        if (!resp.ok) {
            console.warn('[SQA Sync] Batch endpoint no disponible, fallback a individual');
            return pending;
        }
        const data = await resp.json();
        if (data.success && Array.isArray(data.results)) {
            const failed = [];
            const succeededIds = [];
            // Match por id (no por índice): caps[] puede omitir ítems sin dataUrl
            // y el servidor puede filtrar inválidos. Sin id → conservar (reintento individual).
            const byId = new Map(pending.map(p => [p.id, p]));
            for (const r of data.results) {
                const orig = (r && r.id) ? byId.get(r.id) : null;
                if (r && r.success && orig) succeededIds.push(orig.id);
                else if (orig) failed.push(orig);
            }
            const answeredIds = new Set(data.results.map(r => r && r.id).filter(Boolean));
            for (const p of pending) {
                if (!answeredIds.has(p.id) && !succeededIds.includes(p.id) && !failed.includes(p)) failed.push(p);
            }
            if (succeededIds.length > 0) await OfflineDB.deleteMany(succeededIds).catch(() => {});
            const succeeded = succeededIds.length;
            console.log(`[SQA Sync] Batch IndexedDB completado: ${succeeded}/${pending.length} exitosas`);
            return failed;
        }
    } catch (e) {
        console.warn('[SQA Sync] Error en batch sync (IndexedDB), fallback a individual:', e.message);
    }
    return pending;
}

async function tryIndividualSync(pending) {
    const stillPending = [];
    for (const cap of pending) {
        let success = false;
        const sysSync = await swGetSystemInfo();
        try {
            // Blob nativo IndexedDB, fallback dataUrl legacy
            let blob = cap.blob || null;
            if (!blob && cap.dataUrl) blob = await getBlobFromDataUrl(cap.dataUrl);
            let dataUrlForFallback = cap.dataUrl || null;
            if (!dataUrlForFallback && blob) dataUrlForFallback = await blobToDataUrl(blob).catch(() => null);
            if (blob) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                try {
                    const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-binary', {
                        method: 'POST',
                        headers: await getAuthHeaders({
                            'Content-Type': blob.type || 'image/png',
                            'X-SQA-Url': encodeURIComponent(cap.url),
                            'X-SQA-Title': encodeURIComponent(cap.title),
                            'X-SQA-Timestamp': cap.timestamp,
                            'X-SQA-Browser': encodeURIComponent(sysSync.browser),
                            'X-SQA-OS': encodeURIComponent(sysSync.os),
                            'X-SQA-Has-Header': 'false'
                        }),
                        body: blob,
                        signal: controller.signal
                    });
                    if (resp.ok) success = true;
                } catch (e) {
                    console.warn('[SQA Sync] Fallo envío binario IndexedDB, probando JSON', e.message);
                } finally {
                    clearTimeout(timeoutId);
                }
            }
            if (!success && dataUrlForFallback) {
                const fallbackResp = await fetch(VIEWER_API_BASE_URL + '/api/capture', {
                    method: 'POST',
                    headers: await getAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        dataUrl: dataUrlForFallback,
                        url: cap.url,
                        title: cap.title,
                        timestamp: cap.timestamp,
                        browser: sysSync.browser,
                        os: sysSync.os
                    })
                });
                if (fallbackResp.ok) success = true;
            }
        } catch (err) {
            console.error(`[SQA Sync] Error enviando captura offline pid: ${cap.id}`, err);
        }
        if (success) {
            console.log(`[SQA Sync] Sincronizada captura offline con éxito (IndexedDB): ${cap.id}`);
            await OfflineDB.deletePendingCapture(cap.id).catch(() => {});
        } else {
            stillPending.push(cap);
        }
    }
    return stillPending;
}

let syncTimeoutId = null;
function scheduleAutoSync(delayMs = 15000) {
    if (syncTimeoutId) clearTimeout(syncTimeoutId);
    syncTimeoutId = setTimeout(() => {
        trySyncPendingCaptures();
    }, delayMs);
}

try {
    chrome.runtime.onStartup.addListener(() => {
        scheduleAutoSync(5000);
    });
} catch (e) {}

try {
    chrome.tabs.onActivated.addListener(() => {
        scheduleAutoSync(10000);
    });
} catch (e) {}

scheduleAutoSync(3000);
