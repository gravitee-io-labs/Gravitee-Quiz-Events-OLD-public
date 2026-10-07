/**
 * Event page: boots one event (slug = first path segment) and drives the views
 * landing -> register -> rules -> game -> saving -> results -> review.
 *
 * Everything the views need travels in `ctx`. Personal data (the registration form) lives in memory only.
 */
import { api, ApiError } from '/shared/js/api.js';
import { el, hydrateIcons } from '/shared/js/dom.js';
import { initTheme } from '/shared/js/theme.js';
import { applyBranding } from '/shared/js/branding.js';
import { transition } from '../lib/transition.js';
import { announce } from '/shared/js/ui.js';
import { i18n, t } from '../lib/i18n.js';
import { createAppbar, createFooter, brandLink, applyUrlOverrides, onLanguage } from '../lib/chrome.js';
import { createState, saveSnapshot, clearSnapshot, loadSnapshot, gameFromSnapshot } from './state.js';
import { loadBuzzer } from './buzzer.js';
import { createKiosk } from './kiosk.js';
import { mapServerErrors } from './validate.js';
import { landingView } from './views/landing.js';
import { registerView } from './views/register.js';
import { rulesView } from './views/rules.js';
import { gameView } from './views/game.js';
import { savingView } from './views/saving.js';
import { resultsView } from './views/results.js';
import { reviewView } from './views/review.js';
import { notFoundView, errorView } from './views/status.js';

const VIEWS = {
  landing: landingView,
  register: registerView,
  rules: rulesView,
  game: gameView,
  saving: savingView,
  results: resultsView,
  review: reviewView,
  status: (c) => errorView(c, { onRetry: () => playAgain() }),
};
const BUZZER_VIEWS = new Set(['landing', 'rules', 'game']);

// ------------------------------------------------------------------------------------------------
// page setup
// ------------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const kiosk = params.get('kiosk') === '1';
const noScoreboard = kiosk && params.get('noscoreboard') === '1';
const slug = (() => {
  const first = location.pathname.split('/').filter(Boolean)[0] || '';
  try { return decodeURIComponent(first); } catch { return first; }   // a malformed %-sequence must give "not found", never a blank page
})();

initTheme();
applyUrlOverrides();
if (kiosk) document.documentElement.dataset.kiosk = '1';

const app = document.getElementById('app');
const state = createState(slug);
const appbar = createAppbar(i18n, { onLang: (code) => i18n.setLang(code, { persist: !kiosk }) });
const banner = el('div', { class: 'ev-banner-slot' });
const main = el('main', { id: 'main', class: 'screen__main container', tabindex: '-1' });
const footer = createFooter(i18n, { hubLink: !kiosk });
app.replaceChildren(appbar.el, banner, main, footer.el);
app.setAttribute('aria-busy', 'true');
document.title = 'Gravitee Quiz';
i18n.apply(document);

/** What every view receives. */
const ctx = {
  slug, kiosk, noScoreboard, state, i18n, t,
  event: null,
  buzzer: null,
  onBuzzerPress: null,
  go: (name, props, opts) => show(name, props, opts),
  back: (name) => goBack(name),
  startGame, finishGame, playAgain, resetToLanding, resumeGame, discardResume,
  updateEvent(fresh) { Object.assign(ctx.event, fresh); renderBanner(); },
};

let current = { name: null, instance: null, props: {} };
const stack = []; // our own mirror of the history entries (names), to decide between history.back() and a replace

/** Brand link in the app bar: goes back to the landing page without a reload, and never abandons a running game. */
function makeBrand(name, href) {
  const link = brandLink({ href, name });
  link.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (!ctx.event || current.name === 'landing' || current.name === 'game' || current.name === 'saving') return;
    if (current.name === 'results' || current.name === 'review') playAgain(); else goBack('landing');
  });
  return link;
}

