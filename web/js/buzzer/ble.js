/**
 * ble.js - Web Bluetooth manager for the Gravitee quiz buzzers (ported from the legacy game-client/js/buzzer.js).
 *
 * GATT contract (buzzer-firmware/src/{config.h,buzzer_service.c,battery.c,main.c}, verified):
 *   Buzzer service  6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *     Button state  6e400002-...  READ | NOTIFY   1 byte. The firmware notifies `1` on PRESS only (no release
 *                                                 notification is ever sent; the 50 ms hardware debounce is in the firmware).
 *     LED control   6e400003-...  READ | WRITE    exactly 3 bytes [r, g, b] (any other length is rejected by the firmware).
 *                                                 The hardware has ONE white LED: it is ON when any channel is > 128, OFF
 *                                                 otherwise, and it stays as written (the firmware auto-off timer is never armed).
 *     Buzzer id     6e400004-...  READ            1 byte: 1 = green, 2 = red.
 *   Battery service 0x180F / level 0x2A19         READ | NOTIFY, 1 byte, percent.
 *   Advertised name "Gravitee Quiz Buzzer - Green|Red" (+ the 128-bit service UUID). The firmware accepts ONE connection.
 *
 * Differences from the legacy code (bugs fixed):
 *   - The colour is decided by the buzzer-id characteristic only (legacy: any id other than 1 became "red", and picking
 *     the wrong device for a row silently replaced the other buzzer without disconnecting it). Unknown ids are rejected,
 *     a device that belongs to another slot is connected as ITS colour (notice 'assigned'), and a slot that is already
 *     connected to a different device is never overwritten (error 'taken').
 *   - GATT operations are serialised per device (Web Bluetooth rejects overlapping operations with "GATT operation
 *     already in progress"; the legacy flash/off writes could collide with each other and with the battery read, and the
 *     delayed switch-off of one flash could clobber a newer flash).
 *   - Unexpected disconnects (gattserverdisconnected) reconnect automatically with exponential backoff + jitter.
 *     Manual disconnects, teardown and stale events are told apart with a generation counter, so a deliberate
 *     disconnect never triggers a reconnect and the "disconnected" event is not handled twice.
 *   - Every listener is removed on disconnect/destroy; connect has timeouts; the LED is switched off before a manual
 *     disconnect (the firmware would leave it lit); LED feedback checked `!status === 'connected'` (always false) -> fixed.
 *   - Presses are debounced on the client too (default 250 ms per buzzer) and presses are only a `1` byte.
 *   - Feature detection distinguishes "browser without Web Bluetooth" from "page is not a secure context (HTTPS)".
 */

export const UUID = Object.freeze({
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  buttonState: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  ledControl: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  buzzerId: '6e400004-b5a3-f393-e0a9-e50e24dcca9e',
  batteryService: '0000180f-0000-1000-8000-00805f9b34fb',
  batteryLevel: '00002a19-0000-1000-8000-00805f9b34fb',
});

/** Advertised name prefix (same filter as the legacy code). */
export const NAME_PREFIX = 'Gravitee Quiz Buzzer';
export const COLORS = Object.freeze(['green', 'red']);
/** Value of the buzzer-id characteristic -> colour. */
export const BUZZER_ID = Object.freeze({ 1: 'green', 2: 'red' });
/** Battery percentage at or below which a buzzer is flagged (firmware: BATTERY_LOW_MV = 3.4 V is about 20 %). */
export const BATTERY_LOW = 20;
/** LED colours (the real LED is white: only on/off matters to the current hardware). */
export const LED = Object.freeze({ green: [0, 255, 0], red: [255, 0, 0], off: [0, 0, 0] });

export class BuzzerError extends Error {
  /**
   * @param {'unsupported'|'insecure'|'cancelled'|'adapter'|'blocked'|'busy'|'timeout'|'connect-failed'|'protocol'|'unknown-id'|'taken'|'invalid'} code
   */
  constructor(code, message, { cause, color } = {}) {
    super(message || code);
    this.name = 'BuzzerError';
    this.code = code;
    if (cause) this.cause = cause;
    if (color) this.color = color;
  }
}

