# Auditoría de Código de Terceros — Ext_Web

**Extensión:** Evidencias SQA 3.8.0
**Fecha:** 2026-09-04
**Base:** AUDIT_EXTWEB_ORIGIN_001 (trazabilidad) + TECHDEBT_EXTWEB_005_PHASE1 (renombrado)

## 1. pdf.js (Mozilla Foundation) — TERCERO INTACTO

- **Archivos:** `lib/pdf.min.mjs`, `lib/pdf.worker.min.mjs` (offscreen) +
  `lib/pdf.min.js` UMD + `lib/pdf.worker.min.js` clásico (restaurados de
  CLEANUP_002 para render en content script vía `window.pdfjsLib`, con worker
  por Blob URL cacheado en `window.__sqaPdfWorkerUrl`)
- **Licencia:** Apache-2.0 (aviso incluido en la cabecera de los propios
  ficheros: `Copyright 2024 Mozilla Foundation`). Uso conforme.
- **Modificaciones:** ninguna. Solo se consumen vía `pdf-render.js`
  (`getDocument`, render por página).
- **Acción:** ninguna requerida. Recomendado: añadir `NOTICE` al empaquetar
  para la Store.

## 2. GoFullPage — MODIFICADO DE TERCERO (port declarado)

- **Archivos:** `js/sqa-scroll-finder.js` (antes `gofullpage-scroll-finder.js`,
  332 lín), `js/sqa-styles.js` (antes `gofullpage-styles.js`, 465 lín).
  Renombrados en TECHDEBT_EXTWEB_005_PHASE1; cada cabecera conserva una línea
  de procedencia (`Origen histórico: GoFullPage`).
- **Modificaciones SQA:** namespacing `window.__sqaScrollFinder` /
  `window.__sqaStylesManager`, comentarios y adaptación al pipeline propio,
  integración vía `capture-logic.js` + puentes en `content.js`.
- **Licencia upstream:** **no consta en el repositorio** (sin `LICENSE`,
  cabecera ni URL). Pendiente de dictamen.
- **Acción requerida:** confirmar licencia/atribución exigible antes de
  publicar en Chrome Web Store.

## 3. Familia `capturex_` — MODIFICADO DE TERCERO (origen indeterminado)

- **Alcance:** ~2000 líneas en `content.js` (namespace `capturex_*` 842
  ocurrencias, overlay/selección, stitching scroll→crop→merge, límites canvas,
  typo fosilizado `slection`, `getFullPageAction`,
  `captureSelectAllPageScreenshot`). Sin nombre de proyecto, marca, licencia ni
  URL en el código; backups ya venían con branding SQA; sin historial git.
- **Modificaciones SQA:** botones en español, `OffscreenCanvas`, header
  corporativo horneado, `fetchNextEvidenceId`, telemetría de permisos, guards
  de scroll, avisos de truncado/parcialidad (P0).
- **Licencia upstream:** **indeterminable con la evidencia disponible.**
- **Acción requerida:** mismo dictamen que §2; si exige copyleft/atribución,
  planificar reescritura del núcleo de stitching.

## 4. Nativo SQA (no tercero)

`service-worker.js`, `js/background/*`, `popup.*`, `welcome.*`,
`offscreen.js`, `pdf-render.js` (pegamento propio), `drawEvidenceHeader`,
`PERMISSION_TRACE`, API `127.0.0.1:3000`, `PRIVACY_POLICY.md` (este directorio).

## 5. Regla para la Store

Declarar en la ficha de publicación: "Contiene pdf.js (Apache-2.0, Mozilla) y
componentes de captura portados de GoFullPage y familia capturex_ con
modificaciones propias; licencias en revisión (ver §2-§3)". No publicar como
pública hasta cerrar el dictamen.
