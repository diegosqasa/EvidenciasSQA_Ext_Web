/**
 * Evidencias SQA — tools/build-icons.mjs
 *
 * Rasteriza Media/Logo_SQA.svg a los PNG cuadrados que exige Chrome/Edge para
 * el icono del toolbar (manifest.action.default_icon y chrome.action.setIcon).
 *
 * ¿Por qué un script y no el SVG directo?
 *   Chrome/Edge NO aceptan SVG en `manifest.icons`, `action.default_icon` ni
 *   `chrome.action.setIcon`: el icono debe ser un bitmap. Este script es la
 *   fuente de verdad reproducible del juego de iconos.
 *
 * El SVG se auto-adapta por `prefers-color-scheme` (.sqa: #07162F en claro,
 * #FFFFFF en oscuro). Se generan las dos variantes equivalentes:
 *   - variante "onlight": glifo oscuro  -> se lee en toolbar CLARO
 *   - variante "ondark" : glifo claro   -> se lee en toolbar OSCURO
 *
 * Encuadre por defecto: recorte al ink de las letras (177x124) con la barra
 * naranja RECOLOCADA dentro del hueco libre bajo la linea base (ver
 * placeAccentInLines). El logo completo mide 245x133; escalarlo por 245 dejaba
 * el glifo al 51% del cuadro. Al mover el guion al hueco, el bbox no crece: el
 * glifo sube al ~75% a 16 px conservando la marca.
 *
 * Uso:
 *   node tools/build-icons.mjs                 # Media/SQAtoolbar-*.png + SQAicon-*.png
 *   node tools/build-icons.mjs --analyze       # compara con los iconos actuales
 *   node tools/build-icons.mjs --sheet         # hoja de comparación (elige encuadre)
 *   node tools/build-icons.mjs --full          # logo completo original (referencia)
 *   node tools/build-icons.mjs --fit=contain   # ajuste uniforme (por defecto)
 *   node tools/build-icons.mjs --fit=stretch   # deforma al cuadrado (NO recomendado)
 *
 * Las rutas del SVG usan exclusivamente M/L/Z (polígonos rectos), así que el
 * relleno se resuelve con un scanline exacto + supersampling para antialias.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(ROOT, 'Media', 'Logo_SQA.svg');

// Colores del SVG (deben coincidir con las reglas .sqa / .accent del <style>)
const INK_ONLIGHT = [0x07, 0x16, 0x2f, 255]; // #07162F — glifo oscuro (tema claro)
const ACCENT_ONLIGHT = [0xf5, 0x9c, 0x0c, 255]; // #F59C0C
const INK_ONDARK = [0xff, 0xff, 0xff, 255]; // #FFFFFF — glifo claro (tema oscuro)
const ACCENT_ONDARK = [0xf5, 0x9c, 0x0c, 255];

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4; // 4x -> antialias por box-filter

// ── Parseo del SVG ──────────────────────────────────────────────────────────

export function parseSvg(svgText) {
    const viewBoxMatch = svgText.match(/viewBox\s*=\s*"([^"]+)"/);
    if (!viewBoxMatch) throw new Error('viewBox no encontrado en el SVG');
    const [minX, minY, vbW, vbH] = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);

    // Cada <path class="..." d="..."/> → polígono con su clase de color
    const shapes = [];
    const pathRe = /<path\b([^>]*)\/?>/g;
    let m;
    while ((m = pathRe.exec(svgText)) !== null) {
        const attrs = m[1];
        const dMatch = attrs.match(/\bd\s*=\s*"([^"]+)"/);
        if (!dMatch) continue;
        const classMatch = attrs.match(/class\s*=\s*"([^"]+)"/);
        const cls = classMatch ? classMatch[1] : 'sqa';
        const subpaths = parsePathData(dMatch[1]);
        if (subpaths.length) shapes.push({ cls, subpaths });
    }
    if (!shapes.length) throw new Error('No se encontraron <path> con atributo d=');

    return { viewBox: { minX, minY, w: vbW, h: vbH }, shapes };
}

/**
 * Tokeniza el atributo `d`. Este SVG usa sólo M / L / Z; se lanza un error
 * explícito ante cualquier comando curvo para no rasterizar en silencio mal.
 */
