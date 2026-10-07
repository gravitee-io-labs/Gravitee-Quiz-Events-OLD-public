/**
 * render.js - the live board: podium (ranks 1-3) + leaderboard rows (rank 4..N).
 *
 * Rules of the house:
 *  - entries are diffed by id (game session id): DOM nodes are created once and reused, text is only touched when
 *    it changed, nothing is re-rendered when the data did not change (signature check);
 *  - motion is FLIP (rows slide to their new position), count-up on scores, a "just finished" highlight (6 s) for
 *    newcomers, confetti when a brand new #1 appears. All of it is skipped on the first paint after (re)load,
 *    for hidden views, and under prefers-reduced-motion (the highlight then stays, static);
 *  - rows are sized to the available height (fit mode): the number of visible rows adapts to the screen.
 */
import { el, icon, avatarHue, initials } from '/shared/js/dom.js';
import { countUp, celebrate, prefersReducedMotion } from '/shared/js/effects.js';
import { announce } from '/shared/js/ui.js';
import { timeAgo, countFormat } from './format.js';

export const FRESH_MS = 6000;
const GHOST_UP_TO_RANK = 10;     // "open spot" placeholder rows are only drawn up to this rank
const MIN_ROW_REM = 2.8;        // below this a row stops being readable from a distance
const MAX_ROW_REM = 6.4;
const ANNOUNCE_GAP_MS = 5000;
const EASE = 'cubic-bezier(0.2, 0.9, 0.25, 1)';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** Initials, falling back to the first character (emoji, symbols) when the name has no letter. */
function initialsOf(name) {
  const base = initials(name);
  if (base && base !== '?') return base;
  const first = graphemes ? graphemes.segment(String(name).trim())[Symbol.iterator]().next().value?.segment : Array.from(String(name).trim())[0];
  return first || '?';
}
function setAvatar(node, name) {
  setText(node, initialsOf(name));
  node.style.setProperty('--hue', String(avatarHue(name)));
}

/**
 * @param {{ podiumEl:HTMLElement, listEl:HTMLElement, bodyEl:HTMLElement, i18n:any, limit:number,
 *           now:()=>number, isFit:()=>boolean, isVisible:()=>boolean }} cfg
 */
