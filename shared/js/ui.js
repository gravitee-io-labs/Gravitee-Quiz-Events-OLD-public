/**
 * ui.js - behaviours for the interactive components: toasts, dialogs, announcements, tabs, dropdowns, shell, colour inputs.
 * All CSP friendly (no inline handlers), all keyboard accessible.
 */
import { el, icon, uid, prefersReducedMotion } from './dom.js';

// ---------------------------------------------------------------------------------------------
// aria-live announcements
// ---------------------------------------------------------------------------------------------
let announcer = null;
/**
 * Announce a message to screen readers (visually hidden live region). Use for timer milestones, answer feedback, results.
 * @param {string} message
 * @param {{politeness?: 'polite'|'assertive'}} [opts]
 */
export function announce(message, { politeness = 'polite' } = {}) {
  if (!announcer || !announcer.isConnected) {
    announcer = el('div', { class: 'u-sr-only', id: 'quiz-announcer', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(announcer);
  }
  announcer.setAttribute('aria-live', politeness);
  announcer.textContent = '';
  setTimeout(() => { announcer.textContent = message; }, 40); // a tick later so repeated identical messages are re-read
}

// ---------------------------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------------------------
let region = null;
const TOAST_ICON = { success: 'check-circle-fill', error: 'x-circle-fill', warning: 'warning-fill', info: 'info-fill' };

/**
 * Show a toast.
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error'|'warning', title?: string, duration?: number, action?: {label:string,onClick:()=>void}}} [opts]
 *        duration ms (default 4500, 0 = sticky); errors default to 7000.
 * @returns {{dismiss: ()=>void, element: HTMLElement}}
 */
export function toast(message, { type = 'info', title, duration, action } = {}) {
  if (!region || !region.isConnected) {
    region = el('div', { class: 'toast-region', role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    document.body.append(region);
  }
  while (region.children.length >= 4) region.firstElementChild.remove();
  const ms = duration ?? (type === 'error' ? 7000 : 4500);
  let timer = null;
  const node = el('div', { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICON[type] || TOAST_ICON.info, { class: 'toast__icon' }),
    el('div', { class: 'toast__body' }, title ? el('span', { class: 'toast__title' }, title) : null, el('span', { class: title ? 'toast__msg' : 'toast__title' }, message)),
    action ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm toast__action', on: { click: () => { action.onClick?.(); dismiss(); } } }, action.label)
      : el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm toast__action', 'aria-label': 'Dismiss', on: { click: () => dismiss() } }, icon('x', { size: 'sm' })));
  function dismiss() {
    clearTimeout(timer);
    if (!node.isConnected) return;
    if (prefersReducedMotion()) { node.remove(); return; }
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  }
  const arm = () => { if (ms > 0) timer = setTimeout(dismiss, ms); };
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', arm);
  region.append(node);
  arm();
  return { dismiss, element: node };
}

// ---------------------------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------------------------
/**
 * Open a modal built on the native <dialog>.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {Node|string|Array} [opts.content] body (Node/array of nodes, or text)
 * @param {Array<{label:string, variant?:'primary'|'secondary'|'ghost'|'danger'|'success', value?:any, closes?:boolean, autofocus?:boolean, onClick?:(e:Event, ctl:object)=>void|Promise<void>}>} [opts.actions]
 * @param {'sm'|'md'|'lg'|'xl'} [opts.size='md']
 * @param {boolean} [opts.dismissible=true] Escape / backdrop click / close button
 * @param {string} [opts.icon] sprite icon name shown next to the title
 * @param {boolean} [opts.danger] tint the icon red
 * @returns {{dialog: HTMLDialogElement, close:(value?:any)=>void, closed: Promise<any>}} `closed` resolves with the action value (undefined when dismissed)
 */
export function openModal({ title, description, content, actions = [], size = 'md', dismissible = true, icon: iconName, danger = false, onClose } = {}) {
  const opener = document.activeElement;
  const titleId = uid('dlg-title');
  const dialog = el('dialog', { class: ['dialog', size !== 'md' && `dialog--${size}`], 'aria-labelledby': titleId });
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let result;
  const ctl = { dialog, close: (value) => { result = value; if (dialog.open) dialog.close(); else finish(); }, closed };
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    dialog.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus({ preventScroll: true }); } catch { /* ignore */ } }
    try { onClose?.(result); } catch (e) { console.error(e); }
    resolveClosed(result);
  }

  const header = el('div', { class: 'dialog__header' },
    el('div', { class: 'cluster', style: { gap: 'var(--space-3)', flexWrap: 'nowrap', alignItems: 'flex-start' } },
      iconName ? el('span', { class: ['dialog__icon', danger && 'dialog__icon--danger'] }, icon(iconName)) : null,
      el('div', null, el('h2', { class: 'dialog__title', id: titleId }, title || ''), description ? el('p', { class: 'dialog__desc' }, description) : null)),
    dismissible ? el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Close', on: { click: () => ctl.close(undefined) } }, icon('x')) : null);
  const body = content === undefined || content === null ? null : el('div', { class: 'dialog__body' }, content);
  const footer = actions.length ? el('div', { class: 'dialog__footer' }, actions.map((a) => {
    const btn = el('button', { type: 'button', class: `btn btn--${a.variant || 'secondary'}`, autofocus: a.autofocus ? '' : null }, a.label);
    btn.addEventListener('click', async (e) => {
      try { if (a.onClick) await a.onClick(e, ctl); } catch (err) { console.error(err); return; }
      if (a.closes !== false && !e.defaultPrevented) ctl.close(a.value);
    });
    return btn;
  })) : null;
  dialog.append(header, ...(body ? [body] : []), ...(footer ? [footer] : []));

  dialog.addEventListener('close', finish);
  dialog.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
  if (dismissible) {
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) ctl.close(undefined);
    });
  }
  document.body.append(dialog);
  dialog.showModal();
  const auto = dialog.querySelector('[autofocus]') || dialog.querySelector('.dialog__body :is(input,select,textarea,button)') || dialog.querySelector('.dialog__footer .btn--primary, .dialog__footer .btn--danger');
  auto?.focus?.({ preventScroll: true });
  return ctl;
}