export function parsePathData(d) {
    const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const subpaths = [];
    let current = null;
    let cx = 0;
    let cy = 0;
    let i = 0;
    let cmd = null;

    const readNum = () => Number(tokens[i++]);

    while (i < tokens.length) {
        const t = tokens[i];
        if (/[A-Za-z]/.test(t)) { cmd = t; i++; }

        switch (cmd) {
            case 'M':
            case 'm': {
                let x = readNum();
                let y = readNum();
                if (cmd === 'm') { x += cx; y += cy; }
                cx = x; cy = y;
                current = { points: [[x, y]], closed: false };
                subpaths.push(current);
                cmd = cmd === 'M' ? 'L' : 'l'; // implicit lineto tras moveto
                break;
            }
            case 'L':
            case 'l': {
                let x = readNum();
                let y = readNum();
                if (cmd === 'l') { x += cx; y += cy; }
                cx = x; cy = y;
                if (!current) { current = { points: [], closed: false }; subpaths.push(current); }
                current.points.push([x, y]);
                break;
            }
            case 'H':
            case 'h': {
                let x = readNum();
                if (cmd === 'h') x += cx;
                cx = x;
                if (!current) { current = { points: [], closed: false }; subpaths.push(current); }
                current.points.push([x, cy]);
                break;
            }
            case 'V':
            case 'v': {
                let y = readNum();
                if (cmd === 'v') y += cy;
                cy = y;
                if (!current) { current = { points: [], closed: false }; subpaths.push(current); }
                current.points.push([cx, y]);
                break;
            }
            case 'Z':
            case 'z': {
                if (current) current.closed = true;
                current = null;
                cmd = null;
                break;
            }
            default:
                throw new Error(
                    `Comando de path no soportado por este rasterizador: "${cmd}". ` +
                    `Este script sólo implementa M/L/H/V/Z (el logo es poligonal).`
                );
        }
    }
    return subpaths.filter((s) => s.points.length > 2);
}

// ── Rasterizado (scanline, relleno even-odd) ────────────────────────────────

/**
 * Rasteriza el SVG a un buffer RGBA de w×h.
 * @param {object} svg   resultado de parseSvg()
 * @param {number} w
 * @param {number} h
 * @param {{ink:number[],accent:number[],fit:'contain'|'stretch',pad?:number,source?:{x:number,y:number,w:number,h:number}}} opts
 */
function rasterize(svg, w, h, opts) {
    const { ink, accent, fit = 'contain', pad = 0 } = opts;
    // `source` permite recortar una región del viewBox (monograma cuadrado)
    const src = opts.source || { x: svg.viewBox.minX, y: svg.viewBox.minY, w: svg.viewBox.w, h: svg.viewBox.h };
    const S = SUPERSAMPLE;
    const sw = w * S;
    const sh = h * S;

    // Transformación (región `src` del viewBox) -> lienzo
    const availW = sw - pad * 2 * S;
    const availH = sh - pad * 2 * S;
    let sx;
    let sy;
    let dx;
    let dy;
    if (fit === 'stretch') {
        sx = availW / src.w;
        sy = availH / src.h;
        dx = pad * S - src.x * sx;
        dy = pad * S - src.y * sy;
    } else {
        const s = Math.min(availW / src.w, availH / src.h);
        sx = s;
        sy = s;
        // centrado de la región recortada
        dx = (sw - src.w * s) / 2 - src.x * s;
        dy = (sh - src.h * s) / 2 - src.y * s;
    }

    // Tramos (edges) transformados a coordenadas de supersampling
    const shapesT = svg.shapes.map((shape) => ({
        cls: shape.cls,
        subpaths: shape.subpaths.map((sp) => sp.points.map(([x, y]) => [x * sx + dx, y * sy + dy]))
    }));

    // Acumulador de cobertura por color (RGBA premultiplicado por cobertura)
    const out = Buffer.alloc(w * h * 4);
    const acc = new Float64Array(w * h * 4); // r,g,b,a acumulados
    const SWATCH = { sqa: ink, accent: accent };

    for (let py = 0; py < sh; py++) {
        const yc = py + 0.5;
        // intersecciones x por forma
        const hits = new Map();
        for (let si = 0; si < shapesT.length; si++) {
            const list = [];
            for (const pts of shapesT[si].subpaths) {
                for (let k = 0; k < pts.length; k++) {
                    const [x1, y1] = pts[k];
                    const [x2, y2] = pts[(k + 1) % pts.length];
                    if (y1 === y2) continue;
                    const ymin = Math.min(y1, y2);
                    const ymax = Math.max(y1, y2);
                    if (yc < ymin || yc >= ymax) continue;
                    const t = (yc - y1) / (y2 - y1);
                    list.push(x1 + t * (x2 - x1));
                }
            }
            if (list.length) { list.sort((a, b) => a - b); hits.set(si, list); }
        }

        for (let px = 0; px < sw; px++) {
            const xc = px + 0.5;
            // even-odd: contar cruces a la izquierda del punto, impar = dentro
            let insideShape = -1;
            for (const [si, list] of hits) {
                let crossings = 0;
                for (let k = 0; k < list.length; k++) if (list[k] > xc) crossings++;
                if (crossings % 2 === 1) { insideShape = si; break; }
            }
            if (insideShape < 0) continue;

            // color: el path con clase "accent" pinta naranja; "sqa" pinta tinta
            const cls = shapesT[insideShape].cls;
            const c = cls === 'accent' ? SWATCH.accent : SWATCH.sqa;

            const ox = (px / S) | 0;
            const oy = (py / S) | 0;
            const idx = (oy * w + ox) * 4;
            acc[idx] += c[0];
            acc[idx + 1] += c[1];
            acc[idx + 2] += c[2];
            acc[idx + 3] += 255;
        }
    }

    const norm = S * S;
    for (let i = 0; i < w * h; i++) {
        const a = acc[i * 4 + 3] / norm;
        if (a <= 0) continue;
        // color promedio ponderado por la cobertura, canal alfa = cobertura
        out[i * 4] = Math.round(acc[i * 4] / norm / (a / 255));
        out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / norm / (a / 255));
        out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / norm / (a / 255));
        out[i * 4 + 3] = Math.round(a);
    }
    return out;
}

