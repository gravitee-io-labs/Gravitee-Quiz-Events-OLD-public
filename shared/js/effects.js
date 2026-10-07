/**
 * effects.js - celebratory / feedback effects. Every effect is a no-op (or instant) under prefers-reduced-motion.
 */
import { prefersReducedMotion } from './dom.js';
export { prefersReducedMotion };

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

/**
 * Animate a number inside an element (score count-up).
 * @param {HTMLElement} node
 * @param {number} to
 * @param {{from?:number, duration?:number, format?:(n:number)=>string, easing?:(t:number)=>number}} [opts]
 * @returns {{finished: Promise<void>, cancel: ()=>void}}
 */
export function countUp(node, to, { from = 0, duration = 1400, format, easing = easeOutCubic } = {}) {
  const fmt = format || ((n) => new Intl.NumberFormat(document.documentElement.lang || 'en').format(Math.round(n)));
  let raf = 0, cancelled = false, resolve;
  const finished = new Promise((r) => { resolve = r; });
  if (prefersReducedMotion() || duration <= 0 || from === to) { node.textContent = fmt(to); resolve(); return { finished, cancel() {} }; }
  const start = performance.now();
  const tick = (now) => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / duration);
    node.textContent = fmt(from + (to - from) * easing(t));
    if (t < 1) raf = requestAnimationFrame(tick); else resolve();
  };
  raf = requestAnimationFrame(tick);
  return { finished, cancel() { cancelled = true; cancelAnimationFrame(raf); node.textContent = fmt(to); resolve(); } };
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n, d) => cs.getPropertyValue(n).trim() || d;
  return [get('--brand-solid', '#FC5607'), get('--accent-solid', '#FF9A52'), get('--gold', '#FFC83D'), get('--green', '#4CD964'), '#FFFFFF', get('--brand-text', '#FF6D39')];
}

/**
 * Confetti burst on a full-screen canvas (pointer-events: none, removed when done).
 * @param {{count?:number, colors?:string[], origin?:{x:number,y:number}, spread?:number, angle?:number, power?:number, duration?:number, gravity?:number, zIndex?:number}} [opts]
 *        origin is 0..1 of the viewport (default bottom-centre-ish); angle in degrees (90 = straight up)
 * @returns {{finished: Promise<void>, cancel: ()=>void}}
 */
export function confetti({ count = 120, colors, origin = { x: 0.5, y: 0.65 }, spread = 70, angle = 90, power = 1, duration = 3200, gravity = 1, zIndex = 9000 } = {}) {
  let resolve;
  const finished = new Promise((r) => { resolve = r; });
  if (prefersReducedMotion()) { resolve(); return { finished, cancel() {} }; }
  const palette = colors?.length ? colors : themeColors();
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: String(zIndex) });
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const rad = (d) => (d * Math.PI) / 180;
  const parts = Array.from({ length: count }, () => {
    const a = rad(angle + (Math.random() - 0.5) * spread * 2);
    const v = (9 + Math.random() * 13) * power;
    return {
      x: origin.x * W, y: origin.y * H,
      vx: Math.cos(a) * v, vy: -Math.sin(a) * v,
      w: 6 + Math.random() * 7, h: 4 + Math.random() * 6,
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.4,
      wob: Math.random() * 10, color: palette[(Math.random() * palette.length) | 0],
      shape: Math.random() < 0.25 ? 'circle' : 'rect', life: 0,
    };
  });
  const start = performance.now();
  let raf = 0, done = false;
  const end = () => { if (done) return; done = true; cancelAnimationFrame(raf); canvas.remove(); resolve(); };
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    const fade = t > duration * 0.7 ? Math.max(0, 1 - (t - duration * 0.7) / (duration * 0.3)) : 1;
    for (const p of parts) {
      p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.42 * gravity;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.wob += 0.12;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      const squash = Math.abs(Math.cos(p.wob));
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2.4, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, (-p.h / 2) * squash, p.w, p.h * squash + 0.5);
      ctx.restore();
    }
    if (t < duration) raf = requestAnimationFrame(frame); else end();
  };
  raf = requestAnimationFrame(frame);
  return { finished, cancel: end };
}

/** Bigger celebration for the results screen: a centre burst plus two side cannons. */
export function celebrate(opts = {}) {
  const a = confetti({ count: 90, origin: { x: 0.5, y: 0.6 }, spread: 60, power: 1.1, ...opts });
  const b = confetti({ count: 60, origin: { x: 0, y: 0.8 }, angle: 60, spread: 35, ...opts });
  const c = confetti({ count: 60, origin: { x: 1, y: 0.8 }, angle: 120, spread: 35, ...opts });
  return { finished: Promise.all([a.finished, b.finished, c.finished]).then(() => {}), cancel() { a.cancel(); b.cancel(); c.cancel(); } };
}

/** Run a DOM update inside a View Transition when supported (smooth cross-fade between screens), else just run it. */
export function transition(update) {
  if (typeof document.startViewTransition === 'function' && !prefersReducedMotion()) return document.startViewTransition(update).finished;
  return Promise.resolve(update());
}

/** Quick attention animations via the Web Animations API (reduced-motion safe). */
export function shake(node) {
  if (prefersReducedMotion() || !node.animate) return;
  node.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 420, easing: 'ease-out' });
}
export function pulse(node) {
  if (prefersReducedMotion() || !node.animate) return;
  node.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'ease-out' });
}
