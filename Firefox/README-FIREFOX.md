# Evidencias SQA — Variante Firefox (`Firefox/`)

Adaptación de la extensión Chromium (Chrome/Edge) a Firefox MV3.
Carpeta autocontenida: se carga en `about:debugging` sin tocar la versión Chrome/Edge.

## 1. Qué cambió y por qué

| # | Tema | Chrome/Edge | Firefox (esta carpeta) |
|---|------|-------------|------------------------|
| 1 | Namespace | `chrome.*` callbacks | `browser.*` promesas + `lib/browser-polyfill.js` (oficial Mozilla, v0.12.0) + `js/compat/firefox-compat.js` que parchea `chrome.*` a promesas cuando se omite el callback. No se reescribieron las ~190 llamadas: el shim las hace compatibles. |
| 2 | `manifest.json → background` | `service_worker` (único soportado) | `scripts: [browser-polyfill, background.js]` + `type: module`. Firefox **no soporta** `service_worker` (MDN / bug 1573659); la event-page resultante tiene DOM/`matchMedia` propios. |
| 3 | `message_serialization: structured_clone` | Opt-in Chrome ≥148 para enviar `Blob` por `sendMessage` | **Eliminada** (clave desconocida en Gecko). El probe `stitchBinaryProbe` detecta en runtime si el `Blob` sobrevive y degrada a dataURL si no. |
| 4 | Permiso `offscreen` + `chrome.offscreen.*` | Keepalive + render PDF vía `offscreen.html`/`pdf-render.js` | **Permiso eliminado; API inexistente en Gecko.** `setupKeepAlive()` es no-op; el render PDF va directo a `renderInPageFallback()` (pdf.js UMD + canvas DOM en el content script). `beginOffscreenPdfRender()` y `startPdfCapture()` atajan a in-page cuando `IS_FIREFOX`. Archivos `offscreen.*`/`pdf-render.js` se conservan por paridad pero no se ejecutan. |
| 5 | `chrome.runtime.getContexts` | Detección de offscreen vivo | No existe en Firefox; todos los usos ya estaban guardados con `typeof === 'function'`. En la vía Firefox ni se consultan. |
| 6 | `chrome.extension.isAllowedFileSchemeAccess` | Gate para PDF `file://` | No existe en Firefox → `Ext.isAllowedFileSchemeAccessP()` resuelve `true` y el flujo intenta leer/degrada con mensajes propios (`about:addons` en vez de `chrome://extensions`). |
| 7 | Visor PDF | `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai` | Añadida detección `resource://pdf.js` (visor integrado Firefox) en `pdfRouteReason()`; `resource://pdf.js` se deja pasar el bloqueo de URLs internas. |
| 8 | `chrome.action.setIcon` con callback | Callback + `lastError` | `Ext.setIconSafe()` tolera promesa/callback. |
| 9 | Tema del icono | Reportado por offscreen/popup | En Firefox el background (event-page) **sí tiene `matchMedia`**, así que `detectThemeInBackground()` funciona directo; el popup sigue reportando. Sin dependencia del offscreen. |
| 10 | Popup/welcome | Solo `chrome.*` | `popup.html`/`welcome.html` cargan `browser-polyfill.js`; `popup.js` usa wrappers `extTabsQuery`/`extRuntimeSend` (promesa o callback); `welcome.js`/`content.js` con alias bidireccional. |

## 2. Estructura

```
Firefox/
  manifest.json                 # MV3 Gecko: scripts + type module, sin offscreen/structured_clone
  background.js                 # = service-worker.js + flags IS_FIREFOX y guards
  content.js                    # alias bidireccional + nota structured-clone
  popup.html / popup.js         # polyfill + wrappers promesa/callback
  welcome.html / welcome.js     # polyfill + alias
  offscreen.html / offscreen.js # conservados, NO se cargan en Firefox
  pdf-render.js                 # conservado, NO se ejecuta (vía in-page en su lugar)
  lib/browser-polyfill.js       # webextension-polyfill oficial (nueva dependencia)
  lib/pdf.min.js                # UMD usado por el render in-page (ya existía)
  js/compat/firefox-compat.js   # shim Ext + auto-parche chrome→promesas (nuevo)
  js/background/*.js            # import lateral del shim + detección visor Firefox
```

