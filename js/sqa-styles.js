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

    /** CSS transform matrix helper */
    function getTransformMatrix(el) {
        if (window.DOMMatrix || window.WebKitCSSMatrix) {
            const s = getComputedStyle(el);
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

        // ── INIT ──────────────────────────────────────────────────────────────

        /** Initialize all style overrides for capture */
        init() {
            this._styleStack = [];
            this._fixedStack = [];

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
        },

        // ── FIXED → ABSOLUTE ──────────────────────────────────────────────────

        /**
         * Convert fixed/sticky elements to absolute positioning for capture.
         * @param {number} scrollableHeight — height of the scrollable region
         * @param {number} scrollableWidth — width of the scrollable region
         * @param {boolean} [isTopCapture=false] — whether this is the top capture
         */
        updateFixed(scrollableHeight, scrollableWidth, isTopCapture) {
            const fixedElts = [];
            const stickyElts = [];
            const fixedBg = [];
            const fixedHeader = [];

            // Classify all elements
            this._classifyElements(fixedElts, stickyElts, fixedBg, fixedHeader);

            // Hide fixed headers on non-top captures
            if (!isTopCapture) {
                for (const elt of fixedHeader) {
                    this._addFixed(elt, { visibility: 'hidden', overflow: 'hidden' });
                }
            }

            // Convert fixed → absolute
            for (const elt of fixedElts) {
                const style = getComputedStyle(elt);
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

            // Convert sticky → relative
            const stickyIds = [];
            for (const elt of stickyElts) {
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

            // Hide small inner absolutes
            for (const elt of fixedBg) {
                if (elt.offsetWidth * elt.offsetHeight < 5000) {
                    this._add(elt, { display: 'none' });
                } else {
                    this._add(elt, { backgroundAttachment: 'scroll' });
                }
            }
        },

        /**
         * Classify elements into fixed, sticky, fixedBg, fixedHeader categories.
         */
        _classifyElements(fixed, sticky, fixedBg, fixedHeader) {
            const root = document.body;
            if (!root) return;

            const walker = new SearchNodesFast(root);

            while (walker.hasNext()) {
                const elt = walker.next();
                if (elt === root) continue;

                const style = getComputedStyle(elt);
                const pos = style.position;

                if (pos === 'sticky') {
                    sticky.push(elt);
                } else if (pos === 'fixed') {
                    const bounds = getBounds(elt);

                    // Fixed header: near top of viewport, not too tall
                    if (bounds.top < 20 && bounds.height < window.innerHeight - 20) {
                        // Skip if has overflow:hidden parent
                        if (!this._hasOverflowHiddenParent(elt)) {
                            fixedHeader.push(elt);
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
                        fixed.push(elt);
                    }
                }

                if (style.backgroundAttachment === 'fixed') {
                    fixedBg.push(elt);
                }
            }
        },

        _hasOverflowHiddenParent(element) {
            let parent = element.parentNode;
            while (parent && parent !== document.documentElement && parent !== document.body) {
                if (getComputedStyle(parent).overflow === 'hidden') return true;
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
                        getComputedStyle(n).display !== 'none' &&
                        getComputedStyle(n).visibility !== 'hidden'
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