// ── Codificación PNG (RGBA, sin filtro) ─────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0; // filtro None
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ── Lectura de PNG existentes (sólo máscara alfa) para --analyze ────────────

const PNG_CT = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(file) {
    const b = fs.readFileSync(file);
    let o = 8;
    let w;
    let h;
    let bd;
    let ct;
    let idat = [];
    let plte = null;
    while (o < b.length) {
        const len = b.readUInt32BE(o);
        const type = b.toString('ascii', o + 4, o + 8);
        const data = b.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
        else if (type === 'PLTE') plte = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const ch = PNG_CT[ct];
    const bpp = Math.ceil(bd / 8) * ch;
    const stride = Math.ceil((w * ch * bd) / 8);
    const out = Buffer.alloc(h * stride);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[p++];
        const line = raw.subarray(p, p + stride);
        p += stride;
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const c = prev[x];
            const bb = x >= bpp ? prev[x - bpp] : 0;
            const v = line[x];
            let r;
            if (f === 0) r = v;
            else if (f === 1) r = v + a;
            else if (f === 2) r = v + c;
            else if (f === 3) r = v + ((a + c) >> 1);
            else {
                const pa = Math.abs(c - bb);
                const pb = Math.abs(a - bb);
                const pc = Math.abs(a + c - 2 * bb);
                r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? c : bb);
            }
            cur[x] = r & 255;
        }
    }
    return { w, h, ct, ch, out, stride, plte };
}

function alphaAt(d, x, y) {
    const i = y * d.stride + x * d.ch;
    if (d.ct === 6) return d.out[i + 3];
    if (d.ct === 4) return d.out[i + 1];
    if (d.ct === 2 || d.ct === 0 || d.ct === 3) return 255;
    return 0;
}

/** Máscara binaria (alpha>127) a resolución nativa. */
function maskOf(file) {
    const d = decodePng(file);
    const mask = new Uint8Array(d.w * d.h);
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) mask[y * d.w + x] = alphaAt(d, x, y) > 127 ? 1 : 0;
    return { w: d.w, h: d.h, mask };
}

function agree(a, b) {
    const n = a.mask.length;
    let inter = 0;
    let uni = 0;
    for (let i = 0; i < n; i++) {
        const p = a.mask[i];
        const q = b.mask[i];
        if (p || q) uni++;
        if (p && q) inter++;
    }
    return uni ? inter / uni : 0;
}

function maskFromRgba(rgba, w, h) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
    return { w, h, mask };
}

// ── CLI ────────────────────────────────────────────────────────────────────

/**
 * Caja de tinta real (bounding box) de las formas del SVG.
 *
 * `includeAccent: false` deja SOLO las letras. Es la clave del tamano: el
 * wordmark completo mide 245x133, pero la barra naranja ocupa x=189..242, asi
 * que obliga a escalar por 245 y el glifo queda al ~50% del cuadro. Sin ella el
 * encuadre se rige por 177x124 (las letras) y el glifo gana ~38% de alto.
 */
