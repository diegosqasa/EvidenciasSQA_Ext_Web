# EXT_WEB — Plan de Mejora Funcional y de Rendimiento (AUDIT-001)

| Campo | Valor |
|---|---|
| **ID** | `AUDIT_EXTWEB_IMPROVEMENT_PLAN_001` |
| **Artefacto auditado** | `Ext_Web` (extensión MV3 "Evidencias SQA" v4.1.1) |
| **Ruta** | `C:\projects\Evidencias_Google\Ext_Web` |
| **Método** | Inspección estática exhaustiva de código fuente + análisis de complejidad teórica + verificación de AST |
| **Fecha** | 2026-09-23 |
| **Naturaleza** | Auditoría **exclusivamente estática**. No es un reporte de bugs: es un plan de mejora funcional/perf/memoria/arquitectura |
| **Autor** | Agente de auditoría (Buffy / Freebuff) |

---

## 0. Precondiciones, alcance real y declaración de método

### 0.1 Archivos efectivamente inspeccionados (100% del código propio)

| Archivo | Líneas (revisado 2026-09-23) | Rol |
|---|---:|---|
| `service-worker.js` | 1959 | Entry point MV3: rutas, PDF offscreen, cola offline, watchdog |
| `content.js` | 3043 | Motor de stitching, scroll, crop, header, overlays de selección |
| `js/background/capture-logic.js` | 489 | Orquestación de captura, fast-path visible, PDF routing |
| `js/background/utils.js` | 112 | Estado/badge PDF, telemetría de ruteo |
| `js/background/constants.js` | 16 | Acciones |
| `js/background/state.js` | 29 | Estado en memoria del SW |
| `js/background/auth.js` | 111 | Token X-SQA-Token (caché 5 min) |
| `js/background/offline-db.js` | 185 | IndexedDB de capturas pendientes |
| `js/sqa-styles.js` | 708 | StylesManager (fixed/sticky/transiciones/hacks de sitio + FLOATING_001) |
| `js/sqa-scroll-finder.js` | 334 | Detección de contenedor scrollable |
| `pdf-render.js` | 169 | Offscreen: render PDF full-page |
| `offscreen.js` | 29 | Keepalive de SW |
| `popup.js` / `popup-start.js` / `popup.html` | 137 / 22 / — | UI de disparo |
| `manifest.json` | — | Superficie MV3, permisos |
| `lib/*` | — | pdf.js (tercero, no auditado en profundidad) |

> **Nota de divergencia con el brief:** el brief lista `Ext_Web/capture-logic.js` y `Ext_Web/utils.js` en la raíz. No existen en la raíz; las versiones reales viven en `js/background/`. Se auditó la ubicación real. **No existen módulos separados de "AWS", "Cloudscape", "Stitching" ni "Version Handshake"** como archivos: esas responsabilidades están **disueltas dentro de `content.js` y `js/sqa-styles.js`** y no hay un "version handshake" explícito (ver ARCH-04). El "Runtime Detection" se resuelve por sniffing disperso de `UA-CH`/`contentType` (ver FUNC-05).

### 0.2 Lo que SÍ se ejecutó (verificación de artefacto)

```
node --check  →  content.js, service-worker.js, js/background/*.js,
                 js/sqa-*.js, pdf-render.js, offscreen.js, popup*.js
RESULTADO: 12/12 archivos parsean sin errores de sintaxis (AST válido).
```

### 0.3 Lo que NO se ejecutó (restricción explícita del brief, respetada)

- ❌ Suite FULL
- ❌ Pruebas de scroll de Explorer
- ❌ Pruebas de Notepad / CMD
- ❌ Pruebas E2E extensivas
- ❌ Cualquier ejecución del navegador con la extensión cargada

**Consecuencia declarada:** todas las afirmaciones de rendimiento y memoria de este documento son **análisis estático + complejidad teórica**, no mediciones. Cada hallazgo incluye, por diseño, el **marcador `[FEATURE_RUNTIME]` exacto que lo probaría en la ruta real del usuario** (Anexo B), precisamente para que ninguna mejora se valide "porque compila".

### 0.4 Verificación de la política [FEATURE_RUNTIME] sobre la ruta real

Inventario estático verificado 2026-09-23 (`grep FEATURE_RUNTIME`, `node --check` 8/8 OK):

```
content.js: FR=45 qsa=6 gcs=17 gbr=8 setTimeout=20 rAF=9 consolelog=47
service-worker.js: FR=9 qsa=0 gcs=0 setTimeout=25 consolelog=51
js/sqa-styles.js: FR=2 (vía frLog: FixedFloatKept/StickyFloatKept/FloatingPreserved/FloatHidden + PERF-01)
js/background/capture-logic.js: FR=2 (CaptureRequested, ContentInjectDone)
popup.js: FR=2 | popup-start.js: FR=1
content sendMessage=34 | SW sendMessage=16 | toDataURL=5 createObjectURL=9 revokeObjectURL=9 | SW atob=3 btoa=2
```

**EVID-01 · ACTUALIZADO 2026-09-23 → IMPLEMENTADO (no bloquea):** la instrumentación en la ruta
de captura YA existe (STITCH_DUPLICATED_VIEWPORT_REGRESSION_001 aportó `ViewportTarget/Actual/Delta/
Capture`, `ScrollStableCheck pre/post`, `StitchDraw`, `StickyAdjustment`, `VisibleRect`;
FLOATING_001 aportó `FixedFloatKept/StickyFloatKept/FloatingPreserved/FloatHidden`; PERF-04 aportó
`PageShotSource`, PERF-01 `StyleClassification*/ClassificationCache*`, PERF-09 `ViewportStabilize`).
El inventario original ("solo 3 ocurrencias en popup") era de la revisión anterior y queda
superseded. La Fase 0 (instrumentación) se considera cumplida; el roadmap arranca en Fase 1.

---

## FASE 1 — Resumen ejecutivo

### 1.1 Veredicto

La extensión **funciona y está viva**, pero su motor de captura completa (`content.js`) arrastra **~1.600 líneas de un ancestro tipo GoFullPage** (el propio código lo declara: `AUDIT_EXTWEB_ORIGIN_001`) que hoy constituyen el 100% del coste de captura en páginas grandes. La MV3 se modernizó correctamente en el **background** (módulos ES, IndexedDB, offscreen, auth con token, watchdog, error buffer circular, telemetría de fases), pero:

1. **El content script es un monolito de 2.747 líneas** con estado global mutable en 40+ variables `capturex_*`, responsabilidades mezcladas (detección de scroll + manipulación de DOM + composición de imagen + UI de selección + render de PDF + dibujo de encabezado) y **estrategias duplicadas** (3 detectores de scroll, 3 implementaciones de "captura visible", 5 implementaciones de detección de navegador/SO, 4 de detección de PDF).
2. **El pico de memoria del stitching (MEM-01/PERF-02) → IMPLEMENTADO 2026 (ver Anexo E).** El `Promise.all` de bitmaps fue sustituido por `decodeBitmapStreaming` con `BITMAP_WINDOW=4` + `close()` inmediato (`content.js:695-740`, `StitchMemoryMode=STREAMING`). El canvas final único persiste como riesgo residual en páginas >45.000 px (ver 9.1), pero el pico de ~1,5 GB por decodificación simultánea queda eliminado.
3. **El coste por página en DOM grande → PARCIALMENTE MITIGADO (PERF-01 + PERF-05/06/07).** Clasificación fixed/sticky una vez por captura (`CaptureClassificationCache`), walk único pre-captura sin `innerHTML`, `getVisibleBoundingRect` con WeakMap + profundidad ≤15, prefijos acumulados O(N). Residual verificado: `changStyleForShot` re-evalúa candidatos del fallback por viewport (`content.js:2374`), `SM.updateFixed` recalcula `fullH/fullW` (reflow) por viewport y `getNewDocHeight` mide `scrollHeight` por viewport — ver PERF-06b y PERF-01b en Anexo E.
4. **El transporte doble base64 → IMPLEMENTADO (PERF-04/BinaryChannel).** `getNowShotImgData` adjunta `shotBlob` inline (`structured_clone`, `manifest.json`), `PageShotSource route=inline-blob` verificado en logs de campo (AvalPay: `blobPages=3/4 dataUrlPages=0`). Residual: rama fallback legacy `requestCaptureScreenshot` con dataURL 2-8 MB sigue viva (`content.js:3020-3028`) y el SW conserva `getBlobFromDataUrl`/`blobToDataUrl` con `atob` completo — ver PERF-04b en Anexo E.
5. **Existen 2 bugs funcionales de pérdida silenciosa** que convierten una mejora trivial en "la captura nunca termina": el *dedup de scrollTop* (`content.js:1856`) y el *aborto por imagen en blanco* (`service-worker.js:1155-1161`). Ambos carecen de timeout local y dependen del watchdog de 15 s para no dejar la extensión bloqueada.
6. **La restauración de estilos es incompleta por diseño**: `StylesManager.init()` vacía `_styleStack`/`_fixedStack` en **cada página** sin restaurar; los elementos tocados en páginas ≠ última **conservan `position:absolute !important`** con offsets obsoletos tras la captura.

### 1.2 Estado por área (tabla obligatoria de métricas)

| Área | Estado | Impacto | Prioridad | Beneficio Esperado |
|---|---|---|---|---|
| Motor de stitching (`content.js`) | 🟡 Medio (pico decode resuelto; canvas final único persiste) | Memoria + CPU | **P1** | Streaming BITMAP_WINDOW=4 hecho; falta tiling del canvas final |
| Detección de scroll (3 detectores + fallback `querySelectorAll('*')`) | 🟠 Alto (walk único PERF-05 hecho; triple walk residual) | CPU + Mantenibilidad | **P1** | Unificar a 1 walk compartido (PERF-06b) |
| StylesManager por página (`_classifyElements`) | 🟢 Bajo (caché por captura hecha) + residual por viewport | CPU | **P2** | Throttle `updateFixed` + memo `fullH/fullW` (PERF-01b) |
| Transporte base64 SW↔content (doble serialización) | 🟢 Bajo (BinaryChannel inline hecho) + fallback legacy vivo | CPU + Memoria + Mensajería | **P2** | Eliminar rama dataURL/pull (PERF-04b) |
| Re-encode PNG por viewport (`cropImageContent`) | 🟠 Alto | CPU + CPU del renderer | **P1** | −0,15/0,4 s por viewport |
| Dedup de `scrollTop` que corta la cadena | 🔴 Crítico | Funcional (captura incompleta) | **P0** | Elimina stall de 15 s + captura truncada silenciosa |
| Aborto silencioso por "imagen en blanco" (10 reintentos) | 🔴 Crítico | Funcional (captura perdida) | **P0** | Elimina >5 s de espera y capturas perdidas |
| Restauración incompleta de estilos (`_fixedStack` reseteado) | 🟠 Alto | Funcional (corrompe la página) | **P1** | Página queda intacta post-captura |
| Rutas PDF (4 detecciones divergentes + 1 rota) | 🟠 Alto | Funcional + Mantenibilidad | **P1** | Recupera PDF local (`file://`) hoy inoperante |
| Chunking `imgDataChunk*` sin productor | 🟡 Medio | Mantenibilidad + Memoria muerta | **P2** | −150 líneas, −1 Map sin límite |
| Watchdog recreado por mensaje | 🟡 Medio | CPU (timer churn) | **P2** | −1 `clearInterval`+`setInterval` por mensaje |
| Cola offline (`offline-db.js` + `trySyncPendingCaptures`) | 🟡 Medio | Memoria (unbounded) + Red | **P2** | Cota de lote; elimina `getAll()` sin límite |
| `scheduleAutoSync(3000)` on-wake | 🟡 Medio | CPU + Red | **P2** | −trabajo en cada despertar de SW |
| Duplicación navegador/SO (5 impl.) | 🟡 Medio | Mantenibilidad + Consistencia | **P2** | 1 fuente de verdad para metadatos |
| Acoplamiento content↔SW (protocolo implícito, sin contrato) | 🟠 Alto | Arquitectura | **P1** | Contrato versionado, handshake real |
| Código muerto/legacy (≈13 bloques, ~600 líneas) | 🟡 Medio | Mantenibilidad | **P2** | −22% de `content.js` sin cambio funcional |
| `[FEATURE_RUNTIME]` ausente en la ruta de captura | 🟢 Resuelto (45 content + 9 SW + 2 capture-logic + frLog SM) | Verificabilidad | — | Toda mejora ya es demostrable; mantener disciplina de marcadores |

**Leyenda:** 🔴 requiere intervención antes de cualquier nuevo feature · 🟠 deuda que degrada al escalar · 🟡 deuda que encarece el mantenimiento.

### 1.3 Los 3 riesgos que más probabilidad tienen de generar un ticket de usuario mañana

1. **"La captura de la página completa se queda cargando y nunca sale la evidencia"** → dedup de `scrollTop` + aborto por blanco silenciosos, sin error visible (FUNC-01, FUNC-02).
2. **"Se congeló la pestaña / se cerró sola"** → pico de ~1,5 GB en el stitching (PERF-02, MEM-01, MEM-02).
3. **"Después de capturar, la página quedó descolocada"** → restauración imperfecta de estilos fixed (FUNC-04).

---

## FASE 2 — Hallazgos funcionales

> Cada hallazgo indica la **ruta de usuario real** y el **marcador `[FEATURE_RUNTIME]` que lo demostraría** (definidos en Anexo B).

### FUNC-01 · `PERF_CRITICAL`/`FUNC_CRITICAL` — El dedup de `scrollTop` corta la cadena de stitching en silencio

- **Evidencia:** `content.js:1856-1857`
  ```js
  if (capturex_capturedScrollTops && capturex_capturedScrollTops.has(scrollTop)) return;
  if (capturex_capturedScrollTops) capturex_capturedScrollTops.add(scrollTop);
  ```
- **Mecánica:** si dos invocaciones consecutivas de `captureVisiblePageScreenshot` reciben el mismo `scrollTop`, la segunda **retorna sin enviar ningún mensaje al SW**. El SW ya había hecho `captureVisibleTab` y esperaba el siguiente `captureVisiblePageScreenshot`; nadie lo enviará. La única salida es el watchdog (`MAX_CAPTURE_TIME_MS = 15000`) → `triggerSelfHealing` → estado idle **sin evidencia y sin error mostrado al usuario**.
- **Cuándo ocurre (rutas alcanzables):**
  - `afterStyles()` reduce altura y recalcula `scrollTop = scrollTop - reduceHeight` (`content.js:1901+`) → puede reproducir un `scrollTop` previo.
  - Si `capturex_onePageHeight - capturex_onePageOverlap <= 0` (contenedor con `clientHeight` muy pequeño) el avance por página es 0 → **stall garantizado en la segunda iteración**.
  - En páginas virtualizadas el scroll real se estabiliza y `nextScrollTop` puede colapsar al mismo valor.
