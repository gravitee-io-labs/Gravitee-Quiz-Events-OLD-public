/**
 * Scoreboard (big screen / TV friendly) - /{slug}/scoreboard
 *
 *   ?limit=10 (3..50)  ?lang=en|fr  ?theme=dark|light  ?qr=0  ?rotate=1
 *
 * Boot: read the event, brand the page, then follow the live feed (SSE with polling fallback) and keep the board in
 * sync. See render.js (podium, rows, motion), feed.js (transport), kiosk.js (fullscreen / idle / wake lock).
 */
import { api } from '/shared/js/api.js';
import { eventUrl } from '/shared/js/config.js';
import { createI18n } from '/shared/js/i18n.js';
import { initTheme, setTheme, getTheme, cycleTheme, onThemeChange } from '/shared/js/theme.js';
import { applyBranding, setDocumentTitle } from '/shared/js/branding.js';
import { el, icon, hydrateIcons, sleep } from '/shared/js/dom.js';
import { countUp, prefersReducedMotion } from '/shared/js/effects.js';
import { announce } from '/shared/js/ui.js';

import { dictionaries } from './strings.js';
import { readParams, slugFromPath, ROTATE_MS } from './params.js';
import { createFeed, POLL_MS } from './feed.js';
import { createBoard } from './render.js';
import { createStatsView } from './stats.js';
import { buildJoinCard, buildQr } from './join.js';
import { initKiosk } from './kiosk.js';
import { measureClockSkew, shortUrl, countFormat } from './format.js';
import { isSafeImageUrl } from '../lib/format.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const params = readParams();
const slug = slugFromPath();

const i18n = createI18n({ dictionaries, fallback: 'en' });
const t = (key, p) => i18n.t(key, p);
initTheme();
if (params.theme) setTheme(params.theme, { persist: false });   // ?theme= is a per-load override, never saved
hydrateIcons(document);
i18n.apply(document);

const sb = $('sb');
const views = { board: $('view-board'), stats: $('view-stats'), empty: $('view-empty'), status: $('view-status') };

let event = null;
let feed = null;
let board = null;
let statsView = null;
let kiosk = null;
let transport = 'connecting';
let state = 'loading';          // loading | error | notfound | empty | ready
let hasData = false;
let skew = 0;
let offlineTimer = null;
let bannerShown = false;
let rotateTimer = null;
const joinCards = [];
const NOTFOUND_RETRY_MS = 30000;
const now = () => Date.now() + skew;
/** textContent only when it changed: an unchanged poll must not touch the DOM (no mutation, no reflow, no a11y noise). */
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

sb.dataset.mode = params.limit <= 3 ? 'podium' : params.limit > 10 ? 'long' : 'full';
// the QR code is on unless ?qr=0 or the event turns it off (Admin > Appearance > "Show the scan-to-play QR code"; set once the event is loaded)
let qrOn = params.qr;
sb.dataset.qr = qrOn ? 'on' : 'off';
const isFit = () => getComputedStyle(root).getPropertyValue('--sb-fit').trim() === '1';

