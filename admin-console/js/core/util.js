/**
 * core/util.js - small helpers shared by the admin shell and the shell-owned views (events, overview).
 * Private to the shell: the tab views written by other people talk to the shell only through `ctx`.
 */
import { el, icon, formatDate, formatNumber } from '../../shared/js/dom.js';

/** Event tabs, in navigation order (route id, nav title, sprite icon). */
export const TABS = [
  { id: 'overview', title: 'Overview', icon: 'chart-bar' },
  { id: 'questions', title: 'Questions', icon: 'question' },
  { id: 'categories', title: 'Categories', icon: 'tag' },
  { id: 'results', title: 'Results', icon: 'users-three' },
  { id: 'settings', title: 'Settings', icon: 'sliders-horizontal' },
  { id: 'appearance', title: 'Appearance', icon: 'palette' },
];
export const TAB_IDS = TABS.map((t) => t.id);

/** draft / live / closed presentation (label, badge classes, icon, one-line meaning). */
export const STATUS = {
  draft: { label: 'Draft', badge: 'badge--warning', icon: 'pencil-simple', hint: 'Hidden from the hub. Players cannot reach it; you can preview it while signed in.' },
  live: { label: 'Live', badge: 'badge--success', icon: 'play-fill', hint: 'Listed on the hub and playable.' },
  closed: { label: 'Closed', badge: '', icon: 'flag-checkered', hint: 'Not listed and not playable. The scoreboard stays viewable.' },
};
export const STATUS_ORDER = { live: 0, draft: 1, closed: 2 };

/** Status badge element. */
export function statusBadge(status, { dot = true } = {}) {
  const s = STATUS[status] || STATUS.draft;
  return el('span', { class: ['badge', s.badge, dot && 'badge--dot'], dataset: { status } }, s.label);
}

/**
 * A colour that may go into a CSS custom property. Event colours come from the API, or from a bundle file picked by the admin
 * (untrusted): a value such as `url(https://…)` must never reach `style`.
 */
export const safeColor = (value, fallback = 'var(--fg-muted)') => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback);

/** Same rule as the backend (_validate_asset_url): `https://…` or a root-relative path, nothing else (no javascript:, data:, //host, \ tricks). */
export const isSafeAssetUrl = (u) => typeof u === 'string' && !/[\s<>"'`\\\u0000-\u001f\u007f]/.test(u) && (/^https:\/\/[^/]/i.test(u) || /^\/(?![/\\])/.test(u));

/** Small two-colour square showing an event's primary / accent colours. */
export function brandSwatch(branding, { size } = {}) {
  const b = branding || {};
  return el('span', {
    class: 'bsw', 'aria-hidden': 'true',
    style: { '--c1': safeColor(b.primary_color, '#FC5607'), '--c2': safeColor(b.accent_color, '#FF9A52'), ...(size ? { '--bsw-size': size } : {}) },
  });
}

/** Logo image (or the trophy icon when there is none / the image fails to load) for an event medallion. */
export function medalContent(branding, iconSize = '1.6rem') {
  const url = branding?.logo_url;
  const fallback = () => icon('trophy-fill', { size: iconSize });
  if (!url || !isSafeAssetUrl(url)) return fallback();
  const holder = el('span', { class: 'medal-img' });
  const img = el('img', { src: url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => holder.replaceChildren(fallback()), { once: true });
  holder.append(img);
  return holder;
}

/** Reserved slugs (docs/ARCHITECTURE.md section 1): the backend enforces the same list. */
export const RESERVED_SLUGS = new Set('api admin assets shared css js vendor fonts static health docs openapi favicon robots scoreboard game events new login config index manifest sw'.split(' '));

/**
 * Client-side slug check mirroring the backend rules, plus a uniqueness hint against the known events.
 * @returns {string|null} a human message when the slug is not usable
 */
export function slugProblem(slug, events = [], ignoreId = null) {
  if (!slug) return 'Choose a URL slug.';
  if (slug.length < 2 || slug.length > 48) return 'Use 2 to 48 characters.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Lowercase letters, digits and single hyphens only (no leading, trailing or double hyphen).';
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved by the platform.`;
  const clash = events.find((e) => e.slug === slug && e.id !== ignoreId);
  if (clash) return `Already used by "${clash.name}".`;
  return null;
}

/** Suggest a free slug: base, base-2, base-3 ... */
export function freeSlug(base, events = []) {
  const taken = new Set(events.map((e) => e.slug));
  let slug = (base || 'event').slice(0, 44).replace(/-+$/, '') || 'event';
  if (!taken.has(slug) && !RESERVED_SLUGS.has(slug) && slug.length >= 2) return slug;
  for (let i = 2; i < 100; i++) {
    const next = `${slug}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

/** '7 Oct 2026' / '7 - 8 Oct 2026' / '' */
export function dateRange(a, b) {
  if (!a && !b) return '';
  if (!b || a === b) return formatDate(`${a || b}T12:00:00`);
  if (!a) return formatDate(`${b}T12:00:00`);
  const f = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
  const da = new Date(`${a}T12:00:00`), db = new Date(`${b}T12:00:00`);
  return typeof f.formatRange === 'function' ? f.formatRange(da, db) : `${formatDate(da)} - ${formatDate(db)}`;
}

/** Localised-free short time "14:03:09". */
export function clockTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

export const fmt = (n) => formatNumber(n);

/** Human error line from anything thrown by the api client. */
export function errorText(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (err.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
  if (err.isTimeout) return 'The server took too long to answer. Try again.';
  if (typeof err.detail === 'string' && err.detail) return err.detail;
  return err.message || fallback;
}

/** node.replaceChildren(...) that ignores null / false (replaceChildren(null) would insert the text "null"). */
export function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return node;
}

/** Last path segment safe file stem. */
export const fileStem = (s) => String(s || 'event').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'event';

/** Readiness helper: does this event have fewer active questions than one game needs? */
export function needsQuestions(event) {
  const need = event?.settings?.questions_per_game ?? 0;
  const have = event?.counts?.active_questions ?? 0;
  return have < need;
}