/**
 * Promise-based confirmation.
 * @returns {Promise<boolean>} true when confirmed
 * @example if (await confirmDialog({ title: 'Delete event?', message: 'This cannot be undone.', tone: 'danger', confirmLabel: 'Delete' })) …
 */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default', icon: iconName } = {}) {
  const danger = tone === 'danger';
  const ctl = openModal({
    title, description: message, size: 'sm', icon: iconName || (danger ? 'warning' : 'question'), danger,
    actions: [
      { label: cancelLabel, variant: 'secondary', value: false },
      { label: confirmLabel, variant: danger ? 'danger' : 'primary', value: true, autofocus: !danger },
    ],
  });
  if (danger) ctl.dialog.querySelector('.btn--secondary')?.focus(); // destructive: default focus on the safe choice
  return ctl.closed.then((v) => v === true);
}

/** Move focus to the first focusable descendant (or the container itself). */
export function focusFirst(root) {
  const target = root.querySelector('[autofocus], input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
  (target || root).focus?.({ preventScroll: false });
}

/** Busy state for any async button handler: await withBusy(btn, () => api.post(...)). */
export async function withBusy(button, task) {
  button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); button.disabled = true;
  try { return await task(); } finally { button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); button.disabled = false; }
}

// ---------------------------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------------------------
/**
 * Wire ARIA tabs: arrow keys / Home / End, roving tabindex, panel visibility.
 * Markup: [role=tablist] > [role=tab][aria-controls=panelId][aria-selected] and [role=tabpanel][id] (hidden when inactive).
 * @param {ParentNode} [root=document]
 * @param {{onChange?:(tab:HTMLElement, panel:HTMLElement|null)=>void}} [opts]
 * @returns {{select:(idOrEl:string|HTMLElement)=>void}}
 */
export function initTabs(root = document, { onChange } = {}) {
  const lists = Array.from(root.querySelectorAll('[role="tablist"]'));
  const select = (tab, focus = false) => {
    const list = tab.closest('[role="tablist"]');
    for (const t of list.querySelectorAll('[role="tab"]')) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
    const panel = tab.getAttribute('aria-controls') && document.getElementById(tab.getAttribute('aria-controls'));
    onChange?.(tab, panel || null);
  };
  for (const list of lists) {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    tabs.forEach((t) => { t.tabIndex = t === initial ? 0 : -1; const p = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls')); if (p) p.hidden = t !== initial; });
    list.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t && list.contains(t)) select(t); });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select(tabs[(next + tabs.length) % tabs.length], true);
    });
  }
  return { select: (x) => select(typeof x === 'string' ? document.getElementById(x) : x) };
}

// ---------------------------------------------------------------------------------------------
// dropdown menus
// ---------------------------------------------------------------------------------------------
/**
 * Delegated behaviour for every [data-dropdown-trigger] (one call per page).
 * Markup: .dropdown > button[data-dropdown-trigger][aria-haspopup=menu][aria-expanded] + .menu[role=menu][hidden] > .menu__item[role=menuitem]
 * Click toggles, Escape / outside click / item click closes, ArrowUp/Down/Home/End move, focus returns to the trigger.
 * @returns {()=>void} dispose
 */
