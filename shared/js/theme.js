/**
 * theme.js - dark / light / system theme with a per-event default.
 *
 * Rules: the user's explicit choice (localStorage "quiz.theme") always wins. The event default
 * (branding.default_theme, applied by applyBranding) is used only while the user has not chosen.
 * Sets <html data-theme="dark|light"> (always the RESOLVED value) and color-scheme via CSS.
 */
const KEY = 'quiz.theme';
const MODES = ['system', 'light', 'dark'];
const listeners = new Set();
let eventDefault = 'dark';
let override = null;   // non-persisted choice (setTheme(mode, {persist:false}), e.g. from ?theme=)
let started = false;
let mql = null;

let memory = null;     // the user's choice kept in memory too: private windows / blocked storage must still honour a click on the toggle
const store = {
  /** stored value, null when absent, undefined when storage is unavailable */
  get() { try { return localStorage.getItem(KEY); } catch { return undefined; } },
  set(v) { memory = v ?? null; try { v == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch { /* storage blocked: memory only */ } },
};
const valid = (m) => MODES.includes(m);

/** The user's explicit choice, or null. */
export function getUserTheme() { const v = store.get(); if (v === undefined) return valid(memory) ? memory : null; return valid(v) ? v : null; }
/** True when the user explicitly picked a theme (so the event default is ignored). */
export function hasUserChoice() { return getUserTheme() !== null; }
/** Effective preference: 'system' | 'light' | 'dark' (session override, else user choice, else event default). */
export function getTheme() { return override || getUserTheme() || eventDefault; }
/** Effective rendered theme: 'light' | 'dark'. */
export function getResolvedTheme() {
  const pref = getTheme();
  if (pref === 'system') return (mql ?? (mql = window.matchMedia?.('(prefers-color-scheme: dark)')))?.matches === false ? 'light' : 'dark';
  return pref;
}

function apply() {
  const resolved = getResolvedTheme();
  document.documentElement.setAttribute('data-theme', resolved);
  const detail = { preference: getTheme(), resolved };
  listeners.forEach((cb) => { try { cb(detail); } catch (e) { console.error(e); } });
  return detail;
}

/** Subscribe to theme changes. cb({preference, resolved}). Returns an unsubscribe function. */
export function onThemeChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/**
 * Start theme handling (idempotent). Call once at boot.
 * @param {{defaultTheme?: 'dark'|'light'|'system'}} [opts] event default until the user chooses
 */
export function initTheme({ defaultTheme } = {}) {
  if (valid(defaultTheme)) eventDefault = defaultTheme;
  if (!started) {
    started = true;
    if (!override) { try { const q = new URLSearchParams(location.search).get('theme'); if (valid(q)) override = q; } catch { /* no location */ } }   // ?theme=light: this page load only
    mql = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    mql?.addEventListener?.('change', () => { if (getTheme() === 'system') apply(); });
    window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); }); // other tab changed it
  }
  return apply();
}

/**
 * Set the per-event default theme. Only takes effect while the user has not chosen.
 * (applyBranding(...) calls this with branding.default_theme.)
 */
export function setEventDefaultTheme(mode) {
  if (!valid(mode)) return getTheme();
  eventDefault = mode;
  if (!started) initTheme();
  else if (!hasUserChoice()) apply();
  return getTheme();
}

/**
 * Set the theme. `persist:true` (default) records it as the user's explicit choice.
 * `persist:false` applies it for this page load only (handy for ?theme=light on a TV).
 * Pass mode=null to forget the user's choice and fall back to the event default.
 */
export function setTheme(mode, { persist = true } = {}) {
  if (mode !== null && !valid(mode)) return getTheme();
  if (persist) { override = null; store.set(mode); } else override = mode;
  if (!started) initTheme();
  else apply();
  return getTheme();
}

/** system -> light -> dark -> system */
export function cycleTheme() {
  const next = MODES[(MODES.indexOf(getTheme()) + 1) % MODES.length];
  return setTheme(next);
}

const ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const svgNS = 'http://www.w3.org/2000/svg';
function themeIcon(name) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `${new URL('../icons/sprite.svg', import.meta.url).href}#${name}`);
  svg.append(use);
  return svg;
}

/**
 * Build a theme control.
 *  variant 'button'    -> single icon button cycling system/light/dark (header)
 *  variant 'segmented' -> 3-way segmented control (settings)
 * @param {{variant?:'button'|'segmented', labels?:{theme?:string,system?:string,light?:string,dark?:string}}} [opts]
 * @returns {HTMLElement}
 */
export function createThemeToggle({ variant = 'button', labels = {} } = {}) {
  const L = { theme: 'Theme', system: 'System', light: 'Light', dark: 'Dark', ...labels };
  if (variant === 'segmented') {
    const wrap = document.createElement('div');
    wrap.className = 'segmented';
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', L.theme);
    const name = `theme-${Math.random().toString(36).slice(2, 7)}`;
    for (const mode of MODES) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = name; input.value = mode; input.checked = getTheme() === mode;
      input.addEventListener('change', () => setTheme(mode));
      const span = document.createElement('span');
      span.append(themeIcon(ICON[mode]), document.createTextNode(L[mode]));
      label.append(input, span);
      wrap.append(label);
    }
    onThemeChange(({ preference }) => wrap.querySelectorAll('input').forEach((i) => { i.checked = i.value === preference; }));
    return wrap;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost btn--icon';
  const render = () => {
    const pref = getTheme();
    btn.replaceChildren(themeIcon(ICON[pref]));
    btn.setAttribute('aria-label', `${L.theme}: ${L[pref]}`);
    btn.title = `${L.theme}: ${L[pref]}`;
  };
  btn.addEventListener('click', () => cycleTheme());
  onThemeChange(render);
  render();
  return btn;
}
