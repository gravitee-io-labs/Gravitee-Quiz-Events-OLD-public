/**
 * kiosk.js - big-screen niceties: fullscreen toggle (button + "F" key), idle detection (controls and cursor fade
 * after 3 s without input, come back on movement / key / touch / focus) and a screen wake lock so the TV never sleeps.
 */
const IDLE_MS = 3000;

export function initKiosk({ button, getLabels }) {
  const root = document.documentElement;
  const fsEnabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  // ---------------------------------------------------------------- fullscreen
  function paintButton() {
    const on = isFs();
    const labels = getLabels();
    const text = on ? labels.exit : labels.enter;
    button.setAttribute('aria-label', text);
    button.title = text;
    button.setAttribute('aria-pressed', String(on));
    root.classList.toggle('is-fullscreen', on);
  }
  async function toggleFullscreen() {
    try {
      if (isFs()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    } catch { /* refused (no user gesture, iframe policy): nothing to do */ }
  }
  if (fsEnabled) {
    button.hidden = false;
    button.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', paintButton);
    document.addEventListener('webkitfullscreenchange', paintButton);
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(input|textarea|select)$/i.test(e.target?.tagName || '')) {
        e.preventDefault();
        toggleFullscreen();
      }
    });
  }
  paintButton();

  // ---------------------------------------------------------------- idle (controls + cursor)
  let idleTimer = null;
  let lastX = -1;
  let lastY = -1;
  const wake = () => {
    root.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('is-idle'), IDLE_MS);
  };
  document.addEventListener('pointermove', (e) => {
    // browsers fire synthetic moves when content slides under a still cursor: ignore sub-pixel noise
    if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) < 4) return;
    lastX = e.clientX; lastY = e.clientY;
    wake();
  }, { passive: true });
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel']) document.addEventListener(type, wake, { passive: true });
  document.addEventListener('focusin', wake);
  wake();

  // ---------------------------------------------------------------- wake lock
  let sentinel = null;
  async function requestLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch { /* unsupported, battery saver, insecure origin: harmless */ }
  }
  requestLock();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !sentinel) requestLock(); });

  return { toggleFullscreen, paintButton, get wakeLockActive() { return !!sentinel; } };
}
