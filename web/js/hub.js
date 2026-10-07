/**
 * Hub: "Gravitee Quiz Events" lists the live events as big, individually branded cards.
 * One live event -> a hero card. Loading skeleton, empty state, error state with retry.
 */
import { api } from '/shared/js/api.js';
import { el, icon, hydrateIcons } from '/shared/js/dom.js';
import { initTheme } from '/shared/js/theme.js';
import { applyBranding } from '/shared/js/branding.js';
import { transition } from './lib/transition.js';
import { announce } from '/shared/js/ui.js';
import { i18n, t } from './lib/i18n.js';
import { createAppbar, createFooter, brandLink, applyUrlOverrides, onLanguage } from './lib/chrome.js';
import { formatEventDates, isSafeImageUrl } from './lib/format.js';

initTheme();
applyUrlOverrides();
applyBranding(null);

const app = document.getElementById('app');
const appbar = createAppbar(i18n, { brand: brandLink({ href: '/', name: 'Gravitee Quiz Events' }) });
const footer = createFooter(i18n, { hubLink: false });
const main = el('main', { id: 'main', class: 'screen__main container', tabindex: '-1' });
app.replaceChildren(appbar.el, main, footer.el);

let events = null;     // last successful response
let phase = 'loading'; // loading | ready | error
let intro = true;      // entrance animations only for freshly loaded cards, never on a language switch
let heroAnimated = false; // the hero header animates once

// ------------------------------------------------------------------------------------------------
// building blocks
// ------------------------------------------------------------------------------------------------
function heroHeader() {
  const node = el('section', { class: 'hero hub-hero' },
    el('span', { class: ['hero__eyebrow', !heroAnimated && 'u-rise'] }, icon('sparkle-fill'), el('span', null, t('hub.eyebrow'))),
    el('h1', { class: ['hero__title', !heroAnimated && 'u-rise'], style: { '--i': 1 } }, 'Gravitee ', el('em', null, t('hub.title_em'))),
    el('p', { class: ['hero__tagline', !heroAnimated && 'u-rise'], style: { '--i': 2 } }, t('hub.tagline')));
  heroAnimated = true;
  return node;
}

function skeletons() {
  return el('div', { class: 'event-grid hub-grid', 'aria-hidden': 'true' },
    ...[0, 1, 2].map(() => el('span', { class: 'skeleton skeleton--card hub-skeleton' })));
}

function eventCard(ev, { hero = false, index = 0 } = {}) {
  const href = `/${encodeURIComponent(ev.slug)}`;
  const tagline = i18n.pick(ev, 'tagline');
  const description = i18n.pick(ev, 'description');
  const dates = formatEventDates(i18n.lang, ev.starts_on, ev.ends_on);
  const showEventName = ev.name && ev.name.trim().toLowerCase() !== (ev.game_title || '').trim().toLowerCase();
  const logo = isSafeImageUrl(ev.branding?.logo_url) ? ev.branding.logo_url : null;
  const meta = [
    ev.location ? el('span', null, icon('map-pin', { size: 'sm' }), ev.location) : null,
    dates ? el('span', null, icon('calendar-blank', { size: 'sm' }), dates) : null,
  ].filter(Boolean);

  // the whole card is a target (not only its banner): a click on the text goes to the event, links and buttons keep their own behaviour
  const open = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.target.closest('a, button') || window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) window.open(href, '_blank', 'noopener'); else location.assign(href);
  };
  const card = el('article', { class: ['hub-card', intro && 'u-rise', hero && 'hub-card--hero'], style: { '--i': Math.min(index, 5) + 1 }, on: { click: open } },
    el('div', { class: 'hub-card__banner' },
      el('span', { class: 'badge badge--dot hub-card__status' }, t('common.live')),
      logo ? el('img', { class: 'hub-card__logo', src: logo, alt: '', on: { error: (e) => e.currentTarget.remove() } }) : null,
      el('h2', { class: 'hub-card__wordmark' },
        el('a', { class: 'hub-card__link', href }, ev.game_title || ev.name))),
    el('div', { class: 'hub-card__main' },
      el('div', { class: 'hub-card__body' },
        showEventName ? el('p', { class: 'hub-card__event' }, ev.name) : null,
        meta.length ? el('div', { class: 'hub-card__meta' }, ...meta) : null,
        tagline ? el('p', { class: 'hub-card__tagline' }, tagline) : null,
        hero && description ? el('p', { class: 'hub-card__desc' }, description) : null),
      el('div', { class: 'hub-card__actions' },
        el('a', { class: ['btn btn--primary', hero && 'btn--lg'], href }, t('common.play'), icon('arrow-right')),
        el('a', { class: ['btn btn--secondary', hero && 'btn--lg'], href: `${href}/scoreboard` }, icon('trophy'), t('common.scoreboard')))));
  applyBranding(ev, { root: card, title: false });
  return card;
}

function emptyState() {
  return el('section', { class: 'empty hub-empty u-rise' },
    el('div', { class: 'empty__icon' }, icon('calendar-blank')),
    el('h2', { class: 'empty__title' }, t('hub.empty_title')),
    el('p', { class: 'empty__text' }, t('hub.empty_text')),
    el('div', { class: 'empty__actions' },
      el('button', { type: 'button', class: 'btn btn--secondary', on: { click: load } }, icon('arrow-clockwise'), t('common.refresh'))));
}

function errorState() {
  return el('section', { class: 'empty hub-empty', role: 'alert' },
    el('div', { class: 'empty__icon' }, icon('wifi-slash')),
    el('h2', { class: 'empty__title' }, t('hub.error_title')),
    el('p', { class: 'empty__text' }, t('hub.error_text')),
    el('div', { class: 'empty__actions' },
      el('button', { type: 'button', class: 'btn btn--primary', on: { click: load } }, icon('arrow-clockwise'), t('common.retry'))));
}

// ------------------------------------------------------------------------------------------------
// rendering
// ------------------------------------------------------------------------------------------------
function content() {
  if (phase === 'loading') return [heroHeader(), skeletons()];
  if (phase === 'error') return [heroHeader(), errorState()];
  if (!events || events.length === 0) return [heroHeader(), emptyState()];
  if (events.length === 1) return [heroHeader(), el('div', { class: 'hub-solo' }, eventCard(events[0], { hero: true }))];
  return [heroHeader(), el('div', { class: 'event-grid hub-grid' }, events.map((ev, i) => eventCard(ev, { index: i })))];
}

function render({ animate = false } = {}) {
  const update = () => {
    main.replaceChildren(...content());
    main.setAttribute('aria-busy', String(phase === 'loading'));
    hydrateIcons(main);
  };
  document.title = t('hub.page_title');
  return animate ? transition(update) : update();
}

async function load() {
  phase = 'loading';
  render();
  try {
    const list = await api.get('/events');
    events = Array.isArray(list) ? list : [];
    phase = 'ready';
    intro = true;
    await render({ animate: true });
    intro = false;
    announce(events.length ? t('hub.loaded', { count: events.length }) : t('hub.empty_title'));
  } catch (e) {
    console.warn('events request failed', e?.status);
    phase = 'error';
    await render({ animate: true });
  }
}

appbar.setExtras([]);
onLanguage(i18n, () => { appbar.refresh(); footer.refresh(); render(); });
document.documentElement.lang = i18n.lang;
i18n.apply(document);
load();