- **Ruta de usuario:** Popup → **"Toda la página"** (`ACTION_CAPTURE_ALL`) y atajo `Ctrl+Shift+S`.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CapturePageDedupSkipped scrollTop=<n> page=<i>` (no existe hoy). Contraste esperado: `CapturePage i=1..N` seguidos y **un `CaptureComplete` final**. Si aparece `DedupSkipped` y **no** hay `CaptureComplete`, el defecto está reproducido.
- **Fix:** sustituir el `return` por un avance forzado (`scrollTop = scrollTop + Math.max(120, overlap)`), y **siempre** emitir el siguiente mensaje o un error explícito `markCaptureError`. Nunca salir de la función sin notificar al SW.
- **Esfuerzo:** S.

### FUNC-02 · `FUNC_CRITICAL` — Aborto silencioso de la captura completa cuando un viewport "parece en blanco"

- **Evidencia:** `service-worker.js:1100-1109` (`isBlankImageData`), `1140` (`MAX = 10`), `1150-1162`
  ```js
  if (isBlankImageData(data)) {
      if (attempt < MAX) { setTimeout(tryCapture, backoff); }        // backoff = 150 + attempt*100
      else { finishCapturePerf(targetTabId, 'blank-capture', { attempt }); }  // ← sin error, sin aviso
      return;
  }
  ```
- **Mecánica:** al agotar 10 intentos el SW **no llama a `markCaptureError` ni envía nada al content script**. El content queda esperando `getNowShotImgData`; solo el watchdog lo desbloquea 15 s después. El usuario ve "Capturando..." y luego nada.
- **Además, el coste:** cada viewport en blanco cuesta 10 `captureVisibleTab` + espera acumulada ≈ 150+250+350+…+1050 ms ≈ **6 s**. En documentos con franjas blancas grandes (fin de página, visores PDF, tablas con mucho aire) esto se repite **por cada viewport blanco** y la captura degrada a minutos.
- **Heurística frágil:** muestrea `charCodeAt` sobre **los primeros 200 caracteres del PNG ya comprimido** (`atob` de la cabecera), no sobre píxeles. Dos imágenes blancas del mismo tamaño colisionan aquí; una imagen blanca de otro tamaño **no** se detecta. Falsos negativos y falsos positivos a la vez.
- **Ruta de usuario:** "Toda la página" / "Área visible" / fallback de PDF.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CaptureBlankAbort viewport=<i> attempts=10` vs `CaptureBlankRetry viewport=<i> attempt=<n>`.
- **Fix:** (a) usar `createImageBitmap` + muestreo real de píxeles (o `OffscreenCanvas` 1×N) en lugar de bytes comprimidos; (b) **límite 2 intentos**; (c) en el agotamiento, `markCaptureError` + `sendMessage` al content para que cierre el ciclo o degrade a "captura visible".
- **Esfuerzo:** M.

### FUNC-03 · `FUNC_HIGH` — Promesa colgada esperando `image.onload` sin `onerror` en la composición

- **Evidencia:** `content.js:2320-2335` (top), `2341-2355` (left), `2360-2375` (right), `2390-2405` (bottom).
  ```js
  const image = new Image();
  image.src = objectUrlTop;
  await new Promise(resolve => { image.onload = () => { … resolve(); }; });   // ← sin onerror
  ```
- **Mecánica:** si el `Blob`/`objectURL` no carga (revocado, memoria insuficiente al decodificar una franja grande, `blob` nulo porque `cropRangeImage` aún no terminó — ver FUNC-06), la promesa **nunca resuelve**: `splicingImagesAarray` queda pendiente para siempre, `capture_working` sigue en 1, no se libera `capturex_capture_array` y la pestaña retiene todos los blobs.
- **Ruta de usuario:** "Toda la página" en páginas con contenido más ancho/alto que el viewport (dispara `cropRangeImage`).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StitchSegmentLoadFail segment=top|left|right|bottom`.
- **Fix:** envolver en `Promise.race([onload, onerror→reject, timeout 3s])` y propagar a `captureError`.
- **Esfuerzo:** S.

### FUNC-04 · `FUNC_HIGH` — La restauración de estilos es estructuralmente incompleta (la página queda modificada)

- **Evidencia:** `js/sqa-styles.js:72-74`
  ```js
  init() {
      this._styleStack = [];     // ← descarta las entradas de init() anterior SIN restaurarlas
      this._fixedStack = [];     // ← idem: los fixed convertidos en páginas previas nunca se revierten
  ```
  y `js/sqa-styles.js:434-437` (`restoreAll()` solo drena las pilas **del último** `init`).
- **Mecánica:** `content.js:2024` llama `SM.init()` **una vez por página** (dentro de `changStyleForShot`). Cada `init()` (a) tira las pilas anteriores, (b) re-aplica `_hideScrollbars` + `_disableTransitions` (**inyectando 2 `<style>` nuevos por página**, `sqa-styles.js:388-396`), (c) re-ejecuta `_hacks()` con `querySelectorAll('[data-aos]')` y `[role="progressbar"]` (escaneo DOM completo por página). Como `_applyStyles` **concatena** sobre `cssText` actual (`sqa-styles.js:378-386`), cada página **acumula más `!important`** sobre los mismos elementos.
- **Resultado observable:** tras capturar, los elementos que fueron `fixed` en páginas intermedias conservan `position:absolute !important` con `left/top` calculados para otro scroll → **layout roto en la pestaña del usuario** (el síntoma clásico "la página quedó descolocada").
- **Ruta de usuario:** "Toda la página" en cualquier sitio con header fijo (Cloudscape, CloudWatch, consolas).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StyleRestoreBegin overrides=<n>` y `StyleRestoreEnd leftovers=<n>`; **PASS = `leftovers=0`** y `document.querySelectorAll('[class*="capturex_temp_shot"],[style*="!important"]').length` sin cambio respecto a pre-captura.
- **Fix:** `init()` debe restaurar antes de reiniciar (`this.restoreAll()` al entrar) y `_applyStyles` debe escribir con `setProperty(prop, val, 'important')` en vez de reescribir `cssText` completo; inyectar los `<style>` una sola vez (fuera del loop).
- **Esfuerzo:** M.

### FUNC-05 · `FUNC_MEDIUM` — Detección de navegador/SO implementada 5 veces con reglas divergentes

- **Evidencia:**
  - `service-worker.js:34-63` (`swGetSystemInfo`, OS vía `platformVersion.split('.')[2] >= 22000`)
  - `js/background/capture-logic.js:315-330` (`_detectOS`) + `333-339` (`_detectBrowser`) + `341-364` (`_getBrowserInfo`, repite la lógica de `_detectOS`)
  - `content.js:104-131` (`getBrowserVersion`) + `132-166` (`obtenOS`, regla **distinta**: `major >= 14 || build >= 22000`)
- **Consecuencia:** la misma captura puede reportar `Windows 11` en el encabezado dibujado por el content (`drawEvidenceHeader`) y `Windows 10` en el header HTTP `X-SQA-OS` del SW. `_detectOS` además toma el índice `[2]` (build) del `platformVersion`, mientras `obtenOS` compara índice `[0]` (major) — **resultados contradictorios para el mismo UA**.
- **Ruta de usuario:** todas las capturas (metadatos en encabezado + headers).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SysInfoResolved browser=… os=… source=content|sw` — debe emitirse **una sola vez por captura con un único valor**.
- **Fix:** extraer `js/shared/sysinfo.js` (compartido por content y SW) y consumirlo desde los 5 sitios.
- **Esfuerzo:** M.

### FUNC-06 · `FUNC_MEDIUM` — Race en `cropRangeImage`: franjas laterales se omiten silenciosamente

- **Evidencia:** `content.js:1217, 1231, 1245, 1259`
  ```js
  canvasWrapper.toBlob(blob => { capturex_capture_top = blob; }, 'image/png');   // fire-and-forget
  ```
  El consumidor (`content.js:2320`) lee `capturex_capture_top` y lo asigna a `image.src` **sin esperar**; si el `toBlob` no ha resuelto, la condición `if (capturex_capture_top)` es falsa y la franja **se descarta sin aviso** → evidencia con bordes cortados.
- **Ruta de usuario:** "Toda la página" cuando el `contentEle` sobresale del viewport.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StitchEdgeStrip segment=left present=true|false`.
- **Fix:** `cropRangeImage` debe devolver `Promise<{top,bottom,left,right}>` y hacer `await`.
- **Esfuerzo:** S.

### FUNC-07 · `FUNC_HIGH` — PDF local (`file://`) inoperante: envío de `workerBlob`, lectura de `workerText`

- **Evidencia (mismatch confirmado):**
  - Emisor: `service-worker.js:862-866`
    ```js
    let workerBlob = null;
    if (workerText) workerBlob = new Blob([workerText], { type: 'text/javascript' });
    chrome.tabs.sendMessage(tabId, { action: 'renderPdfInPage', data: b64, workerBlob }, …);
    ```
  - Receptor: `content.js:2664-2665`
    ```js
    else if (request.action === 'renderPdfInPage') {
        renderPdfInPage(request.data, request.workerText);   // ← propiedad que NUNCA se envía
    ```
  - Consumidor: `content.js:254` → `let wsrc = (workerBlob instanceof Blob && workerBlob.size > 100000) ? workerBlob : null;` → `throw new Error('Worker blob not provided by SW')`.
- **Doble defecto:** (1) nombre de propiedad distinto; (2) aun renombrándola, un `Blob` **no sobrevive** la serialización JSON de `chrome.runtime.sendMessage` (el propio código lo documenta en `content.js:305-311`, `BUG_PDF_DD_001`), por lo que llegaría `{}`.
- **Consecuencia:** la ruta "último recurso sin offscreen" para PDF local está **muerta**; el usuario recibe "No se pudo renderizar el PDF" y cae al fallback de captura visible.
- **Ruta de usuario:** abrir un PDF con `Ctrl+O` (esquema `file://`) → "Toda la página".
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] PdfLocalRenderStart` … `PdfLocalRenderOk pages=<n>` (hoy: `PdfLocalRenderFail reason=Worker blob not provided by SW`).
- **Fix:** enviar `workerText` (string) o una URL `chrome.runtime.getURL(...)`; para > 1 MB, trocear como se hace con `pdfLocalPdfChunk`.
- **Esfuerzo:** S.

### FUNC-08 · `FUNC_MEDIUM` — `nowTop` nunca es distinto de 0: la capacidad de reanudar captura es código muerto

- **Evidencia:** `content.js:1479` `captureAllPageScreenshot: function (nowTop = 0)`; el único invocador es el listener de mensajes (`content.js:~2640`) que llama **sin argumentos**, y `executeCapture` envía `{ action: actionName }` sin `nowTop` (`capture-logic.js:296`).
- **Consecuencia:** las ramas `nowTop > 0` de `captureSelectAllPageScreenshot` (`content.js:1670-1675`) y `getFullPageAction(top)` nunca se ejecutan → **~40 líneas inalcanzables** y una capacidad de producto (retomar tras interrupción) que no existe.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CaptureResumeRequested fromScrollTop=<n>` (esperado: **nunca** emitido; confirma el código muerto) — o `CaptureResumeGranted` si se decide implementarla de verdad.
- **Fix:** decidir producto (eliminar o implementar con `tabId`+`scrollTop` persistidos). No dejar el estado intermedio.
- **Esfuerzo:** S (borrar) / M (implementar).

### FUNC-09 · `FUNC_MEDIUM` — `document.contentType` como discriminador de PDF en el content script (ruta OOPIF)

- **Evidencia:** `content.js:1481-1484`
  ```js
  if (document.contentType === 'application/pdf' || /\.pdf($|[?#])/i.test(location.href) || …)
  ```
  En Chrome, el visor PDF es un **OOPIF** y `document.contentType` en el documento embebido no es fiable; el propio comentario del módulo (`capture-logic.js:90-96`) reconoce que "el PDF viewer (OOPIF) no expone scroll DOM".
- **Consecuencia:** la detección se resuelve por el **título** (`.pdf`) → falsos positivos en páginas cuyo título termina en ".pdf" (listados de carpetas, tickets) y falsos negativos en blob-PDF sin título.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] PdfRouteDetected reason=<url-pdf-ext|title-pdf-ext|blob-title-pdf|none> source=sw|content` + `PdfRouteMatched` (mismo `reason` en ambos).
- **Fix:** una única función `detectPdf(tab|document)` en `js/shared/`, usada por SW y content (ver ARCH-02).
- **Esfuerzo:** M.

### FUNC-10 · `FUNC_MEDIUM` — `captureVisibleOnly` desde content es un round-trip completo para una sola imagen

- **Evidencia:** `content.js:1467-1477` → envía `captureVisiblePageScreenshot` → SW captura → reenvía el base64 al content → content **dibuja encabezado + recomprime** → `processFinalImageBlob`.
- **Contraste:** `capture-logic.js:128` (`captureVisibleFastPath`) hace lo mismo **sin content script** (capture → blob → POST binario). Son **dos implementaciones del mismo botón**; la del content solo se usa ahora desde `sendPdfVisibleFallback` (`service-worker.js:729`).
- **Consecuencia:** en el fallback de PDF ya se paga el coste caro (round-trip + re-encode + encabezado) en vez del fast path barato; y el usuario puede recibir evidencia con/sin encabezado según la ruta.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] VisibleCaptureRoute route=fastpath|content-roundtrip` (hoy: `roundtrip` en el fallback PDF).
- **Fix:** que `sendPdfVisibleFallback` invoque `captureVisibleFastPath(tab)` y reservar la ruta del content a capturas con selección/área.
- **Esfuerzo:** S.

### FUNC-11 · `FUNC_LOW` — `setSelectionCaptureData` codifica el canvas dos veces (y descarta el primer resultado)

- **Evidencia:** `content.js:1383-1387`
  ```js
  canvasWrapper.toBlob(blob => {
      const cropImageDataUrl = canvasWrapper.toDataURL('image/png');   // ← re-encode completo
      chrome.runtime.sendMessage({ action: "setSelectionCaptureData", dataUrl: cropImageDataUrl });
      canvas = null;
  }, 'image/png');
  ```
  El `blob` del callback **nunca se usa**: se paga un encode PNG y **acto seguido** otro del mismo contenido. En la rama `OffscreenCanvas`, `toDataURL` además **crea un canvas DOM temporal y copia** (`content.js:29-37`).
- **Ruta de usuario:** "Seleccionar área" → **Confirmar**.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SelectionUpload route=dataurl bytes=<n>` (objetivo: `route=blob`).
- **Fix:** usar el `blob` del callback y enviar binario; eliminar el `toBlob` o el `toDataURL`, no ambos.
- **Esfuerzo:** S.

### FUNC-12 · `FUNC_LOW` — `showTip` definido dos veces (la primera versión es inalcanzable)

- **Evidencia:** `content.js:1961` `showTip: function (txt)` y `content.js:2572` `showTip: function (msg)` — **clave duplicada en el mismo objeto literal**; la segunda gana. La primera (~12 líneas, caja negra centrada) es código muerto.
- **Severidad real:** MAINTAINABILITY, pero es síntoma de que `capturex_com_saveAction` es un objeto de 1.400 líneas sin disciplina.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] ToastShown variant=toast` (nunca `centered-box`).
- **Fix:** eliminar la definición 1961.
- **Esfuerzo:** XS.

### FUNC-13 · `FUNC_MEDIUM` — `processFinalImage(null)` marca la captura como **completada**

- **Evidencia:** `service-worker.js:1291-1297`
  ```js
  if (!imageData || typeof imageData !== 'string') {
      if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
      clearHealingInterval();
      markCaptureCompleted();          // ← éxito falso
      return;
  }
  ```
  Idéntico en el caso `!blob` (`service-worker.js:1298-1304`). Igual patrón en `processFinalImageBlob` (`service-worker.js:1330-1336`): ante un payload inválido reporta `markCaptureCompleted()`.
