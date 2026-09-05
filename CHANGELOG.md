# Evidencias SQA - Extensión de Captura de Pantalla

**Versión:** 3.8.0  
**Descripción:** Herramienta profesional de captura de pantalla diseñada para analistas de QA, que permite generar evidencias con metadatos integrados, gestión de historial, edición avanzada y adjuntos desde el portapapeles/arrastre.

---

## 📋 Changelog

### v3.8.0 — 2026-05-11
**Perf: Optimización de Almacenamiento y Memoria (~40% menos consumo)**
- **Migración a JPEG**: Se cambió el formato de captura y guardado de PNG a JPEG (0.82 de calidad). Esto reduce drásticamente el tamaño de las evidencias (entre 5x y 10x) y acelera la carga en el historial.
- **Optimización de Chunks**: Refactorizada la función `handleImageChunk` para usar un array en lugar de concatenación de strings, mejorando la velocidad de procesamiento de capturas grandes.
- **Gestión de Memoria con Bitmaps**: Implementación de `createImageBitmap` y cierre explícito de recursos en el Service Worker y utilidades de UI, reduciendo la presión sobre el recolector de basura (GC).
- **Límite de Historial de Editor**: Se estableció un límite de 20 pasos de deshacer/rehacer para evitar el crecimiento excesivo de memoria en sesiones de edición largas.
- **Miniaturas de Alto Rendimiento**: Actualizado el generador de miniaturas para usar calidad media y JPEG, optimizando la fluidez del desplazamiento en la galería.
- **Nombres de Archivo**: Actualizada la lógica de descarga para usar extensión `.jpg` por defecto.

### v3.7.2 — 2026-05-04
**Bug Fixes: Fabric Syntax and Empty Viewer**
- **Error de Sintaxis Fabric.js**: Se renombró la librería a `fabric.v530.min.js` para asegurar la carga de la versión limpia y evitar problemas de caché del navegador que causaban el error `Unexpected identifier 'library'`.
- **Visor Vacío**: Implementada lógica y UI para manejar el estado cuando no hay capturas. Ahora el visor muestra un mensaje amigable en lugar de quedar bloqueado o cerrarse automáticamente.
- **Auto-cierre**: Se eliminó la función que cerraba la ventana automáticamente cuando no había capturas, permitiendo que el usuario vea el estado vacío.

### v3.7.1 — 2026-05-04
**Refactor: Estructura de Proyecto y Limpieza de Recursos**
- **Organización de Media**: Se consolidaron todos los activos visuales (logos, iconos) en el directorio `/Media`.
- **Corrección de Librerías**: Se reemplazaron las librerías `fabric.min.js` y `jszip.min.js` que estaban corruptas por versiones estables instaladas vía npm.
- **Limpieza de Referencias**: Sincronización de todas las rutas de imagen en `manifest.json`, `result.html`, `popup.html` y scripts (`content.js`, `imageProcessor.js`).
- **Validación de CSP**: Asegurada la compatibilidad con Manifest V3 al usar recursos locales para scripts críticos.

### v3.7.0 — 2026-05-02
**Feature: Adjuntos desde Clipboard y Drag & Drop**
- **Clipboard Paste**: Permite pegar imágenes directamente en el visor SQA (`Ctrl+V`). Las imágenes se procesan, normalizan y guardan automáticamente en el historial.
- **Drag & Drop**: Soporte para arrastrar archivos de imagen desde el explorador de archivos directamente al visor para adjuntarlos como evidencia.
- **Encabezado Integrado**: Se unificó la lógica del encabezado SQA; ahora las imágenes externas pegadas o arrastradas incluyen automáticamente el encabezado institucional (Logo, Título, Fecha y Navegador).
- **Calidad y Normalización**: Las imágenes adjuntas se escalan a un ancho estándar de 627px usando suavizado de alta calidad para mantener la nitidez.
- **Arquitectura Modular**: Introducción de `clipboardHandler.js`, `imageProcessor.js` y `storageManager.js` para gestionar el nuevo flujo de adjuntos.

### v3.6.5 — 2026-04-23
**Perf: Reducción de latencia en captura (~60% más rápido)**

#### Optimizaciones de Tiempos
- **`prepareTime`**: Reducido de 800ms → 300ms (con elementos scrollables) y de 100ms → 50ms (sin elementos scrollables). Primer frame de captura llega mucho antes.
- **`waitTime` base**: Reducido de 500ms → 200ms por página (scrollTop > 0) y de 150ms → 80ms en la primera página.
- **`waitTime` extra dinámico**: Reducido de +800ms → +300ms cuando la página crece durante la captura.
- **`waitTime` extra en bloque final**: Reducido de +1000ms → +400ms.
- **`_waitTime` en verificación final**: Reducido de 1000ms → 300ms cuando `scrollTop > 0`, y de 100ms → 60ms en el caso base.
- **`isScrollLoadedElement` timeout**: Reducido de 1000ms → 400ms. Elimina el principal cuello de botella en páginas sin lazy-load.
- **`changStyleForShot` delay**: Reducido de 100ms → 60ms (por página) y de 20ms → 10ms (setup inicial).
- **Service Worker post-inyección**: Delay reducido de 500ms → 150ms al inyectar `content.js` por primera vez.
- **Service Worker retry delay**: Reducido de 300ms → 150ms entre reintentos de mensaje.

#### Impacto estimado
| Escenario | Antes | Después |
|:---|:---|:---|
| Página simple (1 pantalla) | ~650ms | ~130ms |
| Página con scroll (3 pantallas) | ~2.8s | ~1.0s |
| Primera carga (inyección) | ~800ms | ~300ms |
