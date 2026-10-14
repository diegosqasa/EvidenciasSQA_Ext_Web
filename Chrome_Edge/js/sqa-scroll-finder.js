/**
 * SQA Scroll Finder
 *
 * Origen histórico: GoFullPage (trazabilidad: AUDIT_EXTWEB_ORIGIN_001).
 *
 * BFS-based scrollable element detection with viewport-aware filtering.
 * Replaces the simple querySelectorAll('*') approach with a smarter algorithm
 * that finds the optimal scrollable element for full-page capture.
 *
 * Exposes: window.__sqaScrollFinder
 */
(function () {
    'use strict';

    // ============================================================================
    // SearchNodes — BFS/DFS tree walker
    // ============================================================================
    const IGNORED_NODE_NAMES = new Set(['SCRIPT', 'HEAD', 'STYLE', 'LINK', 'META']);

    class SearchNodes {
        constructor(root, options = {}) {
            this.root = root || document.body || document.documentElement;
            this.isBfs = options.isBfs || false;
            this.autoAdd = options.autoAdd || false;
            this.onlyElementNodes = options.onlyElementNodes !== false;
            this.ignoreHidden = options.ignoreHidden !== false;
            this.search = this.root ? [this.root] : [];
        }

        hasNext() { return this.search.length > 0; }

        next() {
            const item = this.isBfs ? this.search.shift() : this.search.pop();
            if (this.autoAdd && item) this.addAll(item.childNodes);
            return item;
        }

        addAll(childNodes) {
            let nodes = Array.from(childNodes);
            if (this.onlyElementNodes || this.ignoreHidden) {
                nodes = nodes.filter(n => n.nodeType === Node.ELEMENT_NODE);
            }
            if (this.ignoreHidden) {
                nodes = nodes.filter(n => !IGNORED_NODE_NAMES.has(n.nodeName));
            }
            if (this.ignoreHidden) {
                nodes = nodes.filter(n => !this.isHidden(n));
            }
            this.search.push(...nodes);
        }

        isHidden(element) {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
            const s = getComputedStyle(element);
            if (s.display === 'none' || s.visibility === 'hidden') return true;
            const h = parseInt(s.height, 10);
            const w = parseInt(s.width, 10);
            if (h === 0 && s.overflowY === 'hidden' && s.position !== 'static') return true;
            if (w === 0 && s.overflowX === 'hidden' && s.position !== 'static') return true;
            return false;
        }
    }

    // ============================================================================
    // Helpers
    // ============================================================================

    /** Get CSS transform matrix (DOMMatrix or WebKitCSSMatrix) */
    function getTransformMatrix(element) {
        if (window.DOMMatrix || window.WebKitCSSMatrix) {
            const s = getComputedStyle(element);
            const t = s.transform || s.webkitTransform;
            return window.DOMMatrix ? new DOMMatrix(t) : new WebKitCSSMatrix(t);
        }
        return null;
    }

    /** Get border + padding box for an element */
    function getBox(element) {
        const s = getComputedStyle(element);
        const px = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
        return {
            left: px(s.borderLeftWidth) + px(s.paddingLeft),
            right: px(s.borderRightWidth) + px(s.paddingRight),
            top: px(s.paddingTop) + px(s.borderTopWidth),
            bottom: px(s.paddingBottom) + px(s.borderBottomWidth)
        };
    }

    /** Compute absolute bounds of an element, accounting for transforms and offsets */
    function getBounds(element, isFrame) {
        const rect = element.getBoundingClientRect();
        let absLeft = 0, absTop = 0;
        let el = element;
        while (el) {
            absLeft += el.offsetLeft;
            if (el === document.body) {
                absTop += el.getBoundingClientRect().top + window.scrollY;
            } else {
                absTop += el.offsetTop;
            }
            const m = getTransformMatrix(el);
            if (m) { absLeft += m.m41; absTop += m.m42; }
            el = el.offsetParent;
        }

        const bounds = {
            left: absLeft,
            top: absTop,
            width: rect.width,
            height: rect.height
        };

        if (isFrame) {
            const box = getBox(element);
            bounds.left += box.left;
            bounds.top += box.top;
            bounds.width -= box.left + box.right;
            bounds.height -= box.top + box.bottom;
        }

        return bounds;
    }

    /** Check if element is visible in viewport (roughly) */
    function isVisible(bounds, cssDisplay, cssVisibility, cssOpacity) {
        return bounds.width !== 0 && bounds.height !== 0 &&
            bounds.left + bounds.width > 0 && bounds.left < window.innerWidth &&
            bounds.top + bounds.height > 0 && bounds.top < window.innerHeight &&
            cssDisplay !== 'none' && cssVisibility !== 'hidden' && cssOpacity !== '0';
    }

    // ============================================================================
    // ScrollFinder
    // ============================================================================
    const ScrollFinder = {

        _empty() { return { type: 'empty' }; },

        /**
         * Find the best scrollable element via BFS.
         * @param {number} windowWidth
         * @param {number} windowHeight
         * @param {number} fullWidth — document full width
         * @param {number} fullHeight — document full height
         * @param {Element} [root] — optional root element
         * @returns {Object} scrollable descriptor or empty
         */
        find(windowWidth, windowHeight, fullWidth, fullHeight, root) {
            const result = this._empty();

            // Skip if content fits in viewport
            if (fullWidth > windowWidth + 15 || fullHeight > windowHeight + 15) {
                // Continue — content overflows
            } else {
                return result;
            }

            // Skip on extension pages
            if (window.location.protocol === 'chrome-extension:' && window.location.pathname === '/editor.html') {
                return result;
            }

            root = root || document.body;
            if (!root) return result;

            // Try vertical first, then horizontal
            const vResult = this._findByDim(root, true);
            if (vResult && vResult.elt !== document.body) return vResult;

            const hResult = this._findByDim(root, false);
            if (hResult && hResult.elt !== document.body) return hResult;

            if (vResult) return vResult;
            if (hResult) return hResult;

            // Try iframe as last resort
            return this._findFrame(windowWidth, windowHeight) || result;
        },

        /**
         * PERF-06b: scoped candidate evaluation over the shared preScan walk.
         * Same acceptance predicate as _findByDim (vertical), but iterates ONLY
         * the pre-filtered candidates — no tree walk, no querySelectorAll, and
         * getComputedStyle runs per candidate (a handful) instead of per node.
         * `frames` likewise comes from the shared preScan (no querySelectorAll).
         * Returns the same descriptor shape as find().
         */
        findFromCandidates(candidates, frames, windowWidth, windowHeight) {
            windowWidth = windowWidth || window.innerWidth;
            windowHeight = windowHeight || window.innerHeight;
            const list = candidates || [];
            let maxScroll = 0;
            let bestElement = null;
            let bestBounds = null;
            let bestStyle = null;
            for (let i = 0; i < list.length; i++) {
                const element = list[i];
                if (!element || element.nodeType !== 1) continue;
                let offsetH, scrollH, offsetW;
                try {
                    offsetH = element.offsetHeight; scrollH = element.scrollHeight; offsetW = element.offsetWidth;
                } catch (e) { continue; }
                if (!(scrollH > offsetH + 5 && offsetH > 50 && scrollH > maxScroll && offsetW > 40)) continue;
                let style;
                try { style = getComputedStyle(element); } catch (e) { continue; }
                const overflow = style.overflowY;
                let isPerfectScrollbar = false;
                try {
                    isPerfectScrollbar = ['ps', 'ps-container'].some(function (c) { return element.classList.contains(c); }) &&
                        ['ps-active-y', 'ps--active-y'].some(function (c) { return element.classList.contains(c); });
                } catch (e) { isPerfectScrollbar = false; }
                if (style.pointerEvents === 'none' ||
                    !((overflow !== 'hidden' && overflow !== 'visible') || isPerfectScrollbar)) continue;
                let bounds;
                try { bounds = getBounds(element); } catch (e) { continue; }
                const margin = 18;
                if (bounds.left + margin >= 0 && bounds.left + bounds.width <= windowWidth + margin &&
                    bounds.top + margin >= 0 && bounds.top + bounds.height <= windowHeight + margin) {
                    bestBounds = bounds;
                    maxScroll = scrollH;
                    bestElement = element;
                    bestStyle = style;
                }
            }
            if (bestElement && bestElement !== document.body) {
                let contentHeight = bestBounds.height;
                let contentWidth = bestBounds.width;
                const scrollWidth = bestElement.scrollWidth;
                const scrollHeight = bestElement.scrollHeight;
                if (bestStyle) {
                    const perpOverflow = bestStyle.overflowX;
                    if (perpOverflow === 'hidden') {
                        const pl = parseFloat(bestStyle.paddingLeft) || 0;
                        const pr = parseFloat(bestStyle.paddingRight) || 0;
                        bestBounds.left += pl;
                        contentWidth -= pl + pr;
                    }
                }
                return {
                    type: 'elt',
                    elt: bestElement,
                    scrollHeight: Math.max(contentHeight, scrollHeight),
                    scrollWidth: Math.max(contentWidth, scrollWidth),
                    top: bestBounds.top,
                    bottom: bestBounds.top + contentHeight,
                    left: bestBounds.left,
                    right: bestBounds.left + contentWidth,
                    height: contentHeight,
                    width: contentWidth,
                    ready: true
                };
            }
            // Frame fallback over the shared preScan frame list (no querySelectorAll).
            const flist = frames || [];
            const minArea = Math.min(windowWidth * windowHeight / 4, 180000);
            let bestArea = 0;
            let bestFrame = null;
            for (let k = 0; k < flist.length; k++) {
                const frame = flist[k];
                if (!frame || frame.nodeType !== 1) continue;
                let bounds;
                try { bounds = getBounds(frame); } catch (e) { continue; }
                const area = bounds.width * bounds.height;
                if (area >= minArea && area > bestArea &&
                    bounds.left + 18 >= 0 && bounds.left + bounds.width <= windowWidth + 18 &&
                    bounds.top + 18 >= 0 && bounds.top + bounds.height <= windowHeight + 18) {
                    bestArea = area;
                    bestFrame = {
                        type: 'frame',
                        frame: frame,
                        width: bounds.width,
                        height: bounds.height,
                        top: bounds.top,
                        left: bounds.left,
                        url: frame.src,
                        tagName: (frame.tagName || 'iframe').toLowerCase(),
                        bottom: bounds.top + bounds.height,
                        right: bounds.left + bounds.width,
                        ready: false
                    };
                }
            }
            return bestFrame || this._empty();
        },

        /**
         * Find best scrollable element in one dimension (vertical or horizontal).
         */
        _findByDim(root, vertical) {
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            let maxScroll = 0;
            let bestElement = root;
            let bestBounds = null;
            let bestStyle = null;

            const walker = new SearchNodes(root, { autoAdd: false });

            while (walker.hasNext()) {
                const element = walker.next();
                const offsetDim = element[vertical ? 'offsetHeight' : 'offsetWidth'];
                const scrollDim = element[vertical ? 'scrollHeight' : 'scrollWidth'];

                if (scrollDim > offsetDim + 5 && offsetDim > 50 && scrollDim > maxScroll &&
                    element[vertical ? 'offsetWidth' : 'offsetHeight'] > 40) {

                    const style = getComputedStyle(element);
                    const overflow = style[vertical ? 'overflowY' : 'overflowX'];

                    // Check PerfectScrollbar compatibility
                    const psClasses = vertical ? ['ps-active-y', 'ps--active-y'] : ['ps-active-x', 'ps--active-x'];
                    const isPerfectScrollbar = ['ps', 'ps-container'].some(c => element.classList.contains(c)) &&
                        psClasses.some(c => element.classList.contains(c));

                    if (style.pointerEvents !== 'none' &&
                        (overflow !== 'hidden' && overflow !== 'visible' || isPerfectScrollbar)) {

                        const bounds = getBounds(element);
                        const margin = 18;

                        if (bounds.left + margin >= 0 && bounds.left + bounds.width <= windowWidth + margin &&
                            bounds.top + margin >= 0 && bounds.top + bounds.height <= windowHeight + margin) {

                            bestBounds = bounds;
                            maxScroll = scrollDim;
                            bestElement = element;
                            bestStyle = style;
                        }
                    }
                }
                walker.addAll(element.childNodes);
            }

            bestBounds = bestBounds || getBounds(bestElement);

            let contentHeight = bestBounds.height;
            let contentWidth = bestBounds.width;
            let scrollWidth = bestElement.scrollWidth;
            let scrollHeight = bestElement.scrollHeight;

            // Adjust for hidden overflow in perpendicular axis
            if (bestStyle) {
                const perpOverflow = bestStyle[vertical ? 'overflowX' : 'overflowY'];
                if (perpOverflow === 'hidden') {
                    if (vertical) {
                        const pl = parseFloat(bestStyle.paddingLeft) || 0;
                        const pr = parseFloat(bestStyle.paddingRight) || 0;
                        bestBounds.left += pl;
                        contentWidth -= pl + pr;
                        scrollWidth -= pl + pr;
                    } else {
                        const pt = parseFloat(bestStyle.paddingTop) || 0;
                        const pb = parseFloat(bestStyle.paddingBottom) || 0;
                        bestBounds.top += pt;
                        contentHeight -= pt + pb;
                        scrollHeight -= pt + pb;
                    }
                }
            }

            // Skip body
            if (bestElement === document.body) return null;

            // Skip root element if not scrollable
            if (root !== document.body && bestElement === root &&
                Math.abs(scrollWidth - contentWidth) <= 2 && Math.abs(scrollHeight - contentHeight) <= 2) {
                return null;
            }

            return {
                type: 'elt',
                elt: bestElement,
                scrollHeight: Math.max(contentHeight, scrollHeight),
                scrollWidth: Math.max(contentWidth, scrollWidth),
                top: bestBounds.top,
                bottom: bestBounds.top + contentHeight,
                left: bestBounds.left,
                right: bestBounds.left + contentWidth,
                height: contentHeight,
                width: contentWidth,
                ready: true
            };
        },

        /**
         * Find a large iframe that could be the main scrollable content.
         */
        _findFrame(windowWidth, windowHeight) {
            const frames = Array.from(document.querySelectorAll('iframe, frame'));
            const minArea = Math.min(windowWidth * windowHeight / 4, 180000);
            let bestArea = 0;
            let bestFrame = null;

            for (const frame of frames) {
                const bounds = getBounds(frame);
                const area = bounds.width * bounds.height;

                if (area >= minArea && area > bestArea &&
                    bounds.left + 18 >= 0 && bounds.left + bounds.width <= windowWidth + 18 &&
                    bounds.top + 18 >= 0 && bounds.top + bounds.height <= windowHeight + 18) {

                    bestArea = area;
                    bestFrame = {
                        type: 'frame',
                        frame: frame,
                        width: bounds.width,
                        height: bounds.height,
                        top: bounds.top,
                        left: bounds.left,
                        url: frame.src,
                        tagName: frame.tagName.toLowerCase(),
                        bottom: bounds.top + bounds.height,
                        right: bounds.left + bounds.width,
                        ready: false
                    };
                }
            }

            return bestFrame || null;
        },

        /**
         * Detect body background color.
         */
        bodyBg() {
            const candidates = [document.body, document.documentElement].filter(Boolean);
            for (const el of candidates) {
                const bg = window.getComputedStyle(el).backgroundColor || '';
                if (bg && bg !== 'transparent' && !bg.match(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\)$/)) {
                    return bg;
                }
            }
            return '#ffffff';
        }
    };

    // Expose globally for content.js
    window.__sqaScrollFinder = ScrollFinder;
})();