export function initDropdowns(root = document) {
  const menuOf = (trigger) => trigger.closest('.dropdown')?.querySelector('.menu');
  const items = (menu) => Array.from(menu.querySelectorAll('[role^="menuitem"]:not([disabled])'));
  const closeAll = (except) => root.querySelectorAll('[data-dropdown-trigger][aria-expanded="true"]').forEach((t) => { if (t !== except) close(t); });
  function open(trigger, focusFirstItem = false) {
    const menu = menuOf(trigger);
    if (!menu) return;
    closeAll(trigger);
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (focusFirstItem) items(menu)[0]?.focus();
  }
  function close(trigger, returnFocus = false) {
    const menu = menuOf(trigger);
    if (menu) menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }
  const onClick = (e) => {
    if (e.__quizDropdown) return; // initDropdowns called twice on nested roots: handle each click once
    e.__quizDropdown = true;
    const trigger = e.target.closest('[data-dropdown-trigger]');
    if (trigger) { trigger.getAttribute('aria-expanded') === 'true' ? close(trigger) : open(trigger); return; }
    const item = e.target.closest('.menu [role^="menuitem"]');
    if (item) { const t = item.closest('.dropdown')?.querySelector('[data-dropdown-trigger]'); if (t && !item.hasAttribute('data-keep-open')) close(t, true); return; }
    closeAll();
  };
  const onKey = (e) => {
    if (e.__quizDropdown) return;
    e.__quizDropdown = true;
    const trigger = e.target.closest?.('[data-dropdown-trigger]');
    if (trigger && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); open(trigger, true); return; }
    const menu = e.target.closest?.('.menu');
    if (!menu) return;
    const list = items(menu), i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(menu.closest('.dropdown').querySelector('[data-dropdown-trigger]'), true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') closeAll();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); };
}

// ---------------------------------------------------------------------------------------------
// admin shell (mobile sidebar)
// ---------------------------------------------------------------------------------------------
/**
 * Wire .shell: [data-shell-toggle] opens/closes the sidebar on small screens; Escape, scrim click and nav clicks close it.
 * @returns {()=>void} dispose
 */
export function initShell(shell = document.querySelector('.shell')) {
  if (!shell) return () => {};
  const set = (open) => {
    shell.dataset.sidebar = open ? 'open' : 'closed';
    shell.querySelector('[data-shell-toggle]')?.setAttribute('aria-expanded', String(open));
  };
  const onClick = (e) => {
    if (e.target.closest('[data-shell-toggle]')) set(shell.dataset.sidebar !== 'open');
    else if (e.target.closest('.shell__scrim') || e.target.closest('.shell__sidebar .nav__item')) set(false);
  };
  const onKey = (e) => { if (e.key === 'Escape' && shell.dataset.sidebar === 'open') { set(false); shell.querySelector('[data-shell-toggle]')?.focus(); } };
  shell.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  set(false);
  return () => { shell.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
}

// ---------------------------------------------------------------------------------------------
// colour input (swatch + hex text)
// ---------------------------------------------------------------------------------------------
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/**
 * Keep every .color-input's <input type=color> and hex text field in sync. Fires a bubbling 'input' and 'change' event on
 * the wrapper-level root so you can listen once: root.addEventListener('input', e => e.target.closest('.color-input')…).
 * Invalid hex marks the text field aria-invalid until fixed.
 * @returns {()=>void} dispose
 */
export function initColorInputs(root = document) {
  const full = (v) => { const h = v.replace('#', ''); return `#${(h.length === 3 ? [...h].map((c) => c + c).join('') : h).toUpperCase()}`; };
  const onInput = (e) => {
    const wrap = e.target.closest?.('.color-input');
    if (!wrap) return;
    const swatch = wrap.querySelector('.color-input__swatch'), text = wrap.querySelector('.color-input__hex');
    if (e.target === swatch) { text.value = swatch.value.toUpperCase(); text.removeAttribute('aria-invalid'); }
    else if (e.target === text) {
      const ok = HEX.test(text.value.trim());
      text.setAttribute('aria-invalid', String(!ok));
      if (ok) swatch.value = full(text.value.trim()).toLowerCase();
    }
  };
  const onChange = (e) => {
    const wrap = e.target.closest?.('.color-input');
    if (!wrap || e.target !== wrap.querySelector('.color-input__hex')) return;
    const text = e.target;
    if (HEX.test(text.value.trim())) { text.value = full(text.value.trim()); text.removeAttribute('aria-invalid'); }
  };
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  return () => { root.removeEventListener('input', onInput); root.removeEventListener('change', onChange); };
}

// ---------------------------------------------------------------------------------------------
// range sliders
// ---------------------------------------------------------------------------------------------
/**
 * Paint the filled part of every input.range (sets --p = 0..100 on input). Call once; works for ranges added later too.
 * @returns {()=>void} dispose
 */
export function initRanges(root = document) {
  const paint = (r) => { const min = +r.min || 0, max = +r.max || 100; r.style.setProperty('--p', String(((+r.value - min) / (max - min)) * 100)); };
  root.querySelectorAll('input.range').forEach(paint);
  const onInput = (e) => { if (e.target.matches?.('input.range')) paint(e.target); };
  root.addEventListener('input', onInput);
  return () => root.removeEventListener('input', onInput);
}
