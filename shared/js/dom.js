/**
 * dom.js - tiny DOM toolkit: element builder with SAFE text, icons from the sprite, formatters and helpers.
 * No dependencies. Never uses innerHTML: strings are always text nodes.
 */

/** Absolute URL of the icon sprite, resolved from this module so it works at /shared/ and /admin/shared/. */
export const SPRITE_URL = new URL('../icons/sprite.svg', import.meta.url).href;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'use', 'symbol', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'text', 'tspan', 'title']);

const currentLang = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en';

// ---------------------------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------------------------
/** querySelector shortcut. @returns {HTMLElement|null} */
export const qs = (selector, root = document) => root.querySelector(selector);
/** querySelectorAll as a real array. */
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// ---------------------------------------------------------------------------------------------
// element builder
// ---------------------------------------------------------------------------------------------
function cls(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(cls).filter(Boolean).join(' ');
  return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ');
}

function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.append(child);
    else parent.append(document.createTextNode(String(child)));
  }
}

/**
 * Create an element. Strings/numbers become text nodes (no HTML injection possible).
 *
 * @param {string} tag  'div', 'button', 'svg', ... (SVG tags get the SVG namespace)
 * @param {object|null} [attrs]
 *   class / className  string | array | {name: bool}
 *   style              {color:'red', '--value': 50}  (custom properties allowed, CSP friendly)
 *   dataset            {id: 3} -> data-id="3"
 *   aria               {label:'Close', hidden:true} -> aria-label, aria-hidden
 *   on                 {click: fn, input: fn}   or   onclick / onClick: fn
 *   text               shortcut for textContent
 *   anything else      attribute; true -> "", false/null/undefined -> omitted. `value`, `checked`, `disabled`, `hidden` are set as properties.
 * @param {...(Node|string|number|null|false|Array)} children
 * @returns {HTMLElement|SVGElement}
 * @example el('button', {class: 'btn btn--primary', on: {click: save}}, icon('check'), 'Save')
 */
export function el(tag, attrs, ...children) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs); attrs = null; // el('p', 'text')
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.setAttribute('class', cls(value));
    else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        k.startsWith('--') ? node.style.setProperty(k, String(v)) : (node.style[k] = v);
      }
    } else if (key === 'dataset') Object.entries(value).forEach(([k, v]) => { if (v !== null && v !== undefined) node.dataset[k] = String(v); });
    else if (key === 'aria') Object.entries(value).forEach(([k, v]) => { if (v !== null && v !== undefined) node.setAttribute(`aria-${k}`, String(v)); });
    else if (key === 'on' && typeof value === 'object') Object.entries(value).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'text') node.textContent = String(value);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate'].includes(key) && !(node instanceof SVGElement)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(node, children);
  return node;
}

/** Remove all children. @returns the node */
export function clear(node) { node.replaceChildren(); return node; }

