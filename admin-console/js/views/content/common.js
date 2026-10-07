/**
 * Helpers shared by the Questions and Categories views (content authoring).
 *
 * Everything here is UI plumbing: constants that mirror the backend rules (docs/ARCHITECTURE.md section 3 / 5.3),
 * a dialog helper with a "close guard", paging helpers and API error formatting. English only (admin console).
 */
import { el, icon, uid } from '../../../shared/js/dom.js';
import { ApiError } from '../../../shared/js/api.js';
import { confirmDialog } from '../../../shared/js/ui.js';

// ---------------------------------------------------------------------------------------------
// Constants mirroring the backend validation rules
// ---------------------------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  questionText: 2000,
  explanation: 4000,
  labelIdeal: 25,     // fits a giant answer button on a phone
  labelMax: 40,       // ARCHITECTURE section 6: two_choices labels are <= 40 chars
  name: 100,
  description: 2000,
  mediaUrl: 500,
});

export const DIFFICULTY = Object.freeze({ 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Level 4', 5: 'Level 5' });
export const FORMAT_LABEL = Object.freeze({ true_false: 'True / False', two_choices: 'Two choices' });
export const TRUE_FALSE_LABELS = Object.freeze({ green_label_en: 'TRUE', green_label_fr: 'Vrai', red_label_en: 'FALSE', red_label_fr: 'Faux' });

/** Preset category colours (the first eight are the ones the CSV import hands out). */
export const PALETTE = Object.freeze([
  ['#FC5607', 'Orange'], ['#7C5CFF', 'Violet'], ['#22D3EE', 'Cyan'], ['#10B981', 'Emerald'],
  ['#F59E0B', 'Amber'], ['#EC4899', 'Pink'], ['#3B82F6', 'Blue'], ['#84CC16', 'Lime'],
  ['#EF4444', 'Red'], ['#14B8A6', 'Teal'], ['#A855F7', 'Purple'], ['#64748B', 'Slate'],
]);

/**
 * Tiny hand-off between the two views (module state survives unmount/mount): the categories tab sets a
 * filter here, then navigates to the questions tab which consumes it once.
 */
export const handoff = { questionFilter: null };

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------
export const HEX_RE = /^#[0-9a-f]{6}$/i;
export const isHex = (v) => HEX_RE.test(String(v || '').trim());

/** '#abc' / 'ABC123' / '#ABC123' -> '#AABBCC' style full upper hex, or null when invalid. */
export function normalizeHex(value) {
  const h = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${[...h].map((c) => c + c).join('').toUpperCase()}`;
  if (/^[0-9a-f]{6}$/i.test(h)) return `#${h.toUpperCase()}`;
  return null;
}

/**
 * A colour that may go into a CSS custom property. Category / branding colours come from the API (or from an imported bundle
 * file) and are untrusted: a value such as `url(https://…)` or `red;background:…` must never reach `style`.
 */
export const safeColor = (value, fallback = 'var(--fg-muted)') => normalizeHex(value) || fallback;

export const trim = (v) => (typeof v === 'string' ? v.trim() : '');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const supportsFr = (event) => !event || !Array.isArray(event.languages) || event.languages.includes('fr');

/** Question as the player sees it in a given language (FR falls back to EN). */
export function pickText(q, field, lang) {
  const fr = trim(q[`${field}_fr`]);
  return lang === 'fr' && fr ? fr : (q[`${field}_en`] ?? '');
}

/** 'complete' | 'partial' (explanation not translated) | 'missing' (no French question text). */
export function frStatus(q) {
  if (!trim(q.question_text_fr)) return 'missing';
  if (trim(q.explanation_en) && !trim(q.explanation_fr)) return 'partial';
  return 'complete';
}

export const correctLabel = (q, lang = 'en') => {
  const side = q.correct_answer === 'red' ? 'red' : 'green';
  return pickText(q, `${side}_label`, lang) || (side === 'green' ? 'TRUE' : 'FALSE');
};

/** Human message for any thrown error (ApiError or not). */
export function describeError(e) {
  if (e instanceof ApiError) {
    if (e.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
    if (e.isTimeout) return 'The server took too long to answer. Try again.';
    if (e.isForbidden) return 'You do not have permission to do that.';
    return e.detail || `The request failed (${e.status}).`;
  }
  return e?.message || 'Something went wrong.';
}

/** Ask for confirmation through the shell (ctx.confirm) with a design-system fallback. */
export async function confirm(ctx, opts) {
  if (typeof ctx?.confirm === 'function') return ctx.confirm(opts);
  return confirmDialog({ title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel, tone: opts.danger ? 'danger' : 'default' });
}

export function notify(ctx, message, type = 'info') {
  if (typeof ctx?.toast === 'function') ctx.toast(message, { type });
}

/** Page numbers with ellipses: pageList(5, 12) -> [1, '…', 4, 5, 6, '…', 12]. */
export function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = new Set([1, pages, page, page - 1, page + 1]);
  if (page <= 3) { out.add(2); out.add(3); out.add(4); }
  if (page >= pages - 2) { out.add(pages - 1); out.add(pages - 2); out.add(pages - 3); }
  const sorted = [...out].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const res = [];
  sorted.forEach((n, i) => { if (i && n - sorted[i - 1] > 1) res.push('…'); res.push(n); });
  return res;
}

// ---------------------------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------------------------
/** Every question of an event matching the server-side filters (pages of 500). */
export async function fetchAllQuestions(api, eventId, filters = {}, { signal } = {}) {
  const limit = 500;
  const items = [];
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const page = await api.get(`/admin/events/${eventId}/questions`, { query: { ...filters, skip, limit, include_inactive: true }, signal });
    total = page.total;
    items.push(...page.items);
    if (!page.items.length) break;
    skip += limit;
  }
  return items;
}

/** Split an ApiError into {fields: {name: message}, form: string|null} for inline display. */
export function mapApiErrors(e, knownFields = []) {
  const fields = {};
  let form = null;
  if (e instanceof ApiError) {
    for (const [key, message] of Object.entries(e.fieldErrors || {})) {
      const name = key.split('.').pop();
      const text = String(message).replace(/^Value error,\s*/i, '');
      if (knownFields.includes(name)) fields[name] = text;
      else form = form ? `${form} ${text}` : text;
    }
    if (!Object.keys(e.fieldErrors || {}).length) form = describeError(e);
  } else form = describeError(e);
  return { fields, form };
}

// ---------------------------------------------------------------------------------------------
// Dialog / panel with a close guard (unsaved changes) - native <dialog> + design-system classes
// ---------------------------------------------------------------------------------------------
const openPanels = new Set();

/** Close every panel this module opened (used when a view unmounts, e.g. the shell navigates away). */
export function closeAllPanels() {
  for (const panel of [...openPanels]) panel.close(undefined, { force: true });
}

/**
 * Open a modal panel.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.description]
 * @param {string} [o.iconName] sprite icon shown in the header
 * @param {'sm'|'md'|'lg'|'xl'} [o.size]
 * @param {string} [o.className] extra class on the <dialog>
 * @param {Node} o.content body
 * @param {Node} [o.footer] a .dialog__footer element (the caller owns the buttons)
 * @param {(value:any)=>boolean|Promise<boolean>} [o.beforeClose] return false to keep the panel open
 * @param {()=>HTMLElement|null} [o.restoreFocus] element to focus after closing when the opener is gone
 * @param {string|HTMLElement} [o.initialFocus] selector or element focused when opened
 */
export function openPanel({ title, description, iconName, size = 'lg', className = '', content, footer, beforeClose, restoreFocus, initialFocus, headerExtra }) {
  const opener = document.activeElement;
  const titleId = uid('qv-dlg');
  const titleEl = el('h2', { class: 'dialog__title', id: titleId }, title);
  const descEl = el('p', { class: 'dialog__desc', hidden: !description }, description || '');
  const closeBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm qv-panel__close', 'aria-label': 'Close' }, icon('x'));
  const header = el('div', { class: 'dialog__header' },
    el('div', { class: 'cluster qv-panel__headmain' },
      iconName ? el('span', { class: 'dialog__icon' }, icon(iconName)) : null,
      el('div', { class: 'qv-panel__titlebox' }, titleEl, descEl)),
    el('div', { class: 'cluster qv-panel__headside' }, headerExtra || null, closeBtn));
  const body = el('div', { class: 'dialog__body qv-panel__body' }, content);
  const dialog = el('dialog', { class: ['dialog', size !== 'md' && `dialog--${size}`, 'qv-panel', className], 'aria-labelledby': titleId }, header, body, footer || null);

  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let result;
  let finished = false;
  let closing = false;

  function finish() {
    if (finished) return;
    finished = true;
    openPanels.delete(api);
    dialog.remove();
    const target = opener && opener.isConnected && typeof opener.focus === 'function' ? opener : restoreFocus?.();
    try { target?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    resolveClosed(result);
  }
  async function close(value, { force = false } = {}) {
    if (closing) return false;
    closing = true;
    try {
      if (!force && beforeClose && (await beforeClose(value)) === false) return false;
    } finally { closing = false; }
    result = value;
    if (dialog.open) dialog.close(); else finish();
    return true;
  }

  closeBtn.addEventListener('click', () => close(undefined));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
  dialog.addEventListener('close', finish);
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog || !downOnBackdrop) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close(undefined);
  });

  document.body.append(dialog);
  dialog.showModal();
  const first = typeof initialFocus === 'string' ? dialog.querySelector(initialFocus) : initialFocus;
  (first || dialog.querySelector('[autofocus]') || dialog.querySelector('input:not([type=hidden]):not(:disabled), textarea, select'))?.focus?.({ preventScroll: true });

  const api = {
    dialog, body, closed, close,
    setTitle(text, desc) { titleEl.textContent = text; if (desc !== undefined) { descEl.textContent = desc || ''; descEl.hidden = !desc; } },
  };
  openPanels.add(api);
  return api;
}

