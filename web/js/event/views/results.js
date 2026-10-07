/**
 * Results: animated score, rank "#N of M", correct / wrong / unanswered tiles, a message that fits the
 * performance, confetti for the podium or a high score, and the next actions.
 * In kiosk mode the screen resets to the landing page after 45 s.
 */
import { el, icon } from '/shared/js/dom.js';
import { countUp, celebrate } from '/shared/js/effects.js';
import { announce } from '/shared/js/ui.js';

export const KIOSK_RESULTS_SECONDS = 45;

export function performanceTier(correct, total) {
  const ratio = total > 0 ? correct / total : 0;
  if (total > 0 && correct === total) return 'perfect';
  if (ratio >= 0.8) return 'great';
  if (ratio >= 0.6) return 'good';
  if (ratio >= 0.4) return 'ok';
  return 'start';
}

export function resultsView(ctx) {
  const { state, t, i18n, kiosk, noScoreboard, slug } = ctx;
  const r = state.results;
  const s = r.game_session;
  const total = (r.review && r.review.length) || (s.correct_answers + s.wrong_answers + s.unanswered) || state.game?.questions?.length || 0;
  const tier = performanceTier(s.correct_answers, total);
  const name = (state.form.first_name || '').trim();
  const podium = r.rank >= 1 && r.rank <= 3;
  const subKey = r.rank === 1 ? 'results.sub_first' : podium ? 'results.sub_podium' : `results.sub_${tier}`;
  const scoreboardHref = `/${encodeURIComponent(slug)}/scoreboard`;
  const fmt = (n) => i18n.number(Math.round(n));

  /** Builds the whole screen from state (called again on a language switch: text only, no side effects). */
  function build(finalScore) {
    const scoreValue = el('span', { class: 'score-hero__value', 'aria-hidden': 'true' }, finalScore ? fmt(s.total_score) : '0');
    const title = el('h1', { class: 'ev-title ev-title--result', tabindex: '-1' }, t(`results.msg_${tier}${name ? '_named' : ''}`, { name }));
    const tile = (tone, label, value, iconName) => el('div', { class: ['stat', tone && `stat--${tone}`] },
      el('div', { class: 'stat__head' }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__icon' }, icon(iconName))),
      el('div', { class: 'stat__value u-tabular' }, i18n.number(value)));
    const countdown = kiosk ? el('p', { class: 'ev-kiosk-next', 'aria-hidden': 'true' }, icon('timer', { size: 'sm' }), el('span')) : null;
    const root = el('div', { class: 'ev-results' },
      el('header', { class: 'ev-head' }, title, el('p', { class: 'ev-sub' }, t(subKey))),
      el('section', { class: 'score-hero ev-score u-pop', 'aria-label': t('results.score') },
        el('span', { class: 'score-hero__label' }, t('results.score')),
        scoreValue,
        el('span', { class: 'u-sr-only' }, `${i18n.number(s.total_score)} ${t('results.points')}`),
        el('span', { class: 'score-hero__sub' },
          el('span', { class: 'badge badge--brand badge--lg ev-rank', 'aria-label': t('results.rank_aria', { rank: r.rank, total: r.total_players }) },
            icon('trophy-fill'), el('span', null, t('results.rank', { rank: i18n.number(r.rank), total: i18n.number(r.total_players) }))))),
      el('div', { class: 'stats stats--compact ev-tiles u-rise', style: { '--i': 2 }, role: 'group', 'aria-label': t('results.summary', { correct: s.correct_answers, wrong: s.wrong_answers, unanswered: s.unanswered }) },
        tile('success', t('results.correct'), s.correct_answers, 'check-circle'),
        tile('danger', t('results.wrong'), s.wrong_answers, 'x-circle'),
        tile('', t('results.unanswered'), s.unanswered, 'timer')),
      el('div', { class: 'ev-actions u-rise', style: { '--i': 3 } },
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', 'data-action': 'review', on: { click: () => ctx.go('review') } }, icon('list-checks'), t('results.review')),
        !(kiosk && noScoreboard) ? el('a', { class: 'btn btn--secondary btn--lg', href: scoreboardHref, 'data-action': 'scoreboard' }, icon('trophy'), t('results.scoreboard')) : null,
        el('button', { type: 'button', class: 'btn btn--ghost btn--lg', 'data-action': 'again', on: { click: () => ctx.playAgain() } }, icon('arrow-counter-clockwise'), t('results.again'))),
      countdown);
    return { root, scoreValue, title, countdown };
  }

  let ui = build(false);
  let timer = 0;
  let confettiHandle = null;
  let countHandle = null;
  let endAt = 0;
  const paintCountdown = () => {
    if (!ui.countdown) return;
    ui.countdown.lastElementChild.textContent = t('results.next_player', { s: Math.max(0, Math.ceil((endAt - Date.now()) / 1000)) });
  };

  return {
    el: ui.root,
    focusEl: ui.title,
    mounted() {
      countHandle = countUp(ui.scoreValue, s.total_score, { duration: 1500, format: fmt });
      announce(t('results.announce', { score: i18n.number(s.total_score), rank: r.rank, total: r.total_players }));
      if (podium || (total > 0 && s.correct_answers >= 1 && s.correct_answers / total >= 0.8)) {
        confettiHandle = setTimeout(() => celebrate(), 450);
      }
      if (kiosk) {
        endAt = Date.now() + KIOSK_RESULTS_SECONDS * 1000;
        paintCountdown();
        timer = setInterval(() => {
          if (Date.now() >= endAt) { clearInterval(timer); ctx.resetToLanding(); } else paintCountdown();
        }, 500);
      }
    },
    /** Language switch: rebuild the text, keep the final score, the confetti and the kiosk clock untouched. */
    refresh() {
      countHandle?.cancel?.();
      const next = build(true);
      ui.root.replaceWith(next.root);
      ui = next;
      paintCountdown();
    },
    destroy() { clearInterval(timer); clearTimeout(confettiHandle); countHandle?.cancel?.(); },
  };
}