/** 'ok' | 'insecure' (not a secure context: HTTPS needed) | 'unsupported' (no Web Bluetooth in this browser). */
export function detectSupport(nav = typeof navigator !== 'undefined' ? navigator : undefined, win = typeof window !== 'undefined' ? window : undefined) {
  if (win && win.isSecureContext === false) return 'insecure';
  if (!nav || !nav.bluetooth || typeof nav.bluetooth.requestDevice !== 'function') return 'unsupported';
  return 'ok';
}

const GATT_OP_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeDisconnect(device) {
  try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch { /* already gone */ }
}

/** Write with response when the browser offers the explicit API (the LED characteristic is WRITE, not WRITE_NO_RESPONSE). */
const writeChar = (ch, data) => (typeof ch.writeValueWithResponse === 'function' ? ch.writeValueWithResponse(data) : ch.writeValue(data));

function toLedBytes(rgb) {
  const [r = 0, g = 0, b = 0] = rgb;
  const c = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  return Uint8Array.of(c(r), c(g), c(b)); // always exactly 3 bytes, as the firmware requires
}

/** Map a DOMException/Error from the browser to a BuzzerError. `stage` = 'chooser' | 'link'. */
function mapError(err, stage, color) {
  if (err instanceof BuzzerError) return err;
  const name = err?.name || '';
  const message = String(err?.message || '');
  if (stage === 'chooser') {
    if (name === 'NotFoundError' && /adapter/i.test(message)) return new BuzzerError('adapter', message, { cause: err, color });
    if (name === 'NotFoundError') return new BuzzerError('cancelled', message, { cause: err, color }); // "User cancelled the requestDevice() chooser."
    if (name === 'SecurityError' || name === 'NotAllowedError') return new BuzzerError('blocked', message, { cause: err, color });
    if (name === 'NotSupportedError') return new BuzzerError('unsupported', message, { cause: err, color });
  } else if (name === 'NotFoundError') {
    return new BuzzerError('protocol', message, { cause: err, color }); // service/characteristic missing: not one of our buzzers
  } else if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new BuzzerError('blocked', message, { cause: err, color });
  }
  return new BuzzerError('connect-failed', message || 'connect failed', { cause: err, color });
}

const makeSlot = (color) => ({
  color,
  state: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  gen: 0,                // bumped on every take-over / teardown: stale async work and stale events compare against it
  device: null,
  name: '',
  server: null,
  buttonChar: null,
  ledChar: null,
  battery: null,
  lowNotified: false,
  attempt: 0,
  timer: null,
  linkCleanups: [],      // characteristic listeners (removed on every link drop)
  deviceCleanup: null,   // gattserverdisconnected listener (lives as long as the device is owned by the slot)
  lastPress: 0,
  ledToken: 0,          // bumped by every LED command: an older pattern stops when it sees a newer token
  pattern: null,        // token of the feedback pattern currently playing, or null
});

/**
 * @param {object} [options]
 * @param {number} [options.debounceMs=250]          ignore a second press of the same buzzer within this window
 * @param {number} [options.connectTimeoutMs=12000]  GATT connect + discovery budget for a user-initiated connect
 * @param {number} [options.restoreTimeoutMs=6000]   same, for the silent restore of already-paired devices
 * @param {number[]} [options.reconnectDelays]       backoff in ms (last value repeats forever)
 * @param {number} [options.jitter=0.2]              +/- fraction applied to each delay
 * @param {Navigator} [options.nav]  @param {Window} [options.win]   injectable for tests
 */