Nueva dependencia: **solo** `lib/browser-polyfill.js` (vendorizado, sin npm).
No se requiere build.

## 3. Instalación temporal (desarrollo)

1. Abrir `about:debugging#/runtime/this-firefox` → **Cargar complemento temporal**.
2. Seleccionar `Firefox/manifest.json` (Firefox ≥ 121; recomendado ≥ 128 ESR).
3. Probar: popup (3 capturas), atajos `Ctrl+Shift+S/E/W/V`, PDF http(s) y `file://`, tema claro/oscuro, cola offline (IndexedDB funciona igual en la event-page).

## 4. Empaquetado / firma

```powershell
cd C:\projects\EvidenciasSQA_Ext_Web\Firefox
# ZIP del contenido (no de la carpeta contenedora)
Compress-Archive -Path * -DestinationPath ..\EvidenciasSQA-firefox-4.1.2.zip -Force
```

Subir el ZIP a [AMO](https://addons.mozilla.org/developers/) (`id`: `evidencias-sqa@sqa.com.co`).
`strict_min_version: 121.0` ya declarada.

## 5. Verificación realizada

- `node --check` OK en los 13 JS (ESM validados como `.mjs`).
- `manifest.json` validado: sin `message_serialization`/`offscreen`/`service_worker`, con `background.scripts` + `type: module`.
- Diferencias pendientes conocidas (no bloqueantes):
  - Transporte binario `Blob` por mensajes: si el structured-clone de Firefox lo rechaza, el probe degrada a dataURL automáticamente (mismo comportamiento que Chromium antiguo).
  - `file://`: Firefox pide habilitar acceso a archivos en `about:addons → Detalles`; sin él, degrada a captura visible parcial con aviso.
  - La app de escritorio local (`http://127.0.0.1:3000`) debe estar corriendo igual que en Chromium.

## 6. Blindaje anti-cuelgue (solo Firefox, 2026-10-02)

El stitching full-page podía morir en silencio y el único síntoma era el
`self-healing triggered` del background sin ningún `UPLOAD_*` posterior.
Causa: throws dentro de handlers `image.onload`, `Image` sin `onerror`,
`toBlob`/probe/acks sin timeout y promesas que nunca se asentan (el `.catch`
no las alcanza porque el executor ya retornó).

Cambios aplicados (no tocan la versión Chromium):

- `content.js`
  - `createUniversalCanvas()`: valida dimensiones (mín 1, máx 16000), prueba
    `OffscreenCanvas` antes de usarlo y degrada a canvas DOM.
  - `cropImageContent().onload`: `try/catch` → `reject` en vez de excepción
    no capturada.
  - `guardImageLoad()` (nuevo): envuelve los `new Image()` del ensamblado
    final con `onerror` + timeout 25 s → `captureError` visible.
  - `toBlob` (vía OffscreenCanvas): timeout 20 s → `callback(null)`.
  - `splitSendImgData()`: blob nulo/vacío o array vacío → `captureError`
    visible en vez de silencio.
  - `stitchBinaryProbe()`: timeout 6 s → fallback dataURL.
  - Acks de `stitchBinaryChunk`: timeout 8 s por chunk → fallback dataURL.
  - `fetchNextEvidenceId()`: timeout 4 s → header sin ID.
  - `sqaHeartbeat()` (nuevo): un mensaje por viewport procesado para mantener
    vivo el watchdog del background durante stitches largos.
- `background.js`
  - Nuevo handler `sqaHeartbeat` (solo `touchHeartbeat`, sin efectos).
  - Watchdog: modo `full` tolera 90 s totales / 20 s sin latido (antes 15/8);
    `visible`/`area` y `pdf` sin cambios.
  - `captureError` ahora registra `msg=` (antes solo el `tabId`).

## 6b. Canvas tainted por el logo (solo Firefox, 2026-10-02)

Síntoma: `ContentErrorRouted ... msg=No se pudo generar la imagen final
(canvas vacío)` tras un `peek-sequence` 200 OK. Causa: `drawEvidenceHeader`
dibujaba `moz-extension://.../Media/SQA-128.png` directo en un canvas del
mundo de la página; en Firefox eso marca el canvas como no-limpio y `toBlob`
devuelve `null` en silencio (`toDataURL` lanza `SecurityError`). En Chromium
no ocurre (mundo aislado). Los recortes por viewport no dibujan logo, por eso
llegaban bien los 4 viewports y solo fallaba el ensamblado final.

- El logo se carga vía `fetch` → `blob:` del mismo origen (cacheado).
- Tras el header se verifica con `getImageData`; si tiñó, se recompone sin
  logo (header solo-texto) en vez de fallar. Aplica a página completa
  (`splicingImagesAarray`) y a área (`cropImage`, que además envolvió su
  `toDataURL` en `try/catch`).
- Nueva traza en consola de página: `CanvasTaintedByLogo` y `FinalCanvas w=
  ... h=... offscreen=... tainted=...`.

## 8. Requisito en la app desktop (origen permitido)
Los endpoints de escritura del visor (`POST /api/capture-binary`,
`POST /api/capture`) validan la cabecera `Origin` y responden
`403 {"success":false,"error":"forbidden","message":"Origin not allowed"}`
a todo lo que no esté en su lista. En Chromium el origen es
`chrome-extension://<id>` (aceptado); en Firefox es `moz-extension://<uuid>`
(rechazado). La extensión **no puede** cambiar ese origen (cabecera
prohibida controlada por el navegador), así que el arreglo va en la app
desktop: aceptar el esquema `moz-extension://` (cualquier UUID — en Firefox
el UUID no es estable entre instalaciones temporales; no sirve allowlist
exacta) además de `chrome-extension://`. Verificado el
2026-10-02 con `body={"success":false,"error":"forbidden","message":"Origin
not allowed"}` en ambas rutas de upload. Mientras tanto las capturas quedan
en cola offline (IndexedDB) y se sincronizan solas al aceptar el visor.

## 7. Cómo reportar un fallo de captura en Firefox
La consola del background (`about:debugging → Inspeccionar`) solo muestra la
mitad. Para diagnosticar se necesita también la consola **de la página**
(F12 en la pestaña capturada, filtro `[FEATURE_RUNTIME]`):

- `ViewportTarget/Actual/Capture index=N` → hasta qué viewport avanzó.
- `PageShotSource route=...` → si el Blob llegó al content (`inline-blob`) o
  falló (`missing-blob`).
- `BinaryChannelStart / BinaryChunkAck / WireStats` → si el ensamblado final
  se envió por canal binario, o `json-fallback` si degradó a dataURL.
- `captureError` / `StitchDraw` / `BitmapDecoded` → punto exacto del fallo.

## 9. Validación AMO (`web-ext lint`: 0 errores, avisos conocidos)

- `data_collection_permissions` (requerido desde nov-2025): declarado
  `"required": ["none"]`. Criterio: la extensión no envía nada a terceros ni
  al desarrollador; las capturas viajan solo a la app desktop local
  (`127.0.0.1:3000`) por acción explícita del usuario. Si el revisor lo pide,
  cambiar a `"websiteContent"`.
- `offscreen.*` / `runtime.getContexts` (~14 avisos): código muerto en
  Firefox, inalcanzable en runtime (guards `IS_FIREFOX` /
  `supportsOffscreen()` + `typeof === 'function'`); el render PDF usa la vía
  en página. Se conserva por paridad con Chromium.
- `innerHTML` en `content.js` (botones Copiar/Confirmar/Cancelar, cadenas
  estáticas) y `sqa-styles.js` (`_addStyleSheet`, cambiado a `textContent`,
  idéntico comportamiento): sin datos de usuario interpolados.
- `eval`/`Function`/`import()` dinámico en `lib/pdf*.js`: código upstream de
  Mozilla pdf.js sin modificar (necesario para renderizar PDFs); omnipresente
  en extensiones que lo empaquetan.
- Ningún aviso es error: no bloquean la firma, pero conviene pegar este
  resumen en las notas para el revisor de AMO.
