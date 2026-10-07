/**
 * ui.js - the header button and the accessible <dialog> of the buzzer module.
 * Built with shared/js/dom.js (text nodes only, no innerHTML, no inline handlers: CSP safe) and the design system classes;
 * module specific rules live in web/css/buzzer.css.
 */
import { el, icon, uid, SPRITE_URL } from '/shared/js/dom.js';
import { COLORS, NAME_PREFIX } from './ble.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DOT_STATE = { connected: 'on', connecting: 'connecting', reconnecting: 'connecting', disconnected: 'off' };
const PRESS_FLASH_MS = 1400;

/**
 * @param {object} deps
 * @param {ReturnType<import('./ble.js').createBuzzerManager>} deps.manager
 * @param {(key: string, params?: object) => string} deps.t   translator (see strings.js)
 */
export function createBuzzerUi({ manager, t }) {
  const messages = { green: null, red: null }; // { key, params, tone } per row, re-translated on every render
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  let returnFocusTo = null;
  let testing = false;
  let disposed = false;

  // -------------------------------------------------------------------------------------------
  // header button
  // -------------------------------------------------------------------------------------------
  const btnIcon = icon('bluetooth');
  const buttonEl = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--icon buzzer-btn',
    'aria-haspopup': 'dialog',
    dataset: { level: 'none', warn: 'false', reconnecting: 'false' },
    on: { click: () => open() },
  }, btnIcon, el('span', { class: 'buzzer-btn__dot', 'aria-hidden': 'true' }));

  const setIcon = (name) => btnIcon.firstElementChild?.setAttribute('href', `${SPRITE_URL}#${name}`);

  // -------------------------------------------------------------------------------------------
  // dialog skeleton
  // -------------------------------------------------------------------------------------------
  const titleId = uid('buzzer-title');
  const introId = uid('buzzer-intro');
  const titleEl = el('h2', { class: 'dialog__title', id: titleId });
  const introEl = el('p', { class: 'dialog__desc', id: introId });
  const closeBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon', on: { click: () => close() } }, icon('x'));

  const supportIcon = icon('warning-fill', { class: 'alert__icon' });
  const supportTitle = el('p', { class: 'alert__title' });
  const supportText = el('p', { class: 'alert__text' });
  const supportAlert = el('div', { class: 'alert alert--warning buzzer-support', hidden: true }, supportIcon, el('div', null, supportTitle, supportText));

  const adapterText = el('p', { class: 'alert__text' });
  const adapterAlert = el('div', { class: 'alert alert--warning buzzer-support', hidden: true }, icon('bluetooth-slash', { class: 'alert__icon' }), el('div', null, adapterText));

  const rows = {};
  const list = el('ul', { class: 'buzzer-list', role: 'list' });
  for (const color of COLORS) {
    const row = buildRow(color);
    rows[color] = row;
    list.append(row.root);
  }

  const keysLead = el('span');
  const keysGreen = el('span');
  const keysRed = el('span');
  const keys = el('p', { class: 'buzzer-keys' },
    icon('keyboard', { class: 'buzzer-keys__icon' }),
    el('span', { class: 'buzzer-keys__text' },
      keysLead, ' ',
      el('span', { class: 'buzzer-keys__pair' }, el('kbd', { class: 'kbd kbd--green' }, 'G'), ' ', keysGreen),
      ' ',
      el('span', { class: 'buzzer-keys__pair' }, el('kbd', { class: 'kbd kbd--red' }, 'R'), ' ', keysRed)));

  const testBtn = el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => runTest() } }, icon('lightning'), el('span', { class: 'buzzer-test__label' }));
  const disconnectAllBtn = el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => { if (!isDisabled(disconnectAllBtn)) manager.disconnectAll(); } } }, icon('plugs-connected'), el('span'));
  const doneBtn = el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => close() } });
  const footer = el('div', { class: 'dialog__footer' }, testBtn, disconnectAllBtn, doneBtn);

  const dialog = el('dialog', { class: 'dialog buzzer-dialog', 'aria-labelledby': titleId, 'aria-describedby': introId },
    el('div', { class: 'dialog__header' },
      el('div', { class: 'buzzer-dialog__head' },
        el('span', { class: 'dialog__icon' }, icon('bluetooth')),
        el('div', null, titleEl, introEl)),
      closeBtn),
    el('div', { class: 'dialog__body' }, supportAlert, adapterAlert, list, keys),
    footer);

  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return; // a click on the backdrop targets the <dialog> itself
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) close();
  });
  dialog.addEventListener('keydown', trapTab);
  dialog.addEventListener('close', () => {
    const target = returnFocusTo && returnFocusTo.isConnected ? returnFocusTo : buttonEl;
    returnFocusTo = null;
    if (!disposed) { try { target.focus({ preventScroll: true }); } catch { /* ignore */ } }
  });
  document.body.append(dialog);

  // -------------------------------------------------------------------------------------------
  // rows
  // -------------------------------------------------------------------------------------------
  function buildRow(color) {
    const labelId = uid(`buzzer-${color}`);
    const swatchIcon = icon('bluetooth');
    const nameEl = el('span', { class: 'buzzer-row__name', id: labelId });
    const statusDot = el('span', { class: 'status-dot', 'data-state': 'off', 'aria-hidden': 'true' });
    // the live region holds only the state; the attempt counter changes on every retry and must not be re-announced
    const statusLive = el('span', { role: 'status', 'aria-live': 'polite' });
    const statusAttempt = el('span', { class: 'buzzer-row__attempt', 'aria-hidden': 'true' });
    const statusText = el('span', { class: 'buzzer-row__state' }, statusLive, statusAttempt);
    const batteryIcon = icon('battery-full');
    const batteryText = el('span');
    const battery = el('span', { class: 'buzzer-battery', hidden: true }, batteryIcon, batteryText);
    const padText = el('span', { class: 'buzzer-pad__text', role: 'status', 'aria-live': 'polite' });
    const pad = el('div', { class: 'buzzer-pad', hidden: true }, el('span', { class: 'buzzer-pad__led', 'aria-hidden': 'true' }), padText);
    const hint = el('p', { class: 'buzzer-row__hint' });
    const msgIcon = icon('info-fill');
    const msgText = el('span');
    const msg = el('p', { class: 'buzzer-row__msg', role: 'status', 'aria-live': 'polite', hidden: true }, msgIcon, msgText);
    const actionLabel = el('span');
    const actionIcon = icon('plug');
    const action = el('button', { type: 'button', class: 'btn btn--primary buzzer-row__action', 'aria-describedby': labelId, on: { click: () => onAction(color) } }, actionIcon, actionLabel);

    const root = el('li', { class: 'buzzer-row', dataset: { color, state: 'disconnected' } },
      el('span', { class: 'buzzer-row__swatch', 'aria-hidden': 'true' }, swatchIcon),
      el('div', { class: 'buzzer-row__main' },
        el('div', { class: 'buzzer-row__title' },
          nameEl,
          el('kbd', { class: `kbd kbd--${color}` }, color === 'green' ? 'G' : 'R')),
        el('div', { class: 'buzzer-row__status' }, statusDot, statusText, battery),
        pad, msg, hint),
      el('div', { class: 'buzzer-row__actions' }, action));

    return { root, swatchIcon, nameEl, statusDot, statusText, statusLive, statusAttempt, battery, batteryIcon, batteryText, pad, padText, hint, msg, msgIcon, msgText, action, actionIcon, actionLabel, padTimer: null };
  }

  /** Only touch the DOM when the text really changes: live regions re-announce on every replaced text node. */
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const isDisabled = (btn) => btn.getAttribute('aria-disabled') === 'true';
  function setDisabled(btn, disabled) {
    if (disabled) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
  }
  const setBusy = (btn, busy) => { if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); };

  const colorLabel = (color) => t(color); // 'Green buzzer' / 'Buzzer vert'
  const colorName = (color) => t(`colorName.${color}`);

  async function onAction(color) {
    const status = manager.getStatus()[color];
    if (status.state === 'connecting') return;
    if (status.state === 'connected' || status.state === 'reconnecting') {
      setMessage(color, null);
      await manager.disconnect(color);
      return;
    }
    setMessage(color, null);
    try {
      await manager.connect(color); // called synchronously from the click: the chooser needs the user gesture
    } catch (err) {
      showConnectError(color, err);
    }
  }

  function showConnectError(color, err) {
    switch (err?.code) {
      case 'cancelled': case 'busy': case 'unsupported': case 'insecure': case 'invalid':
        return; // nothing to tell: the user cancelled, or the support banner already explains it
      case 'adapter': return setMessage(color, { key: 'adapter', tone: 'error' });
      case 'blocked': return setMessage(color, { key: 'error.blocked', tone: 'error' });
      case 'protocol': return setMessage(color, { key: 'error.protocol', tone: 'error' });
      case 'unknown-id': return setMessage(color, { key: 'error.unknownId', tone: 'error' });
      case 'taken': return setMessage(color, { key: 'error.taken', params: { colorKey: err.color || color }, tone: 'error' });
      default: return setMessage(color, { key: 'error.connect', params: { colorKey: color }, tone: 'error' });
    }
  }

  /** @param {'green'|'red'} color @param {{key:string, params?:object, tone?:'error'|'info'}|null} message */
  function setMessage(color, message) {
    messages[color] = message;
    if (!disposed) renderRow(color, manager.getStatus());
  }

  async function runTest() {
    if (testing || isDisabled(testBtn)) return;
    testing = true;
    render();
    try { await manager.testLeds(); } finally { testing = false; if (!disposed) render(); }
  }

  // -------------------------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------------------------
  function renderRow(color, status) {
    const row = rows[color];
    const s = status[color];
    const available = status.support === 'ok';
    row.root.dataset.state = s.state;
    row.root.hidden = !available;
    row.nameEl.textContent = colorLabel(color);
    row.statusDot.dataset.state = DOT_STATE[s.state];
    setText(row.statusLive, t(`state.${s.state}`));
    setText(row.statusAttempt, s.state === 'reconnecting' ? ` (${t('state.attempt', { n: Math.max(1, s.attempt) })})` : '');
    row.swatchIcon.firstElementChild?.setAttribute('href', `${SPRITE_URL}#${s.connected ? 'bluetooth-connected' : 'bluetooth'}`);

    // battery
    if (s.connected && s.battery !== null) {
      row.battery.hidden = false;
      row.battery.dataset.low = String(s.lowBattery);
      setText(row.batteryText, s.lowBattery ? t('batteryLow', { pct: s.battery }) : t('battery', { pct: s.battery }));
      const lvl = s.battery;
      row.batteryIcon.firstElementChild?.setAttribute('href', `${SPRITE_URL}#${lvl > 85 ? 'battery-full' : lvl > 60 ? 'battery-high' : lvl > 35 ? 'battery-medium' : lvl > 10 ? 'battery-low' : 'battery-empty'}`);
    } else {
      row.battery.hidden = true;
    }

    // press test pad
    row.pad.hidden = !s.connected;
    if (!row.pad.classList.contains('is-active')) setText(row.padText, t('press.idle'));

    // message + hint
    const message = messages[color];
    row.msg.hidden = !message;
    if (message) {
      const params = { ...(message.params || {}) };
      if (params.colorKey) { params.color = colorName(params.colorKey); delete params.colorKey; }
      if (message.key === 'notice.assigned') params.actual = colorName(params.actual || color);
      row.msg.dataset.tone = message.tone || 'info';
      row.msgIcon.firstElementChild?.setAttribute('href', `${SPRITE_URL}#${message.tone === 'error' ? 'warning-fill' : 'info-fill'}`);
      setText(row.msgText, t(message.key, params));
    }
    row.hint.hidden = !(s.state === 'disconnected' && !message);
    setText(row.hint, t('pick', { name: `${NAME_PREFIX} - ${color === 'green' ? 'Green' : 'Red'}` }));

    // action button
    const connecting = s.state === 'connecting';
    row.action.className = `btn buzzer-row__action ${s.state === 'disconnected' || connecting ? 'btn--primary' : 'btn--secondary'}`;
    setText(row.actionLabel, connecting ? t('connecting') : s.state === 'connected' ? t('disconnect') : s.state === 'reconnecting' ? t('stop') : t('connect'));
    row.actionIcon.firstElementChild?.setAttribute('href', `${SPRITE_URL}#${s.state === 'disconnected' || connecting ? 'plug' : s.state === 'connected' ? 'plugs-connected' : 'stop'}`);
    setDisabled(row.action, connecting);
    setBusy(row.action, connecting);
  }

  function render(status = manager.getStatus()) {
    if (disposed) return;
    const available = status.support === 'ok';

    // header button
    buttonEl.dataset.level = available ? status.level : 'off';
    buttonEl.dataset.warn = String(available && status.lowBattery);
    buttonEl.dataset.reconnecting = String(available && status.reconnecting);
    setIcon(!available ? 'bluetooth-slash' : status.count > 0 ? 'bluetooth-connected' : 'bluetooth');
    const parts = [];
    if (!available) parts.push(t('button.unsupported'));
    else {
      parts.push(status.count === 0 ? t('button.none') : status.count === 2 ? t('button.both') : t('button.count', { n: status.count }));
      if (status.reconnecting) parts.push(t('button.reconnecting'));
      if (status.lowBattery) parts.push(t('button.lowBattery'));
    }
    const label = `${t('button.label')}: ${parts.join(', ')}`;
    buttonEl.setAttribute('aria-label', label);
    buttonEl.title = label;

    // dialog chrome
    titleEl.textContent = t('title');
    introEl.textContent = t('intro');
    closeBtn.setAttribute('aria-label', t('close'));
    supportAlert.hidden = available;
    if (!available) {
      const kind = status.support === 'insecure' ? 'insecure' : 'unsupported';
      supportTitle.textContent = t(`${kind}.title`);
      supportText.textContent = t(`${kind}.text`);
    }
    adapterAlert.hidden = !(available && status.adapter === false);
    adapterText.textContent = t('adapter');
    keysLead.textContent = t('keys.lead');
    keysGreen.textContent = t('keys.green');
    keysRed.textContent = t('keys.red');
    doneBtn.textContent = t('done');

    for (const color of COLORS) renderRow(color, status);
    list.hidden = !available;

    // footer
    testBtn.hidden = !available;
    disconnectAllBtn.hidden = !available;
    testBtn.querySelector('.buzzer-test__label').textContent = testing ? t('testing') : t('test');
    setDisabled(testBtn, status.count === 0 || testing);
    setBusy(testBtn, testing);
    disconnectAllBtn.lastElementChild.textContent = t('disconnectAll');
    const anyLink = status.green.state !== 'disconnected' || status.red.state !== 'disconnected';
    setDisabled(disconnectAllBtn, !anyLink);
  }

  // -------------------------------------------------------------------------------------------
  // open / close / focus
  // -------------------------------------------------------------------------------------------
  const focusables = () => Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((n) => !n.hidden && !n.closest('[hidden]') && n.getClientRects().length > 0);

  function trapTab(event) {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
  }

  function open() {
    if (disposed || dialog.open) return;
    returnFocusTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : buttonEl;
    render();
    dialog.showModal();
    const target = Array.from(dialog.querySelectorAll('.buzzer-row__action')).find((b) => !b.closest('[hidden]') && !isDisabled(b)) || doneBtn;
    target.focus({ preventScroll: true });
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  // -------------------------------------------------------------------------------------------
  // press feedback
  // -------------------------------------------------------------------------------------------
  function showPress(color) {
    const row = rows[color];
    if (!row || disposed) return;
    row.pad.classList.add('is-active');
    row.padText.textContent = t('press.got');
    clearTimeout(row.padTimer);
    timers.delete(row.padTimer);
    row.padTimer = later(() => {
      row.pad.classList.remove('is-active');
      row.padText.textContent = t('press.idle');
    }, PRESS_FLASH_MS);
    pulseButton();
  }

  let pulseTimer = null;
  function pulseButton() {
    buttonEl.classList.remove('is-pressed');
    void buttonEl.offsetWidth; // restart the CSS animation
    buttonEl.classList.add('is-pressed');
    clearTimeout(pulseTimer);
    timers.delete(pulseTimer);
    pulseTimer = later(() => buttonEl.classList.remove('is-pressed'), 700);
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (dialog.open) dialog.close();
    dialog.remove();
    buttonEl.remove();
  }

  render();

  return {
    buttonEl,
    dialog,
    open,
    close,
    get isOpen() { return dialog.open; },
    render,
    showPress,
    setMessage,
    destroy,
  };
}
