/**
 * qr.js - render a QR code as an inline SVG (no canvas, crisp at any size, prints well).
 * Uses the vendored qrcode-generator (MIT, ../vendor/qrcode.js). UTF-8 safe.
 */
import qrcode from '../vendor/qrcode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const utf8 = (s) => Array.from(new TextEncoder().encode(s));
qrcode.stringToBytes = utf8; // default encoder only handles ISO-8859-1

/** @returns {{count:number, isDark:(r:number,c:number)=>boolean}} */
function matrix(text, ecc) {
  const qr = qrcode(0, ecc); // typeNumber 0 = smallest version that fits
  qr.addData(text, 'Byte');
  qr.make();
  return { count: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) };
}

/**
 * QR code as an SVG element. Dark modules use `fg`, the quiet zone `bg` (keep dark-on-light: scanners need it).
 * @param {string} text  content to encode (URL, ...)
 * @param {{ecc?:'L'|'M'|'Q'|'H', margin?:number, fg?:string, bg?:string, label?:string}} [opts]
 *        margin = quiet zone in modules (default 2, 4 is the spec but 2 scans fine on screens)
 * @returns {SVGSVGElement} width/height 100% (size it with CSS / the .qr wrapper)
 */
export function qrSvg(text, { ecc = 'M', margin = 2, fg = '#000000', bg = '#FFFFFF', label } = {}) {
  const { count, isDark } = matrix(String(text), ecc);
  const size = count + margin * 2;
  let d = '';
  for (let r = 0; r < count; r++) { // merge horizontal runs: much smaller path
    let c = 0;
    while (c < count) {
      if (!isDark(r, c)) { c++; continue; }
      const start = c;
      while (c < count && isDark(r, c)) c++;
      d += `M${start + margin} ${r + margin}h${c - start}v1h-${c - start}z`;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label || `QR code: ${text}`);
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', String(size)); rect.setAttribute('height', String(size)); rect.setAttribute('fill', bg);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', fg);
  svg.append(rect, path);
  return svg;
}

/**
 * QR wrapped in the styled `.qr` card (white padded tile with shadow). Size it with --qr-size (CSS) or `size`.
 * @param {string} text
 * @param {Parameters<typeof qrSvg>[1] & {size?: string|number, large?: boolean}} [opts] size: CSS length or px number
 * @returns {HTMLDivElement}
 */
export function qrCode(text, { size, large, ...opts } = {}) {
  const wrap = document.createElement('div');
  wrap.className = large ? 'qr qr--lg' : 'qr';
  if (size) wrap.style.setProperty('--qr-size', typeof size === 'number' ? `${size}px` : size);
  wrap.append(qrSvg(text, opts));
  return wrap;
}

/** Replace the children of `container` with a QR tile. @returns {HTMLDivElement} the tile */
export function renderQr(container, text, opts) {
  const tile = qrCode(text, opts);
  container.replaceChildren(tile);
  return tile;
}
