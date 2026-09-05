/**
 * Evidencias SQA — background/utils.js
 */

import { captureStatus, captureInProgress, workerState } from './state.js';
import { ACTIONS } from './constants.js';

export function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || '');
}

export function markCaptureCompleted(message = 'Captura completada.') {
    setPdfBadge('');
    if (workerState.clearCompletedStatusTimer) clearTimeout(workerState.clearCompletedStatusTimer);
    if (captureStatus.tabId) captureInProgress.delete(captureStatus.tabId);

    updateCaptureStatus({ active: false, progress: 100, phase: 'completed', message, error: '', tabId: captureStatus.tabId });
    workerState.clearCompletedStatusTimer = setTimeout(() => {
        updateCaptureStatus({ active: false, mode: null, progress: 0, phase: 'idle', message: '', error: '', tabId: null });
    }, 4000);
}

export function markCaptureError(message, tabId = captureStatus.tabId) {
    setPdfBadge('');
    if (workerState.clearCompletedStatusTimer) clearTimeout(workerState.clearCompletedStatusTimer);
    if (tabId) {
        captureInProgress.delete(tabId);
    }
    updateCaptureStatus({ active: false, phase: 'error', message: 'La captura se detuvo.', error: message || 'Error', tabId });
}

export function isExpectedCaptureError(error) {
    const message = getErrorMessage(error).toLowerCase();
    return (
        message.includes('frame with id 0 is showing error page') ||
        message.includes('showing error page') ||
        message.includes('cannot access contents of url') ||
        message.includes('the tab was closed') ||
        message.includes('extensions gallery cannot be scripted')
    );
}

export function isMissingTabError(error) {
    const message = getErrorMessage(error);
    return message.includes('No tab with id');
}

export function updateCaptureStatus(patch) {
    const oldPhase = captureStatus.phase;
    Object.assign(captureStatus, patch);
    // Note: Removed chrome.runtime.sendMessage to popup - toast notifications now handled by Windows 11 native
    // if (patch.phase && patch.phase !== oldPhase) {
    //     chrome.runtime.sendMessage({ action: ACTIONS.captureStatus, status: { ...captureStatus } }, () => {
    //         if (chrome.runtime.lastError) { /* ignore */ }
    //     });
    // }
}

// ============================================================================
// FEATURE_PDF_UX_001: progreso PDF "Página X de N" en el badge del icono.
// Solo la ruta PDF lo enciende; completado/error siempre lo apagan (todos los
// flujos pasan por markCaptureCompleted/markCaptureError, y apagar un badge
// vacío es no-op, así que visible/completa/área/clipboard no se ven afectadas).
// ============================================================================
export function setPdfBadge(text) {
    try {
        if (chrome && chrome.action && chrome.action.setBadgeText) {
            chrome.action.setBadgeText({ text: String(text || '').slice(0, 4) });
            if (text) chrome.action.setBadgeBackgroundColor({ color: '#002B55' });
        }
    } catch (e) {}
}

export function showPdfPageProgress(current, total) {
    try {
        current = Math.max(0, parseInt(current, 10) || 0);
        total = Math.max(0, parseInt(total, 10) || 0);
        if (total > 0) {
            if (current > total) current = total;
            setPdfBadge(current + '/' + total);
            return 'Página ' + current + ' de ' + total;
        }
    } catch (e) {}
    return null;
}

// ============================================================================
// BUG_PDF_ROUTING_001: telemetría de ruteo PDF ([PDF_ROUTE]). Solo consola local
// (devtools del SW). URLs truncadas a 200 chars. Sin PII adicional.
// ============================================================================
export function pdfUrlInfo(tab) {
    try {
        const url = (tab && tab.url) || '';
        return {
            url: url.slice(0, 200),
            scheme: (url.split(':')[0] || '').toLowerCase(),
            hasPdfExt: /\.pdf($|[?#])/i.test(url),
            isBlob: url.startsWith('blob:'),
            isFile: url.startsWith('file://'),
            isViewer: url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'),
            title: ((tab && tab.title) || '').slice(0, 120)
        };
    } catch (e) {
        return {};
    }
}

export function pdfRouteLog(event, info) {
    try {
        console.log('[PDF_ROUTE]', JSON.stringify(Object.assign({ t: Date.now(), event }, info || {})));
    } catch (e) {}
}