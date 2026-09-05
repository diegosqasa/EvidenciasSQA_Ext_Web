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