/** addEventListener that returns an unsubscribe function. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Delegated listener: delegate(list, 'click', '[data-id]', (e, matchedEl) => ...). Returns unsubscribe. */
export function delegate(root, type, selector, handler, options) {
  const listener = (e) => {
    const match = e.target instanceof Element ? e.target.closest(selector) : null;
    if (match && root.contains(match)) handler(e, match);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

// ---------------------------------------------------------------------------------------------
// icons
// ---------------------------------------------------------------------------------------------
/**
 * SVG icon from the sprite (Phosphor). Decorative by default (aria-hidden); pass `label` to make it meaningful.
 * @param {string} name   sprite id, e.g. 'trophy', 'check-circle', 'trophy-fill' (see README for the full list)
 * @param {{size?: 'xs'|'sm'|'lg'|'xl'|'2xl'|number|string, label?: string, class?: string, spin?: boolean}} [opts]
 *        size: a preset, a number (px) or any CSS length
 * @returns {SVGSVGElement}
 */
export function icon(name, { size, label, class: extra, spin } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const classes = ['icon'];
  if (size && ['xs', 'sm', 'lg', 'xl', '2xl'].includes(size)) classes.push(`icon--${size}`);
  else if (size !== undefined && size !== null) svg.style.setProperty('--icon-size', typeof size === 'number' ? `${size}px` : String(size));
  if (spin) classes.push('icon--spin');
  if (extra) classes.push(extra);
  svg.setAttribute('class', classes.join(' '));
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${SPRITE_URL}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Fill static markup: every element with data-icon="name" receives the svg (optional data-icon-size, data-icon-label).
 *   <span data-icon="trophy" data-icon-size="lg"></span>
 */
export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll('[data-icon]')) {
    if (host.querySelector(':scope > svg.icon')) continue;
    host.prepend(icon(host.dataset.icon, { size: host.dataset.iconSize, label: host.dataset.iconLabel }));
  }
}

// ---------------------------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------------------------
/** Escape &, <, >, ", ' (for the rare case you must build an HTML string). */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 'Jean-Pierre Dupont' -> 'JD', 'alex' -> 'A'. Unicode aware. */
export function initials(name, max = 2) {
  const words = String(name ?? '').trim().split(/[\s ]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = (w) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '';
  const letters = words.length === 1 ? [first(words[0])] : [first(words[0]), first(words[words.length - 1])];
  return letters.join('').slice(0, max).toUpperCase() || '?';
}

/** Stable 0..359 hue from a string (for avatars). */
export function avatarHue(seed) {
  let h = 2166136261;
  for (const ch of String(seed ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 360;
}

/** Avatar element: <span class="avatar" style="--hue: …">AB</span>. */
export function avatar(name, { size, class: extra } = {}) {
  return el('span', { class: ['avatar', size && `avatar--${size}`, extra], style: { '--hue': avatarHue(name) }, 'aria-hidden': 'true' }, initials(name));
}

/** URL-safe slug: 'World AI Summit – Amsterdam 2026' -> 'world-ai-summit-amsterdam-2026'. */
export function slugify(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 48).replace(/-+$/, '');
}

// ---------------------------------------------------------------------------------------------
// formatting (Intl)
// ---------------------------------------------------------------------------------------------
/** 1234.5 -> '1,234.5' (en) / '1 234,5' (fr). */
export function formatNumber(n, { lang = currentLang(), ...opts } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return new Intl.NumberFormat(lang, opts).format(n);
}
/** 0.756 -> '76%'. */
export function formatPercent(ratio, { lang = currentLang(), digits = 0 } = {}) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '–';
  return new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: digits }).format(ratio);
}
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** English dates are day-first ("7 Oct 2026", 24 h clock): the events are European. Everything else uses its own locale. */
const dateLocale = (lang) => (lang === 'en' ? 'en-GB' : lang);
/** '2026-10-07' (no time: event starts_on / ends_on) is a calendar day, not an instant: never shift it with the viewer's time zone. */
const dayOnly = (value) => (typeof value === 'string' && DATE_ONLY.test(value) ? { timeZone: 'UTC' } : {});
/** Date or ISO string -> '7 Oct 2026' (en) / '7 oct. 2026' (fr). Date-only strings keep their calendar day in every time zone. */
export function formatDate(value, { lang = currentLang(), ...opts } = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short', year: 'numeric', ...dayOnly(value), ...opts }).format(d);
}
/** Date or ISO string -> '7 Oct 2026, 14:32'. */
export function formatDateTime(value, { lang = currentLang(), ...opts } = {}) {
  return formatDate(value, { lang, hour: '2-digit', minute: '2-digit', ...opts });
}
/** Two dates -> '7 Oct 2026' (same day) / '7–8 Oct 2026' / '30 Sep – 2 Oct 2026'. Either may be empty. */
export function formatDateRange(a, b, { lang = currentLang() } = {}) {
  if (!a && !b) return '';
  if (!a || !b || a === b) return formatDate(a || b, { lang });
  const f = new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short', year: 'numeric', ...dayOnly(a) });
  const [da, db] = [a, b].map((v) => (v instanceof Date ? v : new Date(v)));
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return formatDate(a, { lang }) || formatDate(b, { lang });
  return typeof f.formatRange === 'function' ? f.formatRange(da, db) : `${formatDate(a, { lang })} – ${formatDate(b, { lang })}`;
}
/** Seconds -> '1:05' (or '1:02:03'). */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
/** 1536 -> '1.5 KB'. */
export function formatBytes(bytes, { lang = currentLang() } = {}) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Math.max(0, bytes || 0), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`;
}
/** Date -> 'in 3 hours' / 'il y a 2 jours'. */
export function relativeTime(value, lang = currentLang(), now = Date.now()) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (t - now) / 1000;
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  for (const [unit, secs] of steps) if (Math.abs(diff) >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  return '';
}

// ---------------------------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------------------------
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let uidCounter = 0;
/** Unique DOM-safe id: uid('field') -> 'field-1'. */
export const uid = (prefix = 'id') => `${prefix}-${++uidCounter}`;

/** Debounce: returns a function with .cancel() and .flush(). */
export function debounce(fn, wait = 250) {
  let timer = null, lastArgs = null, lastThis = null;
  const debounced = function (...args) {
    lastArgs = args; lastThis = this;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(lastThis, lastArgs); }, wait);
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; };
  debounced.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn.apply(lastThis, lastArgs); } };
  return debounced;
}

/** Throttle (leading + trailing). */
export function throttle(fn, wait = 100) {
  let last = 0, timer = null, lastArgs = null;
  return function (...args) {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= wait) { last = now; fn.apply(this, args); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, lastArgs); }, wait - (now - last));
  };
}

/** Copy text. Uses the async clipboard API, falls back to execCommand (http, old browsers). @returns {Promise<boolean>} */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = el('textarea', { value: text, readonly: '', 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Save a Blob (or string) as a file download. */
export function downloadBlob(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

/** Toggle a button's loading state (spinner + aria-busy + disabled). */
export function setBusy(button, busy = true) {
  button.classList.toggle('is-loading', busy);
  if (busy) { button.setAttribute('aria-busy', 'true'); button.disabled = true; } else { button.removeAttribute('aria-busy'); button.disabled = false; }
  return button;
}

/** Plain object from a <form> ({name: value}); checkboxes become booleans, numbers stay strings. */
export function formToObject(form) {
  const out = {};
  for (const field of form.elements) {
    if (!field.name || field.disabled) continue;
    if (field.type === 'checkbox') out[field.name] = field.checked;
    else if (field.type === 'radio') { if (field.checked) out[field.name] = field.value; }
    else out[field.name] = field.value;
  }
  return out;
}

/** true when the user asked for less motion. */
export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** true on touch-first devices (no hover). */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
