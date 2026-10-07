/**
 * Full-page states that replace the game: unknown event (404) and "could not load".
 */
import { el, icon } from '/shared/js/dom.js';

export function notFoundView(ctx) {
  const { t } = ctx;
  const title = el('h1', { class: 'empty__title ev-empty-title', tabindex: '-1' }, t('event.not_found_title'));
  return {
    el: el('section', { class: 'empty ev-empty u-rise' },
      el('div', { class: 'empty__icon' }, icon('map-pin')),
      title,
      el('p', { class: 'empty__text' }, t('event.not_found_text')),
      el('div', { class: 'empty__actions' }, el('a', { class: 'btn btn--primary btn--lg', href: '/' }, icon('squares-four'), t('event.see_events')))),
    focusEl: title,
  };
}

export function errorView(ctx, { onRetry }) {
  const { t } = ctx;
  const title = el('h1', { class: 'empty__title ev-empty-title', tabindex: '-1' }, t('event.error_title'));
  return {
    el: el('section', { class: 'empty ev-empty', role: 'alert' },
      el('div', { class: 'empty__icon' }, icon('wifi-slash')),
      title,
      el('p', { class: 'empty__text' }, t('event.error_text')),
      el('div', { class: 'empty__actions' },
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', on: { click: () => onRetry() } }, icon('arrow-clockwise'), t('common.retry')),
        el('a', { class: 'btn btn--ghost', href: '/' }, t('event.see_events')))),
    focusEl: title,
  };
}
