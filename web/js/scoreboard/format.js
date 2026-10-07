/**
 * format.js - small formatting helpers (relative time, ISO parsing, short URL).
 */
const rtfCache = new Map();

/** Date.parse that also copes with microsecond fractions ("...:26.284327Z") on every engine. */
export function parseIso(value) {
  if (!value) return NaN;
  const iso = String(value).replace(/(\.\d{3})\d+/, '$1');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/**
 * "5 min ago" / "il y a 5 min". Under 45 s returns `justNow` (the caller's translated "just now").
 * @param {string} iso completed_at
 * @param {string} lang
 * @param {number} now ms epoch (server-corrected)
 * @param {string} justNow
 */
export function timeAgo(iso, lang, now, justNow) {
  const t = parseIso(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return justNow;
  let rtf = rtfCache.get(lang);
  if (!rtf) { rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' }); rtfCache.set(lang, rtf); }
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

/** "https://quiz.events.gravitee.io/ai-masters" -> "quiz.events.gravitee.io/ai-masters" */
export function shortUrl(url) {
  return String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Offset (ms) to add to Date.now() to get server time, from the HTTP Date header of a cheap request. */
export async function measureClockSkew(url = '/api/health') {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    const t1 = Date.now();
    const header = res.headers.get('date');
    const server = header ? Date.parse(header) : NaN;
    if (Number.isNaN(server)) return 0;
    // the Date header has 1 s resolution: aim at the middle of that second and of the round trip
    const skew = server + 500 - (t0 + t1) / 2;
    return Math.abs(skew) < 2000 ? 0 : Math.round(skew); // ignore sub-2 s noise, correct real drift
  } catch { return 0; }
}

/**
 * Formatter for countUp(): never shows a negative number. shared/js/effects.js countUp measures its start time with
 * performance.now() but receives the (earlier) rAF timestamp on the first frame, so t can be slightly < 0 and the
 * ease-out curve then undershoots (a new 137 point score flashed "-1" for one frame).
 */
export const countFormat = (nf) => (n) => nf(Math.max(0, Math.round(n)));