export function createBoard({ podiumEl, listEl, bodyEl, i18n, limit, now, isFit, isVisible }) {
  const t = (key, params) => i18n.t(key, params);
  const nf = (n) => i18n.number(n);
  const timeNodes = new Set();

  // ---------------------------------------------------------------- shared pieces
  /** "check 13 / cross 2" pair + screen reader text. */
  function statNodes() {
    const mk = (name, cls) => el('span', { class: `sb-stat ${cls}` }, icon(name), el('span', { 'aria-hidden': 'true' }), el('span', { class: 'u-sr-only' }));
    return { ok: mk('check-bold', 'sb-stat--ok'), ko: mk('x-bold', 'sb-stat--ko') };
  }
  function fillStats(nodes, e) {
    setText(nodes.ok.children[1], String(e.correct_answers));
    setText(nodes.ok.children[2], t('board.correct_n', { count: e.correct_answers }));
    setText(nodes.ko.children[1], String(e.wrong_answers));
    setText(nodes.ko.children[2], t('board.wrong_n', { count: e.wrong_answers }));
  }
  function makeTime() {
    const node = el('time', { class: 'sb-time' });
    timeNodes.add(node);
    return node;
  }
  function fillTime(node, e) {
    node.dataset.t = e.completed_at || '';
    if (e.completed_at) node.setAttribute('datetime', e.completed_at);
    setText(node, e.completed_at ? timeAgo(e.completed_at, i18n.lang, now(), t('board.just_now')) : '');
  }
  const makeBadge = () => el('span', { class: 'sb-fresh badge badge--solid' }, icon('sparkle-fill'), el('span'));
  const fillBadge = (badge) => setText(badge.lastElementChild, t('board.just_finished'));

  const counters = new WeakMap();
  /** Show a number, counting up from `from` when `animate` (cancels a running count on the same node). */
  function showNumber(node, to, { from = to, animate = false, duration = 1100 } = {}) {
    counters.get(node)?.cancel();
    counters.delete(node);
    if (!animate || from === to || prefersReducedMotion()) { setText(node, nf(to)); return; }
    setText(node, nf(from));                                   // no empty frame before the first tick
    counters.set(node, countUp(node, to, { from, duration, format: countFormat(nf) }));
  }

  // ---------------------------------------------------------------- podium
  function buildSlot(rank) {
    const avatarEl = el('span', { class: 'avatar avatar--xl podium__avatar', 'aria-hidden': 'true' }, '?');
    const nameEl = el('div', { class: 'podium__name' });
    const num = el('span', { class: 'sb-num' }, '–');
    const pts = el('span', { class: 'u-sr-only' });
    const stats = statNodes();
    const time = makeTime();
    const badge = makeBadge();
    const card = el('div', { class: 'sb-place__card' },
      avatarEl, nameEl,
      el('div', { class: 'podium__score' }, num, pts),
      el('div', { class: 'podium__meta sb-place__meta' }, stats.ok, stats.ko, time, badge));
    const root = el('div', { class: 'podium__place sb-place is-empty', role: 'listitem', dataset: { rank } },
      rank === 1 ? icon('crown-fill', { class: 'podium__crown' }) : null,
      card,
      el('div', { class: 'podium__block' }, el('span', { class: 'podium__rank', 'aria-hidden': 'true' }, String(rank))));
    return { root, card, avatarEl, nameEl, num, pts, stats, time, badge, id: null, score: 0 };
  }
  const slots = [1, 2, 3].map(buildSlot);
  podiumEl.replaceChildren(...slots.map((s) => s.root));

  function setSlot(slot, e, { animate, count }) {
    if (!e) {
      slot.id = null; slot.score = 0;
      slot.root.classList.add('is-empty');
      slot.root.dataset.id = '';
      setAvatar(slot.avatarEl, '?');
      setText(slot.nameEl, t('board.your_name'));
      slot.nameEl.removeAttribute('title');
      counters.get(slot.num)?.cancel();
      setText(slot.num, '–');
      setText(slot.pts, '');
      for (const n of [slot.stats.ok, slot.stats.ko]) { setText(n.children[1], '–'); setText(n.children[2], ''); }
      slot.time.dataset.t = ''; slot.time.removeAttribute('datetime'); setText(slot.time, '');
      fillBadge(slot.badge);
      return;
    }
    const swapped = slot.id !== e.id;
    const from = slot.id === null ? 0 : slot.score;
    slot.root.classList.remove('is-empty');
    slot.root.dataset.id = String(e.id);
    setAvatar(slot.avatarEl, e.player_name);
    setText(slot.nameEl, e.player_name);
    slot.nameEl.title = e.player_name;
    setText(slot.pts, ` ${t('board.points')}`);
    fillStats(slot.stats, e);
    fillTime(slot.time, e);
    fillBadge(slot.badge);
    showNumber(slot.num, e.score, { from, animate: animate && count && (swapped || from !== e.score), duration: swapped ? 1300 : 900 });
    if (swapped && animate && slot.id !== null && !prefersReducedMotion()) {
      slot.card.animate([{ opacity: 0, transform: 'translateY(18px) scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EASE });
    }
    slot.id = e.id;
    slot.score = e.score;
  }

  // ---------------------------------------------------------------- rows
  const rows = new Map();   // entry id -> row
  const ghosts = [];        // by rank
  function buildRow() {
    const rankNum = el('span', { class: 'sb-rank-n' });
    const avatarEl = el('span', { class: 'avatar avatar--sm sb-row__avatar', 'aria-hidden': 'true' });
    const nameEl = el('span', { class: 'lb__name' });
    const stats = statNodes();
    const time = makeTime();
    const badge = makeBadge();
    const num = el('span', { class: 'sb-num' });
    const pts = el('span', { class: 'u-sr-only' });
    const root = el('li', { class: 'lb__row sb-row' },
      el('span', { class: 'lb__rank' }, rankNum),
      avatarEl,
      el('span', { class: 'sb-row__who' }, nameEl, el('span', { class: 'lb__sub' }, stats.ok, stats.ko, time, badge)),
      el('span', { class: 'lb__score' }, num, pts));
    return { root, rankNum, avatarEl, nameEl, time, badge, stats, num, pts, id: null, score: 0 };
  }
  function setRow(row, e, rank, { animate, count }) {
    const swapped = row.id !== e.id;
    const from = row.id === null ? 0 : row.score;
    row.id = e.id;
    row.root.dataset.id = String(e.id);
    row.root.dataset.rank = String(rank);
    setText(row.rankNum, String(rank));
    setAvatar(row.avatarEl, e.player_name);
    setText(row.nameEl, e.player_name);
    row.nameEl.title = e.player_name;
    fillStats(row.stats, e);
    fillTime(row.time, e);
    fillBadge(row.badge);
    setText(row.pts, ` ${t('board.points')}`);
    showNumber(row.num, e.score, { from, animate: animate && count && (swapped || from !== e.score), duration: 1000 });
    row.score = e.score;
  }
  function ghostRow(rank) {
    let g = ghosts[rank];
    if (!g) {
      g = el('li', { class: 'lb__row sb-row is-ghost', 'aria-hidden': 'true' },
        el('span', { class: 'lb__rank' }, el('span', { class: 'sb-rank-n' })),
        el('span', { class: 'sb-row__who' }, el('span', { class: 'lb__name' })));
      ghosts[rank] = g;
    }
    g.dataset.rank = String(rank);
    setText(g.querySelector('.sb-rank-n'), String(rank));
    setText(g.querySelector('.lb__name'), t('board.open_spot'));
    return g;
  }

  /** Make `parent`'s children exactly `nodes`, in order, touching the DOM only where it differs. */
  function reconcile(parent, nodes) {
    let ref = parent.firstChild;
    for (const n of nodes) {
      if (n === ref) { ref = ref.nextSibling; continue; }
      parent.insertBefore(n, ref);
    }
    while (ref) { const next = ref.nextSibling; ref.remove(); ref = next; }
  }

  // ---------------------------------------------------------------- metrics (how many rows fit)
  let metrics = { fit: false, slotCount: Math.max(0, limit - 3), rowH: null };
  function measure() {
    const wanted = Math.max(0, limit - 3);
    if (!isFit()) return { fit: false, slotCount: wanted, rowH: null };
    const avail = bodyEl.clientHeight;
    if (avail < 48) return metrics.fit ? metrics : { fit: true, slotCount: wanted, rowH: null };   // hidden / not laid out yet
    const gap = Number.parseFloat(getComputedStyle(listEl).rowGap) || 0;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const minH = rem * MIN_ROW_REM;
    const maxH = rem * MAX_ROW_REM;
    const slotCount = Math.min(wanted, Math.max(1, Math.floor((avail + gap) / (minH + gap))));
    const rowH = slotCount ? clamp((avail - (slotCount - 1) * gap) / slotCount, minH, maxH) : minH;
    return { fit: true, slotCount, rowH: Math.floor(rowH * 10) / 10 };   // floor: rounding up made the last row overflow its room by a pixel
  }
  const metricsKey = (m) => `${m.fit}|${m.slotCount}|${m.rowH}`;
  function applyRowHeight() {
    if (metrics.rowH) listEl.style.setProperty('--row-h', `${metrics.rowH}px`);
    else listEl.style.removeProperty('--row-h');
  }

  // ---------------------------------------------------------------- fresh highlight (6 s)
  const fresh = new Map();   // id -> timer
  function syncFresh() {
    for (const s of slots) s.root.classList.toggle('is-fresh', s.id !== null && fresh.has(s.id));
    for (const r of rows.values()) r.root.classList.toggle('is-fresh', fresh.has(r.id));
  }
  function markFresh(ids) {
    for (const id of ids) {
      clearTimeout(fresh.get(id));
      fresh.set(id, setTimeout(() => { fresh.delete(id); syncFresh(); }, FRESH_MS));
    }
    syncFresh();
  }

  // ---------------------------------------------------------------- announcements (polite, rate limited)
  let pendingNews = [];
  let announceTimer = null;
  let lastAnnounceAt = 0;
  function queueNews(items) {
    pendingNews.push(...items);
    if (announceTimer) return;
    announceTimer = setTimeout(flushNews, Math.max(600, lastAnnounceAt + ANNOUNCE_GAP_MS - Date.now()));
  }
  function flushNews() {
    announceTimer = null;
    const news = pendingNews;
    pendingNews = [];
    if (!news.length) return;
    lastAnnounceAt = Date.now();
    const top = news.reduce((a, b) => (b.rank < a.rank ? b : a));
    let text;
    if (news.length > 1) text = t('live.many', { count: news.length, name: top.name, score: nf(top.score) });
    else if (top.rank === 1) text = t('live.leader', { name: top.name, score: nf(top.score) });
    else text = t('live.one', { name: top.name, score: nf(top.score), rank: top.rank });
    announce(text, { politeness: 'polite' });
  }

  // ---------------------------------------------------------------- update
  let entries = [];
  const known = new Set();
  let started = false;
  let sig = '';
  let invite = true;      // false for a closed event: no placeholder rows

  const signature = (list) => `${i18n.lang}|${metricsKey(metrics)}|${JSON.stringify(list.map((e) => [e.id, e.player_name, e.score, e.correct_answers, e.wrong_answers, e.completed_at]))}`;

  /**
   * Apply a snapshot (entries sorted by rank).
   * @param {Array} next
   * @param {{silent?:boolean}} [opts] silent: no motion, no highlight, no announcement (language change, resize)
   * @returns {boolean} true when the DOM was touched
   */
  function update(next, { silent = false } = {}) {
    const before = metrics;
    metrics = measure();
    const s = signature(next);
    if (s === sig) { applyRowHeight(); return false; }
    sig = s;

    const visible = isVisible();
    const initial = !started && !silent;
    const live = started && !silent;                               // a real update on a running board
    const motion = visible && !prefersReducedMotion();
    const prevTopId = entries[0]?.id ?? null;
    const newIds = live ? next.filter((e) => !known.has(e.id)).map((e) => e.id) : [];
    entries = next;
    for (const e of next) known.add(e.id);

    // a score only counts up for a genuinely new entry, a changed score, or the very first paint;
    // an entry that merely moved (podium <-> list, rank change) shows its number as is
    const newSet = new Set(newIds);
    const counts = (e, prevScore) => initial || newSet.has(e.id) || (prevScore !== undefined && prevScore !== e.score);

    // podium
    slots.forEach((slot, i) => {
      const e = next[i];
      setSlot(slot, e, { animate: (initial || live) && motion, count: !!e && counts(e, slot.id === e.id ? slot.score : undefined) });
    });

    // rows (FLIP: measure first, mutate, then play the inverse)
    const sameLayout = metricsKey(before) === metricsKey(metrics);
    const firstTop = new Map();
    if (live && motion && sameLayout) for (const [id, r] of rows) firstTop.set(id, r.root.getBoundingClientRect().top);

    const rest = next.slice(3, 3 + metrics.slotCount);
    const wanted = new Set(rest.map((e) => e.id));
    const created = new Set();
    const order = [];
    const list = rest.map((e, i) => {
      let row = rows.get(e.id);
      if (!row) { row = buildRow(); rows.set(e.id, row); created.add(e.id); }
      setRow(row, e, 4 + i, { animate: (initial || live) && motion, count: counts(e, row.id === e.id ? row.score : undefined) });
      order.push(row.root);
      return row;
    });
    for (const [id, row] of rows) if (!wanted.has(id)) { row.root.remove(); timeNodes.delete(row.time); rows.delete(id); }   // a long-running kiosk must not accumulate dead nodes
    const room = Math.max(0, metrics.slotCount - rest.length);
    const ghostCount = invite ? clamp(Math.min(GHOST_UP_TO_RANK, limit) - 3 - rest.length, 0, room) : 0;   // no "open spot" invitation once nobody can play any more
    for (let g = 0; g < ghostCount; g += 1) order.push(ghostRow(4 + rest.length + g));
    reconcile(listEl, order);
    applyRowHeight();

    if (motion) {
      list.forEach((row, i) => {
        if (initial) {
          row.root.animate([{ opacity: 0, transform: 'translateX(-28px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay: 160 + i * 60, easing: EASE, fill: 'backwards' });
        } else if (created.has(row.id)) {
          if (live) row.root.animate([{ opacity: 0, transform: 'translateX(-36px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 620, easing: EASE });
        } else if (firstTop.has(row.id)) {
          const dy = firstTop.get(row.id) - row.root.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) row.root.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 700, easing: EASE });
        }
      });
    }

    // newcomers: highlight, announce, confetti for a new #1
    if (newIds.length) {
      markFresh(newIds);
      const news = newIds.map((id) => {
        const idx = next.findIndex((e) => e.id === id);
        return idx < 0 ? null : { name: next[idx].player_name, score: next[idx].score, rank: idx + 1 };
      }).filter(Boolean);
      if (news.length) queueNews(news);
      const topId = next[0]?.id ?? null;
      if (topId !== null && topId !== prevTopId && newIds.includes(topId) && visible) celebrate();
    } else syncFresh();

    syncTimes();
    if (!silent) started = true;
    return true;
  }

  function syncTimes() {
    for (const node of timeNodes) {
      const iso = node.dataset.t;
      if (iso) setText(node, timeAgo(iso, i18n.lang, now(), t('board.just_now')));
    }
  }

  /** Viewport / container size changed: recompute how many rows fit (no motion). */
  function relayout() {
    if (!started) return;
    if (metricsKey(measure()) === metricsKey(metrics)) return;
    update(entries, { silent: true });
  }
  /** Language changed: rebuild every text from the last snapshot (no motion). */
  function relocalize() {
    if (!started) return;
    sig = '';
    update(entries, { silent: true });
  }

  /** Closed events show final results only: no "open spot" placeholders. */
  function setInvite(next) {
    if (invite === next) return;
    invite = next;
    relocalize();
  }

  return {
    update, relayout, relocalize, syncTimes, setInvite,
    get entries() { return entries; },
    get started() { return started; },
    get slotCount() { return metrics.slotCount; },
  };
}
