# EXT_WEB — Plan de Mejoras Funcionales y de Rendimiento 002

**Fecha:** 2026-09-23
**Última actualización:** 2026-09-23 — estado de implementación registrado (ver «Estado de implementación», tras esta sección).
**Método:** Auditoría exclusivamente estática (inspección de código fuente). Sin suite FULL, sin pruebas E2E.
**Alcance real auditado:** `service-worker.js` (1910 líneass), `content.js` (2757), `js/background/*` (capture-logic 487, utils 131, auth 110, offline-db 185, state, constants), `js/sqa-scroll-finder.js` (334), `js/sqa-styles.js` (467), `pdf-render.js` (301), `offscreen.js`, `popup.js`, `manifest.json`.

---

# ESTADO DE IMPLEMENTACIÓN (actualización 2026-09-23)

> Leyenda: ✅ = implementado y **validado en runtime** (log real del usuario); 🔧 = implementado, verificado (`node --check` + paridad con paquete Empa) y **pendiente de validación runtime**; ⬜ = pendiente (backlog).

## Implementado — 12 de las 20 del Top-20

| # Top-20 | ID | Mejora | Estado | Marcadores FEATURE_RUNTIME de validación |
|---|---|---|---|---|
| 1 | PERF-01 | `CaptureClassificationCache` (clasificación 1× por captura) + `updateFixed` idempotente por elemento | ✅ Validado runtime | `StyleClassificationStart` 1×, `UpdateFixedMode=CACHE` 13/13, `ClassificationCacheUsed uses=1..13` (noticiasrcn.com, 1727 nodos, 9 ms; cero FULL_SCAN) |
| 2 | PERF-02/MEM-01 | Bitmap Streaming (ventana deslizante ≤4, `close()` inmediato) | 🔧 | `StitchMemoryMode=STREAMING`, `BitmapDecoded/Drawn/Closed index=..`, criterio `MaxBitmapsOpen ≤ 4` |
| 4 | PERF-03 | Canal binario content→SW (opt-in `structured_clone` + chunks 1.5 MB con ack; fallback dataURL intacto) | 🔧 | `BinaryChannelProbe result=structured-clone`, `WireStats via=binary base64Bytes=0`, `[PERF] stitch-binary-assembled` |
| 5 | PERF-04 | Screenshot por página inline (push Blob en `getNowShotImgData`; buffer liberado al entregar — MEM-04 parcial) | 🔧 | `[PERF] page-shot-inline-ready`, `PageShotSource route=inline-blob dataUrlPages=0`; pull `requestCaptureScreenshot` solo fallback |
| 6 | PERF-05 | Walk único pre-captura (`preScanDocument`, cero `innerHTML`, iframes sin `querySelectorAll`) | 🔧 | `PreScanWalk nodes=.. ms=..`, `MaxHeightScan innerHtmlCalls=0`, `FrameScan merged=true`, `PreScanCacheUsed` |
| 7 | PERF-09 | Delays: prep unificada 60/0 ms (adiós `setTimeout(10/20)`), 1 frame con scroll estable, transform 80→40 ms | 🔧 | `PrepDelay ms=60 scrollables=N`, `ViewportStabilize frames=1 ms=..`, `ScrollTransformWait ms=40` |
| 8 | PERF-10 | Caché de 1 valor del ID de evidencia (header sin espera de red ≤2 s) | 🔧 | `EvidenceIdCacheSet` 1× por página, `EvidenceIdCacheHit` en el resto |
| 9 | FUNC-01..04 | Purga de código muerto (~230 líneas: protocolo `imgDataChunk` + `handleImageChunk` + helpers, `dom`/`replaceURL`/`isBrowser`/`isVisibleNode`/`scrollToHeight`, `pause/resumeAllAnimations`, `elementAbsolutePositions`, `TEMP_IMAGE_STORAGE_TTL_MS`) | 🔧 | `MarkerPurge removed=imgDataChunk+tempImageStorage+legacy-dom`; grep confirma 0 llamadores residuales |
| 14 | PERF-06 | Prefijos acumulados `buildHeightPrefix` en los 4 bucles de dibujo/truncado (O(N²)→O(N)) | 🔧 | grep: 0 bucles `dheight +=` residuales; PNG cosido idéntico |
| 15 | PERF-07 | `getVisibleBoundingRect` con caché WeakMap + profundidad de ancestros ≤15 | 🔧 | Invalidación acoplada a `_clearBBoxCache` (ciclo ya validado en PERF-01) |
| 18 | MEM-04 | `URL.revokeObjectURL(__sqaPdfWorkerUrl)` tras lanzar `getDocument` | 🔧 | `blobUrl revoked post-getDocument` (wtrace) |
| 19 | MEM-05 | `pdfInPageRetryDone.delete(tabId)` en `_finalizeCapture` (Set ya no acumula por vida de pestaña) | 🔧 | PDF local re-capturable con reintento in-page disponible de nuevo |

