// PERF_POPUP_STARTUP_001: script clásico (sin ES modules) para eliminar la
// resolución del grafo de módulos (popup.js + constants.js) del camino crítico
// al primer render. Las acciones se replican de js/background/constants.js.
// NOTA: mantener sincronizado si cambian los valores en constants.js.
//
// Variante Firefox: `browser.*` (promesas) con fallback a `chrome.*` (callbacks).
// lib/browser-polyfill.js se carga antes (ver popup.html) y además este archivo
// tolera ambos estilos sin depender del polyfill.
var extApi = (function () {
  try {
    if (typeof browser !== 'undefined' && browser && browser.tabs) return browser;
  } catch (e) {}
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.tabs) return chrome;
  } catch (e) {}
  return null;
})();
function extTabsQuery(info) {
  try {
    var r = extApi && extApi.tabs && extApi.tabs.query(info);
    if (r && typeof r.then === 'function') return r;
  } catch (e) {}
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query(info, function (tabs) { resolve(tabs || []); });
    } catch (e) { resolve([]); }
  });
}
function extRuntimeSend(msg, cb) {
  try {
    var r = (typeof browser !== 'undefined' ? browser : chrome).runtime.sendMessage(msg);
    if (r && typeof r.then === 'function') {
      r.then(function (resp) { try { cb && cb(resp); } catch (e) {} },
           function () { try { cb && cb(null); } catch (e) {} });
      return;
    }
  } catch (e) {}
  try {
    chrome.runtime.sendMessage(msg, function (resp) { try { cb && cb(resp); } catch (e) {} });
  } catch (e) { try { cb && cb(null); } catch (x) {} }
}
const ACTIONS = {
  captureAll: 'ACTION_CAPTURE_ALL',
  captureVisible: 'ACTION_CAPTURE_VISIBLE',
  captureArea: 'ACTION_CAPTURE_AREA'
};

// PERF_POPUP_STARTUP_001: telemetría de apertura del popup.
// BUG_POPUP_CSP_001: __POPUP_T0 ya NO se marca con script inline (CSP MV3 lo
// prohíbe) — popup-start.js (externo, síncrono en <head>) lo fija antes que este
// archivo.
function popupTrace(event, extra) {
  try {
    const t0 = (typeof window.__POPUP_T0 === 'number') ? window.__POPUP_T0 : 0;
    const dtMs = Math.round(performance.now() - t0);
    console.log('[POPUP_PERF_TRACE]', JSON.stringify(Object.assign({ event, dtMs, t: Date.now() }, extra || {})));
  } catch (e) {}
}

// BUG_POPUP_CSP_001: marcas [FEATURE_RUNTIME] del ciclo de vida del popup.
function featureTrace(name) {
  try {
    const t0 = (typeof window.__POPUP_T0 === 'number') ? window.__POPUP_T0 : performance.now();
    const dtMs = Math.round(performance.now() - t0);
    console.log('[FEATURE_RUNTIME] ' + name + ' dtMs=' + dtMs + ' t=' + Date.now());
  } catch (e) {}
}

popupTrace('PopupScriptExec');

document.addEventListener('DOMContentLoaded', () => {
  popupTrace('DOMContentLoaded');
  featureTrace('PopupDomLoaded');

  const btnCaptureAll = document.getElementById('btnCaptureAll');
  const btnCaptureVisible = document.getElementById('btnCaptureVisible');
  const btnCaptureArea = document.getElementById('btnCaptureArea');
  const btnOpenViewer = document.getElementById('btnOpenViewer');
  const closePopup = document.getElementById('closePopup');

  // PERF_POPUP_STARTUP_001: medir el primer paint real del popup.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-paint') popupTrace('FirstPaint', { fpMs: Math.round(entry.startTime) });
      }
    });
    po.observe({ type: 'paint', buffered: true });
  } catch (e) {}

  // --- Manejo del cambio dinámico del icono oficial de la extensión ---
  function updateThemeIcon() {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = isDark ? 'dark' : 'light';

    // PERF_POPUP_STARTUP_001: el primer sendMessage despierta el service worker
    // si está dormido (típicamente 50-400 ms). Se difiere al primer frame para
    // que nunca bloquee el render inicial del popup.
    // FIREFOX: wrapper tolerante a promesa/callback (sin chrome.runtime.lastError).
    popupTrace('ThemeMessageSent');
    extRuntimeSend({ action: 'themeChanged', theme }, function (resp) {
      if (resp && resp.ok === false) {
        popupTrace('ThemeMessageError', { error: resp.error || 'unknown' });
        return;
      }
      popupTrace('ThemeMessageAck');
    });
  }

  // Inicializar tema del icono DESPUÉS del primer paint (render primero,
  // consultas después).
  requestAnimationFrame(() => setTimeout(updateThemeIcon, 0));

  // Escuchar cambios de tema del sistema operativo
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeIcon);
  }

  if (closePopup) {
    closePopup.addEventListener('click', () => window.close());
  }

  // Cerrar al hacer click fuera del contenido principal
  document.addEventListener('click', (e) => {
    const header = document.querySelector('.header');
    const panel = document.querySelector('.panel');
    if (!header.contains(e.target) && !panel.contains(e.target)) {
      window.close();
    }
  });

  function setButtonsDisabled(disabled) {
    btnCaptureAll.disabled = disabled;
    btnCaptureVisible.disabled = disabled;
    if (btnCaptureArea) btnCaptureArea.disabled = disabled;
  }

  async function startCapture(action) {
    setButtonsDisabled(true);
    const [tab] = await extTabsQuery({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setButtonsDisabled(false);
      return;
    }

    try {
      // FIREFOX: sin throw si no hay receptor (resuelve null); el background
      // confirma con {started:true} cuando aplica.
      await extTabsQuery({ active: true, currentWindow: true }).catch(function () {});
      extRuntimeSend({ action, tabId: tab.id });
      setTimeout(() => window.close(), 150);
    } catch (error) {
      console.error('[popup] Error al iniciar captura:', error);
      setButtonsDisabled(false);
    }
  }

  btnCaptureAll.addEventListener('click', () => startCapture(ACTIONS.captureAll));
  btnCaptureVisible.addEventListener('click', () => startCapture(ACTIONS.captureVisible));
  if (btnCaptureArea) {
    btnCaptureArea.addEventListener('click', () => startCapture(ACTIONS.captureArea));
  }
  if (btnOpenViewer) {
    btnOpenViewer.addEventListener('click', async () => {
      try { console.log('[PERMISSION_TRACE] API=fetch URL=http://127.0.0.1:3000/api/show Action=popup:btnOpenViewer Origin=sqasa.co'); } catch {}
      // FIX: Usar HTTP fetch en vez de evidenciassqa://open para evitar el diálogo
      // "quiere acceder a otras aplicaciones y servicios en este dispositivo"
      try {
        await fetch('http://127.0.0.1:3000/api/show', { method: 'GET' });
      } catch (e) {
        console.warn('[popup] fetch /api/show failed:', e.message);
      }
      setTimeout(() => window.close(), 150);
    });
  }

  featureTrace('PopupReady');
});
