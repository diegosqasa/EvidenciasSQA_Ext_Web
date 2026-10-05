/**
 * Evidencias SQA — js/compat/firefox-compat.js (solo variante Firefox)
 *
 * Capa de compatibilidad cross-browser para la variante Firefox.
 * Se importa como PRIMERA línea del background y sus submódulos, de modo que
 * el resto del código puede seguir usando `chrome.*` o `browser.*`
 * indistintamente.
 *
 * Qué resuelve:
 *  1. Namespace: en Firefox `browser.*` es promesas nativas y `chrome.*` es
 *     callbacks. En Chromium solo existe `chrome.*`. Aquí se aliasan ambos.
 *  2. `chrome.storage.local` con `await`: en Firefox `chrome.*` no devuelve
 *     promesas; se delega a `browser.*` cuando existe.
 *  3. APIs inexistentes en Firefox: `chrome.offscreen`,
 *     `chrome.runtime.getContexts`, `chrome.extension.isAllowedFileSchemeAccess`.
 *     Se exponen guards para degradar (PDF in-page, sin keepalive).
 *
 * No sustituye a `lib/browser-polyfill.js` (que ya va cargado vía manifest
 * como primer script del background): lo complementa para los casos que el
 * polyfill no cubre (APIs Chromium-only).
 */

const _g = typeof globalThis !== 'undefined' ? globalThis : self;

// 1. Alias bidireccional de namespaces (idempotente).
try {
  if (typeof _g.browser !== 'undefined' && typeof _g.chrome === 'undefined') {
    _g.chrome = _g.browser;
  } else if (typeof _g.chrome !== 'undefined' && typeof _g.browser === 'undefined') {
    _g.browser = _g.chrome;
  }
} catch (e) {}

export function isFirefox() {
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (ua.includes('Firefox/') || ua.includes('FxiOS')) return true;
    // En el background event-page de Firefox el UA también lo indica.
    // Fallback: existe `browser` nativo pero no `chrome.offscreen`.
    if (typeof _g.browser !== 'undefined' && typeof _g.chrome !== 'undefined') {
      if (!_g.chrome.offscreen && typeof _g.browser.runtime?.getBrowserInfo === 'function') return true;
    }
    return !!(typeof _g.browser !== 'undefined' && !_g.chrome?.offscreen && /Gecko\//.test(ua));
  } catch (e) {
    return false;
  }
}

export function supportsOffscreen() {
  try {
    return !!(_g.chrome?.offscreen && typeof _g.chrome.offscreen.createDocument === 'function');
  } catch (e) {
    return false;
  }
}

function _api() {
  // Preferir `browser` (promesas) cuando exista; si no, `chrome`.
  return _g.browser || _g.chrome || null;
}

/** storage.local.get con promesa en ambos navegadores. */
export async function storageGet(keys) {
  const api = _api();
  try {
    const r = await api?.storage?.local?.get(keys);
    if (typeof r !== 'undefined') return r || {};
  } catch (e) {}
  // Fallback callback-style (Chromium `chrome.*` sin polyfill).
  return new Promise((resolve) => {
    try {
      _g.chrome.storage.local.get(keys, (r) => resolve(r || {}));
    } catch (e) {
      resolve(typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {});
    }
  });
}