Adicional implementado/validado en sesiones previas a esta actualización (fuera del Top-20): pipeline PDF completo — offscreen con `disableFontFace` + watchdog por fase + fail-fast 8 s, chunks `pdfRenderBlobChunk` con ack/reintento, FUNC-07 corregido (`workerBlob`), CORS de `peekNextEvidenceId` enrutado por el SW, ruta directa `file://` → render in-page (total medido ~1–2 s hasta el visor).

## Backlog restante — 8 de 20 + deuda menor

| # Top-20 | ID | Mejora | Esfuerzo | Nota |
|---|---|---|---|---|
| 3 | PERF-01 | Saltarse la rama fallback de `changStyleForShot` cuando StylesManager existe (hoy el fallback clasifica 1× por captura aunque no se use) | S | QW #5 de FASE 7 |
| 10 | ARCH-03 | Extraer `env-info.js`: detección browser/OS única (hoy 6 implementaciones) | S | Ya causó BUG_HEADER_BROWSER_REGRESSION_001 |
| 11 | ARCH-02 | Extraer `viewer-api.js`: URL base + headers X-SQA-* + upload binario/JSON + cola offline | S | URL hardcodeada en 8 sitios |
| 12 | ARCH-01 | Extraer `pdf-pipeline.js` del SW (estado + timers + handlers PDF) | M | SW hoy ~1950 líneas |
| 13 | FUNC-07 | Módulo compartido de parámetros pdf.js (offscreen vs in-page ya divergieron) | S | |
| 16 | PERF-08 | `isScrollLoadedElement`: observador único por captura + timeout 400→200 ms | S | |
| 17 | PERF-01 | `updateFixed` por región del viewport (refinamiento del caché ya validado) | M | Toca código validado — requiere regresión visual |
| 20 | FUNC-08 | Dispatcher tipado para las ~26 acciones restantes | M | |

Deuda menor fuera del Top-20: FUNC-05 (detección PDF doble), FUNC-06 (3 rutas de captura visible), FUNC-09 (handshake de versión), FUNC-10 (regex frágil del worker), MEM-02 (streaming por tira de `capturex_capture_array`), MEM-03 (stacks intermedios de estilos).

## Desviaciones de alcance (transparencia)

1. **Ruta solicitada inexistente.** `C:\projects\Evidencias_Google\Ext_Web` no existe en esta máquina. Se auditó el workspace real del proyecto: `C:\projects\EvidenciasSQA_Ext_Web-main` (misma base de código que la copia empaquetada `Empa\EvidenciasSQA_Ext_Web`, ya sincronizada).
2. **Módulos especializados de la plantilla no existen** en este código: no hay módulos AWS, Cloudscape, CloudWatch, "Version Handshake" ni "Runtime Detection". Los análogos reales auditados son:
   - ScrollRoot → `js/sqa-scroll-finder.js` (BFS del scroll root) + fallback en `content.js`.
   - PDF → `pdf-render.js` (offscreen) + `renderPdfInPage` (content) + máquina de estados en SW.
   - Version Handshake → `js/background/auth.js` (token X-SQA-Token, TTL 5 min) — no hay handshake de versión.
   - Runtime Detection → detección UA-CH duplicada en 6 sitios (ver ARCH-03).
3. **Existe auditoría previa `_001.md`** (1017 líneas). Este documento es la edición `_002`: re-audita el código actual (que ya incorpora fixes de `_001` como D2, FUNC-07, BUG_PDF_STALL) y genera hallazgos nuevos. `_001` se preserva intacta.

---

# FASE 1 — Resumen ejecutivo

El motor de captura **funciona** (pipeline PDF validado end-to-end en runtime: captura → visor en ~1–2 s). Los problemas dominantes ya no son de corrección sino de **arquitectura y coste por nodo del DOM**:

