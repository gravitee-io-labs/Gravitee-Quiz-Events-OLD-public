/**
 * View transition wrapper. shared/js/effects.js `transition()` returns `.finished` only: when the browser aborts a
 * transition (orientation change / viewport resize mid-way, a newer transition starting) `ready` and
 * `updateCallbackDone` reject with nobody listening, which Chrome reports as an uncaught error in the console.
 * Same behaviour (cross-fade when supported and motion is allowed), every promise handled.
 */
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** @param {() => void} update runs exactly once, inside the transition when there is one @returns {Promise<void>} */
export function transition(update) {
  if (typeof document.startViewTransition === 'function' && !reduced()) {
    try {
      const t = document.startViewTransition(update);
      t.ready?.catch(() => {});
      t.updateCallbackDone?.catch(() => {});
      return t.finished.catch(() => {});
    } catch { /* fall through: run the update without animation */ }
  }
  return Promise.resolve(update());
}
