/**
 * Kiosk mode (?kiosk=1): the booth laptop resets itself for the next visitor.
 *  - results screen: 45 s (handled by the results view)
 *  - any other view, except a running game / saving: 120 s without input -> back to the landing page
 */
export const IDLE_SECONDS = 120;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];

/**
 * @param {{enabled: boolean, idleSeconds?: number, getView: () => string, onIdle: () => void}} opts
 * @returns {{touch(): void, destroy(): void}}
 */
export function createKiosk({ enabled, idleSeconds = IDLE_SECONDS, getView, onIdle }) {
  if (!enabled) return { touch() {}, destroy() {} };
  let last = Date.now();
  const touch = () => { last = Date.now(); };
  INPUT_EVENTS.forEach((type) => window.addEventListener(type, touch, { capture: true, passive: true }));
  const timer = setInterval(() => {
    const view = getView();
    if (view === 'game' || view === 'saving') { last = Date.now(); return; }
    if (Date.now() - last >= idleSeconds * 1000) { last = Date.now(); onIdle(); }
  }, 1000);
  return {
    touch,
    destroy() {
      clearInterval(timer);
      INPUT_EVENTS.forEach((type) => window.removeEventListener(type, touch, { capture: true }));
    },
  };
}
