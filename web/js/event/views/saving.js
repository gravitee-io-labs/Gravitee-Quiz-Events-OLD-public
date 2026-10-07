/**
 * "Saving your score": POST the answers, with exponential backoff on network / 5xx failures.
 * A finished game is never lost: the answers stay in memory (and in the resume snapshot, without personal data)
 * until the server confirms.
 *
 * Lost response: the server may have scored the game while the answer never reached us (a flaky Wi-Fi drops the
 * response, not the request). The retry then gets 409 "already saved". Instead of stopping there, we read the result
 * the server holds (GET .../result, authorised by the same game token as the submit) and show the normal results and
 * review. The "already saved" screen remains the last resort, when the result cannot be read (token lost, game gone).
 */
import { el, icon } from '/shared/js/dom.js';
import { api, ApiError } from '/shared/js/api.js';
import { announce } from '/shared/js/ui.js';
import { saveSnapshot, clearSnapshot } from '../state.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export function savingView(ctx) {
  const { t, state, slug, kiosk, noScoreboard } = ctx;
  const g = state.game;
  const scoreboardHref = `/${encodeURIComponent(slug)}/scoreboard`;
  const host = el('div', { class: 'ev-saving', role: 'status', 'aria-live': 'polite' });
  const title = el('h1', { class: 'ev-title', tabindex: '-1' });
  const root = el('div', { class: 'ev-saving-wrap glass' }, title, host);

  let destroyed = false;
  let attempt = 0;
  let recovering = false; // the server already holds this game: read its result instead of sending the answers again
  let wake = null; // resolves the current wait early ("try again now")
  let ticker = 0;
  let repaint = () => {}; // re-draws the current state (language switch)

  const spinner = () => el('span', { class: 'spinner ev-spinner', 'aria-hidden': 'true' });

  function paint({ heading, text, extra = [], tone, spin = true }) {
    title.textContent = heading;
    host.replaceChildren(...[
      spin ? spinner() : el('span', { class: ['ev-saving__icon', tone && `ev-saving__icon--${tone}`] }, icon(tone === 'danger' ? 'warning-fill' : 'check-circle')),
      text ? el('p', { class: 'ev-sub' }, text) : null,
      ...extra,
    ].filter(Boolean));
  }

  const retryNow = el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => wake?.() } }, icon('arrow-clockwise'), t('game.saving_retry_now'));

  function wait(ms, onTick) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const done = () => { clearInterval(ticker); wake = null; resolve(); };
      wake = done;
      ticker = setInterval(() => {
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left <= 0 || destroyed) done(); else onTick(left);
      }, 250);
      onTick(Math.ceil(ms / 1000));
    });
  }

  function failed(key) {
    repaint = () => failed(key);
    paint({
      heading: t('game.failed_title'), text: t(key), tone: 'danger', spin: false,
      extra: [el('div', { class: 'ev-saving__actions' },
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', on: { click: () => { attempt = 0; run(); } } }, icon('arrow-clockwise'), t('common.retry')),
        el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => ctx.playAgain() } }, t('results.again')))],
    });
    announce(t(key), { politeness: 'assertive' });
  }

  function alreadySaved() {
    clearSnapshot(slug);
    repaint = alreadySaved;
    paint({
      heading: t('game.saved_title'), text: t('game.saved_text'), tone: 'ok', spin: false,
      extra: [el('div', { class: 'ev-saving__actions' },
        !(kiosk && noScoreboard) ? el('a', { class: 'btn btn--primary btn--lg', href: scoreboardHref }, icon('trophy'), t('results.scoreboard')) : null,
        el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => ctx.playAgain() } }, icon('arrow-counter-clockwise'), t('results.again')))],
    });
  }

  const gamePath = () => `/events/${encodeURIComponent(slug)}/games/${g.id}`;

  /** POST the answers (the game token travels in the body). */
  function sendAnswers() {
    const body = g.submitToken ? { answers: g.answers, submit_token: g.submitToken } : { answers: g.answers };
    return api.post(`${gamePath()}/submit`, body, { timeout: 20000 });
  }

  /** GET the result of the completed game (a GET has no body: the token travels in a header; our own backoff, no hidden retries). */
  function readResult() {
    return api.get(`${gamePath()}/result`, { headers: g.submitToken ? { 'X-Game-Token': g.submitToken } : {}, timeout: 20000, retries: 0 });
  }

  async function run() {
    while (!destroyed) {
      attempt += 1;
      const sending = attempt;
      repaint = () => paint({ heading: t('game.saving_title'), text: t('game.saving_sending', { n: sending }), extra: [el('p', { class: 'ev-note' }, icon('lock-key', { size: 'sm' }), el('span', null, t('game.saving_keep')))] });
      paint({ heading: t('game.saving_title'), text: t('game.saving_sending', { n: attempt }), extra: [el('p', { class: 'ev-note' }, icon('lock-key', { size: 'sm' }), el('span', null, t('game.saving_keep')))] });
      try {
        const res = recovering ? await readResult() : await sendAnswers();
        if (destroyed) return;
        state.results = res;
        clearSnapshot(slug);
        ctx.go('results', { replace: true });
        return;
      } catch (e) {
        if (destroyed) return;
        const status = e instanceof ApiError ? e.status : 0;
        if (recovering) {
          // The result is owed to us but cannot be had (no / wrong token, game gone, still not completed): it IS saved.
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) { alreadySaved(); return; }
        } else {
          // 409: scored already. A "game_not_in_progress" game was abandoned (nothing to read); any other 409 is
          // our own earlier attempt that went through, so fetch its result right away (no waiting).
          if (status === 409 && e.code !== 'game_not_in_progress') { recovering = true; continue; }
          if (status === 409) { alreadySaved(); return; }
          if (status === 403) { failed(e.code === 'event_closed' ? 'game.failed_closed' : 'game.failed_text'); return; }
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) { failed('game.failed_text'); return; }
        }
        const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
        const n = attempt;
        let secondsLeft = Math.ceil(delay / 1000);
        let retryText = null;
        const paintRetry = () => {
          retryText = el('p', { class: 'ev-sub' }, t('game.saving_retry', { s: secondsLeft, n }));
          retryNow.replaceChildren(icon('arrow-clockwise'), t('game.saving_retry_now'));
          paint({ heading: t('game.saving_title'), text: '', extra: [retryText, retryNow, el('p', { class: 'ev-note' }, icon('lock-key', { size: 'sm' }), el('span', null, t('game.saving_keep')))] });
        };
        repaint = paintRetry;
        paintRetry();
        await wait(delay, (left) => { secondsLeft = left; if (retryText) retryText.textContent = t('game.saving_retry', { s: left, n }); });
      }
    }
  }

  return {
    el: root,
    focusEl: title,
    mounted() {
      saveSnapshot(slug, g, 'submitting');
      run();
    },
    refresh() { repaint(); },
    destroy() { destroyed = true; clearInterval(ticker); wake?.(); },
  };
}