// ------------------------------------------------------------------------------------------------- views / state
function showView(name) {
  const main = $('board');
  const hadFocus = main.contains(document.activeElement);
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  // focus was inside a view that just disappeared (e.g. the "All events" button): park it on <main>, not on <body>
  if (hadFocus && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  sb.dataset.view = name;
  const node = views[name];
  node.classList.remove('is-entering');
  void node.offsetWidth;                                   // restart the entrance animation
  node.classList.add('is-entering');
  for (const dot of $('sb-pager').children) dot.toggleAttribute('aria-current', dot.dataset.view === name);
}

function setState(next) {
  state = next;
  sb.dataset.state = next;
  if (next === 'ready') { if (sb.dataset.view !== 'stats') showView('board'); }
  else if (next === 'empty') showView('empty');
  else showView('status');
  paintStatusView();
  paintTransport();
  if (next !== 'ready') stopRotation();
}

function paintStatusView() {
  const title = $('sb-status-title');
  const text = $('sb-status-text');
  const spinner = $('sb-status-spinner');
  const action = $('sb-status-action');
  if (state === 'notfound') {
    setText(title, t('status.notfound_title'));
    setText(text, t('status.notfound_text'));
    spinner.hidden = true;
    action.hidden = false;
  } else if (state === 'error') {
    setText(title, t('status.error_title'));
    setText(text, t('status.error_text'));
    spinner.hidden = false;
    action.hidden = true;
  } else {
    setText(title, t('status.loading'));
    setText(text, '');
    spinner.hidden = false;
    action.hidden = true;
  }
}

// ------------------------------------------------------------------------------------------------- connection pill
function paintTransport() {
  const live = $('sb-live');
  const status = event?.status;
  live.hidden = state === 'notfound';          // nothing to be connected to: "Connecting…" next to "Event not found" would contradict
  let st = 'open';
  let text = t('status.live');
  let title = '';
  if (transport === 'offline') { st = 'offline'; text = t('status.reconnecting'); }
  else if (transport === 'connecting') { st = 'connecting'; text = t('status.connecting'); }
  else if (status === 'closed') { st = 'closed'; text = t('status.closed'); }
  else if (status === 'draft') { st = 'closed'; text = t('status.draft'); }
  else if (transport === 'poll') title = t('status.live_poll', { s: POLL_MS / 1000 });
  if (live.dataset.state !== st) live.dataset.state = st;
  if (live.dataset.transport !== transport) live.dataset.transport = transport;
  if (sb.dataset.transport !== transport) sb.dataset.transport = transport;
  setText($('sb-live-label'), text);
  if (title) { if (live.title !== title) live.title = title; } else if (live.hasAttribute('title')) live.removeAttribute('title');
}

function onTransport(next) {
  const was = transport;
  transport = next;
  paintTransport();
  clearTimeout(offlineTimer);
  if (next === 'offline') {
    if (!hasData) setState('error');
    else offlineTimer = setTimeout(() => { bannerShown = true; $('sb-banner').hidden = false; }, 4000);   // a blip is not worth a banner
  } else if (bannerShown) {
    bannerShown = false;
    $('sb-banner').hidden = true;
    if (next === 'sse' || next === 'poll') announce(t('status.restored'), { politeness: 'polite' });
  } else if (was === 'offline') $('sb-banner').hidden = true;
}

// ------------------------------------------------------------------------------------------------- counters
const counterNodes = [
  { value: $('sb-players'), label: $('sb-players-label'), key: 'counters.players', n: null },
  { value: $('sb-games'), label: $('sb-games-label'), key: 'counters.games', n: null },
];
function paintCounters(values = [], { animate = true } = {}) {
  counterNodes.forEach((c, i) => {
    const to = values[i] ?? c.n ?? 0;
    const from = c.n;
    c.n = to;
    setText(c.label, t(c.key, { count: to }));
    c.anim?.cancel();                                  // two quick updates must not fight over the same number
    c.anim = null;
    if (from !== null && from !== to && animate && !prefersReducedMotion()) c.anim = countUp(c.value, to, { from, duration: 900, format: countFormat((n) => i18n.number(n)) });
    else setText(c.value, i18n.number(to));
  });
}

// ------------------------------------------------------------------------------------------------- rotation (?rotate=1)
function startRotation() {
  if (!params.rotate || rotateTimer) return;
  $('sb-pager').hidden = false;
  rotateTimer = setInterval(() => {
    if (document.hidden || state !== 'ready') return;
    if (sb.dataset.view === 'board') { statsView.render({ animateNumbers: true }); showView('stats'); } else showView('board');
  }, ROTATE_MS);
}
function stopRotation() {
  clearInterval(rotateTimer);
  rotateTimer = null;
  $('sb-pager').hidden = true;
}
function restartRotation() { stopRotation(); startRotation(); }

// ------------------------------------------------------------------------------------------------- data
function onData({ entries, totalPlayers, totalGames }) {
  hasData = true;
  paintCounters([totalPlayers, totalGames], { animate: state === 'ready' || state === 'empty' });
  statsView.set({ players: totalPlayers, games: totalGames, entries });
  if (sb.dataset.view === 'stats') statsView.render();

  if (entries.length === 0) {
    if (state !== 'empty') setState('empty');
    board.update([]);
    return;
  }
  const known = new Set(board.entries.map((e) => e.id));
  const hasNewcomer = board.started && entries.some((e) => !known.has(e.id));
  if (state !== 'ready') { setState('ready'); startRotation(); }
  else if (hasNewcomer && sb.dataset.view === 'stats') { showView('board'); restartRotation(); }   // show the arrival, not the numbers
  board.update(entries);
  paintRanksTitle();
}

async function loadEvent() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.get(`/events/${encodeURIComponent(slug)}`, { retries: 1 });
    } catch (e) {
      if (e?.isNotFound) {
        // draft / not created yet: the TV is often switched on before the event goes live, so keep looking
        if (state !== 'notfound') { setState('notfound'); paintTransport(); }
        await sleep(NOTFOUND_RETRY_MS);
        continue;
      }
      if (state !== 'error') { transport = 'offline'; paintTransport(); setState('error'); }
      await sleep(Math.min(15000, 2000 * 1.5 ** attempt));
    }
  }
}