- **El coste del stitching escala O(N × páginas):** hasta 4 recorridos completos del DOM con `getComputedStyle` por viewport capturado (`changStyleForShot` fallback, `SM.updateFixed`, `findScrollableElements`, `getMaxHeight`). En un DOM de 50 000 nodos con 30 páginas son >4,5 M cálculos de estilo en el hilo principal → jank severo, riesgo de congelar la pestaña.
- **Pico de memoria en el ensamblado:** `splicingImagesAarray` decodifica **todos** los bitmaps simultáneamente (`Promise.all`) antes de dibujar: ~18 MB por página a 2880 px de ancho → pico teórico >500 MB en capturas de 30 páginas.
- **Doble conversión de imágenes por captura:** Blob→DataURL (FileReader, +33 % de wire) en content → atob→Blob en SW → upload. El canal binario ya existe (PDF usa `pdfRenderBlobChunk`); el stitching no lo aprovecha.
- **Código muerto confirmado por grep:** protocolo `imgDataChunk` (consumidor sin productor), `dom()`/`replaceURL`/`isBrowser` legacy IE, `elementAbsolutePositions` (WeakMap nunca escrito), `pauseAllAnimations`/`resumeAllAnimations`.
- **Detección de entorno duplicada 6 veces** (2 en content, 4 en background) con riesgo de divergencia ya visible.
- El SW es un módulo monolítico de 1910 líneas con 4 responsabilidades mezcladas.

Prioridad 1: eliminar los recorridos O(N) por página y el `Promise.all` de bitmaps. Prioridad 2: canal binario content→SW. Prioridad 3: extracción de módulos y purga de código muerto.

---

# FASE 2 — Hallazgos funcionales

| ID | Hallazgo | Evidencia | Clasificación |
|----|----------|-----------|---------------|
| FUNC-01 | **Protocolo `imgDataChunk` muerto.** El SW registra `message.action.startsWith('imgDataChunk')` + `tempImageStorage` + `scheduleTempImageCleanup` (~80 líneas con estado y timers), pero **ningún módulo produce** esos mensajes (grep: única ocurrencia = consumidor). | `service-worker.js:679`, `:1433-1460` | FUNC_MEDIUM |
| FUNC-02 | **Legacy IE/herencia GoFullPage muerta.** `isBrowser()` prueba `MSIE`/`currentStyle`; `dom()` (scrubber recursivo que elimina script/iframe/link/meta) **nunca es invocado** (su única referencia es su propia recursión en `content.js:662`); `replaceURL`/`trim` solo los usa `dom()`. ~90 líneas muertas que además se leen al mantener el archivo. | `content.js:600-700` | MAINTAINABILITY |
| FUNC-03 | **Estado muerto:** `elementAbsolutePositions = new WeakMap()` se declara y se resetea en `reSetCaptureXData`, pero **jamás se escribe** (0 llamadas a `.set`). | `content.js:361`, `:966` | FUNC_LOW |
| FUNC-04 | **`pauseAllAnimations`/`resumeAllAnimations` sin llamadores.** Definiciones huérfanas; la primera es además O(N) `getComputedStyle` sobre `document.querySelectorAll('*')` — si alguien la llegara a invocar, sería un congelador de pestañas. | `content.js:838-858` | FUNC_MEDIUM |
| FUNC-05 | **Doble detección de PDF.** `executeCapture` (capture-logic) detecta PDF y desvía **antes** de mensajear al content; el content además repite su propia detección en `captureAllPageScreenshot` (`content.js:1685-1692`). La segunda capa solo es alcanzable si el content dispara sin pasar por el SW — camino casi imposible hoy. Dos criterios de detección que pueden divergir (regex `\.pdf($|[?#])` vs tests por componentes). | `capture-logic.js:79-91`, `content.js:1685` | FUNC_LOW |
| FUNC-06 | **Tres implementaciones de captura visible:** `captureVisibleFastPath` (SW, sin content), `captureDirectCapture` (SW, fallback), y content `captureVisibleOnly`→`handleVisibleCaptureRequest` (round-trip completo). La única consumidora real de la tercera es el fallback PDF parcial. Cada una con su propio manejo de errores y formato. | `capture-logic.js:100`, `:318`; `service-worker.js:1313` | FUNC_MEDIUM |
| FUNC-07 | **Render PDF duplicado con drift real:** `renderPdfInPage` (content, ~120 líneas) y `renderPdf` (offscreen, ~200) reimplementan el mismo algoritmo (getDocument → viewport loop → escala → composición canvas). Ya divergieron: el offscreen lleva `disableFontFace` + `isOffscreenCanvasSupported:false` + timeout por página; el in-page no. | `content.js:221-330`, `pdf-render.js:31-230` | ARCHITECTURE |
| FUNC-08 | **`ACTIONS.captureStatus`, `ACTIONS.openViewer` parcialmente huérfanos:** el despachador tipado solo cubre 8 de ~34 acciones; el resto son strings crudos duplicados en 2 archivos. | `constants.js:5-15`, `service-worker.js:294+` | MAINTAINABILITY |
| FUNC-09 | **No hay "version handshake" real:** `auth.js` cachea token con TTL 5 min pero no valida versión extensión↔visor; un visor viejo puede rechazar capturas nuevas con errores genéricos 4xx sin diagnóstico. | `js/background/auth.js` | FUNC_LOW |
| FUNC-10 | **Fallback in-page de PDF worker con regex frágil:** `if (!/worker\|script\|establish\|load/i.test(msg)) throw e` decide si reintentar con Blob URL; un cambio de mensaje de pdf.js rompe el fallback silenciosamente. | `content.js:262-266` | FUNC_LOW |

