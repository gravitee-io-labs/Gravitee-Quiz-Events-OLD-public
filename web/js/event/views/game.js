/**
 * Game view: one question at a time, countdown ring, two giant answer buttons.
 *
 * Semantics kept from the legacy client (game-client/js/app.js):
 *  - the clock starts when the question is shown; time_taken is measured from then, clamped to timer_seconds;
 *  - a timeout records player_answer = null with time_taken = timer_seconds;
 *  - only the first answer per question counts (double clicks / key + buzzer at once are ignored);
 *  - correctness is NEVER shown during the game: the server reveals it with the final results.
 * The clock is deadline based (performance.now()), so a throttled background tab cannot stretch a question.
 */
import { el, icon } from '/shared/js/dom.js';
import { announce } from '/shared/js/ui.js';
import { isSafeImageUrl, round3 } from '../../lib/format.js';
import { saveSnapshot } from '../state.js';
import { chipColor } from './landing.js';

const LOCK_MS = 650;        // short pause after an answer before the next question
const IMAGE_WAIT_MS = 1500; // never wait longer than this for a question image before starting the clock
const FLASH_MS = 160;

const sizeFor = (text) => {
  const n = String(text || '').length;
  return n <= 90 ? 'lg' : n <= 160 ? 'md' : n <= 260 ? 'sm' : 'xs';
};

function whenImageReady(img, ms) {
  if (!img || img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
    const timer = setTimeout(done, ms);
    img.addEventListener('load', done);
    img.addEventListener('error', done);
  });
}

