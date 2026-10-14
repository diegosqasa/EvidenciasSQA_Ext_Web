// Evidencias SQA — offscreen.js
// Mantiene vivo el service worker (MV3) para que el popup y los atajos
// respondan sin el delay de cold-start. Chrome suspende el SW tras ~30s
// de inactividad; este documento reabre una conexión port cada ~25s.

let keepAlivePort = null;
let pingTimer = null;

function ensurePort() {
    if (keepAlivePort) {
        try { keepAlivePort.postMessage({ action: 'keepalive' }); } catch (e) {}
        return;
    }
    try {
        keepAlivePort = chrome.runtime.connect({ name: 'sqa-keepalive' });
        keepAlivePort.postMessage({ action: 'keepalive' });
        keepAlivePort.onDisconnect.addListener(() => {
            keepAlivePort = null;
        });
    } catch (e) {}
}

function startPing() {
    ensurePort();
    if (pingTimer) return;
    pingTimer = setInterval(ensurePort, 25000);
}

startPing();

// ============================================================================
// Tema del icono del toolbar
// ----------------------------------------------------------------------------
// El service worker NO tiene `window` ni `matchMedia`, así que no puede saber
// por sí mismo si el navegador está en claro u oscuro. Este documento offscreen
// SÍ puede, y ya está vivo desde el arranque del SW: es por tanto el lugar
// correcto para detectarlo. Antes el único que reportaba el tema era el popup
// (al abrirse), así que al recargar la extensión o al reiniciar el navegador el
// icono quedaba con el valor del manifest — el set equivocado para ese tema.
//
// Se reporta (a) al cargar y (b) en cada cambio de tema del sistema, de modo que
// el icono cambia en vivo, sin necesidad de abrir el popup.
// ============================================================================

let themeAcked = false;
let themeRetries = 0;
const THEME_MAX_RETRIES = 5;

function reportTheme() {
    try {
        const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        const theme = (mq && mq.matches) ? 'dark' : 'light';
        chrome.runtime.sendMessage({ action: 'themeChanged', theme, source: 'offscreen' }, () => {
            if (chrome.runtime.lastError) {
                // El SW puede estar terminando de arrancar (listener aún no registrado).
                if (themeRetries < THEME_MAX_RETRIES) {
                    themeRetries++;
                    setTimeout(reportTheme, 800 * themeRetries);
                }
                return;
            }
            themeAcked = true;
        });
    } catch (e) {}
}

reportTheme();

try {
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reportTheme);
    }
} catch (e) {}

// Si el SW se recreó (se perdió el ack), el ciclo de keepalive vuelve a reportar
// hasta que confirme. Evita depender de la carrera de arranque.
setInterval(() => {
    if (!themeAcked) reportTheme();
}, 25000);