---

# FASE 3 — Hallazgos de rendimiento

| ID | Hallazgo | Evidencia | Clasificación |
|----|----------|-----------|---------------|
| PERF-01 | **O(N × páginas) en estilos — el cuello de botella dominante.** Por cada viewport capturado se ejecuta `afterScroll→changStyleForShot`. Ruta SQA StylesManager: `SM.updateFixed(fullH, fullW)` re-clasifica **todo el árbol** (`SearchNodesFast` + 2 `getComputedStyle` por nodo) en **cada paso de scroll**. Ruta fallback: `querySelectorAll(':not(style):not(script)...')` + `getComputedStyle` por elemento, igual de O(N) por página. Con 50 000 nodos × 30 páginas ≈ 3-4,5 M cálculos de estilo → segundos-minutos de main thread, layout thrashing. | `content.js:2050-2100`, `js/sqa-styles.js:100-260,450-467` | PERF_CRITICAL |
| PERF-02 | **Pico de memoria en splicing:** `const loaded = await Promise.all(items.map(loadBitmap))` decodifica **todas** las páginas antes del primer `drawImage`. A DPR 2 (2880 px de ancho), cada página ≈ 2880×1600×4 B ≈ 18 MB; 30 páginas ≈ 540 MB simultáneos → riesgo de OOM/fallo silencioso de `createImageBitmap`. El batching (`BATCH=4`) solo espacia los *dibujos*, no las *cargas*. Mismo patrón en `splicingImagesAarrayLast` (`loaded2`). | `content.js:2270-2280`, `:2455-2470` | PERF_CRITICAL |
| PERF-03 | **Doble conversión Blob↔DataURL por captura completa.** `splitSendImgData` hace FileReader→DataURL (+33 % tamaño, 339 KB→452 KB medido en runtime) y el SW re-decodifica con `getBlobFromDataUrl` (bucle `charCodeAt`). El canal binario `pdfRenderBlobChunk` ya existe y funciona. Coste: ~1 encode + 1 decode + 33 % de wire por captura. | `content.js:2530-2555`, `service-worker.js:801-840` | PERF_HIGH |
| PERF-04 | **Round-trip de mensajería por página con dataURL en la respuesta:** content envía `captureVisiblePageScreenshot` → SW captura → content pide `getNowShotImgData` → el SW responde con **el dataURL completo** (2-8 MB serializados) → content lo recorta y re-encodea. 3-4 mensajes + ~2 copias de un PNG gigante por viewport. | `content.js:2608-2680`, `service-worker.js:372-380` | PERF_HIGH |
| PERF-05 | **Tres recorridos DOM extra antes de la primera captura:** `findScrollableElements` (BFS con `getComputedStyle` por nodo), `getMaxHeight(document.body, 0, 20)` (recursión completa con `getComputedStyle` + `innerHTML.length` — que **serializa el innerHTML** de cada candidato), y `querySelectorAll('iframe, frame')` + `isElementOccluded` (fuerza layout con `elementFromPoint`). En páginas grandes esto solo ya es visible (~100-500 ms). | `content.js:1700-1760`, `js/sqa-scroll-finder.js:150-200` | PERF_HIGH |
| PERF-06 | **Sumas prefijas O(i) dentro del bucle de dibujo:** `for (let j=0; j<i; j++) dheight += heights[j]` recalculado por página → O(N²) trivial pero gratuito de eliminar con un array acumulado. | `content.js:2290-2310`, `:2480-2500` | PERF_LOW |
| PERF-07 | **`getVisibleBoundingRect` sube por todos los ancestros con `getBoundingClientRect` por nivel** (lecturas de layout sin cacheo entre niveles). Se usa en la composición de elementos con transform; en árboles profundos son decenas de reflows. | `content.js:545-570` | PERF_MEDIUM |
| PERF-08 | **`isScrollLoadedElement` añade 400 ms fijos** por candidato scrollable lazy (MutationObserver + timeout). En páginas con varios contenedores se paga por cada uno. | `content.js:806-840` | PERF_MEDIUM |
| PERF-09 | **Delays fijos heredados:** `prepareTime` 150/30 ms + `setTimeout(10)` + `setTimeout(20)` + `afterFrameStable` (2-3 rAF) por paso → ~200-300 ms de espera por viewport antes de capturar. 30 páginas ≈ 6-9 s de puro sleep. Ya mejoró vs `_001` (800→300 ms) pero sigue siendo el segundo coste tras PERF-01. | `content.js:1770-1790`, `:1900-1960` | PERF_HIGH |
| PERF-10 | **`peekNextEvidenceId` en el camino crítico del header:** `drawEvidenceHeader` hace `await fetchNextEvidenceId()` (SW→visor, timeout 2 s) **antes de componer**; si el visor está lento, toda la captura espera hasta 2 s. Debería ser paralelo o con caché de 1 valor. | `content.js:1329-1340`, `service-worker.js:630-650` | PERF_MEDIUM |

