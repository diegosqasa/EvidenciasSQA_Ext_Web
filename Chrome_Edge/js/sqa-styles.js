/**
 * SQA StylesManager
 *
 * Origen histórico: GoFullPage (trazabilidad: AUDIT_EXTWEB_ORIGIN_001).
 *
 * Manages CSS overrides during full-page capture:
 * - Converts fixed → absolute with precise offset calculation
 * - Converts sticky → relative
 * - Disables transitions/animations
 * - Hides scrollbars
 * - Handles parallax elements (Wix, Squarespace)
 * - Site-specific hacks (Google, Quora, Notion)
 *
 * Exposes: window.__sqaStylesManager
 */
(function () {
    'use strict';
    function sqaPermTrace(action, detail){ try{console.log('[PERMISSION_TRACE] '+action+' '+(typeof detail==='string'?detail:JSON.stringify(detail).slice(0,300))+' URL='+location.href);}catch{} }

    const POSITIONED = new Set(['absolute', 'fixed', 'relative', 'sticky']);

    // PERF-01: stash de estilos computados por captura. El escaneo único calcula
    // UN getComputedStyle por nodo y el clasificador/convertidor lo reutilizan.
    let _styleStash = null;

    // FEATURE_RUNTIME: trazas obligatorias de clasificación (PERF-01).
    function frLog(msg) { try { console.log('[FEATURE_RUNTIME] ' + msg); } catch (e) {} }

    /** getComputedStyle con stash: 1 cálculo por nodo y por captura. */
    function styleOf(el) {
        let s = _styleStash && _styleStash.get(el);
        if (!s) { s = getComputedStyle(el); if (_styleStash) _styleStash.set(el, s); }
        return s;
    }

    /** CSS transform matrix helper */
    function getTransformMatrix(el) {
        if (window.DOMMatrix || window.WebKitCSSMatrix) {
            const s = styleOf(el);
            const t = s.transform || s.webkitTransform;
            return window.DOMMatrix ? new DOMMatrix(t) : new WebKitCSSMatrix(t);
        }
        return null;
    }

    /** Compute absolute bounds accounting for transforms */
    function getBounds(el) {
        const rect = el.getBoundingClientRect();
        let absLeft = 0, absTop = 0;
        let current = el;
        while (current) {
            absLeft += current.offsetLeft;
            if (current === document.body) {
                absTop += current.getBoundingClientRect().top + window.scrollY;
            } else {
                absTop += current.offsetTop;
            }
            const m = getTransformMatrix(current);
            if (m) { absLeft += m.m41; absTop += m.m42; }
            current = current.offsetParent;
        }
        return { left: absLeft, top: absTop, width: rect.width, height: rect.height };
    }

    /** Parse pixel values from computed style */
    function pxToFloat(val) { return parseFloat(val) || 0; }
    function pxToInt(val) { return parseInt(val, 10) || 0; }

    /** Check if a color is transparent */
    function isTransparent(color) {
        const c = (color || '').toLowerCase().replace(/\s+/g, '');
        return c === '' || c === 'rgba(0,0,0,0)' || c === '#0000' || c === '#00000000' || c === 'transparent';
    }

    // ============================================================================
    // StylesManager
    // ============================================================================
    const StylesManager = {
        _styleStack: [],    // normal style overrides (restored via popAll)
        _fixedStack: [],    // fixed-element overrides (restored via popAllFixed)
        _styleTag: null,
        // PERF-01 FASE 1: CaptureClassificationCache — clasificación O(N) UNA vez por captura.
        _captureActive: false,
        _classCache: null,      // { fixedElts, stickyElts, fixedBg, fixedHeader, nodes }
        _mutObserver: null,     // FASE 4: invalidación por crecimiento estructural (nunca por scroll)
        _mutSuspended: false,
        _mutDirty: false,
        _mutAdded: 0,
        _mutThreshold: 400,
        _cacheUses: 0,
        _hiddenHeaders: null,
        _convertedElts: null,   // fixed→absolute ya aplicado (idempotencia por captura)
        _bgHandled: null,       // fixedBg ya procesado
        _floaterElts: null,     // FLOATING_001: flotantes intactos en vp0, ocultos desde vp1
        _floaterHidden: null,
        _stickyApplied: false,

        // ── INIT ──────────────────────────────────────────────────────────────

        /** Initialize all style overrides for capture */
        init() {
            // PERF-01: idempotente por captura. Antes se ejecutaba en CADA viewport
            // (changStyleForShot por página): reiniciaba los stacks (=> restoreAll solo
            // restauraba la última página) y añadía un <style> de transitions/scrollbars
            // por página (fuga DOM). Ahora corre una vez por captura.
            if (this._captureActive) return;
            this._captureActive = true;
            this._styleStack = [];
            this._fixedStack = [];
            this._classCache = null;
            this._mutDirty = false;
            this._mutAdded = 0;
            this._mutSuspended = false;
            this._cacheUses = 0;
            this._hiddenHeaders = new WeakSet();
            this._convertedElts = new WeakSet();
            this._bgHandled = new WeakSet();
            this._floaterElts = [];
            this._floaterHidden = new WeakSet();
            this._stickyApplied = false;

            // scrollBehavior: auto on <html>
            this._add(document.documentElement, { scrollBehavior: 'auto' });

            // If body uses overflow:scroll, allow overflow
            const body = document.body;
            if (body) {
                const bodyStyle = getComputedStyle(body);
                if (bodyStyle.overflowY === 'scroll') {
                    this._add(body, { overflowY: 'visible' });
                }
            }

            this._hideScrollbars();
            this._disableTransitions();
            this._hacks();

            // FASE 4: observer AL FINAL — las inyecciones <style> del propio init
            // no deben invalidar la caché que aún no existe.
            this._observeMutations();
        },

        // ── PERF-01: CaptureClassificationCache ─────────────────────────────

        /** Fuerza estado limpio si una captura previa quedó sin restoreAll (abort/error). */
        beginCapture() {
            if (this._captureActive) {
                frLog('ClassificationCacheInvalidated reason=CAPTURE_ABORTED_WITHOUT_RESTORE');
                this._endCapture();
            }
        },

        /** Fin de captura: libera caché, observer y stash (no retener nodos). */
        _endCapture() {
            this._disposeMutations();
            this._captureActive = false;
            this._classCache = null;
            this._mutSuspended = false;
            this._mutDirty = false;
            this._mutAdded = 0;
            this._cacheUses = 0;
            this._hiddenHeaders = null;
            this._convertedElts = null;
            this._bgHandled = null;
            this._floaterElts = null;
            this._floaterHidden = null;
            this._stickyApplied = false;
            _styleStash = null;
        },

        /**
         * FASE 4: invalidación controlada — solo crecimiento estructural del documento
         * (nodos añadidos/eliminados) y solo SIGNIFICATIVO (> _mutThreshold, relativo
         * al tamaño clasificado). El scroll y los atributos NO reclasifican.
         */
        _observeMutations() {
            if (this._mutObserver || typeof MutationObserver === 'undefined') return;
            try {
                this._mutObserver = new MutationObserver((records) => {
                    if (this._mutSuspended) return;
                    for (let i = 0; i < records.length; i++) {
                        const r = records[i];
                        if (r.type !== 'childList') continue;
                        const added = r.addedNodes.length;
                        const removed = r.removedNodes.length;
                        if (!added && !removed) continue;
                        this._mutAdded += added;
                        if (this._mutAdded > this._mutThreshold) {
                            this._mutDirty = true;
                            break;
                        }
                    }
                });
                const target = document.body || document.documentElement;
                if (target) this._mutObserver.observe(target, { childList: true, subtree: true, attributes: false, characterData: false });
            } catch (e) {
                this._mutObserver = null;
            }
        },

        _disposeMutations() {
            if (this._mutObserver) {
                try { this._mutObserver.disconnect(); } catch (e) {}
                this._mutObserver = null;
            }
        },

        /**
         * FASE 1/2: acceso a la CaptureClassificationCache. Construye UNA vez
         * (StyleClassificationStart/Completed) y reutiliza en todos los viewports
         * siguientes (UpdateFixedMode=CACHE). Solo reconstruye por crecimiento
         * significativo del DOM (FASE 4), nunca por scroll.
         */
        _getClassificationCache() {
            if (this._classCache) {
                if (this._mutDirty) {
                    frLog('ClassificationCacheInvalidated reason=DOM_GROWTH addedNodes=' + this._mutAdded);
                    frLog('UpdateFixedMode=FULL_SCAN');
                    this._classCache = null;
                    this._mutDirty = false;
                    this._mutAdded = 0;
                    // continúa a reconstrucción puntual
                } else {
                    this._cacheUses++;
                    frLog('UpdateFixedMode=CACHE');
                    frLog('ClassificationCacheUsed uses=' + this._cacheUses + ' ClassificationCacheHit');
                    return this._classCache;
                }
            }
            return this._buildClassificationCache();
        },

        _buildClassificationCache() {
            frLog('StyleClassificationStart');
            const t0 = (window.performance && performance.now) ? performance.now() : 0;
            frLog('ClassificationCacheCreated');
            const cache = { fixedElts: [], stickyElts: [], fixedBg: [], fixedHeader: [], nodes: 0 };
            // Stash de estilos SOLO durante el escaneo único: 1 getComputedStyle por
            // nodo visitado; se libera al terminar (memoria acotada).
            _styleStash = new Map();
            try {
                this._classifyElements(cache);
            } finally {
                _styleStash = null;
            }
            const dt = t0 ? Math.round(performance.now() - t0) : -1;
            // Umbral de invalidación relativo al documento clasificado (FASE 4).
            this._mutThreshold = Math.max(200, Math.round(cache.nodes * 0.1));
            this._mutAdded = 0;
            this._mutDirty = false;
            frLog('ClassifiedNodes=' + cache.nodes);
            frLog('FixedElementsDetected=' + cache.fixedElts.length);
            frLog('StickyElementsDetected=' + cache.stickyElts.length);
            frLog('FloatingElementsDetected=' + cache.fixedBg.length);
            frLog('StyleClassificationCompleted timeMs=' + dt + ' cached=' + (cache.fixedElts.length + cache.stickyElts.length + cache.fixedHeader.length + cache.fixedBg.length));
            this._classCache = cache;
            return cache;
        },

        // ── FIXED → ABSOLUTE ──────────────────────────────────────────────────

        /**
         * Convert fixed/sticky elements to absolute positioning for capture.
         * @param {number} scrollableHeight — height of the scrollable region
         * @param {number} scrollableWidth — width of the scrollable region
         * @param {boolean} [isTopCapture=false] — whether this is the top capture
         */
        updateFixed(scrollableHeight, scrollableWidth, isTopCapture) {
            // PERF-01 FASE 2: reutiliza la CaptureClassificationCache. NUNCA re-escanea
            // el DOM por viewport; la única reclasificación permitida es por crecimiento
            // estructural significativo (FASE 4, resuelta dentro de _getClassificationCache).
            const cache = this._getClassificationCache();
            const fixedElts = cache.fixedElts, stickyElts = cache.stickyElts;
            const fixedBg = cache.fixedBg, fixedHeader = cache.fixedHeader;

            // Hide fixed headers on non-top captures (una vez por elemento y captura;
            // antes se re-apilaba cssText duplicado en cada viewport — MEM-03)
            if (!isTopCapture) {
                for (const elt of fixedHeader) {
                    if (this._hiddenHeaders.has(elt)) continue;
                    this._hiddenHeaders.add(elt);
                    this._addFixed(elt, { visibility: 'hidden', overflow: 'hidden' });
                }
            }

            // Convert fixed → absolute (idempotente: una vez por elemento y captura;
            // la geometría absoluta calculada en el primer viewport es válida para todos)
            let _floatKept = 0;
            for (const elt of fixedElts) {
                if (this._convertedElts.has(elt)) continue;
                this._convertedElts.add(elt);

                const style = getComputedStyle(elt);
                // FLOATING_001 rev2: botones flotantes (lupa, ayuda ?, chat). El pin
                // por coordenadas los dejaba mal ubicados (el absolute es relativo al
                // offsetParent, no al documento). Estrategia fiel: se dejan FIXED en
                // el primer viewport (salen en su posicion real, como Edge nativo) y
                // se ocultan desde el segundo (una sola ocurrencia, jamas duplican).
                try {
                    const _fr = elt.getBoundingClientRect();
                    const _fw = _fr.width || elt.offsetWidth || 0;
                    const _fh = _fr.height || elt.offsetHeight || 0;
                    const _area = _fw * _fh;
                    const _topAuto = !style.top || style.top === 'auto';
                    const _leftAuto = !style.left || style.left === 'auto';
                    const _rightSet = style.right && style.right !== 'auto';
                    const _bottomSet = style.bottom && style.bottom !== 'auto';
                    const _nearRight = (_fr.right > window.innerWidth - 120);
                    const _nearEdgeV = (_fr.top < 160) || (_fr.bottom > window.innerHeight - 160);
                    if (_area > 0 && _area < 40000 && ((_rightSet && _leftAuto) || (_bottomSet && _topAuto) || (_nearRight && _nearEdgeV))) {
                        if (this._floaterElts.indexOf(elt) === -1) this._floaterElts.push(elt);
                        _floatKept++;
                        frLog('FixedFloatKept w=' + Math.round(_fw) + ' h=' + Math.round(_fh) + ' screenTop=' + Math.round(_fr.top) + ' screenLeft=' + Math.round(_fr.left) + ' mode=keep-fixed-vp0');
                        continue;
                    }
                } catch (e) {}
                const oldLeft = pxToFloat(style.left);
                const oldRight = pxToFloat(style.right);
                const oldTop = pxToFloat(style.top);
                const oldBottom = pxToFloat(style.bottom);
                const oldWidth = pxToFloat(style.width);
                const oldHeight = pxToFloat(style.height);
                const oldScrollHeight = elt.scrollHeight;
                const oldOverflowY = style.overflowY;

                // First: convert to absolute
                this._addFixed(elt, { position: 'absolute', transition: 'none' });

                const offsetParent = elt.offsetParent;
                if (!offsetParent) continue;

                const parentBounds = getBounds(offsetParent);

                // Calculate new offsets relative to offsetParent
                const newLeft = oldLeft - parentBounds.left;
                const newRight = scrollableWidth - (parentBounds.left + parentBounds.width) - oldRight;
                const newTop = oldTop - parentBounds.top;
                const newBottom = scrollableHeight - (parentBounds.top + parentBounds.height) - oldBottom;

                const updates = {};
                let hasUpdates = false;

                // Horizontal
                if (!isNaN(newLeft) && newLeft <= 0) {
                    hasUpdates = true;
                    if (!isNaN(newRight) && newRight >= 0) {
                        updates.left = `${newLeft}px`;
                        updates.right = `${newRight}px`;
                    } else {
                        updates.left = `${newLeft}px`;
                    }
                } else if (!isNaN(newRight) && newRight >= 0) {
                    hasUpdates = true;
                    updates.right = `${newRight}px`;
                }

                // Vertical
                if (!isNaN(newTop) && newTop <= 0) {
                    hasUpdates = true;
                    let h = oldHeight;
                    if (oldOverflowY === 'scroll' || oldOverflowY === 'auto') {
                        h = Math.max(h, oldScrollHeight);
                    }
                    updates.height = `${h}px`;
                    if (!isNaN(newBottom) && newBottom >= 0) {
                        updates.top = `${newTop}px`;
                        updates.bottom = `${newBottom}px`;
                        delete updates.height;
                    } else if (oldBottom === 0 && offsetParent.getBoundingClientRect().height !== 0) {
                        updates.bottom = '0px';
                    } else {
                        updates.top = `${newTop}px`;
                        updates.bottom = 'auto';
                    }
                } else if (!isNaN(newBottom) && newBottom >= 0) {
                    hasUpdates = true;
                    if (oldBottom === 0 && offsetParent.getBoundingClientRect().height !== 0) {
                        updates.bottom = '0px';
                    } else {
                        updates.bottom = `${newBottom}px`;
                    }
                }

                // Width
                if ((!updates.left !== !updates.right) && oldWidth) {
                    updates.width = `${oldWidth}px`;
                }

                if (hasUpdates) {
                    if (updates.width) updates.maxWidth = updates.width;
                    if (updates.height) updates.maxHeight = updates.height;
                    this._addFixed(elt, updates);
                }
            }
            try { frLog('FloatingPreserved count=' + _floatKept + ' fixedTotal=' + fixedElts.length); } catch (e) {}

            // Convert sticky → relative (una sola vez por captura; antes inyectaba un
            // <style> duplicado por viewport). Excepcion FLOATING_001 rev2: un sticky
            // pequeno pegado al borde derecho es un boton flotante (ej. ayuda ?), no
            // contenido: se deja intacto en vp0 y se oculta desde vp1 (ver bloque
            // FloatHidden abajo). Convertirlo a relative le quita su anclaje y lo
            // desplaza a posicion estatica (desaparece o sale mal ubicado).
            if (!this._stickyApplied) {
                this._stickyApplied = true;
                const stickyIds = [];
                for (const elt of stickyElts) {
                    let _isFloater = false;
                    try {
                        const _sr = elt.getBoundingClientRect();
                        const _sw = _sr.width || elt.offsetWidth || 0;
                        const _sh = _sr.height || elt.offsetHeight || 0;
                        if (_sw > 0 && _sh > 0 && (_sw * _sh) < 40000 && _sh < 200 && (_sr.right > window.innerWidth - 120)) {
                            _isFloater = true;
                            if (this._floaterElts.indexOf(elt) === -1) this._floaterElts.push(elt);
                            frLog('StickyFloatKept w=' + Math.round(_sw) + ' h=' + Math.round(_sh) + ' screenTop=' + Math.round(_sr.top) + ' screenLeft=' + Math.round(_sr.left) + ' mode=keep-vp0');
                        }
                    } catch (e) {}
                    if (_isFloater) continue;
                    this._add(elt, {
                        position: 'relative',
                        top: 'auto', left: 'auto', right: 'auto', bottom: 'auto'
                    });
                    if (!elt.id) elt.id = `__sqa_id_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    stickyIds.push(elt.id);
                }

                // Apply sticky override via stylesheet
                if (stickyIds.length) {
                    const selector = stickyIds.map(id => `#${CSS.escape(id)}`).join(',');
                    this._addStyleSheet(`${selector} { position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; }`);
                }
            }

            // Hide small inner absolutes (una vez por elemento y captura)
            for (const elt of fixedBg) {
                if (this._bgHandled.has(elt)) continue;
                this._bgHandled.add(elt);
                if (elt.offsetWidth * elt.offsetHeight < 5000) {
                    this._add(elt, { display: 'none' });
                } else {
                    this._add(elt, { backgroundAttachment: 'scroll' });
                }
            }

            // FLOATING_001 rev2: los flotantes se dejaron FIXED/intactos en vp0 para
            // salir en posicion real; desde vp1 se ocultan (visibility, sin layout
            // shift) para que aparezcan UNA sola vez. restoreAll los restaura.
            if (!isTopCapture && this._floaterElts && this._floaterElts.length) {
                let _hid = 0;
                for (const elt of this._floaterElts) {
                    if (this._floaterHidden.has(elt)) continue;
                    this._floaterHidden.add(elt);
                    this._addFixed(elt, { visibility: 'hidden' });
                    _hid++;
                }
                if (_hid) frLog('FloatHidden count=' + _hid);
            }
        },

        /**
         * Classify elements into fixed, sticky, fixedBg, fixedHeader categories.
         * PERF-01 FASE 1: corre UNA vez por captura (llamado solo desde
         * _buildClassificationCache) y llena la CaptureClassificationCache.
         * Usa el stash de estilos: 1 getComputedStyle por nodo en vez de 3.
         */
        _classifyElements(cache) {
            const root = document.body;
            if (!root) return;

            const walker = new SearchNodesFast(root);

            while (walker.hasNext()) {
                const elt = walker.next();
                if (elt === root) continue;
                cache.nodes++;

                const style = styleOf(elt);
                const pos = style.position;

                if (pos === 'sticky') {
                    cache.stickyElts.push(elt);
                } else if (pos === 'fixed') {
                    const bounds = getBounds(elt);

                    // Fixed header: near top of viewport, not too tall
                    if (bounds.top < 20 && bounds.height < window.innerHeight - 20) {
                        // Skip if has overflow:hidden parent
                        if (!this._hasOverflowHiddenParent(elt)) {
                            cache.fixedHeader.push(elt);
                        }
                    }
                    // Offscreen fixed: skip
                    else if ((bounds.top + bounds.height <= 0 && bounds.height > 0) ||
                        (bounds.left + bounds.width <= 0 && bounds.width > 0) ||
                        (bounds.top > window.innerHeight && bounds.height > 0) ||
                        (bounds.left > window.innerWidth && bounds.width > 0)) {
                        // Skip offscreen
                    }
                    // Too tall fixed: skip
                    else if (bounds.height > window.innerHeight && bounds.width >= 2 * window.innerWidth / 3) {
                        // Skip
                    }
                    // Has overflow:hidden parent: skip
                    else if (this._hasOverflowHiddenParent(elt)) {
                        // Skip
                    }
                    else {
                        cache.fixedElts.push(elt);
                    }
                }

                if (style.backgroundAttachment === 'fixed') {
                    cache.fixedBg.push(elt);
                }
            }
        },

        _hasOverflowHiddenParent(element) {
            let parent = element.parentNode;
            while (parent && parent !== document.documentElement && parent !== document.body) {
                if (styleOf(parent).overflow === 'hidden') return true;
                parent = parent.parentNode;
            }
            return false;
        },

        // ── SCROLLBAR HIDING ──────────────────────────────────────────────────

        _hideScrollbars() {
            this._addStyleSheet(
                'html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0 !important; height: 0 !important; }\n' +
                'html, body { scrollbar-width: none !important; }'
            );
        },

        // ── TRANSITION DISABLING ──────────────────────────────────────────────

        _disableTransitions() {
            this._addStyleSheet(
                '* { transition: none !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }'
            );

            // Remove AOS attributes
            const aosElements = document.querySelectorAll('[data-aos]');
            for (const elt of aosElements) {
                const val = elt.getAttribute('data-aos');
                elt.removeAttribute('data-aos');
                this._styleStack.push({ action: 'removed_attr', elt, attr: 'data-aos', value: val });
            }

            // Destroy skrollr
            if (document.documentElement.classList.contains('skrollr')) {
                try {
                    const script = document.createElement('script');
                    script.innerHTML = 'skrollr.init().destroy(); throw new Error("haha")';
                    (document.body || document.head).appendChild(script);
                } catch (e) { /* ignore */ }
            }

            // Dispatch destroy event [PERMISSION_TRACE]
            try{ sqaPermTrace('Before DOM modification: animateme:destroy', location.href); }catch{}
            window.dispatchEvent(new CustomEvent('animateme:destroy'));
            try{ sqaPermTrace('After DOM modification: animateme:destroy', 'dispatched'); }catch{}
            this._styleStack.push({
                action: 'func',
                undo: () => { try{ sqaPermTrace('Before DOM modification: animateme:enable', location.href); }catch{} window.dispatchEvent(new CustomEvent('animateme:enable')); try{ sqaPermTrace('After DOM modification: animateme:enable', 'dispatched'); }catch{} }
            });
        },

        // ── SITE-SPECIFIC HACKS ───────────────────────────────────────────────

        _hacks() {
            // Google: hide hidden progressbars
            document.querySelectorAll('[role="progressbar"]').forEach(elt => {
                if (elt.style.display === 'none') {
                    this._add(elt, { visibility: 'hidden' });
                }
            });

            // Squarespace: fix figure opacity
            this._addStyleSheet('.sqs-layout .sqs-row .sqs-block-content figure { opacity: 1 !important; }');

            // Quora: fix sticky action bar
            const host = window.location.host;
            if (host === 'quora.com' || host.endsWith('quora.com')) {
                this._addStyleSheet('.Answer.ActionBar.sticky { position: static !important }');
            }

            // AdWords: fix sticky headers
            this._addStyleSheet('[stickyclass="sticky"], ess-particle-table [role="row"], [acxscrollhost] .header-sticky-container { transform: translate(0px, 0px) !important }');

            // Notion: fix scroller transforms
            if (document.querySelector('.notion-scroller')) {
                this._addStyleSheet('.notion-scroller > .notion-table-view > .notion-selectable > div { transform: none !important; }');
            }
        },

        // ── STYLE STACK MANAGEMENT ────────────────────────────────────────────

        _add(element, styles) {
            if (element && element.style) {
                const before = element.style.cssText;
                this._applyStyles(element, styles);
                this._styleStack.push({ action: 'css', elt: element, before, after: element.style.cssText });
            }
        },

        _addFixed(element, styles) {
            if (element && element.style) {
                const before = element.style.cssText;
                this._applyStyles(element, styles);
                this._fixedStack.push({ action: 'css', elt: element, before, after: element.style.cssText });
            }
        },

        _applyStyles(element, styles) {
            if (!element) return;
            let css = element.style.cssText + '; ';
            for (const [prop, val] of Object.entries(styles)) {
                const dash = prop.replace(/([a-zA-Z])(?=[A-Z])/g, '$1-').toLowerCase();
                css += `${dash}: ${val} !important; `;
            }
            element.style.cssText = css;
        },

        _addStyleSheet(css) {
            const style = document.createElement('style');
            style.innerHTML = css;
            const head = document.getElementsByTagName('head')[0] || document.getElementsByTagName('body')[0];
            if (head) {
                head.appendChild(style);
                this._styleStack.push({ action: 'new_elt', elt: style });
            }
        },

        // ── RESTORE ───────────────────────────────────────────────────────────

        /** Restore all normal styles */
        popAll() {
            while (this._styleStack.length) {
                this._pop(this._styleStack);
            }
        },

        /** Restore all fixed-element styles */
        popAllFixed() {
            while (this._fixedStack.length) {
                this._pop(this._fixedStack);
            }
        },

        _pop(stack) {
            const entry = stack.pop();
            if (!entry) return;

            switch (entry.action) {
                case 'new_elt':
                    if (entry.elt.parentNode) entry.elt.parentNode.removeChild(entry.elt);
                    break;
                case 'removed_attr':
                    entry.elt.setAttribute(entry.attr, entry.value);
                    break;
                case 'func':
                    entry.undo();
                    break;
                default: // 'css'
                    entry.elt.style.cssText = entry.before;
            }
        },

        /** Restore everything — call after capture completes */
        restoreAll() {
            this.popAll();
            this.popAllFixed();
            // PERF-01: fin de captura → libera caché de clasificación, observer y stash
            // (no retener referencias a nodos entre capturas).
            this._endCapture();
        }
    };

    // ============================================================================
    // Fast node walker (minimal version for _classifyElements)
    // ============================================================================
    class SearchNodesFast {
        constructor(root) {
            this.stack = root ? [root] : [];
        }
        hasNext() { return this.stack.length > 0; }
        next() {
            const item = this.stack.pop();
            if (item) {
                const children = Array.from(item.childNodes).filter(
                    n => n.nodeType === Node.ELEMENT_NODE &&
                        !IGNORED_NODE_NAMES.has(n.nodeName) &&
                        styleOf(n).display !== 'none' &&
                        styleOf(n).visibility !== 'hidden'
                );
                this.stack.push(...children);
            }
            return item;
        }
    }

    const IGNORED_NODE_NAMES = new Set(['SCRIPT', 'HEAD', 'STYLE', 'LINK', 'META']);

    // Expose globally for content.js
    window.__sqaStylesManager = StylesManager;
})();