- **Consecuencia:** el usuario cree que capturó; no hay evidencia ni error. Es exactamente el modo de fallo que oculta los bugs FUNC-01/02/03.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] FinalizeFailed reason=invalid-payload|conversion-failed` + **`CaptureComplete` ausente**.
- **Fix:** `markCaptureError('No se pudo procesar la imagen capturada.')`.
- **Esfuerzo:** XS.

### FUNC-14 · `FUNC_LOW` — `imgDataChunk*` y `workerState.nowShotImgData`: protocolos sin productor/consumidor

- **Evidencia:** `service-worker.js:486` (`message.action.startsWith('imgDataChunk')`) y `service-worker.js:1235` (`handleImageChunk`) — **ningún** emisor en el repositorio (`grep imgDataChunk` solo aparece en SW + CHANGELOG). `workerState.nowShotImgData` (`state.js:11`) se lee en `service-worker.js:317` y solo se **escribe** con `''` (`319`): nunca recibe una imagen.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] ChunkProtocolUsed` (esperado: nunca).
- **Fix:** eliminar protocolo, `Map` `tempImageStorage`, `allChunksPresent`, `destroyChunkStorage`, `scheduleTempImageCleanup`, `clearTempImageCleanup`, `TEMP_IMAGE_STORAGE_TTL_MS`.
- **Esfuerzo:** S.

---

## FASE 3 — Hallazgos de rendimiento

### PERF-01 · `PERF_CRITICAL` — `_classifyElements` recorre TODO el DOM con ~3 `getComputedStyle` por nodo, **en cada página**

- **Evidencia:** `js/sqa-styles.js:229-286` (recorrido) + `441-459` (`SearchNodesFast.next` con **dos** `getComputedStyle` en el filtro + uno más por elemento en el cuerpo) + `content.js:2022-2030` (llamada por página):
  ```js
  // content.js — changStyleForShot(), ejecutado en CADA viewport
  SM.init();
  SM.updateFixed(fullH, fullW, capturex_capture_array.length === 0);   // ← _classifyElements()
  ```
- **Coste teórico:** `3 × N` resoluciones de estilo por página. Con DOM de 50.000 nodos → 150.000 por página; a 2–6 µs por `getComputedStyle` en caché limpia ⇒ **≈0,3–0,9 s por viewport**. Para una captura de 50 viewports: **15–45 s** solo aquí, bloqueando el hilo principal (jank total, riesgo de "página no responde").
- **Agravante:** `init()` inyecta **2 `<style>` nuevos por página** (`sqa-styles.js:292-296, 301-305`) ⇒ **2 recálculos completos de estilo del documento por página**, además. Y `_hacks()` ejecuta `querySelectorAll('[data-aos]')` + `[role="progressbar"]` por página (`sqa-styles.js:334-336`).
- **Ruta de usuario:** "Toda la página" en cualquier consola grande (Cloudscape/CloudWatch).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StyleClassify page=<i> nodes=<n> ms=<t>` → **criterio PASS: `ms < 40` por página y estable** (hoy se espera crecimiento lineal con `nodes`).
- **Fix:** (1) clasificar **una sola vez** por captura (los `position:fixed` no cambian entre páginas) y cachear por `WeakMap`; (2) reemplazar `SearchNodesFast` por un recorrido que **no** consulte estilo (filtrar solo por `offsetParent === null` en un segundo pase); (3) mover `_hideScrollbars`/`_disableTransitions` fuera del loop.
- **Esfuerzo:** M.

### PERF-02 · `PERF_CRITICAL` — Decodificación simultánea de TODOS los cortes + canvas único de hasta 90.000 px

- **Evidencia:** `content.js:2347` y `content.js:2485`
  ```js
  const loaded = await Promise.all(items.map(item => loadBitmap(item)));   // ← TODOS a la vez
  ```
  seguido de `createUniversalCanvas(totalWidth, totalHeight + HEADER_HEIGHT)` (`content.js:2318`) con `capturex_capture_max_height = 90000` (`content.js:411`).
- **Coste teórico** (1920×1080, dpr 1, P = número de viewports):
  | Componente | Fórmula | P=40 | P=90 |
  |---|---|---:|---:|
  | Blobs de viewport retenidos (`capturex_capture_array`) | P × ~1 MB | 40 MB | 90 MB |
  | `ImageBitmap` decodificados a la vez | P × 1920×1080×4 B | **332 MB** | **747 MB** |
  | Canvas final | W × H × 4 B | **307 MB** | **691 MB** |
  | Canvas de crop por página (transitorio) | W×H×4 | ~8 MB | ~8 MB |
  | **Pico simultáneo** | | **≈0,7 GB** | **≈1,55 GB** |
- **Consecuencia:** en P=90 el renderer supera el presupuesto de memoria típico → **crash de pestaña / "Aw, Snap"**. No es hipotético: el límite de canvas de Chrome (`capturex_canvas_browserMaxArea_sys = 268435456`, `content.js:410`) permite 1920×139.810, es decir, el código "valida" tamaños que después no puede materializar.
- **Ruta de usuario:** páginas largas (los escenarios que el producto promete).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StitchBatch total=<P> decoded=<k> heapMB=<h>` — PASS = `decoded <= 2` y `heapMB` estable (hoy `decoded == P`).
- **Fix:** decodificar **de a 1–2 cortes**, dibujar y `close()` inmediatamente (ya existe el patrón `image.close()`, solo falta aplicarlo al `Promise.all`); opcionalmente escribir cada franja a un `OffscreenCanvas` por bloques y liberar el array al terminar cada bloque.
- **Esfuerzo:** S (es cambiar `Promise.all(items…)` por un loop secuencial con `close()` inmediato).

### PERF-03 · `PERF_HIGH` — Re-codificación a PNG de **cada** viewport (y doble composición)

- **Evidencia:** `content.js:1266-1336` (`cropImageContent` → `canvasWrapper.toBlob(blob => resolve(blob), 'image/png')`, líneas 1300-1305) invocado **por cada página** desde `content.js:2684`.
- **Coste:** 1 decode (`new Image`) + 1 `drawImage` + **1 encode PNG completo** por viewport. Un PNG de 1920×1080 tarda ~60–180 ms en el renderer. En 50 viewports: **3–9 s de CPU** pura, además de los blobs temporales.
- **Nota:** el contenido ya viene de `captureVisibleTab` con `format: 'png'` (`CAPTURE_IMAGE_FORMAT`), es decir **se vuelve a comprimir un PNG ya comprimido** sin cambiar formato ni calidad → trabajo redundante al 100%.
- **Ruta de usuario:** "Toda la página".
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CropEncode page=<i> ms=<t> bytes=<n>` (objetivo: eliminado; `ms=0`).
- **Fix:** no recomprimir: conservar el `Blob` original o dibujar sobre el canvas final directamente desde el `ImageBitmap` del `dataURL` **ya decodificado** por el SW (evita el viaje de ida y vuelta, ver PERF-04).
- **Esfuerzo:** M.

### PERF-04 · `PERF_HIGH` — Doble serialización base64 por viewport + base64 del resultado final

- **Evidencia:** cadena real por página:
  1. `service-worker.js:1166` — SW guarda el PNG como **data URL** en `captureImageDataByTab` (string base64, +33%).
  2. `service-worker.js:313-321` — el content lo **pide** (`requestCaptureScreenshot`) y el data URL completo **cruza el canal de mensajes** (multi-MB, serializado).
  3. `content.js:2684-2690` — el content lo decodifica (`new Image`), recorta (**PERF-03**) y lo guarda.
  4. `content.js:2545-2563` (`splitSendImgData`) — el resultado final se convierte con `FileReader.readAsDataURL` y se envía a `processFinalImageBlob`.
  5. `service-worker.js:1305+` — `getBlobFromDataUrl` hace `atob()` + **bucle `charCodeAt` byte a byte** (`service-worker.js:657-666`).
- **Coste:** por viewport, ~2 serializaciones base64 + 1 `atob` masivo; al final, 1 encode base64 (content) + 1 decode `atob` (SW) del **stack completo** (hasta ~40 MB de string). El bucle `for (i=0;i<len;i++) u8arr[i]=raw.charCodeAt(i)` es ~20–60 M iteraciones para una imagen de 20 MB → **cientos de ms bloqueando el SW**.
- **Volumen de mensajes:** ≈**4 mensajes por viewport** (contando el eco `getNowShotImgData`/`requestCaptureScreenshot`); una captura de 90 viewports ⇒ **≈360 mensajes**, uno de ellos con varios MB de payload en cada dirección.
- **Ruta de usuario:** todas las capturas completas.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] WireStats pages=<P> messages=<M> base64Bytes=<B>` — PASS = `base64Bytes` ↓60% y `M <= P+4`.
- **Fix:** (a) el SW **no** debe mandar el data URL al content: que el content devuelva solo el rect/crop y el SW componga (o al revés, pero una sola vez); (b) usar `chrome.runtime.sendMessage` con `Blob`/`ArrayBuffer` vía `structuredClone` o el protocolo de chunks binarios **ya existente y probado** en `pdfRenderBlobChunk` (`pdf-render.js:159`, `service-worker.js:376-400`); (c) reemplazar el bucle `charCodeAt` por `fetch(dataUrl).then(r=>r.blob())` o `Uint8Array.fromBase64` cuando esté disponible.
- **Esfuerzo:** L (cambio de protocolo; hacerlo detrás de un flag y con la misma telemetría `[PERF]` ya existente).

### PERF-05 · `PERF_HIGH` — `getMaxHeight`: `innerHTML` serializado **por cada nodo** (O(N·Σsubárbol))

- **Evidencia:** `content.js:1416-1461`, en particular:
  ```js
  if ((element.innerHTML.length > 100 || element.innerHTML.includes('<img')) && …)   // 1439
  ```
  invocado como `capturex_com_saveAction.getMaxHeight(document.body, 0, 20)` (`content.js:1663`).
- **Coste:** `innerHTML` **serializa el subárbol completo** de cada elemento. En un árbol de profundidad D y N nodos el trabajo es ≈ O(N × profundidad × tamaño de subárbol) → **cuadrático en la práctica**. Y se evalúa `innerHTML` **dos veces** en la misma condición (`length` y `includes`), re-serializando cada vez.
- **Alcance real:** se ejecuta en la ruta "iframe cross-origin a pantalla completa" y cuando el documento no supera el viewport +100 px pero hay elementos scrollables (`content.js:1509-1524` → `captureSelectAllPageScreenshot(null, 1)`). **No** se ejecuta en el caso "artículo largo simple".
- **Ruta de usuario:** "Toda la página" en páginas con iframe embebido grande.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] MaxHeightScan nodes=<n> ms=<t> innerHtmlCalls=<k>` (objetivo `k=0`).
- **Fix:** reemplazar `innerHTML.length > 100` por `element.childElementCount > 0 || element.textContent.length > 100` (o `element.querySelector('img')` con caché) y cachear por elemento.
- **Esfuerzo:** S.

### PERF-06 · `PERF_HIGH` — `ScrollFinder` hace `getComputedStyle` sobre todo el árbol y luego hay un **segundo** detector con `querySelectorAll('*')`

- **Evidencia:**
  - `js/sqa-scroll-finder.js:49-56` — `isHidden()` con `getComputedStyle(element)` **por nodo** dentro de `addAll()`.
  - `js/sqa-scroll-finder.js:152-172` — `getBounds(element)` recorre la cadena `offsetParent` llamando `getComputedStyle` en cada ancestro (`getTransformMatrix`).
  - `content.js:2603-2631` — si `ScrollFinder.find()` no devuelve elemento, el **fallback** recorre `document.body.querySelectorAll('*')` y llama `isVerticallyScrollable` (**otro** `getComputedStyle`) + `getBoundingClientRect()` + `isElementOccluded()` (`elementFromPoint`, que fuerza layout) **por elemento**.
- **Coste:** el fallback es el peor caso: `N × (getComputedStyle + getBoundingClientRect + elementFromPoint)`. `elementFromPoint` invalida layout → **layout thrashing** clásico (read/write intercalado). En 50.000 nodos esto puede tardar **segundos** y ocurre **antes** de empezar a capturar.
- **Además:** el encabezado del módulo declara "BFS-based detection" (`sqa-scroll-finder.js:6`) pero `SearchNodes.next()` usa `this.search.pop()` con `isBfs` sin activar ⇒ **es DFS** (`sqa-scroll-finder.js:29`, `_findByDim` en `154`). Documentación ≠ implementación.
- **Ruta de usuario:** "Toda la página" (fase de preparación, con la UI aún viva).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] ScrollDetect detector=finder|legacy nodes=<n> ms=<t>` — PASS = `detector=finder` y `ms < 50`.
- **Fix:** un solo detector; eliminar `isHidden` de estilo durante el recorrido (usar `offsetParent`/`clientHeight===0`), y **nunca** llamar `elementFromPoint` en bucle (bastan `elementsFromPoint` una vez sobre el candidato ganador).
- **Esfuerzo:** M.

### PERF-07 · `PERF_MEDIUM` — `simulateScroll` impone 80 ms muertos por página y lee estilo 2 veces

- **Evidencia:** `content.js:1690-1718` — la ruta de `WheelEvent` está **comentada** ("TEMPORAL AISLAMIENTO", línea 1695) y lo que queda es `getComputedStyle` al entrar + `setTimeout(…, 80)` con **otro** `getComputedStyle` dentro, para decidir si aplica un `transform` matricial. Se invoca por página cuando `contentEle.style.transform` es truthy (`content.js:1836`).
- **Coste:** 80 ms × P. En 50 páginas ⇒ **4 s fijos**. Y `window.getComputedStyle` sobre un elemento transformado fuerza recálculo.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SimulateScroll page=<i> waitedMs=80 dispatched=false`.
- **Fix:** sustituir por `requestAnimationFrame` (ya existe la utilidad `afterFrameStable`, `content.js:1869`) y eliminar el `getComputedStyle` de comparación (usar un flag propio).
- **Esfuerzo:** S.

### PERF-08 · `PERF_MEDIUM` — `wrapTextAnywhere` mide el texto carácter a carácter (O(n²)) y se ejecuta 2–3 veces por captura

- **Evidencia:** `content.js:59-79` — por **cada carácter** se hace `ctx.measureText(testLine)` sobre una cadena que crece ⇒ O(L²) mediciones. Usado en `drawEvidenceHeader` (`content.js:472`), en el pre-cálculo de `HEADER_HEIGHT` de `cropImage` (`content.js:1341-1346`) y de `splicingImagesAarray` (`content.js:2314-2319`).
- **Coste:** URLs con query strings largas (habitual en consolas AWS firmadas) de 1.500–3.000 caracteres ⇒ **millones** de mediciones ≈ decenas de ms cada una, ×3 por captura.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] HeaderTextWrap chars=<L> measures=<m> ms=<t>` — PASS = `measures < L` (hoy `m ≈ L²/2`).
- **Fix:** medir por palabras con un solo `measureText` de la cadena completa y partir por índice binario; o usar `ctx.measureText` una vez por palabra.
- **Esfuerzo:** S.

