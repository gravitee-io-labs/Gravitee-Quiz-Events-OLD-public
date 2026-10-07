/**
 * Small pure helpers shared by the hub and the event page.
 */

const NBSP = '  ';

/** '2026-10-07' (a calendar date, no timezone) -> Date at UTC midnight. */
function parseDay(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * '7 Oct 2026' / '7 - 8 Oct 2026' for date-only strings. Formats in UTC so a calendar date never shifts
 * to the previous day in negative-offset time zones.
 */
export function formatEventDates(lang, startsOn, endsOn) {
  const a = parseDay(startsOn);
  const b = parseDay(endsOn);
  if (!a && !b) return '';
  const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  // the events are European: English is day-first ("7 Oct 2026"), like the design system's own date helpers
  const f = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, opts);
  if (!a || !b || a.getTime() === b.getTime()) return f.format(a || b);
  return typeof f.formatRange === 'function' ? f.formatRange(a, b) : `${f.format(a)} - ${f.format(b)}`;
}

/** "Location · dates" pieces that exist. */
export function eventWhere(event) {
  return (event.location || '').trim();
}

/**
 * Split a hero title into [before, highlighted, after] so the highlighted part gets the brand gradient.
 *   "Become THE Ultimate AI Master!"  -> ["Become THE ", "Ultimate AI Master", "!"]
 *   "Devenez LE Maitre de l'IA !"     -> ["Devenez LE ", "Maitre de l'IA", " !"]
 * Falls back to the last word. Returns [title, '', ''] when nothing sensible can be highlighted.
 */
export function splitHero(title) {
  const s = String(title || '').trim();
  if (!s) return ['', '', ''];
  const tail = `[${NBSP}\\s]*[!?.…]*`;
  let m = s.match(new RegExp(`^(.*?\\b(?:THE|LE|LA|LES|L['’]|UN|UNE)[${NBSP}\\s]+)(.+?)(${tail})$`, 'u'));
  if (m && m[2].trim()) return [m[1], m[2], m[3]];
  m = s.match(new RegExp(`^(.*[${NBSP}\\s])(\\S+?)(${tail})$`, 'u'));
  if (m && m[2]) return [m[1], m[2], m[3]];
  return [s, '', ''];
}

/** "API Masters" -> "API Master" (only for plural-looking last words, used by the default hero title). */
export function singularTitle(title) {
  return String(title || '').replace(/(\w{2,}(?:er|or|ard|ist|ion))s$/iu, '$1');
}

/**
 * True for an `https://host/...` URL or a root-relative path (`/assets/x.png`): same rule as the backend (_validate_asset_url).
 * Never javascript: / data: / vbscript:, never protocol-relative (`//host`, `/\host`), never whitespace, quotes, angle brackets or
 * control characters (a tab or newline inside the scheme is how filters get bypassed).
 */
export function isSafeImageUrl(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || /[\s<>"'`\\\u0000-\u001f\u007f]/.test(u)) return false;
  return /^https:\/\/[^/]/i.test(u) || /^\/(?![/\\])/.test(u);
}

/** A colour that may go into a CSS custom property (`--chip`): `#RGB[A]` / `#RRGGBB[AA]` only, anything else gets `fallback`. */
export function safeColor(color, fallback = 'var(--fg-muted)') {
  return typeof color === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : fallback;
}

/** Rounds to 3 decimals (time_taken in seconds). */
export const round3 = (n) => Math.round(n * 1000) / 1000;