/** storage.local.set con promesa en ambos navegadores. */
export async function storageSet(items) {
  const api = _api();
  try {
    const r = await api?.storage?.local?.set(items);
    void r;
    return;
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.storage.local.set(items, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/** storage.local.remove con promesa en ambos navegadores. */
export async function storageRemove(keys) {
  const api = _api();
  try {
    await api?.storage?.local?.remove(keys);
    return;
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.storage.local.remove(keys, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/** tabs.get promisificado. */
export function tabsGet(tabId) {
  const api = _api();
  try {
    const p = api?.tabs?.get(tabId);
    if (p && typeof p.then === 'function') return p.catch(() => null);
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.tabs.get(tabId, (t) => {
        try {
          if (_g.chrome.runtime?.lastError) resolve(null);
          else resolve(t || null);
        } catch (x) { resolve(t || null); }
      });
    } catch (e) { resolve(null); }
  });
}

/** tabs.query promisificado. */
export function tabsQuery(info) {
  const api = _api();
  try {
    const p = api?.tabs?.query(info);
    if (p && typeof p.then === 'function') return p.catch(() => []);
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.tabs.query(info, (tabs) => {
        try {
          if (_g.chrome.runtime?.lastError) resolve([]);
          else resolve(tabs || []);
        } catch (x) { resolve(tabs || []); }
      });
    } catch (e) { resolve([]); }
  });
}

/** tabs.sendMessage promisificado (resuelve null si no hay receptor). */
export function tabsSendMessage(tabId, message) {
  const api = _api();
  try {
    const p = api?.tabs?.sendMessage(tabId, message);
    if (p && typeof p.then === 'function') return p.catch(() => null);
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.tabs.sendMessage(tabId, message, (resp) => {
        try {
          if (_g.chrome.runtime?.lastError) resolve(null);
          else resolve(resp ?? null);
        } catch (x) { resolve(resp ?? null); }
      });
    } catch (e) { resolve(null); }
  });
}

/** runtime.sendMessage promisificado (resuelve null si no hay receptor). */
export function runtimeSendMessage(message) {
  const api = _api();
  try {
    const p = api?.runtime?.sendMessage(message);
    if (p && typeof p.then === 'function') return p.catch(() => null);
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.runtime.sendMessage(message, (resp) => {
        try {
          if (_g.chrome.runtime?.lastError) resolve(null);
          else resolve(resp ?? null);
        } catch (x) { resolve(resp ?? null); }
      });
    } catch (e) { resolve(null); }
  });
}

/**
 * tabs.captureVisibleTab promisificado.
 * Firefox soporta `tabs.captureTab(tabId)` y `tabs.captureVisibleTab(windowId)`;
 * se intenta captureVisibleTab primero (paridad con Chromium).
 */
export function captureVisibleTabP(windowId, options) {
  const api = _api();
  try {
    const p = api?.tabs?.captureVisibleTab?.(windowId, options || { format: 'png' });
    if (p && typeof p.then === 'function') return p;
  } catch (e) {}
  return new Promise((resolve, reject) => {
    try {
      _g.chrome.tabs.captureVisibleTab(windowId, options || { format: 'png' }, (data) => {
        try {
          const err = _g.chrome.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve(data);
        } catch (x) { resolve(data); }
      });
    } catch (e) { reject(e); }
  });
}

/** scripting.executeScript promisificado (Firefox lo soporta en MV3). */
export function executeScriptP(details) {
  const api = _api();
  try {
    const p = api?.scripting?.executeScript(details);
    if (p && typeof p.then === 'function') return p.catch(() => null);
  } catch (e) {}
  return new Promise((resolve) => {
    try {
      _g.chrome.scripting.executeScript(details, (res) => {
        try {
          if (_g.chrome.runtime?.lastError) resolve(null);
          else resolve(res || null);
        } catch (x) { resolve(res || null); }
      });
    } catch (e) { resolve(null); }
  });
}

/** action.setIcon tolerante a callback-vs-promesa. */
export function setIconSafe(details) {
  try {
    const r = (_g.browser || _g.chrome)?.action?.setIcon(details, () => {
      try {
        if (_g.chrome?.runtime?.lastError) {
          console.error('[SQA] Error aplicando icono:', _g.chrome.runtime.lastError.message);
        }
      } catch (e) {}
    });
    if (r && typeof r.catch === 'function') r.catch((e) => console.error('[SQA] Error aplicando icono:', e?.message || e));
  } catch (e) {
    console.error('[SQA] Error inesperado en actualizarIcono:', e?.message || e);
  }
}

/**
 * file:// guard: en Firefox no existe `chrome.extension.isAllowedFileSchemeAccess`.
 * Se devuelve true para que el flujo intente leer (fetch/relay) y degrade con
 * mensajes propios si falla, en vez de bloquearse por una API inexistente.
 */