---

# FASE 4 — Hallazgos de memoria

| ID | Hallazgo | Evidencia | Clasificación |
|----|----------|-----------|---------------|
| MEM-01 | **Bitmaps simultáneos del splicing** (ver PERF-02): `loaded`/`loaded2` retienen todos los `ImageBitmap` hasta el final del bucle. `image.close()` libera por-dibujo, pero el pico ya ocurrió en la carga. | `content.js:2274,2456` | MEMORY |
| MEM-02 | **`capturex_capture_array` retiene todos los PNG blobs** de la captura completa (hasta ~30-90 MB) hasta `releaseCaptureBuffers`. Es un diseño consciente, pero con streaming por tira (patrón ya probado en PDF) el residente bajaría a ~2-3 MB. | `content.js:366`, `:2556` | MEMORY |
| MEM-03 | **`SM._styleStack`/`_fixedStack` crecen por paso de scroll:** `updateFixed` se llama en cada `changStyleForShot`; cada elemento fixed re-clasificado apila entradas `{elt, before, after}` con strings cssText. En capturas de 100+ pasos con headers fijos, el stack retiene cientos de referencias a nodos + strings. `restoreAll` lo vacía al final, pero el crecimiento intermedio es innecesario (re-clasificar solo nodos nuevos/nodos cuyo estado cambió). | `js/sqa-styles.js:310-345` | MEMORY |
| MEM-04 | **Blob URL del worker PDF nunca revocado:** `window.__sqaPdfWorkerUrl` retiene el worker (1.1 MB) por vida de la página. Menor, pero trivial de revocar tras `getDocument` resuelto. | `content.js:277-280` | MEMORY |
| MEM-05 | **`pdfInPageRetryDone` solo se limpia en `tabs.onRemoved`:** si la pestaña vive horas, el Set acumula tabIds (entradas minúsculas; riesgo nominal). | `service-worker.js:1620-1640` | MEMORY |
| MEM-06 | **Timers y maps del pipeline PDF correctamente acotados** (verificado): `pdfCaptureTimerById`, `pdfLocalBuffers`, `tempImageStorage` (TTL 60 s), `errorBuffer` (circular, 50), `capturePerfByTab` (finish en todas las rutas). Sin fugas detectadas en background salvo MEM-05. | `service-worker.js` | OK |
| MEM-07 | **Listeners de selección correctamente removidos** en `clearSelectionDiv`/Esc; riesgo residual solo si el usuario navega a mitad de la selección (los listeners mueren con el documento — aceptable). | `content.js:1180-1230` | OK |

