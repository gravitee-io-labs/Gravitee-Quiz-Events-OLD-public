/**
 * Landing: a clean hero (emblem, title, tagline) with Play / Scoreboard / Connect buzzers. This page is the one shown on the
 * booth screen, so it carries nothing else (no description, topics, stats or key hints).
 * Also renders the "this event has ended" state (status closed: no Play) and the "resume your game" offer.
 */
import { el, icon } from '/shared/js/dom.js';
import { api } from '/shared/js/api.js';
import { formatEventDates, isSafeImageUrl, splitHero, singularTitle } from '../../lib/format.js';
import { snapshotProgress } from '../state.js';

const POLL_MS = 45000; // + up to 15 s of jitter so hundreds of phones do not poll in lockstep
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

export const chipColor = (color) => (typeof color === 'string' && COLOR_RE.test(color) ? color : 'var(--fg-muted)');

/** [before, highlighted, after] of the hero headline. */
export function heroParts({ event, i18n, t }) {
  const custom = i18n.pick(event, 'hero_title').trim();
  return splitHero(custom || t('landing.hero_default', { title: singularTitle(event.game_title) }));
}

function emblem(event) {
  const logo = isSafeImageUrl(event.branding?.logo_url) ? event.branding.logo_url : null;
  return el('div', { class: ['ev-emblem', 'u-pop'], style: { '--i': 0 } },
    logo ? el('img', { class: 'ev-emblem__logo', src: logo, alt: event.name || event.game_title || '', on: { error: (e) => { e.currentTarget.nextElementSibling?.remove(); e.currentTarget.remove(); } } }) : null,
    logo ? el('span', { class: 'ev-emblem__x', 'aria-hidden': 'true' }, icon('x', { size: 'sm' })) : null,
    el('span', { class: 'ev-emblem__mark' }, el('img', { src: '/shared/img/gravitee-mark.svg', alt: 'Gravitee', width: 40, height: 40 })));
}

function resumeCard(ctx, snapshot) {
  const { t } = ctx;
  const total = snapshot.questions.length;
  const n = Math.max(1, snapshotProgress(snapshot));
  return el('section', { class: 'ev-resume glass glass--brand u-rise', 'aria-labelledby': 'resume-title' },
    el('span', { class: 'ev-resume__icon' }, icon('play-fill')),
    el('div', { class: 'ev-resume__text' },
      el('h2', { class: 'ev-resume__title', id: 'resume-title' }, t('landing.resume_title')),
      el('p', null, t('landing.resume_text', { n, total }))),
    el('div', { class: 'ev-resume__actions' },
      el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => ctx.resumeGame() } }, icon('play-fill'), t('landing.resume')),
      el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => ctx.discardResume() } }, t('landing.discard'))));
}

export function landingView(ctx) {
  const { event, i18n, t, state, kiosk, noScoreboard } = ctx;
  const closed = event.status === 'closed';
  const [pre, em, post] = heroParts(ctx);
  const where = [event.location, formatEventDates(i18n.lang, event.starts_on, event.ends_on)].filter(Boolean).join(' · ');
  const tagline = i18n.pick(event, 'tagline');
  const showScoreboard = !(kiosk && noScoreboard);
  const scoreboardHref = `/${encodeURIComponent(event.slug)}/scoreboard`;

  const title = el('h1', { class: 'hero__title u-rise', style: { '--i': 1 }, tabindex: '-1' },
    pre, em ? el('em', null, em) : null, post);

  const actions = closed
    ? el('div', { class: 'ev-closed glass u-rise', style: { '--i': 3 }, role: 'status' },
      el('span', { class: 'ev-closed__icon' }, icon('flag-checkered')),
      el('h2', { class: 'ev-closed__title' }, t('event.closed_title')),
      el('p', { class: 'ev-closed__text' }, t('event.closed_text')),
      showScoreboard ? el('a', { class: 'btn btn--primary btn--lg', href: scoreboardHref }, icon('trophy'), t('landing.scoreboard')) : null)
    : el('div', { class: 'hero__actions u-rise', style: { '--i': 3 } },
      el('button', { type: 'button', class: 'btn btn--primary btn--xl ev-play', 'data-action': 'play', on: { click: () => ctx.go('register') } }, t('landing.play'), icon('arrow-right')),
      showScoreboard ? el('a', { class: 'btn btn--secondary btn--lg', href: scoreboardHref }, icon('trophy'), t('landing.scoreboard')) : null);

  // "Connect buzzers": a labelled button right under Play, because the small app-bar icon is easy to miss on the booth laptop.
  // The buzzer module loads after the first paint, so the slot is filled now if it is ready, or later through ctx.onBuzzerReady.
  // Hidden on a visitor's own phone (no buzzers there) unless ?kiosk=1.
  const buzzerSlot = el('div', { class: 'ev-buzzer-cta u-rise', style: { '--i': 3 }, hidden: true });
  let offBuzzerStatus = null;
  function mountBuzzer() {
    const buzzer = ctx.buzzer;
    const phone = !kiosk && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (closed || phone || !buzzer || !buzzer.isSupported || buzzerSlot.childElementCount) return;
    const label = el('span');
    const dot = el('span', { class: 'status-dot', 'data-state': 'off', 'aria-hidden': 'true' });
    const button = el('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'connect-buzzers', on: { click: () => buzzer.open() } },
      icon('bluetooth'), label, dot);
    const render = () => {
      const level = buzzer.getStatus?.().level || 'none';
      label.textContent = t(level === 'none' ? 'rules.buzzer_connect' : 'rules.buzzer_manage');
      dot.dataset.state = level === 'both' ? 'on' : level === 'one' ? 'connecting' : 'off';
      button.setAttribute('aria-label', `${label.textContent}. ${t(`rules.buzzer_${level}`)}`);
    };
    render();
    offBuzzerStatus = buzzer.on?.('status', render);
    buzzerSlot.append(button);
    buzzerSlot.hidden = false;
  }

  const hero = el('section', { class: 'hero ev-hero' },
    emblem(event),
    where ? el('span', { class: 'hero__eyebrow u-rise' }, icon('map-pin'), el('span', null, where)) : null,
    closed ? el('span', { class: 'badge badge--lg badge--warning u-rise' }, icon('flag-checkered', { size: 'sm' }), t('event.closed_badge')) : null,
    title,
    tagline ? el('p', { class: 'hero__tagline u-rise', style: { '--i': 2 } }, tagline) : null,
    !closed && state.resume ? resumeCard(ctx, state.resume) : null,
    actions,
    buzzerSlot);

  const root = el('div', { class: 'ev-landing' }, hero);

  let timer = 0;
  async function poll() {
    if (document.visibilityState !== 'visible') return;
    try {
      const fresh = await api.get(`/events/${encodeURIComponent(event.slug)}`, { retries: 0, timeout: 8000 });
      if (!fresh) return;
      const statusChanged = fresh.status !== event.status;
      ctx.updateEvent(fresh);
      if (statusChanged) { ctx.go('landing', {}, { history: 'replace', animate: false, focus: false }); return; }
    } catch { /* offline for a moment: the next poll will catch up */ }
  }

  return {
    el: root,
    focusEl: title,
    mounted() {
      timer = setInterval(poll, POLL_MS + Math.random() * 15000);
      mountBuzzer();
      ctx.onBuzzerReady = mountBuzzer;
    },
    destroy() {
      clearInterval(timer);
      if (ctx.onBuzzerReady === mountBuzzer) ctx.onBuzzerReady = null;
      if (typeof offBuzzerStatus === 'function') offBuzzerStatus();
    },
  };
}