/** Branding, titles, logo, status: everything that depends on the event record. */
function applyEvent(ev, { first = false } = {}) {
  event = ev;
  sb.dataset.status = ev.status;
  board?.setInvite(ev.status !== 'closed');
  if (first) {
    i18n.setSupported(ev.languages);
    i18n.setEventDefault(ev.default_language);
  }
  applyBranding(ev, { title: false });
  setDocumentTitle(ev, t('common.scoreboard'));

  $('sb-title').textContent = ev.game_title;
  const sameName = (ev.name || '').trim().toLowerCase() === (ev.game_title || '').trim().toLowerCase();
  const eventName = $('sb-event');
  eventName.hidden = !ev.name || sameName;
  eventName.textContent = ev.name || '';
  $('sb-brand').setAttribute('href', `/${encodeURIComponent(slug)}`);

  const logo = $('sb-logo');
  const url = isSafeImageUrl(ev.branding?.logo_url) ? ev.branding.logo_url : null;   // https:// or /path only, whatever the API sent
  if (url) { if (logo.getAttribute('src') !== url) logo.src = url; logo.hidden = false; } else { logo.removeAttribute('src'); logo.hidden = true; }
  statsView?.set({ event: ev });
  paintTransport();
}

/** "Ranks 4 to 10": the last rank that actually has a row on this screen (limit, or fewer when the height is short). */
function paintRanksTitle() {
  const slots = board ? board.slotCount : Math.max(0, params.limit - 3);
  let to = Math.max(4, Math.min(params.limit, 3 + slots));
  // final results have no "open spot" rows: the heading names the ranks that really are on screen
  if (event?.status === 'closed' && board) to = Math.max(4, Math.min(to, board.entries.length));
  setText($('sb-ranks-title'), to === 4 && event?.status === 'closed' ? t('board.rank_n', { n: 4 }) : t('board.ranks', { from: 4, to }));
  // closed event with three players or fewer: nothing below the podium, so the podium takes the stage alone
  const alone = event?.status === 'closed' && (board?.entries.length ?? 0) <= 3;
  if (sb.dataset.ranks !== (alone ? 'none' : 'some')) sb.dataset.ranks = alone ? 'none' : 'some';
}

function localize() {
  if (event) setDocumentTitle(event, t('common.scoreboard'));
  paintTransport();
  paintStatusView();
  paintRanksTitle();
  paintCounters([], { animate: false });
  const closed = event?.status === 'closed';
  $('sb-empty-title').textContent = closed ? t('empty.title_closed') : t('empty.title');
  $('sb-empty-text').textContent = closed ? t('empty.text_closed') : t(qrOn ? 'empty.text' : 'empty.text_noscan', { count: event?.settings?.questions_per_game ?? 15 });
  for (const card of joinCards) card.localize();
  if (event && qrOn && !closed) $('sb-empty-qr').replaceChildren(buildQr(eventUrl(slug), t('join.qr', { url: shortUrl(eventUrl(slug)) })));
  buildControls();
  statsView?.render();
  board?.relocalize();
  kiosk?.paintButton();
}