---

# FASE 5 — Hallazgos arquitectónicos

| ID | Hallazgo | Impacto |
|----|----------|---------|
| ARCH-01 | **`service-worker.js` es un módulo dios (1910 líneas):** enrutado de ~34 acciones, máquina de estados PDF (3 rutas + timers + chunks + retry), watchdog, upload + cola offline, perf-marks y gestión de iconos/tema. | Cualquier cambio de PDF requiere leer 1900 líneas; riesgo de regresión colateral alto (ya ocurrió: el closeDocument del keepalive mataba renders). |
| ARCH-02 | **URL del visor hardcodeada 8 veces** (`127.0.0.1:3000` en SW y capture-logic) y `getAuthHeaders` mezclado con construcción manual de headers X-SQA-* en 3 sitios. Cambiar el endpoint toca 8 líneas. | `service-worker.js:16`, `capture-logic.js:150,380` |
| ARCH-03 | **Detección browser/OS duplicada 6 veces:** `swGetSystemInfo` (SW), `_detectOS`, `_detectBrowser`, `_getBrowserInfo` (capture-logic), `getBrowserVersion`, `obtenOS` (content). Ya hubo un bug de divergencia (BUG_HEADER_BROWSER_REGRESSION_001) corregido solo en una de las seis. | `content.js:96-160`, `capture-logic.js:388-440`, `service-worker.js:33-70` |
| ARCH-04 | **Sin dependencias circulares** (verificado por imports: background → state/utils/constants/auth solo). Acoplamiento real es por strings de acción, no por imports. | — |
| ARCH-05 | **Responsabilidades mezcladas en content.js:** motor de stitching + UI de selección + render PDF + utilidades de canvas + trazas, en un solo IIFE de 2757 líneas con ~60 variables de estado mutable de nivel superior. | Mantenimiento riesgoso; imposible de testear unitariamente. |
| ARCH-06 | **Candidatos claros de extracción:** (a) `pdf-pipeline.js` en background (estado + timers + handlers PDF ≈ 500 líneas); (b) `env-info.js` compartido (detección browser/OS única); (c) `viewer-api.js` (URL + headers + upload binario/JSON/fallback); (d) `stitcher.js` (splicing/crop de content). | Reduce ~40 % del tamaño de los 2 archivos grandes sin cambiar comportamiento. |

---

# FASE 6 — Top 20 mejoras recomendadas

