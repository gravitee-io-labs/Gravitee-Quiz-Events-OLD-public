/**
 * color.js - sRGB / OKLab / OKLCH conversion + WCAG 2.x contrast. Pure functions, no DOM, no dependencies.
 * Used by branding.js to turn ANY admin-chosen brand colour into readable, harmonious tokens.
 * Runs in the browser and in Node (see tools/test-color.mjs).
 */

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** @param {string} input '#RGB' | '#RRGGBB' (with or without '#') @returns {{r:number,g:number,b:number}|null} */
export function parseHex(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

/** @returns {string} '#RRGGBB' uppercase */
export function toHex({ r, g, b }) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Returns a valid '#RRGGBB' (uppercase) or `fallback` when the input is not a colour. */
export function normalizeHex(input, fallback = null) {
  const rgb = parseHex(input);
  return rgb ? toHex(rgb) : fallback;
}

const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLinear = (x) => { x = clamp(x, 0, 1); return (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255; };

/** WCAG relative luminance, 0..1 */
export function luminance(hex) {
  const c = parseHex(hex);
  if (!c) return 0;
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio between two hex colours, 1..21 */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------- OKLab / OKLCH (Bjorn Ottosson) ----------
function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** @returns {{l:number,c:number,h:number}} l 0..1, c ~0..0.37, h 0..360 */
export function hexToOklch(hex) {
  const rgb = parseHex(hex) || { r: 0, g: 0, b: 0 };
  const [L, a, b] = linearToOklab(toLinear(rgb.r), toLinear(rgb.g), toLinear(rgb.b));
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h: c < 1e-4 ? 0 : h };
}

const oklchToLinear = ({ l, c, h }) => {
  const hr = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(hr), c * Math.sin(hr));
};
const inGamut = (rgb, eps = 1e-4) => rgb.every((v) => v >= -eps && v <= 1 + eps);

/** OKLCH -> '#RRGGBB'. Out-of-gamut colours are mapped by reducing chroma (hue and lightness preserved). */
export function oklchToHex({ l, c, h }) {
  l = clamp(l, 0, 1);
  c = Math.max(0, c);
  let rgb = oklchToLinear({ l, c, h });
  if (!inGamut(rgb)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h }))) lo = mid; else hi = mid;
    }
    rgb = oklchToLinear({ l, c: lo, h });
  }
  return toHex({ r: fromLinear(rgb[0]), g: fromLinear(rgb[1]), b: fromLinear(rgb[2]) });
}

/** Shortest signed angular distance from a to b, in degrees (-180..180). */
export function hueDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export const WHITE = '#FFFFFF';

/** Near-black text colour, faintly tinted with a hue so labels on brand fills feel intentional. */
export const inkFor = (h = 0) => oklchToHex({ l: 0.19, c: 0.03, h });

/**
 * Best text colour for a background: white or tinted ink, whichever has more contrast.
 * @param {string} bg hex
 * @param {{ink?:string,white?:string}} [opts]
 * @returns {{color:string, ratio:number}}
 */
export function readableOn(bg, { ink = '#0B0B10', white = WHITE } = {}) {
  const cw = contrast(bg, white), ci = contrast(bg, ink);
  return cw >= ci ? { color: white, ratio: cw } : { color: ink, ratio: ci };
}

/**
 * Finds the colour closest in lightness to `start` ({l,c,h}) that satisfies every constraint.
 * Search walks outward from start.l in 0.005 steps, trying the preferred direction first on ties.
 * @param {{l:number,c:number,h:number}} start
 * @param {(hex:string)=>boolean} ok predicate
 * @param {'lighter'|'darker'} prefer direction tried first
 * @returns {string|null} hex or null if nothing satisfies
 */
export function nearestLightness(start, ok, prefer = 'lighter') {
  const dir = prefer === 'lighter' ? 1 : -1;
  for (let d = 0; d <= 1.0001; d += 0.005) {
    const cands = d === 0 ? [0] : [dir * d, -dir * d];
    for (const dd of cands) {
      const l = start.l + dd;
      if (l < 0.02 || l > 0.99) continue;
      const hex = oklchToHex({ l, c: start.c, h: start.h });
      if (ok(hex)) return hex;
    }
  }
  return null;
}
