/**
 * Optional buzzer support. web/js/buzzer/index.js (Web Bluetooth + keyboard) is built separately: it is loaded with a
 * guarded dynamic import, so the game works the same without it (the module can be missing, or throw).
 *
 * Contract: createBuzzerController({ i18n, onPress(color) }) -> { buttonEl, open(), destroy(), isSupported }
 */
const MODULE_URL = '/js/buzzer/index.js';

/**
 * @param {{i18n: object, onPress: (color: 'green'|'red') => void}} opts
 * @returns {Promise<null | {buttonEl: HTMLElement, open: () => void, destroy: () => void, isSupported: boolean}>}
 */
export async function loadBuzzer({ i18n, onPress }) {
  try {
    const mod = await import(/* @vite-ignore */ MODULE_URL);
    if (typeof mod.createBuzzerController !== 'function') return null;
    const controller = mod.createBuzzerController({ i18n, onPress });
    return controller && controller.buttonEl instanceof HTMLElement ? controller : null;
  } catch (e) {
    console.info('Buzzer module not available, continuing with taps and keyboard only.', e?.message || e);
    return null;
  }
}