| # | Mejora | ID origen | Clasificación | Esfuerzo |
|---|--------|-----------|---------------|----------|
| 1 | `updateFixed` incremental: clasificar solo elementos nuevos/que cambian de estado; caché de clasificación por WeakMap válida durante la captura | PERF-01 | PERF_CRITICAL | M |
| 2 | Carga por lotes en splicing: decodificar ventana de 4 bitmaps, dibujar, cerrar, cargar siguientes (elimina pico de ~500 MB) | PERF-02/MEM-01 | PERF_CRITICAL | S |
| 3 | Eliminar el fallback O(N) de `changStyleForShot` (hacer obligatorio StylesManager o portar su lógica) | PERF-01 | PERF_HIGH | S |
| 4 | Canal binario content→SW para el stitch final (reusar `pdfRenderBlobChunk`; elimina FileReader + atob + 33 % wire) | PERF-03 | PERF_HIGH | M |
| 5 | Adjuntar el dataURL de `captureVisibleTab` como Blob en el ack (o devolver solo el chunk id) — mata el round-trip de MB por página | PERF-04 | PERF_HIGH | M |
| 6 | Un solo recorrido DOM pre-captura: fusionar `findScrollableElements` + `getMaxHeight` + detección de iframes en un walk | PERF-05 | PERF_HIGH | M |
| 7 | Reducir delays fijos: `prepareTime` 150→60 ms con scrollable, 30→0 con rAF ya estable; eliminar `setTimeout(10)`+`setTimeout(20)` anidados | PERF-09 | PERF_HIGH | S |
| 8 | `peekNextEvidenceId` paralelo al crop (Promise.all) o caché del último ID | PERF-10 | PERF_LOW | XS |
| 9 | Purga de código muerto: `imgDataChunk`+`tempImageStorage`, `dom()`/`replaceURL`/`isBrowser`, `elementAbsolutePositions`, `pauseAllAnimations`/`resumeAllAnimations` | FUNC-01..04 | MAINTAINABILITY | XS |
| 10 | Extraer `env-info.js` (una sola detección browser/OS con API común, consumida por content y background) | ARCH-03 | ARCHITECTURE | S |
| 11 | Extraer `viewer-api.js`: URL base, headers X-SQA-*, upload binario con fallback JSON, cola offline | ARCH-02 | ARCHITECTURE | S |
| 12 | Extraer `pdf-pipeline.js` del SW (handlers + estado PDF) | ARCH-01 | ARCHITECTURE | M |
| 13 | Unificar render PDF: `renderPdfInPage` importa la misma config (worker, disableFontFace, timeouts) que offscreen — módulo compartido de parámetros | FUNC-07 | ARCHITECTURE | S |
| 14 | Prefijos acumulados para `dheight` (arrays precalculados) | PERF-06 | PERF_LOW | XS |
| 15 | Cachear `getVisibleBoundingRect` por elemento durante la captura (WeakMap) y limitar profundidad de ancestros | PERF-07 | PERF_MEDIUM | XS |
| 16 | `isScrollLoadedElement`: observador global único por captura en vez de uno por candidato; timeout 400→200 ms | PERF-08 | PERF_MEDIUM | S |
| 17 | `updateFixed` por paso: solo re-procesar región del viewport actual (los fixed fuera del viewport no cambian) | PERF-01 | PERF_HIGH | M |
| 18 | Revocar `__sqaPdfWorkerUrl` tras `getDocument` exitoso | MEM-04 | MEMORY | XS |
| 19 | Limpieza de `pdfInPageRetryDone` en `markCaptureCompleted`/`_finalizeCapture` | MEM-05 | MEMORY | XS |
| 20 | Tipar el bus de mensajes: mover las ~26 acciones restantes a `constants.js` y validar en un único dispatcher | FUNC-08 | MAINTAINABILITY | M |

---

# FASE 7 — Quick Wins (< 1 día)

1. **#9 Purga de código muerto** — ✅ IMPLEMENTADO (~230 líneas efectivas fuera; stub inerte de `tempImageStorage` para las comprobaciones de salud).
2. **#8 `peekNextEvidenceId` no bloqueante** — ✅ IMPLEMENTADO (caché de 1 valor; el primer header paga, el resto reutiliza).
3. **#14/#15/#18/#19** — ✅ IMPLEMENTADO (prefijos en 4 bucles, caché de rect visible + profundidad ≤15, revocación del worker URL, limpieza de `pdfInPageRetryDone`).
4. **#7 parcial** — ✅ IMPLEMENTADO (completo, no solo parcial: prep 60/0 ms unificada + 1 frame con scroll estable + ventana transform 40 ms).
5. **#3** — ⬜ Pendiente (backlog): si `window.__sqaStylesManager` existe, saltarse por completo la rama fallback.

---

# FASE 8 — Mejoras de alto impacto (> 1 día)

1. **#1+#17 (PERF-01):** StylesManager incremental + por-viewport. Es la diferencia entre "captura usable" y "pestaña congelada" en DOM de 50 000 nodos. Requiere tests de regresión visual (mismos PNG en páginas de muestra: CloudWatch-like, tabla 10k filas, dashboard con sticky headers).
2. **#2 (PERF-02):** ventana deslizante de bitmaps. Cambia el perfil de memoria de O(N) a O(ventana). Validar con captura de 30+ páginas y DevTools Memory (heap snapshots antes/durante/después).
3. **#4+#5 (PERF-03/04):** protocolo binario unificado content↔SW (un solo mecanismo de chunks para stitch y PDF). Elimina ~2 serializaciones grandes por página y el +33 % de wire. Diseño ya probado en `pdfRenderBlobChunk` con ack/reintento.
4. **#12/#13 (ARCH):** extracción de módulos con paridad de comportamiento; habilita tests unitarios del pipeline PDF (hoy imposible).

---

# FASE 9 — Riesgos futuros