// ------------------------------------------------------------------------------------------------
// view manager
// ------------------------------------------------------------------------------------------------
function updateChrome(name) {
  app.dataset.view = name;
  main.dataset.view = name;
  if (ctx.buzzer) {
    // hidden via visibility (not display) so the app bar controls never move between views; a phone that cannot do Web Bluetooth
    // (iOS Safari, Firefox) has nothing to connect, so the button is dropped altogether there
    const useless = !ctx.buzzer.isSupported && window.matchMedia?.('(pointer: coarse)').matches;
    const show = BUZZER_VIEWS.has(name) && ctx.event?.status !== 'closed';
    ctx.buzzer.buttonEl.hidden = useless;
    ctx.buzzer.buttonEl.style.visibility = show ? '' : 'hidden';
  }
}

/**
 * Show a view.
 * @param {string} name
 * @param {object} [props]
 * @param {{history?: 'push'|'replace'|'none', animate?: boolean, focus?: boolean}} [opts]
 */
async function show(name, props = {}, { history: mode, animate = true, focus = true } = {}) {
  if (!VIEWS[name]) throw new Error(`unknown view ${name}`);
  const forward = new Set(['register', 'rules', 'review']);
  const how = mode || (forward.has(name) && current.name && current.name !== name ? 'push' : 'replace');

  const refreshing = how === 'none' && !animate;
  if (refreshing) main.dataset.still = ''; else delete main.dataset.still; // no entrance animations when only the language changed
  const prev = current;
  prev.instance?.destroy?.();
  let instance;
  try {
    instance = VIEWS[name](ctx, props);
  } catch (e) {
    // a malformed API payload must never leave a blank screen on the booth: show the retry state instead
    console.error(`view "${name}" failed to render`, e);
    name = 'status';
    instance = VIEWS.status(ctx, {});
  }
  current = { name, instance, props };

  if (how === 'push') { history.pushState({ v: name }, ''); stack.push(name); }
  else if (how === 'replace') { history.replaceState({ v: name }, ''); if (stack.length) stack[stack.length - 1] = name; else stack.push(name); }

  const update = () => {
    main.replaceChildren(instance.el);
    hydrateIcons(main);
    updateChrome(name);
    if (focus) window.scrollTo(0, 0);
    try { instance.mounted?.(); } catch (e) { console.error(`view "${name}" failed to start`, e); }
    if (focus && instance.focusEl) instance.focusEl.focus({ preventScroll: true });
  };
  if (animate && prev.instance) {
    // a transition skipped by a newer one rejects its `finished` promise: harmless, the DOM update still ran
    try { await transition(update); } catch { /* skipped */ }
  } else update();
}

let backing = false; // a history.back() is on its way: a double tap on a Back button must not pop two entries (it used to throw the results away)
function goBack(target) {
  if (backing) return;
  if (stack.length > 1 && stack[stack.length - 2] === target) {
    backing = true;
    setTimeout(() => { backing = false; }, 800); // failsafe: popstate always fires, but never leave the buttons dead
    history.back();
    return;
  }
  show(target, {}, { history: 'replace' });
}

window.addEventListener('popstate', (e) => {
  backing = false;
  if (current.name === 'game' || current.name === 'saving') {
    history.pushState({ v: current.name }, ''); // the browser Back button never abandons a running game
    return;
  }
  const wanted = e.state?.v;
  if (!wanted || !VIEWS[wanted]) return;
  // once a game has been played, Back must never reopen the previous player's registration form (shared devices): start over
  if ((wanted === 'register' || wanted === 'rules') && (state.results || state.game)) {
    state.reset();
    state.playerSig = null;
    clearSnapshot(slug);
    history.back(); // one more step: the landing entry below is rendered by this same listener
    return;
  }
  const i = stack.lastIndexOf(wanted);
  if (i >= 0) stack.length = i + 1; else { stack.length = 0; stack.push(wanted); }
  let target = wanted;
  if (target === 'rules' && !state.form.first_name) target = 'landing';
  if ((target === 'review' || target === 'results') && !state.results) target = 'landing';
  if (target === 'game' || target === 'saving') target = 'landing';
  show(target, {}, { history: 'none' });
});

