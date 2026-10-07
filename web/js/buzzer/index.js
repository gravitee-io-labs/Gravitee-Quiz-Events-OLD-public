/**
 * Buzzer module: Web Bluetooth quiz buzzers (green = key G, red = key R) as a self-contained controller.
 *
 *   import { createBuzzerController, mergeBuzzerDictionaries } from '/js/buzzer/index.js';
 *   // <link rel="stylesheet" href="/css/buzzer.css"> in the page head (after the shared stylesheets)
 *
 *   const buzzer = createBuzzerController({
 *     i18n,                                   // optional: shared/js/i18n.js instance (language + onChange)
 *     onPress: (color) => answer(color),      // 'green' | 'red'  (same entry point as the G / R keys)
 *   });
 *   appbarActions.append(buzzer.buttonEl);    // header button: icon + status dot, opens the dialog
 *   buzzer.on('status', (s) => ...);          // s = { supported, support, count, level, lowBattery, reconnecting,
 *                                             //       green: {state, connected, battery, lowBattery, attempt}, red: {...} }
 *   buzzer.feedback('green', isCorrect);      // LED feedback on the buzzer that answered (optional)
 *   buzzer.setReady(true|false);              // both LEDs on while a question is open (optional)
 *   buzzer.destroy();                         // disconnects, removes listeners and DOM
 *
 * Keyboard G / R handling stays in the host: this module only forwards buzzer presses to onPress.
 * While the dialog is open, presses only light the test indicator and are NOT forwarded (so testing never answers a question).
 */
import { createBuzzerManager, COLORS, BATTERY_LOW, NAME_PREFIX, BuzzerError } from './ble.js';
import { createTranslator, buzzerDictionaries, mergeBuzzerDictionaries } from './strings.js';
import { createBuzzerUi } from './ui.js';
import { toast, announce } from '/shared/js/ui.js';

export { buzzerDictionaries, mergeBuzzerDictionaries, BATTERY_LOW, NAME_PREFIX, BuzzerError };

/**
 * @param {object} [options]
 * @param {object} [options.i18n]                 shared i18n instance (optional). Language changes re-render the UI.
 * @param {(color: 'green'|'red', meta: {source: 'ble', at: number}) => void} [options.onPress]
 * @param {boolean} [options.notify=true]         toast + screen-reader announcements for connect / loss / low battery (when the dialog is closed)
 * @param {boolean} [options.forwardWhileOpen=false] forward presses to onPress even while the dialog is open
 * @param {boolean} [options.autoRestore=true]    silently reconnect buzzers this browser already paired with (Chrome 122+)
 * @param {object} [options.ble]                  overrides for the BLE manager (debounceMs, reconnectDelays, ...), mainly for tests
 */
export function createBuzzerController({ i18n = null, onPress, notify = true, forwardWhileOpen = false, autoRestore = true, ble = {} } = {}) {
  const t = createTranslator(i18n);
  const manager = createBuzzerManager(ble);
  const ui = createBuzzerUi({ manager, t });
  const subscribers = { status: new Set(), notice: new Set(), press: new Set() };
  const disposers = [];
  let destroyed = false;

  const emit = (type, payload) => {
    for (const cb of [...subscribers[type]]) {
      try { cb(payload); } catch (e) { console.error(`buzzer ${type} listener failed`, e); }
    }
  };

  const buzzerName = (color) => t(color);

  // BLE -> UI + host ------------------------------------------------------------------------
  disposers.push(manager.on('status', (status) => {
    ui.render(status);
    emit('status', status);
  }));

  disposers.push(manager.on('press', ({ color, at }) => {
    ui.showPress(color);
    emit('press', { color, at });
    if (ui.isOpen && !forwardWhileOpen) return; // testing in the dialog
    try { onPress?.(color, { source: 'ble', at }); } catch (e) { console.error('buzzer onPress failed', e); }
  }));

  disposers.push(manager.on('notice', (n) => {
    emit('notice', n);
    if (n.type === 'assigned') ui.setMessage(n.requested, { key: 'notice.assigned', params: { actual: n.color }, tone: 'info' });
    if (!notify) return;
    const buzzer = buzzerName(n.color);
    // When the dialog is open the rows already say everything (they are live regions): keep the toasts for the game screen.
    if (ui.isOpen) return;
    switch (n.type) {
      case 'connected': toast(t('notice.connected', { buzzer }), { type: 'success', duration: 2500 }); break;
      case 'assigned': toast(t('notice.assigned', { actual: t(`colorName.${n.color}`) }), { type: 'info' }); break;
      case 'lost': toast(t('notice.lost', { buzzer }), { type: 'warning', duration: 5000 }); announce(t('notice.lost', { buzzer }), { politeness: 'assertive' }); break;
      case 'reconnected': toast(t('notice.reconnected', { buzzer }), { type: 'success', duration: 2500 }); break;
      case 'battery-low': toast(t('notice.batteryLow', { buzzer, pct: n.level }), { type: 'warning', duration: 7000 }); break;
      case 'disconnected': announce(t('notice.disconnected', { buzzer })); break;
      default: break;
    }
  }));

  if (i18n && typeof i18n.onChange === 'function') disposers.push(i18n.onChange(() => ui.render()));

  if (autoRestore && manager.supported) {
    // Silent: devices that are off or out of range are skipped. Deferred so the host finishes its own boot first.
    Promise.resolve().then(() => manager.restore()).catch(() => {});
  }

  // public API --------------------------------------------------------------------------------
  const controller = {
    /** Header button (icon + status dot). Append it to your appbar; it opens the dialog. */
    buttonEl: ui.buttonEl,
    /** false in browsers without Web Bluetooth and on insecure (non-HTTPS) pages; the dialog then explains why. */
    isSupported: manager.supported,
    /** 'ok' | 'unsupported' | 'insecure' */
    support: manager.support,
    /** Open the dialog (also fine when unsupported: it shows the explanation). */
    open: () => ui.open(),
    close: () => ui.close(),
    /** Snapshot: { supported, support, adapter, count, level: 'none'|'one'|'both', lowBattery, reconnecting, green, red }. */
    getStatus: () => manager.getStatus(),
    /**
     * Subscribe: 'status' (snapshot on every change), 'press' ({color, at}, also while the dialog is open),
     * 'notice' ({type: 'connected'|'assigned'|'lost'|'reconnected'|'disconnected'|'battery-low', color, ...}).
     * @returns {() => void} unsubscribe
     */
    on(type, cb) {
      if (!subscribers[type] || typeof cb !== 'function') return () => {};
      subscribers[type].add(cb);
      return () => subscribers[type].delete(cb);
    },
    off(type, cb) { subscribers[type]?.delete(cb); },
    /** Programmatic connect (needs a user gesture: opens the browser chooser). Resolves with the colour it connected as. */
    connect: (color) => manager.connect(color),
    disconnect: (color) => manager.disconnect(color),
    disconnectAll: () => manager.disconnectAll(),
    /** LED feedback on the buzzer that answered: steady flash = correct, three blinks = wrong. No-op when not connected. */
    feedback: (color, isCorrect) => manager.feedback(color, isCorrect),
    /** Both LEDs on (a question is open) / off. setReady(false) lets a running feedback pattern finish. */
    setReady: (on) => manager.setReady(on),
    testLeds: () => manager.testLeds(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of disposers.splice(0)) { try { off(); } catch { /* ignore */ } }
      manager.destroy(); // disconnects every buzzer and removes the BLE listeners
      ui.destroy();
      for (const set of Object.values(subscribers)) set.clear();
    },
  };
  return controller;
}

export { COLORS };
