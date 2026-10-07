/**
 * Rules: numbers come from the event settings, then Start (register the player, create the game).
 */
import { el, icon } from '/shared/js/dom.js';
import { withBusy } from '/shared/js/ui.js';

function ruleCard({ iconName, tone, title, children }) {
  return el('article', { class: ['ev-rule', tone && `ev-rule--${tone}`, 'u-rise'] },
    el('span', { class: 'ev-rule__icon' }, icon(iconName)),
    el('div', { class: 'ev-rule__body' },
      el('h2', { class: 'ev-rule__title' }, title),
      ...children));
}

export function rulesView(ctx) {
  const { event, i18n, t, state } = ctx;
  const s = event.settings || {};
  const questions = s.questions_per_game ?? 15;
  const seconds = s.timer_seconds ?? 20;
  const pointsCorrect = s.points_correct ?? 100;
  const bonus = s.time_bonus_max ?? 0;
  const pointsWrong = s.points_wrong ?? 0;
  const name = (state.form.first_name || '').trim();

  const scoring = [
    el('p', null, t('rules.score_correct', { points: i18n.number(pointsCorrect) })),
    bonus > 0 ? el('p', null, t('rules.score_bonus', { bonus: i18n.number(bonus) })) : null,
    pointsWrong > 0 ? el('p', null, t('rules.score_wrong', { points: i18n.number(pointsWrong) })) : el('p', null, t('rules.score_none')),
  ];

  const keyDemo = el('div', { class: 'ev-keys', 'aria-hidden': 'true' },
    el('span', { class: 'ev-keys__item ev-keys__item--green' }, el('span', { class: 'kbd kbd--green' }, 'G'), el('span', null, t('rules.green'))),
    el('span', { class: 'ev-keys__item ev-keys__item--red' }, el('span', { class: 'kbd kbd--red' }, 'R'), el('span', null, t('rules.red'))));

  // a visitor's own phone has no keyboard and no buzzers (they live on the booth laptop, ?kiosk=1): keep the rule short and true
  const phone = !ctx.kiosk && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const cards = [
    ruleCard({ iconName: 'list-checks', title: t('rules.questions_title', { count: questions }), children: [el('p', null, t('rules.questions_text'))] }),
    ruleCard({ iconName: 'timer', tone: 'accent', title: t('rules.time_title', { count: seconds }), children: [el('p', null, t('rules.time_text'))] }),
    ruleCard({ iconName: 'lightning', title: t('rules.score_title'), children: scoring }),
    ruleCard({ iconName: 'hand-pointing', tone: 'success', title: t('rules.controls_title'), children: [el('p', null, t(phone ? 'rules.controls_text_touch' : 'rules.controls_text')), keyDemo] }),
  ];

  // buzzer shortcut: only when the buzzer module loaded and the browser can do Web Bluetooth
  let buzzerCard = null;
  let offBuzzer = null;
  const buzzer = ctx.buzzer;
  if (buzzer && buzzer.isSupported) {
    const statusText = el('p', { class: 'ev-buzzer__status', 'aria-live': 'polite' });
    const renderStatus = () => {
      const level = buzzer.getStatus?.().level || 'none';
      statusText.textContent = t(`rules.buzzer_${level === 'both' ? 'both' : level === 'one' ? 'one' : 'none'}`);
      btnLabel.textContent = level === 'none' ? t('rules.buzzer_connect') : t('rules.buzzer_manage');
    };
    const btnLabel = el('span');
    buzzerCard = el('aside', { class: 'ev-buzzer glass u-rise', 'aria-labelledby': 'buzzer-title' },
      el('span', { class: 'ev-rule__icon' }, icon('bluetooth')),
      el('div', { class: 'ev-buzzer__text' }, el('h2', { class: 'ev-rule__title', id: 'buzzer-title' }, t('rules.buzzer_title')), statusText),
      el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => buzzer.open() } }, icon('bluetooth-connected'), btnLabel));
    renderStatus();
    offBuzzer = buzzer.on?.('status', renderStatus);
  }

  const errorSlot = el('div', { class: 'ev-rules-error', 'aria-live': 'assertive' });
  const showError = (key) => {
    errorSlot.replaceChildren(key ? el('div', { class: 'alert alert--danger', role: 'alert' },
      icon('warning-fill', { class: 'alert__icon' }),
      el('div', null, el('p', { class: 'alert__title' }, t('rules.err_title')), el('p', { class: 'alert__text' }, t(key)))) : '');
  };

  const startBtn = el('button', {
    type: 'button', class: 'btn btn--primary btn--xl btn--block ev-start', 'data-action': 'start',
    on: {
      click: () => withBusy(startBtn, async () => {
        showError(null);
        const result = await ctx.startGame();
        if (result && result.error) showError(result.error);
      }),
    },
  }, icon('play-fill'), t('rules.start'));

  const root = el('div', { class: 'ev-rules' },
    el('header', { class: 'ev-head' },
      el('h1', { class: 'ev-title', tabindex: '-1' }, t('rules.title')),
      el('p', { class: 'ev-sub' }, name ? t('rules.subtitle_named', { name }) : t('rules.subtitle'))),
    el('div', { class: 'ev-rule-grid' }, cards),
    buzzerCard,
    // the Start button (with its error message) sticks to the bottom of a phone screen: the rule cards are taller than the viewport
    el('div', { class: 'ev-start-row' }, errorSlot, startBtn),
    el('div', { class: 'ev-start-after' },
      el('p', { class: 'ev-note' }, icon('timer', { size: 'sm' }), el('span', null, t('rules.note'))),
      el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => ctx.back('register') } }, icon('arrow-left'), t('rules.back'))));

  return {
    el: root,
    focusEl: root.querySelector('.ev-title'),
    destroy() { offBuzzer?.(); },
  };
}