### PERF-09 · `PERF_MEDIUM` — Bucles cuadráticos en la composición y `dheight` recalculado dentro del loop

- **Evidencia:** `content.js:2365-2372` y `content.js:2505-2512` (y de nuevo en 2340-2346 / 2470-2480):
  ```js
  for (let i = 0; i <= endIdx; i++) {
      …
      let dheight = 0;
      for (let j = 0; j < i; j++) dheight += capturex_capture_array_height[j];   // O(P²) acumulado
  ```
  El mismo `dheight` se calcula **dos veces por iteración** (ramas `if/else` que no lo comparten) y también se duplica en la pasada de truncado por altura (`content.js:2280-2296`).
- **Coste:** O(P²) simbólico, despreciable frente a PERF-02 para P≈90 (≈8.000 sumas) pero es la señal de que este bloque no se diseñó para escalar.
- **Fix:** acumulador incremental (`offsetY += height[i-1]`).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StitchLoop segments=<P> sumOps=<n>`.
- **Esfuerzo:** XS.

### PERF-10 · `PERF_MEDIUM` — `afterFrameStable` puede añadir hasta 3 frames + timer por página, y encadena `afterFrameStable` anidado

- **Evidencia:** `content.js:1869-1880` (2 rAF + `setTimeout(0)` por tick, máx 3) y `content.js:1941-1960` (doble `afterFrameStable` anidado en el bloque final).
- **Coste:** ~6 rAF + 6 macrotareas en el último bloque. No es grave por sí solo, pero **multiplica** los puntos de suspensión sin garantizar que la página terminó de pintar (`getPageScrollTop()` puede estabilizarse antes de que el canvas tenga el frame nuevo). Es la causa raíz probable de "franjas repetidas/desplazadas" en sitios con scroll suave.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] FrameStable page=<i> frames=<k> ok=<bool>` + verificación de franja duplicada (`CapturePageDuplicate detected`).
- **Fix:** un único helper con timeout duro y confirmación por doble lectura de `scrollTop` **y** de `performance.now()` vs último paint (`requestAnimationFrame` timestamp).
- **Esfuerzo:** S.

### PERF-11 · `PERF_MEDIUM` — El watchdog se recrea en **cada** mensaje

- **Evidencia:** `service-worker.js:461-465`
  ```js
  if (handlers[message.action]) {
      log({ stage: 'capture', status: 'start', metadata: { action: message.action } });
      armHealingInterval();       // ← clearInterval + setInterval por mensaje
      touchHeartbeat();
      return handlers[message.action]();
  ```
  `armHealingInterval` (`service-worker.js:1455-1465`) hace `clearHealingInterval()` + `setInterval(…, 3000)`.
- **Coste:** en una captura de 90 viewports (≥360 mensajes) ⇒ 360 pares `clearInterval`/`setInterval` + 360 objetos de log `[sq]` con `JSON.stringify`. Además cada `log()` en un SW MV3 es coste real (consola retenida).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] WatchdogRearm count=<n>` (PASS: `count <= pages+2`).
- **Fix:** armar una sola vez al inicio de la captura (`armHealingInterval` idempotente: `if (healingInterval) return;`) y bajar `log()` a `console.debug` con gate de depuración.
- **Esfuerzo:** XS.

### PERF-12 · `PERF_MEDIUM` — `startCapturePerf` sobreescribe las marcas en cada página (se pierde la telemetría por página)

- **Evidencia:** `service-worker.js:522-531` (`capturePerfByTab.set(tabId, {...})`) llamado desde `handleVisibleCaptureRequest` (`service-worker.js:1121`) **una vez por viewport** → reinicia `marks` y `startedAt`. `finishCapturePerf` (`service-worker.js:546-557`) solo vuelca el **último** conjunto.
- **Consecuencia:** la instrumentación existente (`AUDIT_EXTWEB_REAL_PERF_001`) **no puede** demostrar la mejora por página que exige este mismo plan. Es un problema de verificabilidad, no de rendimiento.
- **Fix:** `startCapturePerf` idempotente (no recrear si existe) + `markCapturePerf` con `page` en `extra`.
- **Evidencia runtime requerida:** `[PERF] {op:'stitching-total', marks:[…]}` con **≥P entradas**.
- **Esfuerzo:** XS.

### PERF-13 · `PERF_LOW` — Esperas fijas residuales y micro-timers acumulados

- **Evidencia:** `content.js:1469` (`setTimeout(…, 100)` en `captureVisibleOnly`), `content.js:1531-1600` (`prepareTime` 150/30 ms + `setTimeout(10)` + `setTimeout(20)`), `capture-logic.js:293` (`setTimeout(150)` tras inyectar), `service-worker.js:132` (`400 ms`), `137` (`500 ms`), `1053` (`300 ms`), `ensurePdfRenderAlive` `779-783` (`800 ms`).
- **Coste:** ~0,3–1,1 s fijos por captura + ~1 s por arranque de SW solo en `setupKeepAlive` (y **fuerza recreación** del offscreen: `closeDocument()` + 400 + create + 500 ms, `service-worker.js:115-133`).
- **Riesgo funcional añadido:** si el SW se reinicia mientras un PDF se renderiza, `setupKeepAlive()` **cierra el offscreen** ⇒ se mata el render en curso (la puerta `ensurePdfRenderAlive` lo reintenta, pero se pierde el trabajo ya hecho).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] OffscreenRecreated duringRender=<bool>` (PASS: `false`).
- **Esfuerzo:** M.

### PERF-14 · `PERF_LOW` — `validarIconos()` hace 8 `fetch HEAD` en cada install/startup

- **Evidencia:** `service-worker.js:161-193`. Coste trivial pero **gratuito**: los iconos vienen del propio paquete de la extensión (no pueden faltar salvo build roto). Es la definición de "validación redundante".
- **Fix:** eliminar o gatear a `?debug=1`.
- **Esfuerzo:** XS.

### PERF-15 · `PERF_LOW` — `scheduleAutoSync(3000)` en el top-level del SW

- **Evidencia:** `service-worker.js:1708` (y otra vez `1697-1699` en `onStartup`).
- **Consecuencia:** cada despertar del SW abre IndexedDB (`openDB`), cuenta pendientes y potencialmente convierte blobs a base64. El SW se despierta con mucha frecuencia (notificaciones, tabs, `onActivated`).
- **Fix:** `scheduleAutoSync` solo si `countPendingCaptures() > 0` y con backoff persistido.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SyncScheduled reason=… pending=<n>` (PASS: no se programa si `pending=0`).
- **Esfuerzo:** S.

### PERF-16 · `PERF_LOW` — `isBlankImageData` ejecuta `atob` sobre el data URL completo en cada intento

- **Evidencia:** `service-worker.js:1100-1109` — `atob(dataUrl.substring(commaIdx+1))` decodifica **todo** el base64 (pocos MB) para inspeccionar 200 bytes. Hasta 10 veces por viewport en blanco (ver FUNC-02).
- **Fix:** `dataUrl.slice(commaIdx+1, commaIdx+260)` antes del `atob` (y, mejor, muestreo de píxeles).
- **Esfuerzo:** XS.

---

## FASE 4 — Hallazgos de memoria

### MEM-01 · `MEMORY` `PERF_CRITICAL` — `Promise.all` de `createImageBitmap` (todos los cortes decodificados a la vez)

- **Evidencia:** `content.js:2347`, `content.js:2485`.
- **Pico:** P × W × H × 4 B (ver tabla PERF-02): 332 MB para P=40, **747 MB para P=90**. Los bitmaps solo se liberan con `image.close()` **después** de dibujarse (línea 2385/2520), es decir, cuando todos ya existen.
- **Fuga adicional:** si el bucle lanza (p. ej. `drawImage` con dimensiones inválidas cuando `totalHeight` excede el máximo), los `ImageBitmap` de `loaded` **nunca** se cierran.
- **Fix:** decodificar y cerrar de a uno; envolver en `try/finally` con cierre garantizado.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StitchBitmapsOpen max=<k> heapMB=<h>` (PASS `max <= 2`).

### MEM-02 · `MEMORY` `PERF_CRITICAL` — Canvas final de una sola pieza (hasta 691 MB) + retención del array de cortes

- **Evidencia:** `content.js:2318-2319` (canvas `totalWidth × totalHeight+HEADER`), `capturex_capture_max_height = 90000` (`content.js:411`), `capturex_canvas_browserMaxArea_sys = 268435456` (`content.js:410`).
- **`capturex_capture_array`** (`content.js:401`) acumula **todos** los viewports (Blob **o** data URL string según la rama, `content.js:2692` vs `2701`) y solo se libera en `releaseCaptureBuffers()` (`content.js:460`), que se llama en `splitSendImgData()` (`content.js:2565`) — es decir, **después** de la composición completa.
- **Riesgo:** en la rama sin `contentEle` se empujan **strings base64** (≈1,33× el PNG) en lugar de Blobs ⇒ 90 × ~2,7 MB ≈ **243 MB solo en strings**, además de lo anterior.
- **Fix:** liberar por segmento (`capturex_capture_array[i] = null` tras dibujar, no solo al final) y componer en tiras con `OffscreenCanvas.transferToImageBitmap()`.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CaptureArrayAfterStitch entries=<k>` (PASS: `0` antes de `splitSendImgData`).

### MEM-03 · `MEMORY` `PERF_HIGH` — `capturex_snap_mergedImage_array` retiene **todas** las tiras hasta el final

- **Evidencia:** `content.js:2187` / `2208` (`push(mergedImage)`), consumidas/jerarquizadas en `splitSendImgData` (`content.js:2545-2563`) y liberadas en `releaseCaptureBuffers()`.
- **Consecuencia:** con la página partida en N tiras de hasta 32.767 px de alto, se mantienen N-PNGs de gran tamaño simultáneamente **mientras** se sigue componiendo.
- **Fix:** enviar cada tira al SW en cuanto se compone (streaming) y liberar; el SW ya sabe ensamblar (`pdfRenderBlobChunk`).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SnapshotTiers peak=<n>` (PASS: `1`).

### MEM-04 · `MEMORY` `PERF_HIGH` — `captureImageDataByTab` sin TTL ni cota

- **Evidencia:** `service-worker.js:68` (`new Map()`), `1166` (`set(targetTabId, data)` con un data URL multi-MB), `319` (`delete` solo cuando el content lo pide).
- **Fuga:** si el content script muere o no llega a pedir (`requestCaptureScreenshot`) — p. ej. tras FUNC-01/02 — la entrada **permanece** con varios MB hasta el cierre de la pestaña. No hay TTL, ni `onRemoved`, ni limpieza en el watchdog (`triggerSelfHealing` limpia `tempImageStorage`, `capturePerfByTab` y `activeTabs`, **pero no este Map**).
- **Fix:** borrar en `chrome.tabs.onRemoved` y en `triggerSelfHealing`, y añadir TTL.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] PendingImageDataMap size=<n>` tras `CaptureComplete` (PASS: `0`).

### MEM-05 · `MEMORY` `PERF_MEDIUM` — Cola offline cargada completa en memoria (`getAll()` sin límite) y base64 de todo el lote

- **Evidencia:** `js/background/offline-db.js:94-101` (`store.getAll()` devuelve **todos** los blobs), consumido por `service-worker.js:1543-1545` (`OfflineDB.getAllPendingCaptures()`), y `tryBatchSync` (`service-worker.js:1571-1583`) convierte **cada** blob a data URL para el payload JSON:
  ```js
  for (const cap of pending) { … dataUrl = await blobToDataUrl(cap.blob) … caps.push({…dataUrl}) }
  ```
- **Pico:** `Σ tamaños de todas las capturas pendientes × 2,33` (blob + base64) + el JSON serializado. Con 20 capturas de 5 MB ⇒ **≈230 MB** en un Service Worker.
- **Fix:** paginar (`count` + cursor por lotes de 5), y usar `/api/capture-binary` por ítem (ya existe) en lugar de base64 para el lote.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] OfflineSyncBatch pending=<n> peakHeapMB=<h>` (PASS: `n <= 5`).
- **Esfuerzo:** M.

### MEM-06 · `MEMORY` `PERF_MEDIUM` — `pdfCaptureChunks` retiene N slices **y** el blob ensamblado

- **Evidencia:** `pdf-render.js:159-167` (envía N slices de 1,5 MB) y `service-worker.js:381-400`:
  ```js
  entry.chunks[message.index] = message.blob; …
  const finalBlob = new Blob(entry.chunks, { type: 'image/png' });
  ```
  `new Blob(arrayOfBlobs)` mantiene **ambos** (slices + resultado) hasta que los slices se sueltan; `entry` se borra en `finishPdfCaptureCleanup` (`service-worker.js:705-710`) **después**. Pico ≈ 2 × tamaño del PNG (para 180 MB de canvas ⇒ PNG de ~40 MB ⇒ ~80 MB transitorios).
- **Riesgo de integridad:** `sendToSw` (`pdf-render.js:16`) **ignora la respuesta** (`rtn`) y no reintenta; si el SW se suspende entre slices, el ensamblaje **nunca** completa y solo lo rescata el timeout de 90 s (`CHUNK_TIMEOUT_MS * 3`).
- **Fix:** `entry.chunks[i] = null` tras ensamblar; ack + retry por slice con `rtn`.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] PdfChunksAssembled total=<n> acked=<k>` (PASS: `k == n`).
- **Esfuerzo:** M.

### MEM-07 · `MEMORY` `PERF_MEDIUM` — `_bboxCache` (WeakMap) devuelve rects obsoletos y el patrón `canvas = null` no libera

- **Evidencia:** `content.js:434-441` (`_getCachedRect`/`_clearBBoxCache`), invalidation solo en `reSetCaptureXData` (`content.js:888`) y `restoreStyleForShot` (`content.js:2132`). Entre medio, `changStyleForFullShot` **cambia `min-height`** de los elementos (`content.js:1985-2000`) ⇒ los rects cacheados (usados en `isElementOccluded` y en la clasificación de `fixed`, `content.js:2099-2118`) quedan **desactualizados**.
- **`canvas = null` tras `toBlob`** (`content.js:2324-2327`, `2530-2532`): no libera nada porque el closure mantiene vivo `canvasWrapper`. Es un micro-mito de GC que da falsa sensación de seguridad.
- **Fix:** invalidar el cache tras cada cambio de estilo masivo; eliminar los `canvas = null` inútiles y en su lugar **no retener** el wrap (declararlo en scope del `try`).
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] BBoxCacheInvalidations n=<k>` y `OffByOneRect detected=<bool>`.

### MEM-08 · `MEMORY` `PERF_MEDIUM` — `_sceneStack` de estilos crece por página y los `<style>` inyectados se acumulan

