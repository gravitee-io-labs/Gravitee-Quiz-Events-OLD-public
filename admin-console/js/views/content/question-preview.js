/**
 * Live "what players see" preview of a question, built only from design-system classes
 * (.game-head, .question, .answers, .answer, .chip, .difficulty) and scoped to the event's brand colours.
 */
import { el, icon } from '../../../shared/js/dom.js';
import { applyBranding } from '../../../shared/js/branding.js';
import { DIFFICULTY, safeColor, trim } from './common.js';

/**
 * @param {{event: object}} o
 * @returns {{root: HTMLElement, update(data: object): void, setEvent(event: object): void, setLang(lang: 'en'|'fr'): void, lang: string}}
 */
export function createPreview({ event }) {
  let lang = 'en';
  let reveal = false;
  let data = null;
  let currentEvent = event;

  // ---- static structure ----------------------------------------------------------------------
  const counter = el('span', { class: 'game-counter' });
  const steps = el('div', { class: 'steps' });
  const ring = el('div', { class: 'ring ring--sm', 'data-state': 'ok', style: { '--value': 72 } },
    el('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      el('circle', { class: 'ring__track', cx: 50, cy: 50, r: 44, pathLength: 100 }),
      el('circle', { class: 'ring__bar', cx: 50, cy: 50, r: 44, pathLength: 100 })),
    el('span', { class: 'ring__label' }));
  const meta = el('div', { class: 'question__meta' });
  const media = el('figure', { class: 'question__media qv-pv__media', hidden: true });
  const mediaImg = el('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  media.append(mediaImg);
  mediaImg.addEventListener('error', () => { media.hidden = true; });
  mediaImg.addEventListener('load', () => { media.hidden = false; });
  const text = el('p', { class: 'question__text' });
  const greenLabel = el('span', { class: 'answer__label' });
  const redLabel = el('span', { class: 'answer__label' });
  const green = el('div', { class: 'answer answer--green' }, icon('check-circle-fill', { class: 'answer__icon' }), greenLabel, el('span', { class: 'answer__key' }, 'G'));
  const red = el('div', { class: 'answer answer--red' }, icon('x-circle-fill', { class: 'answer__icon' }), redLabel, el('span', { class: 'answer__key' }, 'R'));
  const screen = el('div', { class: 'qv-pv__screen' },
    el('div', { class: 'game-head' }, el('div', { class: 'game-head__info' }, counter, steps), ring),
    meta,
    el('section', { class: 'question glass' }, media, text),
    el('div', { class: 'answers' }, green, red));
  const frame = el('div', { class: 'preview-frame qv-pv__frame', 'aria-hidden': 'true' }, screen);
  const srSummary = el('p', { class: 'u-sr-only' });
  const note = el('p', { class: 'qv-pv__note', hidden: true });

  // ---- controls ------------------------------------------------------------------------------
  const radios = ['en', 'fr'].map((l) => el('input', { type: 'radio', name: 'qv-pv-lang', value: l, checked: l === lang }));
  const segmented = el('div', { class: 'segmented segmented--sm', role: 'radiogroup', 'aria-label': 'Preview language' },
    ...radios.map((r, i) => el('label', null, r, el('span', null, i === 0 ? 'EN' : 'FR'))));
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) { lang = r.value; render(); } }));
  const revealIn = el('input', { type: 'checkbox', class: 'switch', role: 'switch' });
  revealIn.addEventListener('change', () => { reveal = revealIn.checked; render(); });

  const root = el('section', { class: 'qv-pv', 'aria-label': 'Player preview' },
    el('div', { class: 'qv-pv__bar' },
      el('h3', { class: 'qv-pv__title' }, icon('device-mobile', { size: 'sm' }), 'Player preview'),
      segmented),
    frame, srSummary, note,
    el('label', { class: 'check qv-pv__reveal' }, revealIn, el('span', { class: 'check__text' }, 'Reveal the correct answer')));

  function brand() { try { applyBranding(currentEvent, { root: frame }); } catch { /* defaults */ } }
  brand();

  function render() {
    if (!data) return;
    const s = currentEvent?.settings || {};
    const total = Math.max(1, Number(s.questions_per_game) || 15);
    const n = Math.min(total, 7);
    counter.replaceChildren(`Question ${n} `, el('small', null, `/ ${total}`));
    steps.style.setProperty('--total', String(total));
    steps.replaceChildren(...Array.from({ length: total }, (_, i) => el('i', { class: i < n - 1 ? 'is-done' : i === n - 1 ? 'is-current' : null })));
    ring.querySelector('.ring__label').textContent = String(Number(s.timer_seconds) || 20);

    const fr = lang === 'fr';
    const pick = (en, frv) => (fr && trim(frv) ? trim(frv) : trim(en));
    const q = pick(data.question_text_en, data.question_text_fr);
    text.textContent = q || (fr ? 'Votre question apparaîtra ici…' : 'Your question will appear here…');
    text.classList.toggle('is-placeholder', !q);
    const gl = pick(data.green_label_en, data.green_label_fr) || (data.question_format === 'true_false' ? (fr ? 'Vrai' : 'TRUE') : 'Answer 1');
    const rl = pick(data.red_label_en, data.red_label_fr) || (data.question_format === 'true_false' ? (fr ? 'Faux' : 'FALSE') : 'Answer 2');
    greenLabel.textContent = gl;
    redLabel.textContent = rl;
    frame.lang = lang;

    const cat = data.category;
    const catName = cat ? (fr && trim(cat.name_fr) ? cat.name_fr : cat.name) : null;
    const level = Number(data.difficulty) || 1;
    const metaNodes = [];
    if (cat) metaNodes.push(el('span', { class: 'chip', style: { '--chip': safeColor(cat.color) } }, catName));
    metaNodes.push(el('span', { class: 'difficulty', 'data-level': Math.min(level, 3), role: 'img', 'aria-label': DIFFICULTY[level] || `Level ${level}` }));
    meta.replaceChildren(...metaNodes);

    const url = trim(data.media_url);
    if (url && /^(https:\/\/|\/(?!\/))/.test(url)) {
      if (mediaImg.getAttribute('src') !== url) { mediaImg.setAttribute('src', url); }
      else media.hidden = !mediaImg.complete || mediaImg.naturalWidth === 0;
    } else { mediaImg.removeAttribute('src'); media.hidden = true; }

    const correct = data.correct_answer === 'red' ? 'red' : 'green';
    for (const [node, side] of [[green, 'green'], [red, 'red']]) {
      node.classList.toggle('is-correct', reveal && correct === side);
      node.classList.toggle('is-dimmed', reveal && correct !== side);
    }
    srSummary.textContent = `Preview in ${fr ? 'French' : 'English'}. Question: ${q || 'empty'}. Green button: ${gl}. Red button: ${rl}. Correct answer: ${correct}.`;

    const fallback = fr && (!trim(data.question_text_fr) || (data.question_format === 'two_choices' && (!trim(data.green_label_fr) || !trim(data.red_label_fr))));
    note.hidden = !fallback;
    note.replaceChildren(...(fallback ? [icon('translate', { size: 'sm' }), el('span', null, 'Missing French text: players in French see the English version.')] : []));
  }

  return {
    root,
    update(next) { data = next; render(); },
    setEvent(next) { currentEvent = next; brand(); render(); },
    setLang(l) { lang = l; radios.forEach((r) => { r.checked = r.value === l; }); render(); },
    get lang() { return lang; },
  };
}