/**
 * Language switch + theme button. Built ONCE (and the language group only again when the event changes the list of
 * languages): rebuilding them on every language change dropped the keyboard focus, and shared createThemeToggle()
 * registers a theme listener per instance that is never released.
 */
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
let langKey = null;
let langGroup = null;
let themeBtn = null;
function buildControls() {
  const langs = i18n.supported;
  const key = langs.join(',');
  if (key !== langKey) {
    langKey = key;
    if (langs.length > 1) {
      langGroup = el('div', { class: 'segmented sb-lang', role: 'radiogroup' },
        langs.map((l) => el('label', null,
          el('input', { type: 'radio', name: 'sb-lang', value: l, checked: i18n.lang === l, on: { change: () => i18n.setLang(l) } }),
          el('span', { lang: l, title: l === 'fr' ? 'Français' : l === 'en' ? 'English' : l }, l.toUpperCase()))));
      $('sb-lang-slot').replaceChildren(langGroup);
    } else { langGroup = null; $('sb-lang-slot').replaceChildren(); }
  }
  if (!themeBtn) {
    themeBtn = el('button', { class: 'btn btn--ghost btn--icon', type: 'button', on: { click: () => cycleTheme() } });
    onThemeChange(() => paintThemeButton());
    $('sb-theme-slot').replaceChildren(themeBtn);
  }
  langGroup?.setAttribute('aria-label', t('controls.language'));
  for (const input of langGroup?.querySelectorAll('input') ?? []) input.checked = input.value === i18n.lang;
  paintThemeButton();
}
function paintThemeButton() {
  if (!themeBtn) return;
  const pref = getTheme();
  const label = `${t('controls.theme')}: ${t(`controls.${pref}`)}`;
  themeBtn.replaceChildren(icon(THEME_ICON[pref] || 'monitor'));
  themeBtn.setAttribute('aria-label', label);
  themeBtn.title = label;
}

// ------------------------------------------------------------------------------------------------- boot
async function boot() {
  setState('loading');
  paintTransport();
  board = createBoard({
    podiumEl: $('podium'), listEl: $('sb-list'), bodyEl: $('sb-ranks-body'),
    i18n, limit: params.limit, now, isFit,
    isVisible: () => !views.board.hidden && !document.hidden,
  });
  statsView = createStatsView({ tilesEl: $('sb-tiles'), rulesEl: $('sb-rules'), catsEl: $('sb-cats'), i18n });
  kiosk = initKiosk({ button: $('sb-fs'), getLabels: () => ({ enter: t('controls.fullscreen'), exit: t('controls.fullscreen_exit') }) });
  buildControls();
  measureClockSkew().then((s) => { skew = s; board.syncTimes(); });

  const ev = await loadEvent();
  if (!ev) return;
  applyEvent(ev, { first: true });

  const closed = ev.status === 'closed';
  qrOn = params.qr && ev.branding?.show_join_qr !== false;
  sb.dataset.qr = qrOn ? 'on' : 'off';
  if (qrOn && !closed) {
    const url = eventUrl(slug);
    for (const slot of [$('sb-join-slot'), $('sb-join-slot-stats')]) {
      const card = buildJoinCard({ url, t });
      joinCards.push(card);
      slot.replaceChildren(card.root);
    }
    $('sb-empty-url').textContent = shortUrl(url);
  } else if (!qrOn) {
    // booth-only event: no QR code and no join address on the big screen
    $('sb-empty-url').textContent = '';
    $('sb-empty-url').hidden = true;
  }
  localize();
  hydrateIcons(document);
  setState('loading');   // the event is known, the first snapshot is not: keep the loading view

  i18n.onChange(() => localize());
  let raf = 0;
  const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { board.relayout(); paintRanksTitle(); }); };
  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe($('sb-ranks-body'));

  feed = createFeed({ slug, limit: params.limit, onData, onTransport, stream: ev.status !== 'draft' });

  // relative times ("5 min ago") tick without re-rendering the list
  setInterval(() => board.syncTimes(), 30000);
  // brand / name / status edited in the admin console while the screen is running
  setInterval(refreshEvent, 60000);
}

async function refreshEvent() {
  try {
    const ev = await api.get(`/events/${encodeURIComponent(slug)}`, { retries: 0, timeout: 8000 });
    const strip = ({ stats, ...rest }) => JSON.stringify(rest);
    if (strip(ev) !== strip(event)) { applyEvent(ev); localize(); }
  } catch { /* the live feed already shows connectivity problems */ }
}

boot();