- **Evidencia:** `js/sqa-styles.js:388-396` (`_addStyleSheet` hace `appendChild` de un `<style>` nuevo y lo **empuja a `_styleStack`**), llamado desde `_hideScrollbars`, `_disableTransitions` y `_hacks` ⇒ **≥2 nodos `<style>` por página** hasta `restoreAll()`.
- **Coste:** cada `<style>` nuevo invalida el estilo del documento completo (recálculo O(N)), y los nodos se acumulan (90 páginas ⇒ ~180 `<style>` activos durante la captura).
- **Fix:** inyectar una sola vez (idempotente por `id`) y actualizar su contenido.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] InjectedStyleNodes n=<k>` (PASS: `k <= 2`).

### MEM-09 · `MEMORY` `PERF_LOW` — Observers y listeners del content script nunca se liberan

- **Evidencia:**
  - `content.js:747-780` (`isScrollLoadedElement`): crea un `MutationObserver` con `subtree: true` sobre el contenedor scrollable; se desconecta en `cleanup()`/timeout, correcto — **pero** si `resolve(true)` ocurre por crecimiento, `cleanup()` sí se llama. OK.
  - `content.js:1091-1166` (`captureSelectionEdit`): añade `mousedown`, `mousemove`, `mouseup`, `keydown` **a `document`** y los elimina en `mouseup`/`Escape`. **Ruta de fuga:** si el usuario pulsa **Confirmar/Copiar** (`handleEditBtnClick`/`handleCopyBtnClick` → `handleCancelBtnClick`), se llama `clearSelectionDiv()` que **sí** quita `keydown`… pero `mousedown/mousemove/mouseup` se quitaron en `mouseup`, así que OK. **Sin embargo**, si la captura se inicia y el usuario no interactúa (cierra la pestaña del popup), los 4 listeners de `document` permanecen activos hasta el reload, y cada nuevo `captureSelectionEdit` **vuelve a añadirlos** (`content.js:1107-1108` `document.addEventListener` sin guardia de idempotencia) ⇒ **acumulación de listeners duplicados** por invocación.
  - `content.js:2636-2725` (`chrome.runtime.onMessage`) se registra una sola vez gracias al guard `window.hasInjectedContentScript` (`content.js:16`), pero **el guard no protege contra reinvocaciones dentro de una misma pestaña tras invalidación de contexto** (`content.js:9-13`): si `contextInvalidated`, se vuelve a registrar el listener → **doble ejecución** de `captureAllPageScreenshot` (dos capturas simultáneas, dos loops de scroll sobre la misma página).
- **Fix:** guardias de idempotencia en todos los `addEventListener` de nivel `document`/`window`; reemplazar `window.hasInjectedContentScript` por un símbolo en `globalThis` con versión.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] ContentListenersRegistered count=<n> (expected 1)`.
- **Esfuerzo:** S.

---

## FASE 5 — Hallazgos arquitectónicos

### ARCH-01 · `ARCHITECTURE` — `content.js` es un módulo-Dios de 2.747 líneas con 40+ globales mutables

- **Evidencia:** `content.js:398-458` declara ~40 variables `capturex_*` de estado de captura; `capturex_com_tools` (`content.js:470-853`) mezcla **detección de scroll, matemática de layout, manipulación de DOM, portapapeles y trazas de permisos**; `capturex_com_saveAction` (`content.js:855-2632`) mezcla **UI de selección, crop, composición de canvas, dibujo de encabezado, toasts, detección de scroll y el loop de stitching**.
- **Consecuencia:** cualquier cambio en una responsabilidad obliga a razonar sobre 1.400 líneas de estado compartido; imposible testear unitariamente (todo depende de `document`, `window.devicePixelRatio` y estado global mutable).
- **Candidatos de extracción (servicios):**
  | Servicio propuesto | Origen | Líneas aprox. |
  |---|---|---:|
  | `capture/scroll-engine.js` | `captureVisiblePageScreenshot`, `afterFrameStable`, `scrollTopForCapture`, `simulateScroll` | ~260 |
  | `capture/stitcher.js` | `splicingImagesAarray*`, `splitSendImgData`, `releaseCaptureBuffers` | ~330 |
  | `capture/edge-crop.js` | `cropRangeImage`, `cropImageContent`, `cropImage` | ~200 |
  | `capture/header.js` | `drawEvidenceHeader`, `wrapTextAnywhere`, `formateaFechaHora`, `fetchNextEvidenceId` | ~120 |
  | `capture/scroll-detect.js` | `findScrollableElements`, `getMaxHeight`, `isVerticallyScrollable*` | ~180 |
  | `selection/area-overlay.js` | `captureSelectionEdit` + handlers | ~270 |
  | `pdf/inpage-render.js` | `renderPdfInPage`, `readLocalPdfAndStream` | ~140 |
  | **Total extraíble** | | **~1.500** |
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] ModuleLoaded name=<service> version=<v>` por cada servicio (demuestra que la ruta real pasó por el módulo extraído y no por el monolito).

### ARCH-02 · `ARCHITECTURE` — Detección de PDF: 4 implementaciones divergentes (y 2 muertas)

- **Evidencia:**
  | # | Ubicación | Estado | Regla |
  |---|---|---|---|
  | 1 | `js/background/capture-logic.js:84-97` (`pdfRouteReason`) | **activa** | 6 ramas + motivo |
  | 2 | `service-worker.js:713-724` (`isPdfPageTab`) | **MUERTA** (sin invocadores) | regex `\.pdf(\?.*)?(#.*)?$` |
  | 3 | `js/background/capture-logic.js:99-101` (`isPdfPageTab`) | **MUERTA** (sin invocadores) | delega en #1 |
  | 4 | `content.js:1481-1483` (inline en `captureAllPageScreenshot`) | activa | `contentType` + regex + blob |
- **Riesgo:** las regex **no son equivalentes** (`\.pdf($|[?#])` vs `\.pdf(\?.*)?(#.*)?$`): un documento `.pdf?x` matchea en #1 y **no** en #2. Como #2/#4 deciden rutas distintas (offscreen vs render en página vs captura normal), una divergencia futura produce "a veces captura el PDF y a veces no".
- **Fix:** un único `js/shared/pdf-detect.js` con tests.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] PdfRouteDecision reason=<r> source=sw` y `PdfRouteDecision reason=<r> source=content` — PASS = **mismo `reason`** en ambos.

### ARCH-03 · `ARCHITECTURE` — Protocolo content↔SW implícito, sin contrato ni handshake de versión

- **Evidencia:** hay **34** llamadas a `chrome.runtime.sendMessage`/`chrome.tabs.sendMessage` sin ningún despachador tipado; las acciones se escriben a mano como strings en `content.js` (`"captureVisiblePageScreenshot"`, `"getNowShotImgData"`, `"requestCaptureScreenshot"`, `"croppedImageResult"`, `"setSelectionCaptureData"`, `"processFinalImageBlob"`, `"captureError"`, `"captureWarning"`, `"pdfCaptureRequest"`, `"readLocalPdfBytes"`, `"renderPdfInPage"`, `"pdfInPageError"`, `"pdfWorkerTrace"`, `"setProgress"`, `"openNewTab"`, `"contentjsIsLoad"`, `"checkContentLoaded"`, `"showTip"`, `"RESET_CAPTURE_STATUS"`), y solo **algunas** están en `ACTIONS` (`js/background/constants.js:5-15`, que además contiene `captureStatus`/`openViewer`/`getCaptureStatus` sin emisor).
- **El brief menciona "Version Handshake" — no existe.** El único guard es `checkContentLoaded`, que devuelve `{loaded:true}` **sin versión**. Consecuencia real y ya visible: tras actualizar la extensión, un content script **viejo** (ya inyectado en la pestaña) sigue respondiendo con un protocolo antiguo, y el SW no puede detectarlo. Los bugs `BUG_PDF_WORKER_001`, `BUG_PDF_001c` y los 6 puntos de inyección con **conjuntos de archivos distintos** son la prueba de que esto ya duele.
  - Inyección A: `capture-logic.js:289` → `[sqa-scroll-finder, sqa-styles, content]`
  - Inyección B: `service-worker.js:733` (`sendPdfVisibleFallback`) → `[content]`
  - Inyección C: `service-worker.js:830` (`renderInPageFallback`) → `[pdf.min.js, content]`
  - ⇒ el mismo `content.js` corre con o **sin** `__sqaScrollFinder`/`__sqaStylesManager`, lo que activa silenciosamente el **fallback legacy** caro (PERF-06) sin que nadie lo sepa.
- **Fix:** `js/shared/protocol.js` con `PROTOCOL_VERSION` + `checkContentLoaded` devolviendo `{loaded:true, protocol:SQA_PROTOCOL_VERSION, services:['scrollFinder','stylesManager']}`; el content declara capacidades y el SW decide si reinyectar módulos faltantes.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] HandshakeOk protocol=<v> services=<list>` — y `HandshakeStale` cuando el protocolo no coincide (PASS: nunca en instalación limpia).
- **Esfuerzo:** M.

### ARCH-04 · `ARCHITECTURE` — Dependencias globales en vez de contratos (`window.__sqa*`)

- **Evidencia:** `js/sqa-scroll-finder.js:333` y `js/sqa-styles.js:466` exponen singletons en `window`; `content.js:2606` y `:2022` los consumen con `if (SM)` / `if (SF)` y **fallback silencioso** al camino legacy.
- **Riesgo de mantenimiento:** (a) el fallback nunca se prueba (nunca se sabe cuál de los dos caminos corre en producción); (b) cualquier página que defina `window.__sqaStylesManager` (colisión accidental de nombre con `__sqa`) altera el comportamiento; (c) el orden de carga es un contrato implícito de `manifest`/`executeScript`.
- **Fix:** pasar los servicios por un objeto de capacidades inyectado (`window.__SQA_services` congelado) y **eliminar** los fallbacks legacy tras un periodo de telemetría que demuestre 0 usos.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] StylesManagerUsed used=<bool> fallback=<bool>` — hoy no hay forma de saberlo.

### ARCH-05 · `ARCHITECTURE` — Responsabilidades mezcladas en el SW: ruta PDF embebida en el despachador de mensajes

- **Evidencia:** `service-worker.js:223-458` — un único `onMessage` de ~235 líneas contiene 20 handlers inline, incluidos ~10 de PDF; `service-worker.js:800-870` (`renderInPageFallback`) mezcla **descarga del PDF, conversión base64, inyección de scripts, gestión de timers, lectura del worker y despacho de mensajes**. La indentación del bloque `try/catch` del worker (`service-worker.js:844-861`) es engañosa: el `} catch (e)` está a columna 0 y un `}` cierra el `if (!workerText)` — **el código es válido pero ilegible** (verificado por AST).
- **Fix:** `js/background/pdf-pipeline.js` (ya existe el nombre en comentarios) + despacho por registro (`{ action: handler }`) en lugar del `if/else` gigante; `handlers` ya está empezando a hacerlo, llevarlo hasta el final.
- **Esfuerzo:** M.

### ARCH-06 · `ARCHITECTURE` — Listeners duplicados a nivel de módulo

- **Evidencia:** `service-worker.js:90` y `service-worker.js:1697` registran **dos** `chrome.runtime.onStartup`; `service-worker.js:215` y `service-worker.js:1703` registran **dos** `chrome.tabs.onActivated`. Además `service-worker.js:137` ejecuta `setupKeepAlive()` en top-level **y** `onInstalled` (`87`) y `onStartup` (`92`) lo repiten (mitigado por `_offscreenReadyPromise`, pero el lock se **anula** en `779-783` sin coordinación).
- **Fix:** un solo punto de registro; `setupKeepAlive` estrictamente idempotente sin resetear el lock.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] SwBootstrap listeners=<n>` (PASS: `onStartup=1, onActivated=1`).

### ARCH-07 · `ARCHITECTURE` — Duplicación literal de utilidades entre módulos

| Utilidad | Copia A | Copia B | Diferencia |
|---|---|---|---|
| `getTransformMatrix` | `js/sqa-scroll-finder.js:64-71` | `js/sqa-styles.js:26-33` | idéntica |
| `getBounds` | `js/sqa-scroll-finder.js:87-113` | `js/sqa-styles.js:36-52` | casi idéntica (A soporta `isFrame`) |
| `_classifyElements` walker | `SearchNodes` (`sqa-scroll-finder.js:17-57`) | `SearchNodesFast` (`sqa-styles.js:441-459`) | misma idea, 2 implementaciones |
| `pdfRouteLog`/`pdfUrlInfo` | `js/background/utils.js:104-117` | `content.js:87-95` | misma etiqueta, distinto formato |
| Pre-cálculo de `HEADER_HEIGHT` | `content.js:1341-1346` | `content.js:2314-2319` | idéntico, dentro del mismo archivo |
| Timeout con `Promise.race` | `capture-logic.js:65-77` | `service-worker.js:754-768` (`pingOffscreenPdf`), `service-worker.js:1093-1099` | 3 variantes |
| Loop base64↔bytes | `service-worker.js:657-666`, `content.js:203-208`, `content.js:321`, `pdf-render.js:38-43`, `service-worker.js:877-881`, `service-worker.js:996-1000` | — | **6 copias** del mismo patrón `bin += String.fromCharCode.apply(null, bytes.subarray(...))` |

- **Nota:** el patrón `String.fromCharCode.apply(null, subarray)` con `subarray` grande es además una **bomba de stack** (`RangeError: Maximum call stack size exceeded`) si el bloque no está acotado; en `content.js:203-208` el `STEP` es 32768 (seguro), pero en otros puntos depende del tamaño.

### ARCH-08 · `ARCHITECTURE` — Cobertura de instrumentación asimétrica (el SW no puede probar el content)

- **Evidencia:** el content solo emite 3 tipos de traza (`[CAPTURE_PERF]`, `[PERMISSION_TRACE]`, `wtrace` → `pdfWorkerTrace`), y `[PERF]` de stitch (`content.js:2554-2557`). El SW tiene `capturePerfByTab`, `log()` estructurado, `blobToDataUrl`/`getBlobFromDataUrl` con `heapMB()` (`service-worker.js:455-457`).
- **Problema:** no hay `captureId`/`correlationId` compartido, así que **no se puede correlacionar** una captura de extremo a extremo; y `startCapturePerf` se sobreescribe por página (PERF-12). Toda afirmación de rendimiento extremo-a-extremo es hoy **no verificable**.
- **Fix:** `captureId` generado en `executeCapture` y propagado en todo mensaje; `[PERF]` con el mismo `captureId` en content y SW.
- **Evidencia runtime requerida:** `[FEATURE_RUNTIME] CorrelationOk captureId=<id> events=<n>` (PASS: `n >= 6` con el mismo id).

---

## FASE 6 — Top 20 mejoras recomendadas