/** Re-render the current view after a language change, keeping what the player typed / chose. */
function refreshView() {
  const { name, instance, props } = current;
  if (!instance) return;
  if (typeof instance.refresh === 'function') { instance.refresh(); return; }
  const kept = typeof instance.state === 'function' ? { ...props, ...instance.state() } : props;
  show(name, kept, { history: 'none', animate: false, focus: false });
}

// ------------------------------------------------------------------------------------------------
// banner (draft preview)
// ------------------------------------------------------------------------------------------------
function renderBanner() {
  const draft = ctx.event?.status === 'draft';
  banner.replaceChildren(...(draft ? [el('div', { class: 'alert alert--warning alert--banner ev-draft', role: 'status' },
    el('span', { class: 'alert__icon', 'data-icon': 'warning-fill' }),
    el('div', null, el('p', { class: 'alert__title' }, t('event.draft_title')), el('p', { class: 'alert__text' }, t('event.draft_text'))))] : []));
  hydrateIcons(banner);
}

// ------------------------------------------------------------------------------------------------
// flow actions
// ------------------------------------------------------------------------------------------------
function describeError(e) {
  if (!(e instanceof ApiError)) return 'rules.err_generic';
  if (e.status === 0 || e.status === -1) return 'rules.err_network';
  if (e.status >= 500) return 'rules.err_server';
  if (e.code === 'not_enough_questions') return 'rules.err_not_enough';
  if (e.code === 'event_closed') return 'rules.err_closed';
  return 'rules.err_generic';
}

function registrationPayload() {
  const f = state.form;
  const settings = ctx.event.settings || {};
  const payload = { first_name: f.first_name, last_name: f.last_name, email: f.email };
  if ((settings.collect_phone || 'optional') !== 'hidden' && f.phone_number) payload.phone_number = f.phone_number;
  if (settings.consent_text_en || settings.consent_text_fr) payload.consent = !!f.consent;
  return payload;
}

/** Rules view "Start": register the player (once), then create the game. @returns {{error?: string}} */
async function startGame() {
  const base = `/events/${encodeURIComponent(slug)}`;
  try {
    const payload = registrationPayload();
    const sig = JSON.stringify(payload);
    if (!state.player || state.playerSig !== sig) {
      state.player = await api.post(`${base}/players`, payload);
      state.playerSig = sig;
    }
    const res = await api.post(`${base}/games`, { player_id: state.player.id });
    if (!res || !Array.isArray(res.questions) || res.questions.length === 0) return { error: 'rules.err_not_enough' };
    state.game = {
      id: res.game_session_id,
      timerSeconds: res.timer_seconds,
      pointsCorrect: res.points_correct,
      timeBonusMax: res.time_bonus_max,
      submitToken: typeof res.submit_token === 'string' ? res.submit_token : null, // proves this player started the game (backend REQUIRE_SUBMIT_TOKEN)
      questions: res.questions,
      answers: [],
      shown: -1,
    };
    state.results = null;
    saveSnapshot(slug, state.game, 'playing');
    await show('game', {}, { history: 'replace', animate: false }); // no cross-fade: the clock starts right away
    return {};
  } catch (e) {
    if (e instanceof ApiError && e.status === 422 && Object.keys(e.fieldErrors || {}).length) {
      state.player = null;
      await show('register', { serverErrors: mapServerErrors(e.fieldErrors) }, { history: 'replace' });
      return {};
    }
    if (e instanceof ApiError && e.status === 403 && e.code === 'event_closed') {
      ctx.updateEvent({ status: 'closed' });
      clearSnapshot(slug);
      await show('landing', {}, { history: 'replace' });
      return {};
    }
    return { error: describeError(e) };
  }
}

function finishGame() {
  show('saving', {}, { history: 'replace', animate: false }); // instant: the server usually answers within a blink
}

/** Back to the landing page for the next player: nothing of this play-through survives. */
function playAgain() {
  state.reset();
  state.playerSig = null;
  clearSnapshot(slug);
  show('landing', {}, { history: 'replace' });
}

function resetToLanding() {
  if (kiosk) i18n.setLang(ctx.event?.default_language || i18n.lang, { persist: false });
  appbar.refresh();
  playAgain();
}

