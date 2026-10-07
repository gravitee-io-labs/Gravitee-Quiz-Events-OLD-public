/**
 * Review: every question with the player's answer vs the correct answer (localised labels), explanation,
 * category, points and time. "Mistakes only" filter.
 */
import { el, icon } from '/shared/js/dom.js';
import { chipColor } from './landing.js';

const STATE_ICON = { correct: 'check-bold', wrong: 'x-bold', missed: 'timer' };

export function reviewView(ctx, props = {}) {
  const { state, t, i18n } = ctx;
  const items = state.results?.review || [];
  let filter = props.filter === 'wrong' ? 'wrong' : 'all';

  const stateOf = (it) => (it.player_answer == null ? 'missed' : it.is_correct ? 'correct' : 'wrong');
  const mistakes = items.filter((it) => stateOf(it) !== 'correct').length;
  const answerLabel = (it, color) => i18n.pick(it, color === 'green' ? 'green_label' : 'red_label');
  const colon = i18n.lang === 'fr' ? ' :' : ':'; // French typography: a (non-breaking) space before the colon
  const colorVar = (color) => (color === 'green' ? 'var(--green)' : 'var(--red)');

  function card(it, index) {
    const st = stateOf(it);
    const qText = i18n.pick(it, 'question_text');
    const explanation = i18n.pick(it, 'explanation');
    const cat = it.category;
    const answers = [];
    if (it.player_answer == null) {
      answers.push(el('span', { class: 'chip chip--plain', style: { '--chip': 'var(--amber)' } }, icon('timer', { size: 'sm' }), t('review.no_answer')));
    } else {
      answers.push(el('span', { class: 'chip chip--plain', style: { '--chip': st === 'correct' ? 'var(--green)' : 'var(--red)' } },
        el('span', { class: 'ev-chip-label' }, `${t('review.your_answer')}${colon}`), el('strong', null, answerLabel(it, it.player_answer))));
    }
    if (st !== 'correct') {
      answers.push(el('span', { class: 'chip chip--plain', style: { '--chip': colorVar(it.correct_answer) } },
        el('span', { class: 'ev-chip-label' }, `${t('review.correct_answer')}${colon}`), el('strong', null, answerLabel(it, it.correct_answer))));
    }
    const meta = [
      it.time_taken != null && it.player_answer != null ? el('span', null, icon('clock', { size: 'sm' }), t('review.seconds', { s: i18n.number(it.time_taken, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })) : null,
    ].filter(Boolean);
    return el('li', { class: 'ev-review-li' },
      el('article', { class: 'review-item ev-review-item', 'data-state': st },
        el('span', { class: 'review-item__icon', 'aria-hidden': 'true' }, icon(STATE_ICON[st])),
        el('div', { class: 'ev-review-main' },
          el('div', { class: 'ev-review-top' },
            el('span', { class: 'ev-review-n' }, `${index + 1}.`),
            cat ? el('span', { class: 'chip', style: { '--chip': chipColor(cat.color) } }, i18n.pick(cat, 'name')) : null,
            el('span', { class: 'u-sr-only' }, t(`review.state_${st}`)),
            el('span', { class: 'review-item__points ev-review-points' }, `+${i18n.number(it.points_earned ?? 0)}`, el('span', { class: 'u-sr-only' }, ` ${t('review.points')}`))),
          el('p', { class: 'review-item__q' }, qText)),
        el('div', { class: 'review-item__answers' }, ...answers, ...meta),
        explanation ? el('p', { class: 'review-item__explain' }, el('strong', null, `${t('review.explanation')}${colon} `), explanation) : null));
  }

  const listHost = el('ol', { class: 'ev-review-list', role: 'list' });
  const status = el('p', { class: 'u-sr-only', role: 'status', 'aria-live': 'polite' });

  function paintList() {
    const shown = items.map((it, i) => ({ it, i })).filter(({ it }) => filter === 'all' || stateOf(it) !== 'correct');
    listHost.replaceChildren(...(shown.length
      ? shown.map(({ it, i }) => card(it, i))
      : [el('li', null, el('div', { class: 'empty' }, el('div', { class: 'empty__icon' }, icon('trophy')), el('p', { class: 'empty__title' }, t('review.empty_wrong'))))]));
  }

  const filterRadio = (value, label) => el('label', null,
    el('input', { type: 'radio', name: 'review-filter', value, checked: filter === value, on: { change: () => { filter = value; paintList(); status.textContent = label; } } }),
    el('span', null, label));
  const filters = el('div', { class: 'segmented segmented--brand ev-filter', role: 'radiogroup', 'aria-label': t('review.filter_label') },
    filterRadio('all', t('review.filter_all', { count: items.length })),
    filterRadio('wrong', t('review.filter_wrong', { count: mistakes })));

  paintList();
  const title = el('h1', { class: 'ev-title', tabindex: '-1' }, t('review.title'));
  const root = el('div', { class: 'ev-review' },
    el('header', { class: 'ev-head' }, title, el('p', { class: 'ev-sub' }, t('review.subtitle'))),
    el('div', { class: 'ev-review-bar' },
      el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => ctx.back('results') } }, icon('arrow-left'), t('review.back')),
      filters),
    status,
    listHost,
    el('div', { class: 'ev-actions ev-actions--end' },
      el('button', { type: 'button', class: 'btn btn--primary btn--lg', on: { click: () => ctx.back('results') } }, icon('arrow-left'), t('review.back'))));

  return { el: root, focusEl: title, state: () => ({ filter }) };
}