| # | ID | Clasificación | Mejora | Archivo(s) | Esfuerzo | Impacto | Ruta de usuario | Evidencia `[FEATURE_RUNTIME]` que la valida |
|---|---|---|---|---|---|---|---|---|
| 1 | FUNC-01 | `FUNC_CRITICAL` | Nunca salir del loop de stitching sin notificar al SW (eliminar el `return` seco del dedup) | `content.js:1856` | S | Elimina stall de 15 s y capturas truncadas | "Toda la página" | `CapturePage i=1..N` + `CaptureComplete` (sin `DedupSkipped`) |
| 2 | FUNC-13 | `FUNC_HIGH` | `markCaptureError` en vez de `markCaptureCompleted` ante payload inválido | `service-worker.js:1291,1298,1330` | XS | Deja de ocultar fallos | Todas | `FinalizeFailed` presente y `CaptureComplete` ausente |
| 3 | FUNC-02 | `FUNC_CRITICAL` | Detección de blanco por píxeles + 2 intentos + error explícito | `service-worker.js:1100,1140-1162` | M | −6 s por viewport blanco; fin de capturas perdidas | Todas | `CaptureBlankAbort attempts=2` + error visible |
| 4 | MEM-01/PERF-02 | `MEMORY`/`PERF_CRITICAL` | ✅ HECHO — bitmap streaming ventana 4 + `close()` inmediato | `content.js:695-740` | — | Pico decode eliminado; resta tiling canvas final (MEM-02) | "Toda la página" larga | `StitchBitmapsOpen max=1` observado, `StitchMemoryMode=STREAMING` |
| 5 | MEM-02 | `MEMORY` `PERF_CRITICAL` | Componer en tiras + liberar `capturex_capture_array[i]` al dibujar | `content.js:2320-2400,2545` | M | −250 MB; canvas final ≤ 1 tira | "Toda la página" | `CaptureArrayAfterStitch entries=0` |
| 6 | MEM-03 | `MEMORY` `PERF_HIGH` | Enviar cada tira al SW en streaming | `content.js:2187,2545` | M | −50% de retención; evita el Tope de 32.767 px | "Toda la página" | `SnapshotTiers peak=1` |
| 7 | FUNC-04 | `FUNC_HIGH` + `MEMORY` | Restaurar antes de reiniciar `init()` y aplicar estilos con `setProperty(…, 'important')` | `js/sqa-styles.js:72-74,378-386` | M | La página queda intacta; sin acumulación de `!important` | "Toda la página" con header fijo | `StyleRestoreEnd leftovers=0` |
| 8 | PERF-01 | `PERF_CRITICAL` | ✅ HECHO — `CaptureClassificationCache` 1×/captura + `<style>` idempotente | `js/sqa-styles.js:233,403` | — | Resta throttle por viewport (PERF-01b, Anexo E) | Cloudscape/CloudWatch | `ClassificationCacheUsed … ClassificationCacheHit` en vp1+ |
| 9 | PERF-06 | `PERF_CRITICAL` | ✅ HECHO (PERF-06b 2026-09-23) — walk único: `preScanDocument` primero y `SF.findFromCandidates(raw, frames)` evalúa solo candidatos (estilos por candidato, sin BFS ni `querySelectorAll`); `ScrollDetect detector=finder prefiltered=N` en todas las ramas | `content.js:2872-2924` + `js/sqa-scroll-finder.js:189` | — | −1 walk completo + ~N estilos por captura | "Toda la página" | `ScrollDetect detector=finder prefiltered=<10` |
| 10 | PERF-04 | `PERF_HIGH` | ✅ HECHO (PERF-04b 2026-09-23) — canal binario inline + pull legacy eliminado (handler `requestCaptureScreenshot` suprimido, `processShot` Blob-only con fallo visible vía `captureWarning`, retención SW solo-Blob con `delete` en éxito y fallo, `isBlankImageData` por muestra de 340 chars) | `service-worker.js:475,1369,1438` `content.js:2975` | — | −1 mensaje y −1 FileReader por viewport; veredicto blank idéntico | Todas | `PageShotSource route=inline-blob dataUrlPages=0` + `BlankCheck` |
| 11 | PERF-03 | `PERF_HIGH` | No recomprimir a PNG por viewport (componer desde el bitmap original) | `content.js:1266-1336` | M | −0,06/0,18 s × P de CPU | "Toda la página" | `CropEncode` eliminado |
| 12 | ARCH-03 | `ARCHITECTURE` | `PROTOCOL_VERSION` + handshake con capacidades + conjunto único de inyección | `js/shared/protocol.js`, 6 sitios de inyección | M | Fin de las 3 inyecciones divergentes y del content obsoleto | Todas | `HandshakeOk protocol=<v> services=[…]` |
| 13 | FUNC-07 | `FUNC_HIGH` | Arreglar `workerText`/`workerBlob` (o URL de extensión) | `service-worker.js:866`, `content.js:2665` | S | Recupera PDF local `file://` | PDF local | `PdfLocalRenderOk pages=<n>` |
| 14 | FUNC-03 | `FUNC_HIGH` | `onerror` + timeout en cada `await image.onload` | `content.js:2320-2405` | S | Elimina promesas colgadas que retienen GB | "Toda la página" | `StitchSegmentLoadFail` (o ausencia de cuelgue) |
| 15 | PERF-05 | `PERF_HIGH` | ✅ HECHO — walk único pre-captura, cero `innerHTML` | `content.js:1610` | — | Verificado: `PreScanWalk`, `MaxHeightScan innerHtmlCalls=0` | páginas con iframe | `MaxHeightScan innerHtmlCalls=0` |
| 16 | ARCH-02/FUNC-09 | `ARCHITECTURE`+`FUNC_MEDIUM` | Unificar detección PDF (borrar los 2 muertos, 1 fuente de verdad) | `service-worker.js:713`, `capture-logic.js:99`, `content.js:1481` | S | Fin de 4 reglas divergentes | PDFs | `PdfRouteDecision` idéntico en sw y content |
| 17 | FUNC-05 | `FUNC_MEDIUM` | `js/shared/sysinfo.js` único para browser/OS | 5 sitios | M | Metadatos consistentes | Todas | `SysInfoResolved` 1× con valor único |
| 18 | MEM-04 | `MEMORY` | ✅ HECHO (2026-09-23) — gobernador `mem04Enforce` (≤8 tabs, ≤400 MB, evicción oldest-first) en los 4 puntos de creación + `purgeTabState` central en `onRemoved`/`cancel-all` + poda en healing | `service-worker.js:87-182` | — | Cero buffers huérfanos; peor caso acotado | todas | `MemEvict` / `MemBudget` / `TabStatePurged` |
| 19 | MEM-05/PERF-15 | `MEMORY` | Paginar la cola offline y no programar sync con cola vacía | `offline-db.js:94`, `service-worker.js:1571,1708` | M | −200 MB de pico y menos I/O | offline | `OfflineSyncBatch pending<=5` |
| 20 | PERF-08/09/11/12/14/16 + FUNC-11/12/14 | `PERF_LOW`/`MAINTAINABILITY` | Microlotes: `wrapTextAnywhere` lineal, acumulador incremental, watchdog idempotente, `startCapturePerf` no destructivo, borrar código muerto y validaciones redundantes | varios | S | Menos CPU y ~600 líneas menos | todas | `HeaderTextWrap measures<L`, `WatchdogRearm<=pages+2`, `ChunkProtocolUsed` ausente |

---

## FASE 7 — Quick Wins (menos de 1 día, riesgo bajo)

> Criterio: cambio local, sin protocolo nuevo, con evidencia runtime ya disponible o de 1 línea de añadir.

| QW | Acción | Archivo:línea | Riesgo | Ganancia |
|---|---|---|---|---|
| QW-01 | `return` → avance forzado en el dedup de scroll | `content.js:1856` | Bajo | **Elimina el stall de 15 s** (FUNC-01) |
| QW-02 | `markCaptureCompleted()` → `markCaptureError()` en payload inválido | `service-worker.js:1291,1298,1330` | Bajo | Fallos visibles (FUNC-13) |
| QW-03 | `Promise.all(items.map(loadBitmap))` → loop secuencial con `close()` inmediato | `content.js:2347,2485` | Bajo | **−700 MB** (MEM-01) |
| QW-04 | `isBlankImageData`: `slice(commaIdx+1, commaIdx+260)` antes de `atob` | `service-worker.js:1102` | Muy bajo | −10 `atob` de MB por viewport (PERF-16) |
| QW-05 | `MAX = 10` → `2` + `markCaptureError` al agotar | `service-worker.js:1140,1161` | Bajo | −5 s y sin bloqueo (FUNC-02) |
| QW-06 | `innerHTML.length`/`includes` → `childElementCount`/`textContent` | `content.js:1439,1447` | Bajo | Elimina cuadrático (PERF-05) |
| QW-07 | `armHealingInterval()` idempotente (`if (healingInterval) return`) | `service-worker.js:1455` | Muy bajo | −1 timer por mensaje (PERF-11) |
| QW-08 | Borrar `showTip` duplicado | `content.js:1961-1975` | Muy bajo | −12 líneas (FUNC-12) |
| QW-09 | Borrar `isPdfPageTab` de SW y `capture-logic` | `service-worker.js:713-724`, `capture-logic.js:99-101` | Muy bajo | −20 líneas (ARCH-02) |
| QW-10 | Borrar `pauseAllAnimations`/`resumeAllAnimations` (nunca invocados) | `content.js:790-806` | Muy bajo | −17 líneas peligrosas (D-03) |
| QW-11 | Borrar el bloque legacy `dom`/`replaceURL`/`trim`/`isBrowser`/`isVisibleNode`/`scrollToHeight` | `content.js:600-731` | Muy bajo | −130 líneas (D-01) |
| QW-12 | Borrar protocolo `imgDataChunk*` + `tempImageStorage` + 5 helpers | `service-worker.js:486,495-520,1235-1270` | Bajo | −150 líneas, −1 Map (FUNC-14) |
| QW-13 | `startCapturePerf`: no recrear si existe | `service-worker.js:524` | Muy bajo | Telemetría por página utilizable (PERF-12) |
| QW-14 | `simulateScroll`: `setTimeout(80)` → `afterFrameStable` | `content.js:1706` | Bajo | −80 ms × P (PERF-07) |
| QW-15 | `sendPdfVisibleFallback` → `captureVisibleFastPath` | `service-worker.js:729-748` | Bajo | Captura de PDF visible por la ruta barata (FUNC-10) |
| QW-16 | `captureImageDataByTab.delete(tabId)` en `tabs.onRemoved` y en `triggerSelfHealing` | `service-worker.js:1470,1496` | Muy bajo | Sin Multi-MB retenidos (MEM-04) |
| QW-17 | `scheduleAutoSync` solo si hay pendientes | `service-worker.js:1708` | Bajo | Menos I/O por despertar (PERF-15) |
| QW-18 | `validarIconos()` detrás de flag de depuración | `service-worker.js:87,92` | Muy bajo | −8 fetch por arranque (PERF-14) |
| QW-19 | Acumulador incremental en el loop de composición | `content.js:2365,2505` | Bajo | O(P²)→O(P) (PERF-09) |
| QW-20 | `onerror`+timeout en los 4 `await image.onload` | `content.js:2320-2405` | Bajo | Sin cuelgues (FUNC-03) |

**Quick Wins 01-03 por sí solos** eliminan los dos modos de fallo "no pasa nada" y el crash por memoria. Son **3 cambios de <10 líneas** con evidencia runtime definida.

---

## FASE 8 — Mejoras de alto impacto (1–2 semanas)

### 8.1 Rediseño del pipeline de transporte (PERF-04 + PERF-03 + MEM-02 + MEM-03)

**Objetivo:** un solo viaje de la imagen y una sola composición.

**Diseño propuesto:** que el **content script sea el dueño del binario** y el SW solo dispare capturas:
1. content: `scrollTopForCapture(i)` → pide captura.
2. SW: `captureVisibleTab` → **devuelve un `Blob` por el canal binario ya probado** (`pdfRenderBlobChunk` como precedente: slices de 1,5 MB con `rtn`/ack) en lugar de un data URL de varios MB.
3. content: **acumula `ImageBitmap`** (no PNG recomprimido) usando `createImageBitmap(blob)` y cierra cada uno tras dibujarlo.
4. content: compone en tiras de ≤ 16.000 px con `OffscreenCanvas.transferToImageBitmap()` y las envía en streaming (`processFinalImageBlob`) liberando el array.
5. SW: ensambla con `new Blob(slices)` → `uploadCaptureBinary` (ya binario, ya con token).

**Ganancia esperada (estimada):** −60% de bytes en el canal, −1 encode PNG por viewport, pico de memoria de ~1,5 GB → **~250 MB**, y `messages` de ~4P a ~P+4.

**Evidencia de aceptación:**
- `[FEATURE_RUNTIME] WireStats pages=50 messages=54 base64Bytes=0` (hoy: `messages≈200`, `base64Bytes` en decenas de MB)
- `[FEATURE_RUNTIME] StitchBitmapsOpen max=2`
- `[FEATURE_RUNTIME] CaptureComplete stitchedBytes=<n>`
- **Criterio PASS:** `[PERF] {op:'stitching-total'}` con `captureId` presente, mismo valor en consola del SW y del content, y `ms` < 40% del valor pre-cambio en la misma página de referencia.

### 8.2 Motor de estilos por captura (PERF-01 + FUNC-04 + MEM-08) — `PERF_CRITICAL`

**Objetivo:** pagar O(N) **una vez** por captura, no por página, y restaurar exactamente.

Cambios:
1. `init()` llama `this.restoreAll()` antes de tocar nada (o se ejecuta **una sola vez** por captura, no por página).
2. `_classifyElements` corre **una vez**; el resultado (`fixedElts`, `stickyElts`, `fixedHeader`) se guarda y se **reutiliza con offsets recalculados** por página (`updateFixed` ya recibe `scrollableHeight/Width`, que es lo único que cambia).
3. `_applyStyles` usa `element.style.setProperty(prop, val, 'important')` (sin reescribir `cssText`), y el estado previo se guarda como `Map<prop, prevValue>` para restauración quirúrgica.
4. `_hideScrollbars`/`_disableTransitions` inyectan **un** `<style id="sqa-capture-style">` idempotente.
5. `_hacks()` se mueve a una "fase de inicio" (una vez) y **los hacks de sitio irrelevantes (Squarespace/Quora/AdWords/skrollr) se eliminan** (ver D-05).

**Evidencia de aceptación:**
- `[FEATURE_RUNTIME] StyleClassify page=1 nodes=50000 ms=210` y `StyleClassify page=50 nodes=50000 ms=2` (PASS: la segunda no vuelve a clasificar; `ms<40`)
- `[FEATURE_RUNTIME] InjectedStyleNodes n=1`
- `[FEATURE_RUNTIME] StyleRestoreEnd leftovers=0` **y** un snapshot DOM pre/post captura sin diferencias en `style` de los elementos `fixed`.

### 8.3 Contrato de protocolo y capacidades (ARCH-03 + ARCH-04)

`js/shared/protocol.js`:
```
SQA_PROTOCOL_VERSION = 5
Actions = Object.freeze({ ...todos los string hoy dispersos... })
checkContentLoaded → { loaded:true, protocol:5, services:{scrollFinder:true, stylesManager:true}, injectedFiles:[...] }
```
- El SW decide reinyectar el **set completo** si `services` no cubre lo requerido (elimina las 3 inyecciones divergentes).
- `captureId` obligatorio en cada mensaje de captura; el SW rechaza mensajes sin `captureId` cuando hay una captura activa (elimina la doble captura de MEM-09).

**Evidencia:** `[FEATURE_RUNTIME] HandshakeOk protocol=5 services=[scrollFinder,stylesManager]` + `InjectionSet files=3` (PASS: `3` en el 100% de las capturas, incluida la que dispara el fallback PDF).

### 8.4 Cola offline acotada (MEM-05 + PERF-15)

- `getPendingPage(limit=5, cursor)` en `offline-db.js` usando índice `timestamp` (ya existe: `offline-db.js:41`).
- Sync por ítem con `/api/capture-binary` (evita base64 del lote).
- `chrome.alarms` en lugar de `setTimeout` (el SW se suspende y pierde el timer; hoy `scheduleAutoSync(30000)` puede **nunca ejecutarse** porque el SW muere antes — bug latente de la cola offline).