function resumeGame() {
  const snap = state.resume;
  if (!snap) return;
  state.resume = null;
  state.game = gameFromSnapshot(snap);
  state.results = null;
  const done = state.game.answers.length >= state.game.questions.length;
  show(done ? 'saving' : 'game', {}, { history: 'replace', animate: false });
}

function discardResume() {
  clearSnapshot(slug);
  state.resume = null;
  show('landing', {}, { history: 'replace', animate: false, focus: false });
}

// ------------------------------------------------------------------------------------------------
// boot
// ------------------------------------------------------------------------------------------------
async function boot() {
  app.setAttribute('aria-busy', 'true');
  main.replaceChildren(el('section', { class: 'hero ev-skeleton', 'aria-hidden': 'true' },
    el('span', { class: 'skeleton skeleton--circle', style: { inlineSize: '4rem' } }),
    el('span', { class: 'skeleton skeleton--title', style: { inlineSize: 'min(26rem, 80%)', blockSize: '3.5rem' } }),
    el('span', { class: 'skeleton skeleton--text', style: { inlineSize: 'min(20rem, 70%)' } })));
  appbar.setBrand(brandLink({ href: '/', name: 'Gravitee Quiz' }));

  let event;
  try {
    if (!slug) throw new ApiError(404, 'Not found');
    event = await api.get(`/events/${encodeURIComponent(slug)}`);
  } catch (e) {
    app.removeAttribute('aria-busy');
    const notFound = e instanceof ApiError && (e.status === 404 || e.status === 422);
    document.title = `${t(notFound ? 'event.not_found_title' : 'event.error_title')} · Gravitee Quiz`;
    const make = notFound ? notFoundView : (c) => errorView(c, { onRetry: boot });
    const instance = make(ctx);
    main.replaceChildren(instance.el);
    hydrateIcons(main);
    updateChrome('status');
    current = { name: 'status', instance: { ...instance, refresh: () => { const again = make(ctx); main.replaceChildren(again.el); hydrateIcons(main); } }, props: {} };
    instance.focusEl?.focus({ preventScroll: true });
    return;
  }

  ctx.event = event;
  i18n.setSupported(event.languages?.length ? event.languages : ['en', 'fr']);
  i18n.setEventDefault(event.default_language);
  applyBranding(event);
  appbar.setBrand(makeBrand(event.game_title || event.name, `/${encodeURIComponent(slug)}${kiosk ? location.search : ''}`));
  appbar.refresh();
  renderBanner();
  app.removeAttribute('aria-busy');

  // a finished-but-unsaved game goes straight back to saving; an unfinished one is offered on the landing page
  const snap = event.status === 'closed' ? null : loadSnapshot(slug);
  if (!snap) clearSnapshot(slug);
  stack.length = 0;
  history.replaceState({ v: 'landing' }, '');
  stack.push('landing');
  if (snap && snap.phase === 'submitting') {
    state.game = gameFromSnapshot(snap);
    await show('saving', {}, { history: 'replace', animate: false, focus: false });
  } else {
    state.resume = snap;
    await show('landing', {}, { history: 'replace', animate: false, focus: false }); // first paint: the page starts at the top, the skip link and the app bar stay first in the tab order
  }

  loadBuzzer({ i18n, onPress: (color) => ctx.onBuzzerPress?.(color) }).then((buzzer) => {
    if (!buzzer) return;
    ctx.buzzer = buzzer;
    appbar.setExtras([buzzer.buttonEl]);
    updateChrome(current.name);
    ctx.onBuzzerReady?.(); // the landing view shows its own "Connect buzzers" button once the controller exists
  });
}

createKiosk({
  enabled: kiosk,
  getView: () => current.name,
  onIdle: () => {
    if (!ctx.event) return;
    const dirty = current.name !== 'landing' || state.resume || state.form.first_name || state.form.email;
    if (dirty) resetToLanding();
  },
});

onLanguage(i18n, () => {
  appbar.refresh();
  footer.refresh();
  renderBanner();
  document.title = ctx.event ? document.title : 'Gravitee Quiz';
  refreshView();
  announce(t(`lang.${i18n.lang}`));
});

boot();