export function isAllowedFileSchemeAccessP() {
  return new Promise((resolve) => {
    try {
      const fn = _g.chrome?.extension?.isAllowedFileSchemeAccess;
      if (typeof fn === 'function') { fn.call(_g.chrome.extension, resolve); return; }
      const fnB = _g.browser?.extension?.isAllowedFileSchemeAccess;
      if (typeof fnB === 'function') {
        const r = fnB.call(_g.browser.extension);
        if (r && typeof r.then === 'function') { r.then(resolve).catch(() => resolve(true)); return; }
      }
    } catch (e) {}
    // Firefox: sin API equivalente → asumir permitido e intentar; el pipeline
    // ya degrada a captura visible parcial si la lectura falla.
    resolve(true);
  });
}

export const Ext = {
  isFirefox,
  supportsOffscreen,
  storageGet,
  storageSet,
  storageRemove,
  tabsGet,
  tabsQuery,
  tabsSendMessage,
  runtimeSendMessage,
  captureVisibleTabP,
  executeScriptP,
  setIconSafe,
  isAllowedFileSchemeAccessP,
};

// ---------------------------------------------------------------------------
// Auto-parche: hace que `chrome.*` devuelva promesas cuando se omite el
// callback (estilo `await chrome.storage.local.get(...)` del código Chromium).
// En Firefox delega a `browser.*`; en Chromium no toca nada si ya hay promesa.
// Esto evita reescribir las ~190 llamadas existentes.
// ---------------------------------------------------------------------------
try {
  const B = _g.browser;
  const C = _g.chrome;
  if (B && C && B !== C) {
    const looksPromise = (v) => v && typeof v.then === 'function';
    const promisify2 = (chromeObj, browserObj, method) => {
      try {
        if (!chromeObj || !browserObj || typeof browserObj[method] !== 'function') return;
        if (chromeObj['__sqa_patched_' + method]) return;
        const orig = chromeObj[method].bind(chromeObj);
        const patched = function (...args) {
          const last = args[args.length - 1];
          if (typeof last === 'function') {
            try { return orig(...args); } catch (e) { try { last(undefined); } catch (_) {} return undefined; }
          }
          try {
            const r = browserObj[method](...args);
            if (looksPromise(r)) return r;
          } catch (e) {}
          // Fallback al estilo callback original.
          return new Promise((resolve, reject) => {
            try {
              orig(...args, (res) => {
                try {
                  const err = C?.runtime?.lastError;
                  if (err) reject(new Error(err.message));
                  else resolve(res);
                } catch (x) { resolve(res); }
              });
            } catch (e) { reject(e); }
          });
        };
        chromeObj[method] = patched;
        chromeObj['__sqa_patched_' + method] = true;
      } catch (e) {}
    };
    try {
      if (C.storage?.local && B.storage?.local) {
        promisify2(C.storage.local, B.storage.local, 'get');
        promisify2(C.storage.local, B.storage.local, 'set');
        promisify2(C.storage.local, B.storage.local, 'remove');
      }
    } catch (e) {}
    try {
      if (C.tabs && B.tabs) {
        for (const m of ['get', 'query', 'sendMessage', 'captureVisibleTab', 'create', 'remove', 'getCurrent']) {
          try { promisify2(C.tabs, B.tabs, m); } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      if (C.scripting && B.scripting) {
        for (const m of ['executeScript']) {
          try { promisify2(C.scripting, B.scripting, m); } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      if (C.runtime && B.runtime) {
        for (const m of ['sendMessage']) {
          try { promisify2(C.runtime, B.runtime, m); } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      if (C.action && B.action) {
        for (const m of ['setIcon', 'setBadgeText', 'setBadgeBackgroundColor']) {
          try { promisify2(C.action, B.action, m); } catch (e) {}
        }
      }
    } catch (e) {}
  }
} catch (e) {}