**Evidencia:** `[FEATURE_RUNTIME] OfflineSyncBatch pending=4 peakHeapMB=38` + `SyncAlarmFired source=alarms` (PASS: el sync sobrevive a la suspensión del SW).

---

## FASE 9 — Riesgos futuros

### 9.1 Escalabilidad simulada (estimación teórica, modelo declarado)

**Modelo:** viewport 1920×1080, `dpr=1`, PNG de viewport ≈ 1,0 MB, solape 80 px ⇒ `P = ceil(H / 1000)`; nodos `N`; `ms_classify ≈ N × 3 × 3 µs`; `ms_encode_png ≈ 120 ms` por viewport; pico de memoria = blobs + `Σ bitmaps` (P × 8,3 MB) + canvas final (W×H×4).

| Escenario | H (px) | P | N nodos | Mensajes | Encode PNG | Pico RAM est. | CPU dominante | Riesgo |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Página 1.000 filas | 40.000 | 40 | 12.000 | ~160 | ~4,8 s | **≈0,68 GB** | classify 40×0,11 s ≈ 4,4 s | 🟠 Alto (jank, RAM) |
| Página 10.000 filas | 400.000 | **90 (tope)** | 90.000 | ~360 | ~10,8 s | **≈1,55 GB** | classify 90×0,81 s ≈ **73 s** | 🔴 **Crash probable** |
| Página virtualizada | 1.000–3.000 | 1–3 | ~2.000 | ~12 | ~0,4 s | ≈60 MB | dedup | 🔴 **Contenido duplicado o stall** (FUNC-01) |
| Dashboard complejo (3–6 tracks) | 20.000 | 20 | 25.000 | ~80 | ~2,4 s | ≈0,34 GB | classify 20×0,23 s ≈ 4,6 s | 🟠 Medio-alto |
| CloudWatch gran volumen | 50.000 | 50 | 70.000 | ~200 | ~6 s | ≈0,85 GB | classify 50×0,63 s ≈ **32 s** | 🔴 Alto |
| DOM > 50.000 nodos | 50.000 | 50 | 50.000–100.000 | ~200 | ~6 s | ≈0,85 GB | classify 50×0,45/0,9 s ≈ **22–45 s** | 🔴 Alto (pestaña "no responde") |

**Componentes más sensibles (orden de fragilidad):**
1. `splicingImagesAarray`/`splicingImagesAarrayLast` (memoria + CPU del renderer).
2. `StylesManager._classifyElements` (CPU O(N) por página).
3. `ScrollFinder`/fallback legacy (CPU O(N) con layout thrashing).
4. El dedup de scroll y el aborto por blanco (correctitud).
5. `getBlobFromDataUrl` en el SW (bloqueo del hilo del SW con `charCodeAt` byte a byte).

**Umbral crítico identificado:** a partir de **P > 45** (≈45.000 px de documento) el pico de RAM supera 1 GB; a partir de **N > 40.000** el coste de clasificación domina el tiempo total de captura.

### 9.2 Riesgos de crecimiento futuro (no son bugs de hoy)

| Riesgo | Detonante | Consecuencia |
|---|---|---|
| **Pérdida de sincronía content/SW** | Cualquier `update` de la extensión con una pestaña abierta | El content viejo responde al protocolo nuevo → fallo silencioso (ARCH-03) |
| **Colisión de nombres globales** | Un sitio define `window.__sqaStylesManager` | Se pierde la ruta moderna y cae al fallback sin aviso (ARCH-04) |
| **El stack `scrollTop` deja de avanzar** | Sitios con `scroll-behavior:smooth`, `overflow:clip` o contenedores con `transform` | ✅ MITIGADO 2026 (REGRESSION_001): `scrollTopForCapture` instant + `sqaAfterScrollApplied` con re-scroll ≤3 rondas + `ViewportDelta` explícito. Límite conocido: target más allá del max-scroll (docHeight crecido) es inalcanzable; el crop `y1/y2` usa el delta real y el stitch queda correcto |
| **Endurecimiento de CSP/MV3** | `script.innerHTML` (skrollr, `sqa-styles.js:317`) | Ya está roto; si algún día se "arregla" ingenuamente, violará CSP (D-05) |
| **`chrome.runtime.sendMessage` con Blob** | Si Chrome habilita `structured_clone` (el código ya lo anticipa, `content.js:305-311`) | La ruta binaria cambia; el código tiene que estar preparado (Fase 8.1 lo hace) |
| **PDFs de > 40 MB** | Nuevos laudos/anexos | Corte duro en `b64.length > 40000000` con fallback a "vista visible" (pérdida silenciosa de requisito) |
| **Páginas > 90.000 px** | Reportes regulatorios largos | Truncado por `capturex_capture_max_height` con solo un `showTip` de 2,5 s |
| **Cola offline creciendo sin cota** | App de escritorio apagada varios días | `getAll()` sin límite + base64 del lote → RAM del SW (MEM-05) |
| **Watchdog enmascarando bugs** | `MAX_CAPTURE_TIME_MS = 15000` | Cualquier stall nuevo se "cura" solo y no se detecta: los bugs de pérdida quedan invisibles (por eso FUNC-01/02 no se han visto) |
| **Sin tests** | No hay `package.json`, ni runner, ni un solo test | Toda regresión se descubre en producción (MAINTAINABILITY estructural) |

### 9.3 Riesgo #1 a documentar para dirección

> El watchdog de auto-reparación (`service-worker.js:1430-1500`) **convierte fallos de captura en "no pasó nada"**. Combinado con `markCaptureCompleted()` en rutas de error (FUNC-13), el sistema tiene hoy una **zona ciega** donde la extensión reporta éxito sin evidencia. La primera medida no es optimizar: es **hacer visible el fallo** (QW-02 + Fase 0). Sin eso, cualquier mejora de este plan será indistinguible de "no se ejecutó".

---

## FASE 10 — Roadmap priorizado

### Fase 0 — Instrumentación de evidencia (0,5–1 día) · **BLOQUEANTE**

> Sin esto no se puede cumplir el requisito "demostrar que la funcionalidad se ejecuta en la ruta utilizada por el usuario".

- **0.1** Implementar los marcadores `[FEATURE_RUNTIME]` del Anexo B (≈8 puntos, **uno por fase**, no por viewport, para no agravar PERF-04).
- **0.2** `captureId` correlacionado (`executeCapture` → content → SW → offscreen).
- **0.3** `startCapturePerf` no destructivo (QW-13).
- **0.4** Documento de 1 página: "cómo se recoge la evidencia" (consolas a abrir, clics a hacer, criterios PASS/FAIL).
- **Salida:** una captura real de referencia ("Toda la página" en una página de 5 viewports) con **8 marcadores `[FEATURE_RUNTIME]`** y **1 `[PERF]` con `captureId`**.

### Fase 1 — Quick Wins de correctitud (1 día)

QW-01, QW-02, QW-05, QW-03, QW-20, QW-06, QW-19.

**Salida:** los 3 modos de fallo silenciosos desaparecen; `[FEATURE_RUNTIME] CaptureComplete` presente al 100% en 5 capturas de prueba.
**Métrica:** `CaptureBlankAbort` y `DedupSkipped` **ausentes**.

### Fase 2 — Memoria y estabilidad (3–5 días)

QW-16, QW-03/04 ampliados, MEM-02, MEM-03, MEM-08 (con FUNC-04), MEM-04.

**Salida:** `StitchBitmapsOpen max<=2`, `SnapshotTiers peak=1`, `StyleRestoreEnd leftovers=0`.
**Métrica:** pico de RAM en la página de 10.000 filas ↓ > 60% y **0 crashes**.

### Fase 3 — Rendimiento percibido (1–2 semanas)

PERF-01 (Fase 8.2), PERF-06, PERF-07, PERF-05, PERF-08, PERF-11, PERF-12.

**Salida:** `[PERF] stitching-total` ↓ ≥ 50% en la misma página de referencia; `ScrollDetect detector=finder`; `StyleClassify ms<40` en todas las páginas.

### Fase 4 — Protocolo y arquitectura (2–3 semanas)

ARCH-03 (handshake + capacidades + set de inyección único), ARCH-02 (PDF unificado), FUNC-05 (sysinfo único), ARCH-06 (listeners), ARCH-05 (pipeline PDF fuera del despachador).

**Salida:** `HandshakeOk protocol=5` en el 100% de las capturas, incluido el fallback PDF; `InjectionSet files=3` siempre.

### Fase 5 — Rediseño del transporte binario (2 semanas)

PERF-04 + PERF-03 (Fase 8.1) + MEM-03 streaming.

**Salida:** `WireStats base64Bytes ↓ ≥60%`, `messages <= P+4`, `CaptureArrayAfterStitch entries=0`.
**Riesgo:** alto (cambio de protocolo) → ejecutar tras Fase 0–4 y con telemetría A/B en la misma página.

### Fase 6 — Deuda estructural y limpieza (1–2 semanas, paralelizable)

Annexo A completo (D-01…D-13), ARCH-01 (extracción de los 7 servicios), ARCH-07 (unificar duplicados), ARCH-08.
**Salida:** `content.js` de 2.747 → **~1.200** líneas; 7 módulos con `<script>`/import y `ModuleLoaded` en runtime.

### Fase 7 — Red de seguridad (continuo)

- **7.1** `package.json` + runner mínimo (Vitest) para lógica **pura** extraída (Fase 6): `wrapTextAnywhere`, detección PDF, `sysinfo`, split de tiras, cálculo de overlap.
- **7.2** Harness manual de evidencia (`Docs/AUDITS/EVIDENCE/`) con la captura de referencia de Fase 0 ejecutada antes/después de cada fase.
- **7.3** Guardia anti-regresión: un script que valide que los marcadores `[FEATURE_RUNTIME]` siguen presentes en los archivos (verificable por `node` sin navegador).

### 10.1 Matriz de priorización (Impacto × Esfuerzo)

```
IMPACTO ALTO
   │  QW-01 ●  QW-03 ●                 ● Fase 8.2 (PERF-01)
   │  QW-02 ●  FUNC-02 ●               ● Fase 8.1 (PERF-04+03)
   │  QW-05 ●  FUNC-04 (Fase 8.2) ●    ● ARCH-03 (Fase 4)
   │  QW-16 ●  QW-12 ●                 ● ARCH-01 (Fase 6)
   │
IMPACTO BAJO
   └──────────────────────────────────────────────────────────────
     ESFUERZO BAJO                      ESFUERZO ALTO
        (Fase 1–2)                        (Fase 4–6)
```

### 10.2 Criterio de cierre de cada fase (Definition of Done)

Una fase está cerrada **solo si**:
1. Los marcadores `[FEATURE_RUNTIME]` de su ruta aparecen en la consola correcta (SW o página) durante una captura real disparada **desde el popup** (no desde consola).
2. La métrica objetivo (`[PERF]` con el mismo `captureId` en content y SW) cumple el umbral declarado.
3. Existe captura de evidencia archivada en `Docs/AUDITS/EVIDENCE/<fase>/`.
4. **Ningún** `markCaptureCompleted` sin evidencia subida (verificable con `CaptureComplete` + `UploadOk` en el mismo `captureId`).

---

## Anexo A — Inventario de código muerto / legacy / redundante

| ID | Elemento | Ubicación | Líneas | Evidencia de inutilidad | Acción |
|---|---|---|---:|---|---|
| D-01 | `dom`, `replaceURL`, `trim`, `isBrowser`, `isVisibleNode`, `scrollToHeight` (feature "guardar DOM" de GoFullPage) | `content.js:625-731` | ~130 | `grep`: solo se referencian entre sí; ningún invocador externo | Borrar |
| D-02 | `isPdfPageTab` ×2 (implementaciones divergentes) | `service-worker.js:713`, `capture-logic.js:99` | ~15 | Sin invocadores | Borrar |
| D-03 | `pauseAllAnimations`, `resumeAllAnimations` | `content.js:790-806` | ~17 | Sin invocadores (y serían O(N) `getComputedStyle`) | Borrar |
| D-04 | `workerState.nowShotImgData` | `state.js:11`, leído en `service-worker.js:317` | 3 | Nunca se le asigna una imagen (solo `''`) | Borrar |
| D-05 | Hacks de sitio + skrollr | `js/sqa-styles.js:313-357` | ~45 | skrollr inyecta inline script (CSP) con `throw new Error("haha")`; Squarespace/Quora/AdWords/Notion son irrelevantes para el dominio del producto (AWS/Cloudscape) | Borrar o mover a un módulo opcional |
| D-06 | Protocolo `imgDataChunk*` + almacenamiento por chunks | `service-worker.js:486-487,495-520,1235-1270` | ~150 | Sin productor en el repo (solo SW + CHANGELOG) | Borrar |
| D-07 | `showTip` duplicado (el primero) | `content.js:1961-1975` | ~12 | Clave duplicada en el mismo objeto literal | Borrar |
| D-08 | `ACTIONS.captureStatus`, `ACTIONS.openViewer`, `ACTIONS.getCaptureStatus` | `constants.js:5-15`, `service-worker.js:270-276` | ~10 | `captureStatus` solo en un bloque comentado (`utils.js:53`); el popup abre el visor con `fetch /api/show` (`popup.js:130`) | Borrar |
| D-09 | `if (isVerticallyScrollable(document.documentElement)) { }` | `content.js:1743-1744` | 2 | Bloque vacío | Borrar |
| D-10 | `isVisible()` | `js/sqa-scroll-finder.js:126-131` | 6 | Sin invocadores | Borrar |
| D-11 | `bodyBg()` | `js/sqa-scroll-finder.js:320-330` | 11 | Sin invocadores | Borrar |
| D-12 | `cleanupListeners(tabId)` | `capture-logic.js:109-116` | 8 | El parámetro `tabId` se ignora; solo llama a `_healingCleanup` | Simplificar |
| D-13 | Capacidad `nowTop` (reanudar captura) | `content.js:1479,1670-1675` | ~40 | `nowTop` siempre 0 (FUNC-08) | Decidir: borrar o implementar |
| D-14 | Ramas redundantes de conversión en `processFinalImageBlob` | `service-worker.js:1314-1327` | ~14 | La 2ª condición es inalcanzable (ya convirtió la 1ª) y `inputWasBlob` siempre es `true` | Simplificar |
| D-15 | `imgDataChunk` vs `pdfRenderBlobChunk`: dos protocolos de chunk | SW + `pdf-render.js` | ~60 | Solo uno tiene productor | Unificar (Fase 8.1) |

**Total estimado removible:** ~600 líneas (≈22% de `content.js` y ≈9% del SW) **sin cambio funcional**, salvo D-05/D-13 que requieren decisión de producto.

## Anexo B — Protocolo de evidencia `[FEATURE_RUNTIME]` sobre la ruta real

### B.1 Regla de oro

> **Todo hallazgo de este plan se cierra con un marcador `[FEATURE_RUNTIME]` observado en la ruta que el usuario realmente ejecuta: popup o atajo → `executeCapture` → content script → stitching → subida.** Si el marcador no aparece, la funcionalidad **no se ejecutó**, aunque el código compile y los tests unitarios pasen.

### B.2 Marcadores a implementar (8, uno por fase de captura, **no** por viewport)