export function createBuzzerManager(options = {}) {
  const {
    debounceMs = 250,
    connectTimeoutMs = 12000,
    restoreTimeoutMs = 6000,
    reconnectDelays = [500, 1000, 2000, 4000, 8000, 15000],
    jitter = 0.2,
    nav = typeof navigator !== 'undefined' ? navigator : undefined,
    win = typeof window !== 'undefined' ? window : undefined,
  } = options;

  const support = detectSupport(nav, win);
  const slots = { green: makeSlot('green'), red: makeSlot('red') };
  const listeners = { status: new Set(), press: new Set(), notice: new Set() };
  let destroyed = false;
  let chooserOpen = false;
  let adapter = null; // null = unknown, true/false from navigator.bluetooth.getAvailability()
  const globalCleanups = [];

  // ---------------------------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------------------------
  function emit(type, payload) {
    for (const cb of [...listeners[type]]) {
      try { cb(payload); } catch (e) { console.error(`buzzer ${type} listener failed`, e); }
    }
  }

  function snapshot() {
    const view = (s) => ({
      state: s.state,
      connected: s.state === 'connected',
      battery: s.battery,
      lowBattery: s.state === 'connected' && s.battery !== null && s.battery <= BATTERY_LOW,
      name: s.name || null,
      attempt: s.attempt,
    });
    const green = view(slots.green);
    const red = view(slots.red);
    const count = (green.connected ? 1 : 0) + (red.connected ? 1 : 0);
    return {
      supported: support === 'ok',
      support,
      adapter,
      green,
      red,
      count,
      level: count === 2 ? 'both' : count === 1 ? 'one' : 'none',
      reconnecting: green.state === 'reconnecting' || red.state === 'reconnecting',
      lowBattery: green.lowBattery || red.lowBattery,
    };
  }

  const emitStatus = () => { if (!destroyed) emit('status', snapshot()); };
  const notice = (type, data = {}) => { if (!destroyed) emit('notice', { type, ...data }); };

  function setState(slot, state) {
    if (slot.state === state) return;
    slot.state = state;
    emitStatus();
  }

  // ---------------------------------------------------------------------------------------------
  // GATT helpers
  // ---------------------------------------------------------------------------------------------
  /**
   * Serialise GATT operations PER DEVICE (Web Bluetooth rejects overlapping operations with "GATT operation already in
   * progress"). Everything that talks to a characteristic goes through here, whichever session issued it (a reconnect
   * attempt, a fresh connect, an LED write...), so a take-over can never make two operations collide on one device.
   */
  const deviceQueues = new WeakMap();
  function enqueue(device, op) {
    const prev = deviceQueues.get(device) || Promise.resolve();
    const run = prev.then(() => withTimeout(Promise.resolve().then(op), GATT_OP_TIMEOUT_MS, () => new BuzzerError('timeout', 'GATT operation timed out')));
    deviceQueues.set(device, run.catch(() => {}));
    return run;
  }

  async function writeLed(color, rgb) {
    const slot = slots[color];
    const ch = slot.ledChar;
    if (slot.state !== 'connected' || !ch || !slot.device) return false;
    try {
      await enqueue(slot.device, () => writeChar(ch, toLedBytes(rgb)));
      return true;
    } catch (err) {
      console.warn(`buzzer: LED write failed on the ${color} buzzer`, err?.name || err);
      return false;
    }
  }

  /** Discover the buzzer service and read the buzzer id. Does not subscribe to anything. */
  async function openSession(device, timeoutMs) {
    if (!device?.gatt) throw new BuzzerError('protocol', 'device has no GATT server');
    const server = await withTimeout(
      device.gatt.connect(),
      timeoutMs,
      () => { safeDisconnect(device); return new BuzzerError('timeout', 'GATT connect timed out'); },
    );
    const q = (op) => enqueue(device, op);
    const discover = (async () => {
      const service = await q(() => server.getPrimaryService(UUID.service));
      const buttonChar = await q(() => service.getCharacteristic(UUID.buttonState));
      const ledChar = await q(() => service.getCharacteristic(UUID.ledControl));
      const idChar = await q(() => service.getCharacteristic(UUID.buzzerId));
      const id = (await q(() => idChar.readValue())).getUint8(0);
      return { server, buttonChar, ledChar, id, color: BUZZER_ID[id] || null };
    })();
    return withTimeout(discover, 10000, () => { safeDisconnect(device); return new BuzzerError('timeout', 'GATT discovery timed out'); });
  }

  function setBattery(slot, level) {
    if (!Number.isFinite(level)) return;
    const value = Math.max(0, Math.min(100, Math.round(level)));
    const changed = slot.battery !== value;
    slot.battery = value;
    if (value <= BATTERY_LOW) {
      if (!slot.lowNotified) { slot.lowNotified = true; notice('battery-low', { color: slot.color, level: value }); }
    } else if (value > BATTERY_LOW + 5) {
      slot.lowNotified = false; // hysteresis: warn again only after a real recovery (new battery)
    }
    if (changed) emitStatus();
  }

  /**
   * Subscribe to the button + battery notifications and make the slot "connected".
   * Throws (after removing everything it added) when the link breaks or the slot was taken over meanwhile.
   */
  async function activate(slot, device, session, gen) {
    const { server, buttonChar, ledChar } = session;
    const cleanups = [];
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const undo = () => { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } } };
    const stale = () => slot.gen !== gen || destroyed;
    let batteryLevel = null;
    try {
      await enqueue(device, () => buttonChar.startNotifications());
      listen(buttonChar, 'characteristicvaluechanged', (event) => {
        const view = event.target?.value;
        if (!view || view.byteLength < 1 || slot.gen !== gen) return;
        if (view.getUint8(0) === 1) handlePress(slot); // 1 = pressed; the firmware never sends 0
      });

      // Battery is optional: a buzzer without the service still works.
      try {
        const service = await enqueue(device, () => server.getPrimaryService(UUID.batteryService));
        const batteryChar = await enqueue(device, () => service.getCharacteristic(UUID.batteryLevel));
        batteryLevel = (await enqueue(device, () => batteryChar.readValue())).getUint8(0);
        await enqueue(device, () => batteryChar.startNotifications());
        listen(batteryChar, 'characteristicvaluechanged', (event) => {
          const view = event.target?.value;
          if (view && view.byteLength >= 1 && slot.gen === gen) setBattery(slot, view.getUint8(0));
        });
      } catch (err) {
        if (!server.connected) throw err; // a drop, not a missing service
      }

      if (!server.connected) throw new BuzzerError('connect-failed', 'link dropped while subscribing');
      if (stale()) throw new BuzzerError('cancelled', 'superseded');
    } catch (err) {
      undo();
      throw err;
    }
    slot.server = server;
    slot.buttonChar = buttonChar;
    slot.ledChar = ledChar;
    slot.linkCleanups = cleanups;
    slot.attempt = 0;
    slot.battery = null;
    setBattery(slot, batteryLevel);
    setState(slot, 'connected');
  }

  function dropLink(slot) {
    for (const fn of slot.linkCleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
    slot.server = null;
    slot.buttonChar = null;
    slot.ledChar = null;
  }

  /** Release everything the slot owns. Does not change `state` (callers decide) and does not touch the device link. */
  function release(slot) {
    slot.gen += 1;
    clearTimeout(slot.timer);
    slot.timer = null;
    dropLink(slot);
    if (slot.deviceCleanup) { try { slot.deviceCleanup(); } catch { /* ignore */ } slot.deviceCleanup = null; }
    const device = slot.device;
    slot.device = null;
    slot.name = '';
    slot.battery = null;
    slot.attempt = 0;
    slot.ledToken += 1;
    return device;
  }

  // ---------------------------------------------------------------------------------------------
  // presses
  // ---------------------------------------------------------------------------------------------
  function handlePress(slot) {
    const at = Date.now();
    if (at - slot.lastPress < debounceMs) return;
    slot.lastPress = at;
    emit('press', { color: slot.color, at });
  }

  // ---------------------------------------------------------------------------------------------
  // unexpected disconnect -> reconnect with backoff
  // ---------------------------------------------------------------------------------------------
  function nextDelay(attempt) {
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 1000;
    return Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * jitter)));
  }

  function onGattDisconnected(slot, gen) {
    // Only a drop of an established link is "unexpected": during connect / reconnect attempts we disconnect on purpose.
    if (slot.gen !== gen || slot.state !== 'connected') return;
    dropLink(slot);
    slot.battery = null;
    slot.attempt = 0;
    setState(slot, 'reconnecting');
    notice('lost', { color: slot.color });
    scheduleReconnect(slot, gen);
  }

  function scheduleReconnect(slot, gen) {
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => attemptReconnect(slot, gen), nextDelay(slot.attempt));
  }

  async function attemptReconnect(slot, gen) {
    if (destroyed || slot.gen !== gen || slot.state !== 'reconnecting' || !slot.device) return;
    const device = slot.device;
    slot.attempt += 1;
    emitStatus();
    try {
      const session = await openSession(device, connectTimeoutMs);
      if (slot.gen !== gen) throw new BuzzerError('cancelled', 'superseded');
      if (session.color !== slot.color) throw new BuzzerError('unknown-id', 'device id changed');
      await activate(slot, device, session, gen);
      notice('reconnected', { color: slot.color });
      flashLed(slot.color, LED[slot.color], 200);
    } catch (err) {
      if (slot.gen !== gen || destroyed) return;
      safeDisconnect(device);
      scheduleReconnect(slot, gen);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // connect / restore / disconnect
  // ---------------------------------------------------------------------------------------------
  /**
   * Take a freshly chosen (or restored) device, find out which buzzer it is and make that slot connected.
   * @returns {Promise<'green'|'red'>} the colour it was connected as
   */
  async function adopt(device, { timeoutMs }) {
    const session = await openSession(device, timeoutMs).catch((err) => { safeDisconnect(device); throw mapError(err, 'link'); });
    const color = session.color;
    if (!color) {
      safeDisconnect(device);
      throw new BuzzerError('unknown-id', `unknown buzzer id ${session.id}`);
    }
    const slot = slots[color];
    if (slot.state === 'connected' && slot.device === device) return color; // same physical buzzer picked twice
    if (slot.state === 'connected') {
      safeDisconnect(device);
      throw new BuzzerError('taken', `${color} buzzer already connected`, { color });
    }

    // Take the slot over (it may be 'connecting' for this very request or 'reconnecting' on an old device).
    const previous = release(slot);
    if (previous && previous !== device) safeDisconnect(previous);
    const gen = slot.gen;
    slot.device = device;
    slot.name = device.name || '';
    setState(slot, 'connecting');
    const onDrop = () => onGattDisconnected(slot, gen);
    device.addEventListener('gattserverdisconnected', onDrop);
    slot.deviceCleanup = () => device.removeEventListener('gattserverdisconnected', onDrop);
    try {
      await activate(slot, device, session, gen);
    } catch (err) {
      // Only the current owner tears down: when the slot was taken over (or disconnected) meanwhile, whoever did it
      // is responsible for the device, and disconnecting here could cut the new link.
      if (slot.gen === gen) { release(slot); setState(slot, 'disconnected'); safeDisconnect(device); }
      throw mapError(err, 'link', color);
    }
    flashLed(color, LED[color], 200); // legacy behaviour: short confirmation flash
    return color;
  }

  /**
   * Open the browser's Bluetooth chooser (MUST run inside a user gesture) and connect the device the user picks.
   * The device is connected as the colour it reports, which may differ from `requested` (notice 'assigned').
   * @param {'green'|'red'} requested the row the user clicked
   * @returns {Promise<'green'|'red'>}
   */
  async function connect(requested) {
    if (!COLORS.includes(requested)) throw new BuzzerError('invalid', `unknown colour ${requested}`);
    if (destroyed) throw new BuzzerError('cancelled', 'destroyed');
    if (support !== 'ok') throw new BuzzerError(support, `Web Bluetooth ${support}`);
    const req = slots[requested];
    if (req.state !== 'disconnected' || chooserOpen) throw new BuzzerError('busy', 'a connection is already in progress', { color: requested });
    chooserOpen = true;
    const token = (req.gen += 1);
    setState(req, 'connecting');
    let device;
    try {
      try {
        device = await nav.bluetooth.requestDevice({
          filters: [{ namePrefix: NAME_PREFIX, services: [UUID.service] }],
          optionalServices: [UUID.batteryService],
        });
      } finally {
        chooserOpen = false;
      }
      if (req.gen !== token || destroyed) { safeDisconnect(device); throw new BuzzerError('cancelled', 'cancelled while choosing'); }
      const color = await adopt(device, { timeoutMs: connectTimeoutMs });
      if (destroyed) { safeDisconnect(device); throw new BuzzerError('cancelled', 'destroyed'); }
      notice(color === requested ? 'connected' : 'assigned', { color, requested });
      return color;
    } catch (err) {
      throw mapError(err, device ? 'link' : 'chooser', requested);
    } finally {
      // The requested row shows "connecting" for the duration of the request: give it back if it did not receive a device
      // (cancelled chooser, failure, or the device turned out to be the other colour).
      if (req.state === 'connecting' && !req.device) setState(req, 'disconnected');
    }
  }

  /**
   * Silently reconnect the buzzers this origin was already allowed to use (navigator.bluetooth.getDevices(), Chrome 122+).
   * No chooser, no user gesture needed; devices that are off or out of range are skipped quietly.
   * @returns {Promise<Array<'green'|'red'>>} colours that were restored
   */
  async function restore() {
    if (support !== 'ok' || destroyed || typeof nav.bluetooth.getDevices !== 'function') return [];
    let devices = [];
    try { devices = await nav.bluetooth.getDevices(); } catch { return []; }
    const candidates = devices.filter((d) => typeof d?.name === 'string' && d.name.startsWith(NAME_PREFIX));
    const results = await Promise.allSettled(candidates.map(async (device) => {
      const color = await adopt(device, { timeoutMs: restoreTimeoutMs });
      notice('connected', { color, requested: color, restored: true });
      return color;
    }));
    return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  }

  /** Manual disconnect: no reconnect, LED switched off first, UI state changes immediately. */
  async function disconnect(color) {
    if (!COLORS.includes(color)) return;
    const slot = slots[color];
    if (slot.state === 'disconnected') return;
    const wasConnected = slot.state === 'connected';
    const ledChar = slot.ledChar;
    const device = release(slot);
    setState(slot, 'disconnected');
    if (wasConnected) notice('disconnected', { color, manual: true });
    if (wasConnected && ledChar) {
      // best effort: leave the buzzer dark (the firmware keeps the LED as last written)
      await Promise.race([enqueue(device, () => writeChar(ledChar, toLedBytes(LED.off))).catch(() => {}), sleep(300)]);
    }
    safeDisconnect(device);
  }

  const disconnectAll = () => Promise.all(COLORS.map((c) => disconnect(c))).then(() => undefined);

  // ---------------------------------------------------------------------------------------------
  // LED feedback
  // ---------------------------------------------------------------------------------------------
  /** Light the LED for `ms`, then switch it off (a newer LED command cancels the pending switch-off). */
  async function pulse(color, rgb, ms) {
    const slot = slots[color];
    if (slot.state !== 'connected') return false;
    const token = (slot.ledToken += 1);
    slot.pattern = token;
    try {
      if (!(await writeLed(color, rgb))) return false;
      await sleep(ms);
      if (slot.ledToken === token) await writeLed(color, LED.off);
      return true;
    } finally {
      if (slot.pattern === token) slot.pattern = null;
    }
  }

  async function blink(color, rgb, times, onMs, offMs) {
    const slot = slots[color];
    if (slot.state !== 'connected') return false;
    const token = (slot.ledToken += 1);
    slot.pattern = token;
    try {
      for (let i = 0; i < times; i += 1) {
        if (slot.ledToken !== token) return true;
        if (!(await writeLed(color, rgb))) return false;
        await sleep(onMs);
        if (slot.ledToken !== token) return true;
        await writeLed(color, LED.off);
        if (i < times - 1) await sleep(offMs);
      }
      return true;
    } finally {
      if (slot.pattern === token) slot.pattern = null;
    }
  }

  /** Fire-and-forget LED flash. */
  function flashLed(color, rgb = LED[color], ms = 200) {
    void pulse(color, rgb, ms);
  }

  /**
   * Feedback on the buzzer that answered (legacy provideFeedback): one steady flash when the answer was correct,
   * three quick blinks when it was wrong (the hardware LED is white, so the pattern, not the colour, tells them apart).
   */
  function feedback(color, isCorrect) {
    if (!COLORS.includes(color)) return Promise.resolve(false);
    return isCorrect ? pulse(color, LED.green, 600) : blink(color, LED.red, 3, 120, 120);
  }

  /**
   * "Ready" state: both LEDs on while a question is open, off otherwise (documented in BUZZER_INTEGRATION.md).
   * setReady(false) never interrupts a feedback pattern that is still playing (it ends dark by itself), so
   * `feedback(color, ok); setReady(false)` composes; setReady(true) (next question) cancels it.
   */
  function setReady(on) {
    return Promise.all(COLORS.map((c) => {
      const slot = slots[c];
      if (slot.state !== 'connected') return false;
      if (!on && slot.pattern !== null) return false;
      slot.ledToken += 1;
      slot.pattern = null;
      return writeLed(c, on ? LED[c] : LED.off);
    })).then(() => undefined);
  }

  /** Legacy test pattern: green, red, green, red (300 ms each). Only connected buzzers take part. */
  async function testLeds() {
    const connected = COLORS.filter((c) => slots[c].state === 'connected');
    for (let round = 0; round < 2; round += 1) {
      for (const color of connected) {
        await pulse(color, LED[color], 300);
        await sleep(100);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------------------
  if (support === 'ok' && typeof nav.bluetooth.getAvailability === 'function') {
    nav.bluetooth.getAvailability().then((value) => { adapter = !!value; emitStatus(); }).catch(() => {});
    if (typeof nav.bluetooth.addEventListener === 'function') {
      const onAvailability = (event) => { adapter = !!event.value; emitStatus(); };
      nav.bluetooth.addEventListener('availabilitychanged', onAvailability);
      globalCleanups.push(() => nav.bluetooth.removeEventListener('availabilitychanged', onAvailability));
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true; // from here on no event is emitted and no async continuation touches the slots
    for (const c of COLORS) {
      const slot = slots[c];
      const ledChar = slot.state === 'connected' ? slot.ledChar : null;
      const device = release(slot);
      slot.state = 'disconnected';
      // best effort: leave the buzzer dark (the firmware keeps the LED as last written), then drop the link
      void (async () => {
        if (ledChar && device) await Promise.race([enqueue(device, () => writeChar(ledChar, toLedBytes(LED.off))).catch(() => {}), sleep(300)]);
        safeDisconnect(device);
      })();
    }
    for (const fn of globalCleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
    for (const set of Object.values(listeners)) set.clear();
  }

  function on(type, cb) {
    if (!listeners[type] || typeof cb !== 'function') return () => {};
    listeners[type].add(cb);
    return () => listeners[type].delete(cb);
  }

  return {
    support,
    get supported() { return support === 'ok'; },
    getStatus: snapshot,
    on,
    connect,
    restore,
    disconnect,
    disconnectAll,
    feedback,
    flashLed,
    setReady,
    testLeds,
    destroy,
  };
}