export function gameView(ctx) {
  const { i18n, t, state } = ctx;
  const g = state.game;
  const total = g.questions.length;
  const timer = g.timerSeconds;

  let index = Math.min(g.answers.length, total);
  let locked = true;
  let destroyed = false;
  let startedAt = 0;     // performance.now() when the clock started
  let startedWall = 0;   // Date.now() at the same moment: performance.now() can stand still while a phone sleeps (iOS), the wall clock cannot
  let tickTimer = 0;
  let nextTimer = 0;
  let flashTimer = 0;
  let runId = 0; // guards async work (image wait) against a question that already moved on

  // ---- DOM -------------------------------------------------------------------------------------
  const counter = el('div', { class: 'game-counter', 'aria-hidden': 'true' });
  const chipHost = el('div', { class: 'ev-chip-host' });
  const ringLabel = el('span', { class: 'ring__label' }, String(timer));
  const ring = el('div', { class: 'ring ring--lg ev-ring', 'data-state': 'ok', style: { '--value': 100 }, role: 'timer' },
    el('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      el('circle', { class: 'ring__track', cx: 50, cy: 50, r: 44, pathLength: 100 }),
      el('circle', { class: 'ring__bar', cx: 50, cy: 50, r: 44, pathLength: 100 })),
    ringLabel);
  const steps = el('div', { class: 'steps ev-steps', style: { '--total': total }, 'aria-hidden': 'true' },
    g.questions.map(() => el('i')));
  const srProgress = el('h1', { class: 'u-sr-only', id: 'ev-q-progress' });
  const mediaHost = el('div', { class: 'ev-media-host' });
  const text = el('p', { class: 'question__text ev-question-text' });
  const lockNote = el('p', { class: 'ev-lock', hidden: true, 'aria-hidden': 'true' });
  const card = el('section', { class: 'question glass ev-question', tabindex: '-1', 'aria-labelledby': 'ev-q-progress' },
    srProgress, mediaHost, text, lockNote);

  const answerBtn = (color) => {
    const icn = el('span', { class: 'answer__icon' });
    // the accessible name comes from the content (hidden colour prefix + the visible label), not from an aria-label: it always
    // contains the visible text (WCAG 2.5.3 Label in Name, so "click TRUE" works for voice control) and the key cap stays out of it
    const prefix = el('span', { class: 'u-sr-only' });
    const label = el('span', { class: 'answer__label' });
    const key = el('span', { class: 'answer__key', 'aria-hidden': 'true' }, color === 'green' ? 'G' : 'R');
    const btn = el('button', {
      type: 'button', class: `answer answer--${color}`, 'data-color': color, 'aria-keyshortcuts': color === 'green' ? 'G' : 'R',
      on: { click: () => answer(color, 'tap') },
    }, icn, prefix, label, key);
    return { btn, icn, label, prefix };
  };
  const green = answerBtn('green');
  const red = answerBtn('red');
  const answers = el('div', { class: 'answers ev-answers' }, green.btn, red.btn);

  const root = el('div', { class: 'ev-game' },
    el('div', { class: 'game-head ev-game-head' }, el('div', { class: 'game-head__info' }, counter, chipHost), ring),
    steps,
    card,
    el('div', { class: 'screen__bottom screen__bottom-safe ev-bottom' }, answers));

  // ---- rendering -------------------------------------------------------------------------------
  const current = () => g.questions[Math.min(index, total - 1)];

  /** The question card scrolls inside when its text is long: then it must be reachable with the Tab key (WCAG 2.1.1). */
  function syncScrollable() {
    card.tabIndex = card.scrollHeight > card.clientHeight + 1 ? 0 : -1;
  }

  function paintSteps() {
    [...steps.children].forEach((node, i) => {
      node.className = i < index ? 'is-done' : i === index ? 'is-current' : '';
    });
  }

  function paintTexts() {
    const q = current();
    const n = Math.min(index + 1, total);
    counter.replaceChildren(`${t('game.question')} ${i18n.number(n)} `, el('small', null, `/ ${i18n.number(total)}`));
    srProgress.textContent = t('game.progress', { n, total });
    ring.setAttribute('aria-label', t('game.time_left'));
    const cat = q.category;
    chipHost.replaceChildren(el('span', { class: 'chip', style: { '--chip': cat ? chipColor(cat.color) : 'var(--fg-muted)' } },
      cat ? i18n.pick(cat, 'name') : t('game.category_none')));
    const qText = i18n.pick(q, 'question_text');
    text.textContent = qText;
    text.dataset.size = sizeFor(qText);
    const gl = i18n.pick(q, 'green_label');
    const rl = i18n.pick(q, 'red_label');
    green.label.textContent = gl;
    red.label.textContent = rl;
    green.prefix.textContent = `${t('game.answer_green')} `;
    red.prefix.textContent = `${t('game.answer_red')} `;
    // true/false questions get check / cross icons; two-choice questions stay neutral (an icon would hint at the answer)
    const tf = q.question_format === 'true_false';
    green.icn.replaceChildren(...(tf ? [icon('check-circle-fill')] : []));
    red.icn.replaceChildren(...(tf ? [icon('x-circle-fill')] : []));
    green.btn.classList.toggle('answer--plain', !tf);
    red.btn.classList.toggle('answer--plain', !tf);
    const lastAnswer = g.answers[index];
    if (locked && lastAnswer) paintLockNote(lastAnswer.player_answer);
    const img = mediaHost.querySelector('img');
    if (img) img.alt = t('game.media_alt');
  }

  function paintLockNote(color) {
    lockNote.hidden = false;
    lockNote.classList.toggle('ev-lock--timeout', !color);
    lockNote.replaceChildren(icon(color ? 'lock-key' : 'timer', { size: 'sm' }), el('span', null, color ? t('game.locked') : t('game.timeout')));
  }

  function setRing(left, nextValue) {
    ringLabel.textContent = String(left);
    const danger = Math.min(5, Math.ceil(timer * 0.25));
    const warn = Math.ceil(timer * 0.5);
    ring.dataset.state = left <= danger ? 'danger' : left <= warn ? 'warn' : 'ok';
    ring.style.setProperty('--value', String(Math.max(0, nextValue)));
  }

  function resetRing() {
    ring.classList.add('ev-ring--reset');
    ring.classList.remove('is-locked');
    ring.style.setProperty('--value', '100');
    ring.dataset.state = 'ok';
    ringLabel.textContent = String(timer);
    void ring.offsetWidth; // commit the reset without animating back up from the previous question
    ring.classList.remove('ev-ring--reset');
  }

  // ---- timer -----------------------------------------------------------------------------------
  /** Seconds since the question appeared: the larger of the two clocks, so a locked screen never buys extra time. */
  const elapsedNow = () => Math.max((performance.now() - startedAt) / 1000, (Date.now() - startedWall) / 1000);

  function schedule(k) {
    const due = startedAt + k * 1000;
    tickTimer = setTimeout(() => tick(k), Math.max(0, due - performance.now()));
  }

  function tick(k) {
    if (locked || destroyed) return;
    const step = Math.max(k, Math.floor(elapsedNow())); // normally k; jumps ahead after a throttled / suspended page
    const left = timer - step;
    if (left <= 0) { timeout(); return; }
    setRing(left, ((left - 1) / timer) * 100);
    if (left === 10 || left === 5) announce(t('game.seconds_left', { count: left }));
    schedule(step + 1);
  }

  function startClock() {
    startedAt = performance.now();
    startedWall = Date.now();
    locked = false;
    setRing(timer, ((timer - 1) / timer) * 100);
    schedule(1);
  }

  // ---- question flow ---------------------------------------------------------------------------
  async function showQuestion() {
    const id = ++runId;
    locked = true;
    clearTimeout(tickTimer);
    const q = current();
    g.shown = index;
    saveSnapshot(state.slug, g, 'playing');

    paintSteps();
    resetRing();
    lockNote.hidden = true;
    [green.btn, red.btn].forEach((b) => { b.disabled = true; b.classList.remove('is-selected', 'is-dimmed', 'is-pressed'); });

    mediaHost.replaceChildren();
    let img = null;
    if (q.media_url && q.question_type !== 'text' && isSafeImageUrl(q.media_url)) {
      img = el('img', { src: q.media_url, alt: t('game.media_alt'), decoding: 'async', class: 'ev-media', on: { error: (e) => e.currentTarget.closest('figure')?.remove() } });
      mediaHost.append(el('figure', { class: 'question__media ev-figure' }, img));
    }
    paintTexts();
    syncScrollable();
    card.classList.remove('is-entering');
    void card.offsetWidth;
    card.classList.add('is-entering');
    card.focus({ preventScroll: true });
    window.scrollTo(0, 0);

    const next = g.questions[index + 1];
    if (next && next.media_url && isSafeImageUrl(next.media_url)) { const pre = new Image(); pre.src = next.media_url; }

    if (img) await whenImageReady(img, IMAGE_WAIT_MS);
    if (destroyed || id !== runId) return;
    syncScrollable(); // the image changed the height of the card

    [green.btn, red.btn].forEach((b) => { b.disabled = false; });
    ctx.buzzer?.setReady?.(true);
    startClock();
  }

  /** Stop the ring exactly where the answer happened (no drift during the lock pause). */
  function freezeRing(elapsed) {
    ring.classList.add('ev-ring--reset', 'is-locked');
    ring.style.setProperty('--value', String(Math.max(0, ((timer - elapsed) / timer) * 100)));
  }

  function lockUi(color, seconds) {
    locked = true;
    clearTimeout(tickTimer);
    [green.btn, red.btn].forEach((b) => { b.disabled = true; });
    if (color) {
      const chosen = color === 'green' ? green.btn : red.btn;
      const other = color === 'green' ? red.btn : green.btn;
      chosen.classList.add('is-selected');
      other.classList.add('is-dimmed');
    } else {
      green.btn.classList.add('is-dimmed');
      red.btn.classList.add('is-dimmed');
    }
    freezeRing(seconds);
    paintLockNote(color);
    ctx.buzzer?.setReady?.(false);
    steps.children[index]?.classList.add('is-done');
  }

  function record(color, seconds) {
    const q = g.questions[index];
    g.answers.push({ question_id: q.id, player_answer: color, time_taken: round3(seconds) });
    saveSnapshot(state.slug, g, 'playing');
    lockUi(color, seconds);
    clearTimeout(nextTimer);
    nextTimer = setTimeout(advance, LOCK_MS);
  }

  /** The player's answer. `via` only drives the pressed animation of buttons that were not clicked. */
  function answer(color, via = 'tap') {
    if (locked || destroyed || (color !== 'green' && color !== 'red')) return false;
    if (elapsedNow() >= timer) { timeout(); return false; } // the time is up even if the tick has not fired yet (throttled tab): too late
    locked = true; // first answer wins: set before anything else so a second event in the same tick is ignored
    const elapsed = Math.min(elapsedNow(), timer);
    if (via !== 'tap') {
      const btn = color === 'green' ? green.btn : red.btn;
      btn.classList.add('is-pressed');
      flashTimer = setTimeout(() => btn.classList.remove('is-pressed'), FLASH_MS);
    }
    const label = i18n.pick(current(), color === 'green' ? 'green_label' : 'red_label');
    record(color, elapsed);
    announce(t('game.locked_aria', { answer: label }));
    return true;
  }

  function timeout() {
    if (locked || destroyed) return;
    locked = true;
    record(null, timer);
    announce(t('game.timeout_aria'), { politeness: 'assertive' });
  }

  function advance() {
    if (destroyed) return;
    index += 1;
    if (index >= total) { ctx.finishGame(); return; }
    showQuestion();
  }

  // ---- input -----------------------------------------------------------------------------------
  function onKey(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    // only text entry swallows G / R: the language radios and the theme button keep the focus after a click and must not block the keys
    if (target instanceof HTMLElement && target.matches('textarea, select, [contenteditable="true"], input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"], [type="range"])')) return;
    const k = e.key.toLowerCase();
    if (k === 'g') { answer('green', 'key'); } else if (k === 'r') { answer('red', 'key'); }
  }

  return {
    el: root,
    focusEl: null, // showQuestion() focuses the question card itself
    mounted() {
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', syncScrollable);
      ctx.onBuzzerPress = (color) => answer(color, 'buzzer');
      if (index >= total) { ctx.finishGame(); return; }
      showQuestion();
    },
    refresh() { paintTexts(); syncScrollable(); },
    destroy() {
      destroyed = true;
      runId += 1;
      clearTimeout(tickTimer);
      clearTimeout(nextTimer);
      clearTimeout(flashTimer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', syncScrollable);
      if (ctx.onBuzzerPress) ctx.onBuzzerPress = null;
      ctx.buzzer?.setReady?.(false);
    },
  };
}