| Riesgo | Escenario | Probabilidad | Mitigación |
|--------|-----------|--------------|------------|
| Congelamiento de pestaña en páginas enterprise | CloudWatch/dashboards con 30-80k nodos y sticky headers multipágina: PERF-01 escala linealmente con páginas | Alta | #1/#17 antes de cualquier despliegue a clientes con dashboards |
| OOM en `createImageBitmap` | Capturas > 20 páginas a DPR 2: pico > 350 MB (PERF-02) | Media | #2; fallback: truncar y avisar (ya existe `capturex_capture_truncated`) |
| Divergencia de config pdf.js | Nuevo fix aplicado a una sola de las 2 implementaciones de render (ya pasó con disableFontFace) | Alta | #13 módulo compartido de parámetros |
| Doble detección de entorno produce headers inconsistentes | Ya ocurrió una vez (REGRESSION_001); quedan 6 implementaciones | Media | #10 |
| Visor sin CORS evoluciona a otros endpoints | Cada nuevo endpoint del visor necesitará proxy SW (patrón `peekNextEvidenceId`) | Media | #11 centraliza endpoints y proxy |
| Chrome endurece serialización de mensajes (structured clone obligatorio) | Los Blobs en mensajes (workerBlob, chunks) podrían cambiar de comportamiento | Baja | El protocolo binario propio (#4) reduce la superficie |
| MV3 SW suspendido a mitad de capturas largas | Watchdog + heartbeat ya mitigan; pero cada nuevo timer debe llamar `touchHeartbeat` | Media | Regla de lint/documentación en `pdf-pipeline.js` extraído |

**Simulación de complejidad estimada** (análisis estático, sin ejecución):

| Escenario | Nodos | Páginas ~ | Coste estilos hoy (PERF-01) | Pico memoria splicing | Riesgo |
|-----------|-------|-----------|------------------------------|------------------------|--------|
| Tabla 1 000 filas | ~8 000 | 4-6 | ~40-90k getComputedStyle | ~110 MB | Bajo-Medio |
| Tabla 10 000 filas | ~60 000 | 25-35 | ~1,5-4 M | ~470-630 MB | **Alto** |
| Página virtualizada | ~2 000 visibles | dinámico | bajo, pero contenido placeholder en evidencia | bajo | Funcional (calidad de evidencia), no perf |
| Dashboard complejo | ~15 000 + iframes | 8-12 | ~0,5-1 M + 3 walks pre-captura | ~200 MB | Medio-Alto |
| CloudWatch gran volumen | 30-80 000 | 20-50 | **3-10 M** | **>500 MB** | **Crítico** |
| DOM > 50 000 nodos | 50 000+ | 20+ | ~4 M+ | >400 MB | **Crítico** |

Componentes más sensibles: `changStyleForShot`/`SM.updateFixed`, `splicingImagesAarray`, `findScrollableElements`+`getMaxHeight`, y el round-trip de dataURL por página.

---

# FASE 10 — Roadmap priorizado

**Sprint 1 (Quick Wins, ~1 día)**
- Purga de código muerto (#9), micro-fixes (#8, #14, #15, #18, #19), eliminación de timeouts anidados (#7 parcial).
- Criterio de salida: `node --check` en todos los archivos + captura de regresión en página pequeña y PDF local.

**Sprint 2 (Memoria, 2-3 días)**
- #2 ventana deslizante de bitmaps + #6 walk único pre-captura.
- Criterio: captura de 30 páginas con pico de heap < 150 MB (medido con `[PERF] heapBefore/heapAfter` ya instrumentado).

**Sprint 3 (CPU, 3-5 días)**
- #1/#17 StylesManager incremental + #3 eliminación de fallback + #16 observador único.
- Criterio: en página sintética de 50k nodos, tiempo total de estilizado por página < 50 ms (medible con `performance.now()` alrededor de `changStyleForShot`).

**Sprint 4 (Protocolo binario, 3-4 días)**
- #4/#5 canal binario unificado content↔SW.
- Criterio: `convMs≈0` en logs, wire total reducido ~30 %, cero regresiones en visor.

**Sprint 5 (Arquitectura, 1 semana)**
- #10/#11/#12/#13/#20: extracción de módulos y dispatcher tipado.
- Criterio: `service-worker.js` < 900 líneas; una sola implementación de detección de entorno; parámetros pdf.js en un solo lugar.

**Regla de validación obligatoria** (heredada del encargo): ningún cambio se da por terminado solo porque compile — cada fase debe demostrar en runtime, mediante los marcadores `[PERF]`/`[PDF_ROUTE]`/`[CAPTURE_PERF]` ya existentes, la mejora en la ruta real del usuario (consola del SW + offscreen + content).