| # | Marcador | Emisor | Momento exacto en la ruta del usuario | Qué prueba |
|---|---|---|---|---|
| 1 | `[FEATURE_RUNTIME] CaptureRequested action=<a> tabId=<id> captureId=<c>` | SW `executeCapture` | Click en el popup o `Ctrl+Shift+S` | La ruta del usuario entró |
| 2 | `[FEATURE_RUNTIME] ContentReady protocol=<v> services=<list> injected=<n>` | content `checkContentLoaded` | Handshake previo a la captura | Qué código corre (monolito o módulos) |
| 3 | `[FEATURE_RUNTIME] ScrollDetect detector=finder\|legacy nodes=<n> ms=<t>` | content `findScrollableElements` | Preparación | PERF-06 y ARCH-03/04 |
| 4 | `[FEATURE_RUNTIME] CapturePage i=<i> total=<P> scrollTop=<t> ms=<t>` | content `captureVisiblePageScreenshot` | Cada viewport | FUNC-01 (avance real) y PERF-10 |
| 5 | `[FEATURE_RUNTIME] StyleClassify nodes=<n> ms=<t> styles=<k>` | `sqa-styles` | Antes de la 1ª página y **solo** si reclasifica | PERF-01 (objetivo: 1 sola vez) |
| 6 | `[FEATURE_RUNTIME] StitchStart tiers=<n> bitmaps=<k> heapMB=<h>` / `StitchEnd bytes=<b> ms=<t>` | content `splicingImagesAarray` | Composición | MEM-01/02/03, PERF-02/09 |
| 7 | `[FEATURE_RUNTIME] UploadStart route=binary\|json bytes=<b> captureId=<c>` / `UploadOk` / `UploadFail` | SW `_finalizeCapture` | Subida | FUNC-13, PERF-04 |
| 8 | `[FEATURE_RUNTIME] CaptureComplete captureId=<c> pages=<P> totalMs=<t> partial=<bool>` | SW | Cierre | **Marcador de éxito definitivo** |

### B.3 Marcadores de fallo (los que hacen visible la zona ciega)

| Marcador | Disparador | Interpretación |
|---|---|---|
| `[FEATURE_RUNTIME] CaptureDedupSkipped page=<i> scrollTop=<t>` | `content.js:1856` | FUNC-01 reproducido (NO debe aparecer tras el fix) |
| `[FEATURE_RUNTIME] CaptureBlankAbort viewport=<i> attempts=<n>` | `service-worker.js:1161` | FUNC-02 reproducido |
| `[FEATURE_RUNTIME] StitchSegmentLoadFail segment=<s>` | `image.onerror` (FUNC-03) | Cuelgue de composición |
| `[FEATURE_RUNTIME] FinalizeFailed reason=<r>` | `service-worker.js:1291+` (FUNC-13) | Éxito falso corregido |
| `[FEATURE_RUNTIME] StyleRestoreEnd leftovers=<n>` | `sqa-styles.restoreAll` | FUNC-04 (`leftovers>0` = página corrupta) |
| `[FEATURE_RUNTIME] HandshakeStale remote=<v> local=<v>` | `checkContentLoaded` | ARCH-03 |
| `[FEATURE_RUNTIME] WatchdogTriggered elapsedMs=<t>` | `triggerSelfHealing` | **Cualquier** stall nuevo |
| `[FEATURE_RUNTIME] PdfLocalRenderFail reason=<r>` | ruta PDF local | FUNC-07 |

### B.4 Cómo se recoge (sin suite FULL, sin E2E extensiva)

1. `chrome://extensions` → Evidencias SQA → **Service worker** (consola A).
2. Abrir la página de referencia → DevTools → **Console** (consola B).
3. Click en el **popup → "Toda la página"** (ruta real del usuario; no invocar desde consola).
4. Exportar ambas consolas a `Docs/AUDITS/EVIDENCE/<fase>/<fecha>-<pagina>.log`.
5. Validar con un script (sin navegador):

```
Validaciones automáticas sobre los logs (implementar en Fase 7.3):
  · exactamente 1 × [FEATURE_RUNTIME] CaptureRequested
  · CapturePage con i creciente 1..P, sin huecos y sin DedupSkipped
  · StyleClassify aparece 1 vez (tras Fase 3)
  · StitchEnd.bytes > 0 y bitmaps <= 2 (tras Fase 2)
  · UploadOk con el mismo captureId que CaptureRequested
  · CaptureComplete presente ⇒ captura válida
  · WatchdogTriggered ausente (si aparece: regresión)
```

### B.5 Anti-objetivo (para no empeorar PERF-04)

- ❌ **No** emitir `[FEATURE_RUNTIME]` por viewport desde el SW (duplicaría mensajes).
- ❌ **No** enviar los marcadores del content al SW: se registran en la consola de la página (consola B) — evidencia local, coste cero en el canal de mensajes.
- ❌ **No** activar `console.debug` de `[CAPTURE_PERF]`/`[CAPTURE_PERF]` por viewport en release (hoy `content.js:131-137` y `capture-logic.js:134-141` ya son `console.debug`, mantenerlos detrás de un flag).

## Anexo C — Mapa de rutas reales del usuario (para localizar dónde instrumentar)

| Acción del usuario | Entrada | Orquestador | Motor | Salida | Evidencia actual | Evidencia requerida |
|---|---|---|---|---|---|---|
| Click "Toda la página" / `Ctrl+Shift+S` | `popup.js:117` → `ACTION_CAPTURE_ALL` | `service-worker.js:255` → `executeCapture` | `content.js:1479` → stitching → `processFinalImageBlob` | `_finalizeCapture` | `[PERF] stitching-total` | #1-#8 |
| Click "Area visible" / `Ctrl+Shift+W` | `ACTION_CAPTURE_VISIBLE` | `executeCapture` → `captureVisibleFastPath` (`capture-logic.js:128`) | *sin content* | `_finalizeCapture` | `[CAPTURE_PERF]` | #1, #7, #8 |
| Click "Seleccionar área" / `Ctrl+Shift+E` | `ACTION_CAPTURE_AREA` | `executeCapture` → content `captureSelectionEdit` | overlay → `cropImage` → `setSelectionCaptureData` | `processFinalImage` | `[PERMISSION_TRACE]` | #1, #7, #8 + `SelectionUpload.route` |
| `Ctrl+Shift+V` | `ACTION_OPEN_VIEWER` (`manifest.json`) | `focusDesktopViewer` | `fetch /api/show` | — | `[PERMISSION_TRACE]` | `ViewerOpened` |
| PDF (URL con `.pdf`, viewer) | `ACTION_CAPTURE_ALL` | `executeCapture` → `pdfCaptureRequest` | offscreen `pdf-render.js` | chunks → `_finalizeCapture` | `[PDF_ROUTE]`, `[PDF_TRACE]` | `PdfRouteDecision`, `PdfRenderStart/End`, `PdfChunksAssembled` |
| PDF local `file://` | idem | `startPdfCapture` (`service-worker.js:911`) | offscreen o **render en página (roto, FUNC-07)** | idem o fallback visible | `[PDF_ROUTE]` | `PdfLocalRenderOk/Fail` |
| App de escritorio apagada | cualquiera | `_finalizeCapture` → `savePendingCapture` | `offline-db.js` | cola IndexedDB | `[SQA Sync]` | `OfflineQueued`, `SyncAlarmFired` |

---

## Anexo D — Trazabilidad: cada afirmación tiene evidencia estática verificable

| Afirmación | Verificación reproducible |
|---|---|
| 3 implementaciones de captura visible | `grep -n "captureVisibleFastPath\|captureDirectCapture\|captureVisibleOnly" js/background/capture-logic.js content.js` |
| 3 detectores de scroll | `content.js:2603` (fallback), `js/sqa-scroll-finder.js` (`find`), `content.js:1416` (`getMaxHeight`) |
| 4 detecciones de PDF, 2 muertas | `grep -n "isPdfPageTab" service-worker.js js/background/capture-logic.js` → definiciones sin invocadores |
| 5 detecciones de navegador/SO | `swGetSystemInfo`, `_getBrowserInfo`, `_detectOS`, `_detectBrowser`, `getBrowserVersion`, `obtenOS` |
| 6 copias de base64↔bytes | `grep -n "fromCharCode.apply" service-worker.js content.js pdf-render.js` |
| 34 puntos de mensajería sin contrato | `grep -c "sendMessage" content.js service-worker.js js/background/*.js` |
| `[FEATURE_RUNTIME]` solo en el popup | `grep -rn "FEATURE_RUNTIME"` → 3 ocurrencias, todas en `popup*` |
| Sintaxis válida de los 12 módulos | `node --check` sobre todos los `.js` propios (Node v24.21.0) |

---

## Anexo E — Re-verificación 2026-09-23 (sesión de actualización)

Método: inspección estática + `node --check` 8/8 OK + conteos exactos. NO se ejecutó suite FULL/E2E/Explorer/Notepad/CMD (restricción respetada). Los `[FEATURE_RUNTIME]` citados abajo existen en el código y tienen evidencia de campo (logs AvalPay EV-84/86).

### E.1 Inventario runtime verificado (política cumplida)

| Archivo | FR | qsa | gcs | gbr | setTimeout | sendMessage |
|---|---:|---:|---:|---:|---:|---:|
| `content.js` | 45 | 6 | 17 | 8 | 20 | 34 |
| `service-worker.js` | 9 | 0 | 0 | 0 | 25 | 16 |
| `js/sqa-styles.js` | 2 Twigs frLog (8 sitios: `FixedFloatKept/StickyFloatKept/FloatingPreserved/FloatHidden/Classification*`) | 2 | 7 | 6 | 0 | 0 |
| `js/background/capture-logic.js` | 2 | 0 | 0 | 0 | 6 | — |
| `popup.js` / `popup-start.js` | 2 / 1 | — | — | — | 3 | — |

Transporte imagen: `toDataURL=5`, `createObjectURL=9`, `revokeObjectURL=9`, SW `atob=3 btoa=2`.
Evidencia de campo (ruta real del usuario, AvalPay): `PageShotSource route=inline-blob blobPages=4
dataUrlPages=0`, `ViewportDelta index=1 delta=-360` con `ViewportRescroll ×3` (target 911 vs
max-scroll 551 por crecimiento docHeight 1307→1462 — comportamiento correcto, crop usa delta real),
`StitchMemoryMode=STREAMING`, `BitmapWindowSize=4 MaxBitmapsOpen=1`, `WireStats via=binary`.

### E.2 Código muerto / no-ops RE-confirmados (actualizado 2026-09-23: purga aplicada)

| ID | Elemento | Estado tras purga |
|---|---|---|
| X-01 | `captureError` sin consumidor (0 handlers en SW) | ✅ RESUELTO — handler agregado (`service-worker.js`, enruta a `markCaptureError` + `ContentErrorRouted`) |
| X-02 | `tempImageStorage` stub (5 refs inertes) | ✅ PURGADO — stub + 3 usos eliminados (queda `MarkerPurge` como constancia) |
| X-03 | `captureInProgress.activeTabs.clear()` ×2 | ⏭️ FALSO POSITIVO — `activeTabs` SÍ es un `Set` interno del wrapper (`state.js:25`); el `.clear()` es válido y es el reset global intencional. Sin cambios |
| X-04 | `setCachedToken` sin invocadores | ✅ CONECTADO — llamado tras hit de storage y tras fetch (`auth.js`); la caché en memoria de 5 min ahora sí se puebla |
| X-05 | `isPdfPageTab` en SW sin invocadores | ✅ ELIMINADO (`pdfRouteReason` es la fuente de verdad) |
| X-06 | `finishCapturePerf(tabId, extra)` ignoraba el 2º arg (5 sitios) | ✅ CORREGIDO — firma `(tabId, label, extra)` y vuelco `end/label` en el `[PERF]` |
| LOG-01 | Verbosidad de ticks por frame (~12 logs×P) | ✅ COMPUERTA — `sqaFrTick` (`content.js`): resúmenes siempre visibles (evidencia intacta), ticks silenciables con `__SQA_QUIET_RUNTIME`/`sqaQuietRuntime`; default sin cambios |

### E.3 Hallazgos nuevos de la sesión (ya corregidos en código)

| ID | Hallazgo | Fix aplicado | Evidencia |
|---|---|---|---|
| REGRESSION_001 (H1) | `window.scrollTo({top})` respetaba `scroll-behavior:smooth` → captura del frame anterior → viewport duplicado (AvalPay) | `scrollTopForCapture` instant + asignación directa + `sqaAfterScrollApplied` con re-scroll ≤3 rondas y `ViewportDelta` explícito (`content.js:593-642,2100`) | Tabla Viewport\|TargetY\|ActualY\|Delta sin repetidos; harness `RUNTIME_PROOF PASS` |
| FLOATING_001 rev2 | Conversor fixed→absolute reubicaba flotantes en (0,0) (invisibles); `?` rojo es sticky, no fixed | Flotantes intactos en vp0 + `visibility:hidden` desde vp1; exención sticky-flotante (`sqa-styles.js:293-316,403-432,445-457`) | `FixedFloatKept/StickyFloatKept/FloatingPreserved/FloatHidden` |
| OP6-guard | Parche previo dejó `return` incondicional que abortaba toda captura | Condición `has(scrollTop)` restaurada (`content.js:2137`) | `ViewportSkippedRepeatTarget` solo en repetidos reales |

### E.4 Oportunidades residuales priorizadas (no revertir PERF-05/06/07/09, BinaryChannel, StitchMemoryMode)

| ID | Clasificación | Mejora | Beneficio |
|---|---|---|---|
| PERF-01b | `PERF_MEDIUM` | Throttle `SM.updateFixed` por viewport: memoizar `fullH/fullW`, saltar si `docHeight` no cambió | −1 `Math.max(scrollHeight)` (reflow) + clasificación por viewport |
| PERF-04b | `PERF_MEDIUM` | ✅ HECHO 2026-09-23 — pull legacy eliminado; blank-check por muestra (4-8 MB→255 B) con veredicto idéntico; harness `RUNTIME_PROOF PASS`; `node --check` OK | −1 mensaje/viewport y −2-8 MB transitorios; fallos visibles sin stall 15 s |
| PERF-06b | `PERF_HIGH` | ✅ HECHO 2026-09-23 — walk único compartido (`findFromCandidates`); harness: 5030→6 `getComputedStyle` en DOM 5000, mismo ganador; `node --check` OK | −2 walks O(N) + layouts por captura full-page |
| MEM-04 (abierta) | `MEMORY` | ✅ HECHO 2026-09-23 — cotas + evicción + purga; harness `RUNTIME_PROOF PASS` (10 tabs×50 MB→8 tabs/400 MB, oldest-first, purge sin leaks); `node --check` OK | Cero Multi-MB huérfanos por pestaña |
| X-01…X-06 | `MAINTAINABILITY` | Purgar no-ops/muertos de E.2 + conectar `setCachedToken` | −1-2 RTT `:3000` por captura; healing que sí limpia |
| LOG-01 | `PERF_LOW` | Gatear `FEATURE_RUNTIME` verboso por viewport tras flag debug (`~12 logs × P`) | Menos concat en hot-path sin perder verificabilidad |

---

**Fin del documento.** Próxima acción recomendada: **PERF-06b + PERF-04b** (mayor residuo medible), luego **MEM-04**, con evidencia `[FEATURE_RUNTIME]` por cambio según Anexo B.