export function inkBox(svg, includeAccent = true) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const shape of svg.shapes) {
        if (!includeAccent && shape.cls === 'accent') continue;
        for (const sp of shape.subpaths) {
            for (const [x, y] of sp.points) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Icono "tile": cuadro redondeado con fondo de marca y el glifo en negativo.
 *
 * Para que sirve: `manifest.icons` (pagina de extensiones, dialogo de
 * instalacion) es ESTATICO — Chrome no ofrece ninguna forma de que cambie con
 * el tema. Un glifo navy sobre ese fondo queda invisible en tema oscuro y un
 * glifo blanco queda invisible en tema claro. Un tile de color con el glifo en
 * negativo se lee en LOS DOS, y es lo que usa la mayoria de extensiones.
 */
/** Caja de tinta de UNA clase concreta del SVG (p. ej. 'accent'). */
export function classBox(svg, cls) {
    return inkBox({ viewBox: svg.viewBox, shapes: svg.shapes.filter((s) => s.cls === cls) }, true);
}

/**
 * Recoloca la barra de acento dentro del hueco libre del wordmark.
 *
 * Por que: en el SVG la barra vive en x=189..242, es decir FUERA del bbox de
 * las letras (177 de ancho). Eso obligaba a escalar por 245 y dejaba el glifo
 * al 51% del cuadro — el motivo de que el icono se viera pequeno. Pero las
 * letras dejan un hueco vacio (a la derecha del descendente de la "q", por
 * debajo de la linea base), asi que la barra se puede meter AHI: el bbox total
 * no crece (sigue siendo 177x124), el glifo conserva el ~70% de alto y el
 * guion naranja de la marca se mantiene.
 */
export function placeAccentInLines(svg) {
    const letters = inkBox(svg, false);
    const accent = classBox(svg, 'accent');
    if (!letters.w || !accent.w) return svg;
    // Pegada al borde derecho de las letras, con su centro a 72% del alto de las
    // letras (justo por debajo de la linea base: y=85 sobre un bbox 5..129).
    const dx = Math.round((letters.x + letters.w) - (accent.x + accent.w));
    const targetCy = letters.y + letters.h * 0.72;
    const dy = Math.round(targetCy - (accent.y + accent.h / 2));
    return {
        viewBox: svg.viewBox,
        shapes: svg.shapes.map((s) => (s.cls !== 'accent' ? s : {
            cls: s.cls,
            subpaths: s.subpaths.map((sp) => ({
                ...sp,
                points: sp.points.map(([x, y]) => [x + dx, y + dy])
            }))
        }))
    };
}

/** Union de dos cajas de tinta (el encuadre debe contener ambas). */
export function unionBox(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y
    };
}

/** Traslada (y opcionalmente escala sobre su propio centro) la barra de acento. */
export function transformAccent(svg, { scale = 1, dx = 0, dy = 0 } = {}) {
    const acc = classBox(svg, 'accent');
    const cx = acc.x + acc.w / 2;
    const cy = acc.y + acc.h / 2;
    return {
        viewBox: svg.viewBox,
        shapes: svg.shapes.map((s) => (s.cls !== 'accent' ? s : {
            cls: s.cls,
            subpaths: s.subpaths.map((sp) => ({
                ...sp,
                points: sp.points.map(([x, y]) => [
                    (x - cx) * scale + cx + dx,
                    (y - cy) * scale + cy + dy
                ])
            }))
        }))
    };
}

/**
 * Modos de composición de la barra de acento.
 *
 * OJO, límite geométrico: el slot es CUADRADO y `contain` escala por la
 * dimensión MAYOR del lienzo. Con el guion a la derecha el ancho pasa de 177 a
 * 240, así que el glifo pierde un 26% (52% de alto en vez de 70%). Guion a la
 * derecha y glifo grande son incompatibles: solo se puede mover o acortar el
 * guion. Los tres modos son las tres respuestas posibles.
 *
 *   after       guion en su posición ORIGINAL, tras la "a"  -> fiel, glifo 52%H
 *   after-short mismo sitio, guion al 75% y gap 2u        -> compromiso, 56%H
 *   pocket      guion recolocado en el hueco bajo la línea base -> glifo 70%H
 */
export const ACCENT_MODES = ['after', 'after-short', 'pocket'];
export const DEFAULT_ACCENT_MODE = 'after';

export function composeAccent(svg, mode = DEFAULT_ACCENT_MODE) {
    const letters = inkBox(svg, false);
    const acc = classBox(svg, 'accent');
    if (mode === 'pocket') {
        return { svg: placeAccentInLines(svg), source: letters };
    }
    if (mode === 'after-short') {
        // Mismo sitio (tras la "a"), barra mas corta y pegada: el lienzo pasa de
        // 240 a ~220 de ancho y el glifo recupera ~4 puntos de alto, con el guion
        // todavia por encima de los 2 px que necesita para verse a 16 px.
        const k = 0.75;
        const gap = 2;
        const cx = acc.x + acc.w / 2;
        const dx = (letters.x + letters.w + gap) - (cx - (acc.w * k) / 2);
        const out = transformAccent(svg, { scale: k, dx, dy: 0 });
        return { svg: out, source: unionBox(letters, classBox(out, 'accent')) };
    }
    // 'after': la barra se deja EXACTAMENTE donde la dibujo el disenador.
    return { svg, source: unionBox(letters, acc) };
}

export function renderTile(svg, size, opts) {
    // El margen interno baja en tamanos pequenos: con 15% a 16-32 px el guion
    // naranja queda por debajo de 1 px y se mezcla con el navy hasta desaparecer.
    const { bg, ink, accent, source, radiusPct = 0.22, innerPadPct = size <= 32 ? 0.07 : 0.15 } = opts;
    const SS = 4;
    const W = size * SS;
    // El glifo se rasteriza ya con su margen interno respecto al borde del tile.
    const glyph = rasterize(svg, W, W, { ink, accent, fit: 'contain', source, pad: Math.round(W * innerPadPct) });
    const r = W * radiusPct;
    const out = Buffer.alloc(size * size * 4);
    for (let oy = 0; oy < size; oy++) {
        for (let ox = 0; ox < size; ox++) {
            let pr = 0; let pg = 0; let pb = 0; let pa = 0;
            for (let sy = 0; sy < SS; sy++) {
                const Y = oy * SS + sy + 0.5;
                for (let sx = 0; sx < SS; sx++) {
                    const X = ox * SS + sx + 0.5;
                    // SDF de rectangulo redondeado que llena el lienzo
                    const dx = Math.max(r - X, X - (W - r), 0);
                    const dy = Math.max(r - Y, Y - (W - r), 0);
                    const inBg = (Math.hypot(dx, dy) - r) <= 0 ? 1 : 0;
                    const gi = ((oy * SS + sy) * W + (ox * SS + sx)) * 4;
                    const gA = glyph[gi + 3] / 255;
                    // glifo SOBRE fondo, en premultiplicado (promediar asi es correcto)
                    pr += glyph[gi] * gA + bg[0] * inBg * (1 - gA);
                    pg += glyph[gi + 1] * gA + bg[1] * inBg * (1 - gA);
                    pb += glyph[gi + 2] * gA + bg[2] * inBg * (1 - gA);
                    pa += gA + inBg * (1 - gA);
                }
            }
            const n = SS * SS;
            const A = pa / n;
            if (A <= 0) continue;
            const i = (oy * size + ox) * 4;
            out[i] = Math.round(pr / n / A);
            out[i + 1] = Math.round(pg / n / A);
            out[i + 2] = Math.round(pb / n / A);
            out[i + 3] = Math.round(A * 255);
        }
    }
    return out;
}

function main() {
    const args = process.argv.slice(2);
    const svgText = fs.readFileSync(SVG_PATH, 'utf8');
    const svg = parseSvg(svgText);
    const commands = [...svgText.matchAll(/\bd\s*=\s*"([^"]+)"/g)]
        .flatMap((m) => m[1].match(/[A-Za-z]/g) || []);
    console.log(`SVG: ${path.relative(ROOT, SVG_PATH)}  viewBox=${svg.viewBox.w}x${svg.viewBox.h}  paths=${svg.shapes.length}`);
    console.log(`Comandos de path presentes: ${[...new Set(commands)].join(' ')}`);

    if (args.includes('--analyze')) return analyze(svg);
    if (args.includes('--sheet')) return sheet();

    const fitArg = args.find((a) => a.startsWith('--fit='));
    const fit = fitArg ? fitArg.split('=')[1] : 'contain';
    if (!['contain', 'stretch'].includes(fit)) throw new Error(`--fit inválido: ${fit}`);

    // Modo de composicion de la barra de acento (ver ACCENT_MODES).
    // `--full` vuelve al logo completo original de 245x133 (solo referencia).
    const accentArg = args.find((a) => a.startsWith('--accent='));
    const accentMode = accentArg ? accentArg.split('=')[1] : DEFAULT_ACCENT_MODE;
    if (!ACCENT_MODES.includes(accentMode)) {
        throw new Error(`--accent invalido: ${accentMode} (usa ${ACCENT_MODES.join(' | ')})`);
    }
    const composed = args.includes('--full') ? { svg, source: undefined } : composeAccent(svg, accentMode);
    const art = composed.svg;
    const source = composed.source;
    const letters = inkBox(art, false);
    const accentBox = classBox(art, 'accent');
    console.log(`Modo de acento: ${args.includes('--full') ? 'full (logo original 245x133)' : accentMode}`);
    console.log(`  barra : x ${accentBox.x}..${accentBox.x + accentBox.w}  y ${accentBox.y}..${accentBox.y + accentBox.h}`);
    console.log(`  letras: x ${letters.x}..${letters.x + letters.w}  y ${letters.y}..${letters.y + letters.h}`);
    if (source) {
        // Lo que importa es la tinta de las LETRAS dentro del lienzo, no el lienzo.
        const s = 16 / Math.max(source.w, source.h);
        const gw = letters.w * s;
        const gh = letters.h * s;
        console.log(`  lienzo: ${source.w}x${source.h}  ->  a 16 px el glifo mide ${gw.toFixed(1)}x${gh.toFixed(1)} px (${Math.round((gw / 16) * 100)}%W/${Math.round((gh / 16) * 100)}%H)`);
    }
    const padFor = (size) => (size >= 128 ? 2 : size >= 32 ? 1 : 0);
    console.log(`Encuadre: ${source ? `lienzo ${source.w}x${source.h} (x${source.x},y${source.y})` : 'logo completo 245x133'}`);

    const written = [];
    const write = (name, rgba, size) => {
        fs.writeFileSync(path.join(ROOT, 'Media', name), encodePng(rgba, size, size));
        written.push(`Media/${name}`);
    };

    // 1) Icono del TOOLBAR: glifo transparente, una variante por tema.
    //    Lo asigna chrome.action.setIcon desde el service worker.
    for (const size of SIZES) {
        for (const [suffix, ink] of [['onlight', INK_ONLIGHT], ['ondark', INK_ONDARK]]) {
            const accent = suffix === 'onlight' ? ACCENT_ONLIGHT : ACCENT_ONDARK;
            const rgba = rasterize(art, size, size, { ink, accent, fit, source, pad: padFor(size) });
            write(`SQAtoolbar-${suffix}-${size}.png`, rgba, size);
        }
    }

    // 2) Icono del MANIFEST: tile independiente del tema (pagina de extensiones
    //    y dialogo de instalacion, que NO pueden cambiar con el tema).
    for (const size of SIZES) {
        const navy = renderTile(art, size, {
            bg: INK_ONLIGHT, ink: INK_ONDARK, accent: ACCENT_ONLIGHT, source
        });
        write(`SQAicon-${size}.png`, navy, size);
        const orange = renderTile(art, size, {
            bg: ACCENT_ONLIGHT, ink: INK_ONLIGHT, accent: INK_ONLIGHT, source
        });
        write(`SQAicon-orange-${size}.png`, orange, size);
    }

    console.log(`\nGenerados ${written.length} PNG (fit=${fit}):`);
    for (const w of written) console.log('  ' + w);
}

function analyze(svg) {
    const targets = [
        ['Media/SQA1-128.png', 128, INK_ONLIGHT],
        ['Media/SQA-128.png', 128, INK_ONDARK],
        ['Media/SQA1-48.png', 48, INK_ONLIGHT],
        ['Media/SQA-48.png', 48, INK_ONDARK],
        ['Media/SQA1-32.png', 32, INK_ONLIGHT],
        ['Media/SQA-32.png', 32, INK_ONDARK],
        ['Media/1.png', 32, INK_ONLIGHT],
        ['Media/SQA1-16.png', 16, INK_ONLIGHT],
        ['Media/SQA-16.png', 16, INK_ONDARK]
    ];
    console.log('\nHIPÓTESIS A = SVG ajustado uniformemente (contain, sin deformar)');
    console.log('HIPÓTESIS B = SVG estirado al cuadrado (deformado)\n');
    console.log('icono existente'.padEnd(24), 'lienzo'.padEnd(10), 'A contain'.padEnd(12), 'B stretch'.padEnd(12), 'veredicto');
    for (const [file, size, ink] of targets) {
        const abs = path.join(ROOT, file);
        if (!fs.existsSync(abs)) { console.log(file.padEnd(24), '(no existe)'); continue; }
        const existing = maskOf(abs);
        if (existing.w !== size) {
            console.log(file.padEnd(24), `${existing.w}x${existing.h}`.padEnd(10), '-'.padEnd(12), '-'.padEnd(12), 'no es cuadrado');
            continue;
        }
        const a = maskFromRgba(rasterize(svg, size, size, { ink, accent: ACCENT_ONLIGHT, fit: 'contain', pad: 0 }), size, size);
        const b = maskFromRgba(rasterize(svg, size, size, { ink, accent: ACCENT_ONLIGHT, fit: 'stretch', pad: 0 }), size, size);
        const ia = agree(existing, a);
        const ib = agree(existing, b);
        const verdict = ib > ia + 0.15 ? 'ESTIRADO (deformado)' : ia > ib + 0.15 ? 'contain (correcto)' : 'ambiguo';
        console.log(file.padEnd(24), `${size}x${size}`.padEnd(10),
            (ia * 100).toFixed(1).padStart(6) + '%'.padEnd(5),
            (ib * 100).toFixed(1).padStart(6) + '%'.padEnd(5), `${verdict}  (IoU)`);
    }
}

export { rasterize, encodePng, decodePng, maskOf, maskFromRgba, agree };

// ── Hoja de comparación de encuadres (--sheet) ──────────────────────────────

/** Recortes candidatos: el wordmark es 245x133, un slot de toolbar es cuadrado. */const CANDIDATES = [
    { id: 'accent-after', label: 'POR DEFECTO: guion tras la "a" (posicion original del SVG)',
      note: 'Composicion fiel a la marca. El lienzo pasa a 240x124, asi que el glifo baja al 52% de alto: es el precio de que el guion vaya a la derecha.',
      accentMode: 'after' },
    { id: 'accent-after-short', label: 'Compromiso: guion tras la "a", acortado al 75%',
      note: 'Mismo sitio (tras la a), barra mas corta y gap de 2u. Recupera alto de glifo y el guion sigue por encima de los 2 px que necesita a 16 px.',
      accentMode: 'after-short' },
    { id: 'accent-pocket', label: 'DESCARTADO: guion recolocado bajo la linea base',
      note: 'El glifo llega al 70% de alto, pero el guion queda DEBAJO de la "a". Composicion incorrecta.',
      accentMode: 'pocket' },
    { id: 'full-contain', label: 'Logo completo (contain, sin deformar)',
      note: 'Proporciones intactas. A 16 px ocupa 16x8.7 px: pierde legibilidad.',
      source: null, fit: 'contain' },
    { id: 'noaccent-contain', label: 'Sin barra de acento (contain, sin deformar)',
      note: 'Aspecto 183:133 (1.38). Recupera ~36% de tamano a 16 px vs el completo.',
      source: { x: 0, y: 0, w: 183, h: 133 }, fit: 'contain' },
    { id: 'qa-crop', label: 'Monograma "QA" a cuadrado (sin deformar)',
      note: 'Recorte x60..188. Llena el cuadrado y es legible a 16 px, pero pierde la "S".',
      source: { x: 60, y: 0, w: 128, h: 133 }, fit: 'contain' },
    { id: 'current-stretch', label: 'ACTUAL: wordmark estirado (referencia del defecto)',
      note: 'Aplasta el logo 1.84x en horizontal. Es lo que hay hoy en Media/SQA-*.png.',
      source: null, fit: 'stretch' }
];

function sheet() {
    const svg = parseSvg(fs.readFileSync(SVG_PATH, 'utf8'));
    const comps = Object.fromEntries(ACCENT_MODES.map((m) => [m, composeAccent(svg, m)]));
    const outDir = path.join(ROOT, 'Docs', 'AUDITS', 'icon-preview');
    fs.mkdirSync(outDir, { recursive: true });

    const dataUrl = (rgba, size) => 'data:image/png;base64,' + encodePng(rgba, size, size).toString('base64');

    const rows = CANDIDATES.map((c) => {
        const comp = c.accentMode ? comps[c.accentMode] : null;
        const artSvg = comp ? comp.svg : svg;
        const src = comp ? comp.source : c.source;
        const cells = SIZES.map((size) => {
            const light = dataUrl(rasterize(artSvg, size, size,
                { ink: INK_ONLIGHT, accent: ACCENT_ONLIGHT, fit: c.fit, source: src, pad: size >= 48 ? 1 : 0 }), size);
            const dark = dataUrl(rasterize(artSvg, size, size,
                { ink: INK_ONDARK, accent: ACCENT_ONDARK, fit: c.fit, source: src, pad: size >= 48 ? 1 : 0 }), size);
            return { size, light, dark };
        });
        return { c, cells };
    });

    // ENTREGADO: los PNG reales que acabara usando la extension en el toolbar
    const delivered = SIZES.map((size) => ({
        size,
        onlight: rawDataUrl(`Media/SQAtoolbar-onlight-${size}.png`),
        ondark: rawDataUrl(`Media/SQAtoolbar-ondark-${size}.png`)
    })).filter((d) => d.onlight && d.ondark);

    // TILES: lo que usa manifest.icons. Se prueba sobre fondo claro Y oscuro,
    // que es justo lo que un glifo transparente no puede resolver.
    const tiles = SIZES.map((size) => ({
        size,
        navy: rawDataUrl(`Media/SQAicon-${size}.png`),
        orange: rawDataUrl(`Media/SQAicon-orange-${size}.png`)
    })).filter((t) => t.navy && t.orange);

    // Referencia: los archivos reales que hay hoy en Media/
    const currentRef = ['SQA-16.png', 'SQA-32.png', 'SQA-48.png', 'SQA-128.png'];
    const currentCells = currentRef.map((f) => ({
        size: Number(f.match(/(\d+)\.png/)[1]),
        light: alphaOnlyDataUrl('Media/' + f, INK_ONLIGHT)
    }));

    const html = `<!doctype html><html lang="es"><meta charset="utf-8">
<title>Encuadre del icono del toolbar</title>
<style>
  body{font:13px/1.5 "Segoe UI",sans-serif;background:#fafbfc;color:#16324f;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 8px}
  .sub{color:#5a6b7d;margin:0 0 18px}
  table{border-collapse:collapse;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:8px;overflow:hidden}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #e6ebf0;vertical-align:middle}
  th{background:#003060;color:#fff;font-weight:600;font-size:12px}
  td.size{font-variant-numeric:tabular-nums;color:#5a6b7d;width:56px}
  .strip{display:inline-flex;align-items:center;justify-content:center;border-radius:6px;padding:6px}
  .onlight{background:#f1f3f4}.ondark{background:#202124}
  .note{color:#5a6b7d;font-size:12px}
  .pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:#ffe8cc;color:#8a4b00;margin-left:6px}
  .bad{background:#ffd9d9;color:#8a0000}
  .ok{background:#d8f5e3;color:#0a5c2e}
</style>
<h1>Icono del toolbar: eleccion de encuadre</h1>
<p class="sub">El SVG es un wordmark de 245x133. El slot del toolbar de Chrome es <b>cuadrado</b>, y Chrome <b>no acepta SVG</b> en el icono: hay que rasterizar. Estas son las opciones, renderizadas a partir de <code>Media/Logo_SQA.svg</code>.</p>

${delivered.length ? `<h2>ENTREGADO en Media/ (esto es lo que usara el toolbar)</h2>
<table>
<tr><th>Archivo</th><th>Tamano</th><th>Toolbar claro (#f1f3f4)</th><th>Toolbar oscuro (#202124)</th></tr>
${delivered.map((d) => `<tr><td>SQAtoolbar-onlight|ondark-${d.size}.png</td><td class="size">${d.size}px</td>
  <td><span class="strip onlight"><img src="${d.onlight}" width="${d.size}" height="${d.size}"></span></td>
  <td><span class="strip ondark"><img src="${d.ondark}" width="${d.size}" height="${d.size}"></span></td></tr>`).join('')}
</table>` : ''}

${tiles.length ? `<h2>Icono del manifest (tile): se lee en claro Y en oscuro</h2>
<p class="note">Esto es lo que muestra la pagina de extensiones y el dialogo de instalacion. Como ese icono es estatico, el tile de color es la unica forma de que no quede invisible en un tema.</p>
<table>
<tr><th>Variante</th><th>Tamano</th><th>Sobre fondo claro</th><th>Sobre fondo oscuro</th></tr>
${tiles.map((t) => `<tr><td><b>SQAicon-${t.size}.png</b><br><span class="note">tile navy, glifo blanco</span></td><td class="size">${t.size}px</td>
  <td><span class="strip onlight"><img src="${t.navy}" width="${t.size}" height="${t.size}"></span></td>
  <td><span class="strip ondark"><img src="${t.navy}" width="${t.size}" height="${t.size}"></span></td></tr>
<tr><td><b>SQAicon-orange-${t.size}.png</b><br><span class="note">tile naranja, glifo navy (alternativa)</span></td><td class="size">${t.size}px</td>
  <td><span class="strip onlight"><img src="${t.orange}" width="${t.size}" height="${t.size}"></span></td>
  <td><span class="strip ondark"><img src="${t.orange}" width="${t.size}" height="${t.size}"></span></td></tr>`).join('')}
</table>` : ''}

<h2>Opciones evaluadas</h2>
<table>
<tr><th>Encuadre</th><th>Tamano</th><th>Toolbar claro (#f1f3f4)</th><th>Toolbar oscuro (#202124)</th><th>Nota</th></tr>
${rows.map(({ c, cells }) => cells.map((cell, i) => `<tr>
  ${i === 0 ? `<td rowspan="${cells.length}"><b>${c.id}</b><br><span class="note">${c.label}</span></td>` : ''}
  <td class="size">${cell.size}px</td>
  <td><span class="strip onlight"><img src="${cell.light}" width="${cell.size}" height="${cell.size}"></span></td>
  <td><span class="strip ondark"><img src="${cell.dark}" width="${cell.size}" height="${cell.size}"></span></td>
  ${i === 0 ? `<td rowspan="${cells.length}" class="note">${c.note}</td>` : ''}
</tr>`).join('')).join('')}
</table>

<h2>Referencia: lo que hay hoy en Media/</h2>
<table>
<tr><th>Archivo</th><th>Tamano</th><th>Glifo oscuro</th></tr>
${currentCells.map((c) => `<tr><td>${`SQA-${c.size}.png`}</td><td class="size">${c.size}px</td>
  <td><span class="strip onlight"><img src="${c.light}" width="${c.size}" height="${c.size}"></span></td></tr>`).join('')}
</table>
<p class="note">Los <code>SQA-*</code> actuales son el wordmark estirado (IoU 77-95% contra la hipotesis "stretch", 28-33% contra "contain").<br>
Y <code>Media/SQA1-32.png</code> no es cuadrado: mide 274x115 (un banner), por eso el slot de 32 px sale deformado.</p>
</html>`;

    const outFile = path.join(outDir, 'index.html');
    fs.writeFileSync(outFile, html);
    console.log(`\nHoja generada: ${path.relative(ROOT, outFile)}`);
    console.log('Candidatos: ' + CANDIDATES.map((c) => c.id).join(', '));
}

/** Re-codifica un PNG RGBA existente tal cual (para previsualizar bytes reales). */
function rawDataUrl(file) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) return null;
    const d = decodePng(abs);
    if (d.ct !== 6) return null;
    return 'data:image/png;base64,' + encodePng(d.out, d.w, d.h).toString('base64');
}

/** Redibuja un PNG existente con un tinte uniforme, conservando su alfa. */
function alphaOnlyDataUrl(file, ink) {
    const d = decodePng(path.join(ROOT, file));
    const rgba = Buffer.alloc(d.w * d.h * 4);
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
        const a = alphaAt(d, x, y);
        if (!a) continue;
        const i = (y * d.w + x) * 4;
        rgba[i] = ink[0]; rgba[i + 1] = ink[1]; rgba[i + 2] = ink[2]; rgba[i + 3] = a;
    }
    return 'data:image/png;base64,' + encodePng(rgba, d.w, d.h).toString('base64');
}

// La invocación va al final del archivo: main() depende de los const de arriba.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-icons.mjs')) {
    main();
}
