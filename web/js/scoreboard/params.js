/**
 * params.js - URL contract of the scoreboard.
 *   /{slug}/scoreboard?limit=10&lang=fr&theme=dark&qr=0&rotate=1
 */
export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 3;
export const MAX_LIMIT = 50;
export const ROTATE_MS = 12000;

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Event slug from the pathname: "/ai-masters/scoreboard/" -> "ai-masters". */
export function slugFromPath(pathname = location.pathname) {
  const first = pathname.split('/').filter(Boolean)[0] || '';
  try { return decodeURIComponent(first); } catch { return first; }
}

/** @returns {{limit:number, qr:boolean, rotate:boolean, theme:('dark'|'light'|'system'|null)}} */
export function readParams(search = location.search) {
  const q = new URLSearchParams(search);
  const n = Number.parseInt(q.get('limit') ?? '', 10);
  const limit = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n)) : DEFAULT_LIMIT;
  const qrRaw = (q.get('qr') ?? '').toLowerCase();
  const rotRaw = (q.get('rotate') ?? '').toLowerCase();
  const theme = q.get('theme');
  return {
    limit,
    qr: !FALSE.has(qrRaw),
    rotate: TRUE.has(rotRaw),
    theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : null,
  };
}
