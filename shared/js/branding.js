/**
 * branding.js - turn an event's two brand colours into a complete, accessible theme.
 *
 * applyBranding(event | branding) sets on <html> (or any scoped element):
 *   --brand, --brand-accent            the raw admin colours (decorative use: glows, aurora blobs)
 *   --brand-h, --tint-c                hue + tint chroma that colour the neutral surfaces (see tokens.css)
 *   --brand-solid-{d,l} ...            contrast-solved roles for dark (d) and light (l) themes, which tokens.css
 *                                      maps to --brand-solid / --on-brand / --brand-text / ... per data-theme
 * plus data-bg, <meta name=theme-color>, an SVG favicon tinted with the brand, and document.title.
 *
 * All contrast decisions are made here with real WCAG maths (color.js): any hex in => AA out.
 */
import {
  normalizeHex, hexToOklch, oklchToHex, contrast, readableOn, inkFor, nearestLightness, hueDelta, WHITE,
} from './color.js';
import { setEventDefaultTheme, onThemeChange, getResolvedTheme } from './theme.js';

/** Defaults = Gravitee orange. Same values as the static fallbacks in tokens.css. */
export const DEFAULT_BRANDING = Object.freeze({
  primary_color: '#FC5607',
  accent_color: '#FF9A52',
  background_style: 'aurora',
  logo_url: null,
  default_theme: 'dark',
});

/**
 * Lightness (OKLCH L) of the neutral surfaces. MUST stay in sync with tokens.css.
 * `textRef`/`solidRef` are the most demanding surfaces a brand colour can sit on.
 */
export const SURFACE_L = Object.freeze({
  dark: { bg: 0.155, raised: 0.205, overlay: 0.24, textRef: 0.345, solidRef: 0.24, muted: 0.83, soft: 0.92 },
  light: { bg: 0.975, raised: 1, overlay: 1, textRef: 0.89, solidRef: 0.955, muted: 0.42, soft: 0.3 },
});

const MIN_TEXT = 4.7;   // AA for normal text is 4.5; keep margin for hover/tint drift
const MIN_TEXT_PEAK = 4.65; // brand text over the brightest pixel of a glow: AA (4.5) plus rounding margin
const MIN_UI = 3.1;     // WCAG 1.4.11 non-text contrast is 3
const MIN_LABEL = 4.7;  // label on a solid fill

/**
 * Hue / chroma / start lightness of the status colours. green + red map to the physical buzzers, so they stay
 * recognisably green/red: `nudge` is the max degrees they may drift toward the brand hue (harmony, not identity).
 */
const STATUS = {
  green: { h: 148, c: 0.19, l: { dark: 0.76, light: 0.64 }, prefer: 'ink', nudge: 8 },
  red: { h: 26, c: 0.21, l: { dark: 0.60, light: 0.56 }, prefer: 'white', nudge: 4 },
  amber: { h: 85, c: 0.16, l: { dark: 0.84, light: 0.72 }, prefer: 'ink', nudge: 0 },
  blue: { h: 255, c: 0.15, l: { dark: 0.72, light: 0.56 }, prefer: null, nudge: 0 },
};

/** Complementary-ish accent when the admin only picked a primary colour. */
export function deriveAccent(primaryHex) {
  const p = hexToOklch(normalizeHex(primaryHex, DEFAULT_BRANDING.primary_color));
  return oklchToHex({ l: Math.min(0.88, p.l + 0.14), c: p.c * 0.9, h: (p.h + 28) % 360 });
}

