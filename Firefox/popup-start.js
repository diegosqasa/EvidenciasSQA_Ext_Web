// BUG_POPUP_CSP_001 + PERF_POPUP_STARTUP_001
// -----------------------------------------------------------------------------
// Marca de origen del timeline [POPUP_PERF_TRACE].
//
// El popup usaba un <script> inline en <head> para fijar window.__POPUP_T0 lo
// antes posible. La CSP de MV3 (script-src 'self') PROHÍBE scripts inline y Edge
// lo reportaba como: "Executing inline script violates CSP".
//
// Solución: archivo externo (permitido por CSP) cargado SÍNCRONO en <head>,
// ANTES del <style>, del render del <body> y de popup.js (que se carga al final
// del <body>). Se conserva el mismo propósito del script inline eliminado:
// fijar el origen T0 con la mínima latencia posible.
//
// NOTA: script clásico (sin type="module") para no resolver el grafo de módulos
// antes del primer render (misma política que popup.js).
window.__POPUP_T0 = performance.now();

try {
  console.log(
    '[FEATURE_RUNTIME] PopupT0Initialized t0=' + Math.round(window.__POPUP_T0) + ' t=' + Date.now()
  );
} catch (e) {}