/** Grow a <textarea> with its content (bounded by CSS max-height). */
export function autoGrow(textarea) {
  textarea.style.blockSize = 'auto';
  textarea.style.blockSize = `${textarea.scrollHeight + 2}px`;
}

/** Build a .field wrapper. Returns {root, input, setError, setCounter}. */
export function field({ label, control, id, optional = false, help, counter = false, extra, className = '' }) {
  const fid = id || uid('qv-f');
  if (control && !control.id) control.id = fid;
  const errId = `${fid}-err`;
  const helpId = help ? `${fid}-help` : null;
  const labelEl = el('label', { class: 'field__label', for: control?.id || fid },
    el('span', null, label, optional ? el('span', { class: 'field__optional' }, ' optional') : null),
    extra || null);
  const counterEl = counter ? el('span', { class: 'qv-count', 'aria-hidden': 'true' }) : null;
  const errEl = el('p', { class: 'field__error', id: errId, hidden: true });
  const helpEl = help ? el('p', { class: 'field__help', id: helpId }, help) : null;
  const root = el('div', { class: ['field', className] }, labelEl, control, (helpEl || counterEl) ? el('div', { class: 'qv-field__foot' }, helpEl || el('span'), counterEl) : null, errEl);
  function describe() {
    const ids = [errEl.hidden ? null : errId, helpId].filter(Boolean).join(' ');
    if (control) { if (ids) control.setAttribute('aria-describedby', ids); else control.removeAttribute('aria-describedby'); }
  }
  describe();
  return {
    root, input: control, label: labelEl, errorEl: errEl,
    setError(message) {
      const has = !!message;
      errEl.hidden = !has;
      errEl.replaceChildren(...(has ? [icon('warning-circle', { size: 'sm' }), el('span', null, message)] : []));
      root.classList.toggle('field--invalid', has);
      if (control) { if (has) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid'); }
      describe();
    },
    setCounter(length, { ideal, max } = {}) {
      if (!counterEl) return;
      const limit = ideal ?? max;
      counterEl.textContent = limit ? `${length} / ${limit}` : String(length);
      const state = max !== undefined && length > max ? 'bad' : ideal !== undefined && length > ideal ? 'warn' : 'ok';
      counterEl.dataset.state = state;
    },
  };
}