/** Alpha-blend `top` over `bottom` in sRGB space (what the compositor does). */
function blendHex(bottom, top, alpha) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [b, t] = [p(bottom), p(top)];
  return `#${b.map((v, i) => Math.round(v + (t[i] - v) * alpha).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function refs(theme, h, tintC) {
  const s = SURFACE_L[theme];
  const tint = theme === 'dark' ? tintC : tintC * 0.5;
  return {
    text: oklchToHex({ l: s.textRef, c: tint, h }),
    solid: oklchToHex({ l: s.solidRef, c: tint, h }),
  };
}

/** Solve a filled role (button / switch / badge fill) for a theme: UI contrast vs surface + readable label. */
function solveSolid(start, theme, ref, { prefer = null, ink }) {
  const labelRatio = (hex) => (prefer === 'white' ? contrast(hex, WHITE) : prefer === 'ink' ? contrast(hex, ink) : readableOn(hex, { ink }).ratio);
  const ok = (hex) => contrast(hex, ref) >= MIN_UI && labelRatio(hex) >= MIN_LABEL;
  let hex = nearestLightness(start, ok, theme === 'dark' ? 'lighter' : 'darker');
  let want = prefer;
  if (!hex && prefer) { // preferred label impossible with this hue: let the label colour float
    want = null;
    hex = nearestLightness(start, (h) => contrast(h, ref) >= MIN_UI && readableOn(h, { ink }).ratio >= MIN_LABEL, theme === 'dark' ? 'lighter' : 'darker');
  }
  hex = hex || (theme === 'dark' ? '#E6E6EE' : '#2B2B35');
  const on = want === 'white' ? WHITE : want === 'ink' ? ink : readableOn(hex, { ink }).color;
  const o = hexToOklch(hex);
  const away = on === WHITE ? -0.045 : 0.045; // hover moves away from the label colour: contrast only improves
  const hover = oklchToHex({ l: o.l + away, c: o.c, h: o.h });
  return { solid: hex, hover, on };
}

/** Solve a text-on-surface role: >= MIN_TEXT against the most demanding surface of the theme. */
function solveText(start, theme, ref) {
  const hex = nearestLightness(start, (h) => contrast(h, ref) >= MIN_TEXT, theme === 'dark' ? 'lighter' : 'darker');
  return hex || (theme === 'dark' ? '#F2F2F7' : '#17171F');
}

function solveRoles(startHex, theme, h, tintC, ink, prefer = null) {
  const start = hexToOklch(startHex);
  const r = refs(theme, h, tintC);
  const s = solveSolid(start, theme, r.solid, { prefer, ink });
  return { ...s, text: solveText(start, theme, r.text) };
}

/**
 * Pure: compute every brand-derived token for any pair of colours.
 * @param {string} primary '#RRGGBB' (anything invalid falls back to Gravitee orange)
 * @param {string} [accent] '#RRGGBB' (derived from primary when omitted/invalid)
 * @returns {{brand:string, accent:string, hue:number, tintC:number, vars:Record<string,string>, scopedVars:Record<string,string>, themeColor:{dark:string,light:string}}}
 */
export function computeBrandTokens(primary, accent) {
  const brand = normalizeHex(primary, DEFAULT_BRANDING.primary_color);
  const acc = normalizeHex(accent, null) || deriveAccent(brand);
  const b = hexToOklch(brand);
  const hue = b.c < 0.02 ? 250 : b.h; // grey / black / white brands: keep a neutral cool tint
  const tintC = Math.min(0.02, Math.max(0.004, Math.min(b.c, 0.12) * 0.14));
  const ink = inkFor(hue);

  const scoped = {};
  const vars = {};
  const put = (name, dark, light, target = vars) => { target[`--${name}-d`] = dark; target[`--${name}-l`] = light; };

  for (const [startHex, tokenName, onName] of [[brand, 'brand', 'on-brand'], [acc, 'accent', 'on-accent']]) {
    const d = solveRoles(startHex, 'dark', hue, tintC, ink);
    const l = solveRoles(startHex, 'light', hue, tintC, ink);
    put(`${tokenName}-solid`, d.solid, l.solid, scoped);
    put(`${tokenName}-solid-hover`, d.hover, l.hover, scoped);
    put(onName, d.on, l.on, scoped);
    put(`${tokenName}-text`, d.text, l.text, scoped);
  }

  const inkNeutral = ink;
  for (const [name, spec] of Object.entries(STATUS)) {
    const delta = spec.nudge && b.c >= 0.04 ? Math.max(-spec.nudge, Math.min(spec.nudge, hueDelta(spec.h, b.h) * 0.15)) : 0;
    const h = spec.h + delta;
    const mk = (theme) => {
      const start = { l: spec.l[theme], c: spec.c, h };
      const startHex = oklchToHex(start);
      const r = refs(theme, hue, tintC);
      const s = solveSolid(hexToOklch(startHex), theme, r.solid, { prefer: spec.prefer, ink: inkNeutral });
      return { ...s, text: solveText(hexToOklch(startHex), theme, r.text) };
    };
    const d = mk('dark'), l = mk('light');
    put(name, d.solid, l.solid);
    put(`${name}-hover`, d.hover, l.hover);
    put(`on-${name}`, d.on, l.on);
    put(`${name}-text`, d.text, l.text);
  }

  // Aurora + hero bloom strength: glows must never get bright enough to hurt text that sits directly on the page background.
  // The page aurora keeps fg-muted AA over its brightest pixel (blobs overlapping by up to 35%); the hero bloom is a single
  // stronger blob behind the hero, whose text uses fg / fg-soft. fg-subtle is meant for cards and inputs only.
  const glow = (theme, textL, textC, overlap, extra = []) => {
    const k = theme === 'dark' ? 'd' : 'l';
    const S = SURFACE_L[theme];
    const bg = oklchToHex({ l: S.bg, c: theme === 'dark' ? tintC : tintC * 0.5, h: hue });
    const text = oklchToHex({ l: textL, c: textC, h: hue });
    const solids = [scoped[`--brand-solid-${k}`], scoped[`--accent-solid-${k}`]];
    const ok = (a) => solids.every((c) => contrast(text, blendHex(bg, c, Math.min(1, a * overlap))) >= MIN_TEXT
      && extra.every((t) => contrast(t, blendHex(bg, c, a)) >= MIN_TEXT_PEAK));
    let lo = 0, hi = 0.8;
    for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    return `${Math.round(Math.min(theme === 'dark' ? 0.6 : 0.5, Math.max(0.1, lo)) * 100)}%`;
  };
  // brand / accent coloured text (links, eyebrows) must also survive the brightest single glow (>= 4.5)
  const brandTexts = (k) => [scoped[`--brand-text-${k}`], scoped[`--accent-text-${k}`]];
  put('aurora-strength', glow('dark', SURFACE_L.dark.muted, 0.012, 1.35, brandTexts('d')), glow('light', SURFACE_L.light.muted, 0.02, 1.35, brandTexts('l')));
  put('bloom-strength', glow('dark', SURFACE_L.dark.soft, 0.008, 1), glow('light', SURFACE_L.light.soft, 0.02, 1));

  const themeColor = {
    dark: oklchToHex({ l: SURFACE_L.dark.bg, c: tintC, h: hue }),
    light: oklchToHex({ l: SURFACE_L.light.bg, c: tintC * 0.5, h: hue }),
  };
  return {
    brand, accent: acc, hue, tintC,
    vars: { ...scoped, ...vars },
    scopedVars: scoped,
    themeColor,
  };
}

// ----------------------------------------------------------------------------------------------
// DOM side
// ----------------------------------------------------------------------------------------------
const MARK_PATH = 'M234.539 0C105.007 0.00197474 0.00124218 104.99 0 234.499C-1.16182e-05 364.01 105.005 469 234.54 469L341.58 469V354.155H491L378.608 222.981H228.447L340.729 354.029L234.54 354.029C168.514 354.029 114.993 300.515 114.991 234.501C114.991 168.488 168.515 114.973 234.54 114.971C267.35 114.972 297.054 128.17 318.669 149.576L328.148 158.963L408.435 76.5927L399.049 67.3571C356.729 25.7155 298.623 0.00099608 234.539 0Z';

/** SVG favicon: rounded square in the brand colour + Gravitee mark in a readable colour. */
export function faviconDataUrl(brandHex) {
  const fill = normalizeHex(brandHex, DEFAULT_BRANDING.primary_color);
  const mark = readableOn(fill, { ink: inkFor(hexToOklch(fill).h) }).color;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="${fill}"/><path transform="translate(110 118) scale(.6)" d="${MARK_PATH}" fill="${mark}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let last = null;     // last document-level result
let themeHooked = false;

function setMeta(name, content) {
  let m = document.head.querySelector(`meta[name="${name}"]`);
  if (!m) { m = document.createElement('meta'); m.setAttribute('name', name); document.head.append(m); }
  m.setAttribute('content', content);
}
function setFavicon(href) {
  let l = document.head.querySelector('link#quiz-favicon') || document.head.querySelector('link[rel="icon"]');
  if (!l) { l = document.createElement('link'); l.setAttribute('rel', 'icon'); document.head.append(l); }
  l.id = 'quiz-favicon';
  l.setAttribute('type', 'image/svg+xml');
  l.removeAttribute('sizes');
  l.setAttribute('href', href);
  document.head.querySelectorAll('link[rel="apple-touch-icon"], link[rel="shortcut icon"]').forEach((n) => n.remove());
}

function syncThemeColor() {
  if (!last) return;
  setMeta('theme-color', last.themeColor[getResolvedTheme()] ?? last.themeColor.dark);
}

/**
 * Build the page title "{game_title} · {event name}" (+ optional page prefix) and set document.title.
 * @param {{game_title?:string,name?:string}|string|null} eventOrTitle event object or plain title
 * @param {string} [page] e.g. "Scoreboard" -> "Scoreboard · AI Masters · World AI Summit"
 * @returns {string}
 */
export function setDocumentTitle(eventOrTitle, page) {
  let base;
  if (typeof eventOrTitle === 'string') base = eventOrTitle;
  else if (eventOrTitle) {
    const g = eventOrTitle.game_title, n = eventOrTitle.name;
    base = g && n && g !== n ? `${g} · ${n}` : g || n || 'Gravitee Quiz';
  } else base = 'Gravitee Quiz';
  const title = page ? `${page} · ${base}` : base;
  document.title = title;
  return title;
}

/**
 * Apply an event's branding.
 *
 * @param {object|null} input an event ({branding, game_title, name}) or a bare branding object
 *                           ({primary_color, accent_color, background_style, default_theme}); null/undefined = defaults
 * @param {object}  [opts]
 * @param {HTMLElement} [opts.root=document.documentElement] scope. A non-root element only receives the brand
 *                      variables (use it for hub cards that show another event's colours).
 * @param {boolean} [opts.title=true] update document.title when `input` is an event (document root only)
 * @param {string}  [opts.page] page prefix for the title, see setDocumentTitle
 * @returns {ReturnType<typeof computeBrandTokens> & {branding: object}}
 */
export function applyBranding(input, { root = document.documentElement, title = true, page } = {}) {
  const isEvent = !!input && typeof input === 'object' && ('branding' in input || 'game_title' in input || 'slug' in input);
  const raw = (isEvent ? input.branding : input) || {};
  const branding = {
    ...DEFAULT_BRANDING,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && v !== '')),
    logo_url: raw.logo_url ?? null,
  };
  const tokens = computeBrandTokens(branding.primary_color, branding.accent_color);
  const isDoc = root === document.documentElement;

  const set = (k, v) => root.style.setProperty(k, v);
  set('--brand', tokens.brand);
  set('--brand-accent', tokens.accent);
  if (isDoc) {
    set('--brand-h', String(Math.round(tokens.hue * 10) / 10));
    set('--tint-c', String(Math.round(tokens.tintC * 1000) / 1000));
    for (const [k, v] of Object.entries(tokens.vars)) set(k, v);
    const bg = ['aurora', 'grid', 'plain'].includes(branding.background_style) ? branding.background_style : 'aurora';
    root.setAttribute('data-bg', bg);
    last = tokens;
    setFavicon(faviconDataUrl(tokens.brand));
    if (!themeHooked) { themeHooked = true; onThemeChange(syncThemeColor); }
    if (isEvent && title) setDocumentTitle(input, page);
    setEventDefaultTheme(branding.default_theme);
    syncThemeColor();
  } else {
    root.setAttribute('data-brand-scope', '');
    for (const [k, v] of Object.entries(tokens.scopedVars)) set(k, v);
  }
  return { ...tokens, branding };
}

/** Back to the Gravitee defaults (e.g. on the hub page). */
export function resetBranding(opts) {
  return applyBranding(null, opts);
}

/** Last computed document-level tokens (or null before applyBranding). */
export function getBrandTokens() { return last; }
