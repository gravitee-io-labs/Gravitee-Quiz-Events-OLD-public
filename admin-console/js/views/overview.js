/**
 * #/events/{id}/overview - identity + status control, public links (copy / QR), live numbers, readiness checklist,
 * hardest and easiest questions. Refreshes every 30 s while the tab is visible.
 * ctx (event scope): see app.js
 */
import { el, icon, delegate, formatNumber, formatPercent } from '../../shared/js/dom.js';
import { applyBranding } from '../../shared/js/branding.js';
import { initDropdowns } from '../../shared/js/ui.js';
import { countUp } from '../../shared/js/effects.js';
import { eventUrl, scoreboardUrl } from '../../shared/js/config.js';
import { STATUS, dateRange, fmt, clockTime, errorText, fill, medalContent } from '../core/util.js';
import { changeStatus, copyLink, openQrDialog, openDuplicateDialog, exportEvent, deleteEvent } from '../core/event-actions.js';

const REFRESH_MS = 30_000;
const SCAN_EVERY = 3;            // full question scan every N refreshes (counts changes trigger one immediately)
const MAX_SCAN = 5000;

export default {
  id: 'overview',
  title: 'Overview',
  icon: 'chart-bar',

  async mount(root, ctx) {
    const id = ctx.eventId;
    const st = { stats: null, statsError: null, scan: null, updatedAt: null, loading: false, ticks: 0, sig: '', lastRefresh: 0, eventSig: '', checksSig: '', statsSig: '' };
    const disposers = [];
    let abort = new AbortController();
    let timer = null;
    const ev = () => ctx.getEvent();

    // ---- skeleton of the page (stable nodes) ------------------------------------------------
    const heroHost = el('div');
    const refreshBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Refresh now', title: 'Refresh now', on: { click: () => refresh({ scan: true, manual: true }) } }, icon('arrows-clockwise'));
    const liveDot = el('span', { class: 'status-dot', dataset: { state: 'connecting' } });
    const liveText = el('span', null, 'Loading');
    const livePill = el('div', { class: 'ov-live', role: 'status' }, liveDot, liveText, refreshBtn);
    const statTiles = buildTiles();
    const statsGrid = el('div', { class: 'stats ov-stats' }, ...statTiles.map((t) => t.node));
    const statsAlert = el('div', { hidden: true });
    const checksHost = el('section', { class: 'card ov-card', 'aria-labelledby': 'ov-ready-title' });
    const linksHost = el('section', { class: 'card ov-card', 'aria-labelledby': 'ov-links-title' });
    const hardHost = el('section', { class: 'card ov-card', 'aria-labelledby': 'ov-hard-title' });
    const easyHost = el('section', { class: 'card ov-card', 'aria-labelledby': 'ov-easy-title' });

    root.replaceChildren(
      heroHost,
      el('div', { class: 'ov-section-head' }, el('h2', { class: 'ov-section-title' }, 'Live numbers'), livePill),
      statsAlert, statsGrid,
      el('div', { class: 'ov-grid' }, checksHost, linksHost),
      el('div', { class: 'ov-grid' }, hardHost, easyHost));
    disposers.push(initDropdowns(root));

    // ---- stat tiles ---------------------------------------------------------------------------
    function buildTiles() {
      const defs = [
        ['players', 'Players', 'users-three', ''], ['games', 'Games completed', 'flag-checkered', 'stat--success'],
        ['avg', 'Average score', 'gauge', ''], ['top', 'Top score', 'trophy', 'stat--accent'],
        ['correct', 'Average correct', 'check-circle', 'stat--success'], ['active', 'Active questions', 'question', ''],
      ];
      return defs.map(([key, label, ic, cls]) => {
        const value = el('div', { class: 'stat__value' }, el('span', { class: 'skeleton', style: { inlineSize: '3ch', blockSize: '1em' } }));
        const sub = el('div', { class: 'stat__sub' }, ' ');
        const node = el('div', { class: ['stat', cls, key === 'players' && 'stat--glow'], dataset: { stat: key } },
          el('div', { class: 'stat__head' }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__icon' }, icon(ic))), value, sub);
        return { key, node, value, sub, shown: null };
      });
    }
    function setTile(tile, number, sub, format) {
      const f = format || ((n) => formatNumber(Math.round(n)));
      if (tile.shown === null) tile.value.textContent = '';
      if (tile.shown !== number) countUp(tile.value, number, { from: tile.shown ?? 0, duration: tile.shown === null ? 900 : 600, format: f });
      tile.shown = number;
      tile.sub.textContent = sub || ' ';
    }
    function paintStats() {
      const s = st.stats, e = ev();
      statsAlert.hidden = true;
      if (!s) {
        if (st.statsError) {
          statsAlert.hidden = false;
          statsAlert.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, icon('warning-fill', { class: 'alert__icon' }),
            el('div', null, el('p', { class: 'alert__title' }, 'Could not load the numbers'), el('p', { class: 'alert__text' }, errorText(st.statsError))),
            el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => refresh({ scan: true, manual: true }) } }, icon('arrow-clockwise'), 'Retry')));
        }
        return;
      }
      const tile = (k) => statTiles.find((t) => t.key === k);
      setTile(tile('players'), s.players, s.players === 1 ? '1 registered' : 'registered');
      setTile(tile('games'), s.games_completed, s.games_in_progress ? `${fmt(s.games_in_progress)} in progress` : 'none in progress');
      setTile(tile('avg'), s.avg_score, 'points per game');
      setTile(tile('top'), s.top_score, 'best game so far');
      setTile(tile('correct'), s.avg_correct, `of ${e.settings.questions_per_game} per game`, (n) => formatNumber(n, { maximumFractionDigits: 1, minimumFractionDigits: 0 }));
      setTile(tile('active'), s.questions_active, `of ${fmt(e.counts.questions)} total`);
    }

    // ---- hero -----------------------------------------------------------------------------------
    function paintHero() {
      const e = ev();
      const s = STATUS[e.status] || STATUS.draft;
      const meta = [
        e.location ? ['map-pin', e.location] : null,
        dateRange(e.starts_on, e.ends_on) ? ['calendar-blank', dateRange(e.starts_on, e.ends_on)] : null,
        ['translate', (e.languages || []).map((l) => l.toUpperCase()).join(' · ')],
      ].filter(Boolean);

      const segName = `ov-status-${id}`;
      const segInputs = [];
      const seg = el('div', { class: 'segmented segmented--brand', role: 'radiogroup', 'aria-label': 'Event status' },
        ...['draft', 'live', 'closed'].map((key) => {
          const input = el('input', { type: 'radio', name: segName, value: key, checked: e.status === key, on: { change: () => onStatus(key, input) } });
          segInputs.push(input);
          return el('label', null, input, el('span', null, icon(STATUS[key].icon), STATUS[key].label));
        }));
      const hint = el('p', { class: 'ov-hero__hint', 'aria-live': 'polite' }, s.hint);

      async function onStatus(key, input) {
        if (key === ev().status) return;
        segInputs.forEach((i) => { i.disabled = true; });
        const updated = await changeStatus(ctx, ev(), key);
        segInputs.forEach((i) => { i.disabled = false; });
        if (updated) { await ctx.reloadEvent().catch(() => {}); } else { segInputs.forEach((i) => { i.checked = i.value === ev().status; }); }
        input.focus?.();
      }

      const more = el('div', { class: 'dropdown dropdown--end' },
        el('button', { type: 'button', class: 'btn btn--secondary btn--icon', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-dropdown-trigger': '', 'aria-label': 'More actions', title: 'More actions' }, icon('dots-three-vertical')),
        el('div', { class: 'menu', role: 'menu', hidden: true },
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'duplicate' } }, icon('copy-simple'), 'Duplicate…'),
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'export' } }, icon('download-simple'), 'Export bundle (JSON)'),
          el('hr', { class: 'menu__sep' }),
          el('button', { type: 'button', class: 'menu__item menu__item--danger', role: 'menuitem', dataset: { action: 'delete' } }, icon('trash'), 'Delete event…')));

      const node = el('section', { class: 'card ov-hero', 'aria-label': 'Event identity and status' },
        el('div', { class: 'ov-hero__glow', 'aria-hidden': 'true' }),
        el('div', { class: 'ov-hero__id' },
          el('span', { class: 'ov-hero__medal' }, medalContent(e.branding, '1.9rem')),
          el('div', { class: 'ov-hero__titles' },
            el('p', { class: 'ov-hero__kicker' }, e.game_title),
            el('h1', { class: 'ov-hero__title' }, e.name),
            el('p', { class: 'ov-hero__meta' }, ...meta.map(([ic, t]) => el('span', null, icon(ic, { size: 'sm' }), t)), el('span', null, icon('link-simple', { size: 'sm' }), el('code', null, `/${e.slug}`))))),
        el('div', { class: 'ov-hero__controls' },
          el('div', { class: 'ov-hero__status' }, el('span', { class: 'u-eyebrow', id: 'ov-status-label' }, 'Status'), seg, hint),
          el('div', { class: 'ov-hero__actions' },
            el('a', { class: 'btn btn--secondary', href: eventUrl(e.slug), target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Open game'),
            el('a', { class: 'btn btn--secondary', href: scoreboardUrl(e.slug), target: '_blank', rel: 'noopener' }, icon('television'), 'Scoreboard'),
            more)));
      applyBranding(e, { root: node });
      heroHost.replaceChildren(node);
    }

    // ---- links ----------------------------------------------------------------------------------
    function paintLinks() {
      const e = ev();
      const row = (kind, label, ic, url, desc, { qr = true } = {}) => {
        const copyBtn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', dataset: { action: 'copy', url, what: `${label} link` } }, icon('copy'), el('span', null, 'Copy'));
        return el('li', { class: 'link-row' },
          el('span', { class: 'link-row__icon' }, icon(ic)),
          el('div', { class: 'link-row__main' }, el('div', { class: 'link-row__label' }, label, el('span', { class: 'u-muted' }, ` · ${desc}`)),
            el('a', { class: 'link-row__url', href: url, target: '_blank', rel: 'noopener' }, url.replace(/^https?:\/\//, ''))),
          el('div', { class: 'link-row__actions' }, copyBtn,
            qr ? el('button', { type: 'button', class: 'btn btn--secondary btn--sm', dataset: { action: 'qr', kind }, 'aria-label': `QR code for the ${label.toLowerCase()} link` }, icon('qr-code'), el('span', { class: 'u-hide-sm' }, 'QR')) : null,
            el('a', { class: 'btn btn--ghost btn--icon btn--sm', href: url, target: '_blank', rel: 'noopener', 'aria-label': `Open the ${label.toLowerCase()} in a new tab`, title: 'Open' }, icon('arrow-square-out'))));
      };
      fill(linksHost,
        el('div', { class: 'card__header' }, el('div', null, el('h2', { class: 'card__title', id: 'ov-links-title' }, 'Public links'), el('p', { class: 'card__sub' }, 'Share these with players and put the scoreboard on the big screen.'))),
        el('ul', { class: 'link-list', role: 'list' },
          row('game', 'Game', 'device-mobile', eventUrl(e.slug), 'players join here'),
          row('scoreboard', 'Scoreboard', 'television', scoreboardUrl(e.slug), 'live leaderboard'),
          // the booth laptop: ?kiosk=1 wipes the previous visitor's details after each game (and offers the Bluetooth buzzers)
          row('kiosk', 'Booth laptop', 'desktop', `${eventUrl(e.slug)}?kiosk=1`, 'resets after each visitor', { qr: false })),
        e.status !== 'live' ? el('div', { class: 'alert alert--warning u-mt-4' }, icon('warning-fill', { class: 'alert__icon' }),
          el('div', null, el('p', { class: 'alert__title' }, e.status === 'draft' ? 'Not public yet' : 'Event closed'),
            el('p', { class: 'alert__text' }, e.status === 'draft' ? 'Players see a not-found page until you set the event live. While you are signed in you can still preview it.' : 'The game is no longer playable. The scoreboard link keeps working.'))) : null);
    }

    // ---- readiness ------------------------------------------------------------------------------
    function computeChecks() {
      const e = ev();
      const need = e.settings.questions_per_game, active = e.counts.active_questions;
      const base = `#/events/${id}`;
      const checks = [];

      checks.push({
        id: 'pool', title: 'Enough active questions',
        state: active < need ? 'error' : active === need ? 'warn' : 'ok',
        detail: active < need ? `${fmt(active)} active, but each game needs ${need}. Players will get an error when they start.`
          : active === need ? `Exactly ${need} active: every game asks the same questions. Add a few more for variety.`
            : `${fmt(active)} active questions, ${need} per game.`,
        fix: active <= need ? { label: 'Add questions', href: `${base}/questions` } : null,
      });

      if (!st.scan) {
        checks.push({ id: 'cats', title: 'Every category has questions', state: 'pending', detail: 'Checking…' });
        checks.push({ id: 'lang', title: 'Languages are complete', state: 'pending', detail: 'Checking…' });
      } else {
        const { categories, questions } = st.scan;
        const activeQ = questions.filter((q) => q.is_active);
        const perCat = new Map();
        for (const q of activeQ) if (q.category_id != null) perCat.set(q.category_id, (perCat.get(q.category_id) || 0) + 1);
        const liveCats = categories.filter((c) => c.is_active);
        const empty = liveCats.filter((c) => !perCat.get(c.id));
        if (!categories.length) checks.push({ id: 'cats', title: 'Every category has questions', state: 'warn', detail: 'No categories yet. Categories group the questions and drive the category mix of each game.', fix: { label: 'Add categories', href: `${base}/categories` } });
        else if (empty.length) checks.push({ id: 'cats', title: 'Every category has questions', state: 'warn', detail: `${empty.length} categor${empty.length === 1 ? 'y has' : 'ies have'} no active question: ${empty.slice(0, 4).map((c) => c.name).join(', ')}${empty.length > 4 ? '…' : ''}. They are left out of the game.`, fix: { label: 'Review categories', href: `${base}/categories` } });
        else checks.push({ id: 'cats', title: 'Every category has questions', state: 'ok', detail: `${liveCats.length} active categor${liveCats.length === 1 ? 'y' : 'ies'}, each with at least one active question.` });

        if (!(e.languages || []).includes('fr')) {
          checks.push({ id: 'lang', title: 'Languages are complete', state: 'ok', detail: 'Only English is enabled, nothing to translate.' });
        } else {
          const noFr = activeQ.filter((q) => !String(q.question_text_fr || '').trim());
          const noFrCat = liveCats.filter((c) => !String(c.name_fr || '').trim());
          const noTag = !String(e.tagline_fr || '').trim();
          const parts = [];
          if (noFr.length) parts.push(`${fmt(noFr.length)} of ${fmt(activeQ.length)} active question${activeQ.length === 1 ? '' : 's'} ${noFr.length === 1 ? 'has' : 'have'} no French text`);
          if (noFrCat.length) parts.push(`${noFrCat.length} categor${noFrCat.length === 1 ? 'y has' : 'ies have'} no French name`);
          if (noTag) parts.push('the French tagline is empty');
          const fix = noFr.length ? { label: 'Translate questions', href: `${base}/questions` } : noFrCat.length ? { label: 'Translate categories', href: `${base}/categories` } : { label: 'Open settings', href: `${base}/settings` };
          checks.push(parts.length
            ? { id: 'lang', title: 'Languages are complete', state: 'warn', detail: `${parts.join('; ')}. Missing text falls back to English.`.replace(/^./, (c) => c.toUpperCase()), fix }
            : { id: 'lang', title: 'Languages are complete', state: 'ok', detail: 'French text is present for every active question and category.' });
        }
      }

      checks.push(e.status === 'live'
        ? { id: 'live', title: 'Event is live', state: 'ok', detail: 'Listed on the hub and playable right now.' }
        : { id: 'live', title: 'Event is live', state: 'warn', detail: e.status === 'draft' ? 'The event is a draft: hidden from the hub and not playable.' : 'The event is closed: players can only see the scoreboard.', action: { label: e.status === 'draft' ? 'Go live' : 'Reopen', key: 'live' } });
      return checks;
    }

    function paintChecks() {
      const checks = computeChecks();
      const checksSig = JSON.stringify(checks);
      if (checksSig === st.checksSig) return;                 // nothing changed: keep the DOM (and keyboard focus) as is
      st.checksSig = checksSig;
      const done = checks.filter((c) => c.state === 'ok').length;
      const pending = checks.some((c) => c.state === 'pending');
      const worst = checks.some((c) => c.state === 'error') ? 'error' : checks.some((c) => c.state === 'warn') ? 'warn' : pending ? 'pending' : 'ok';
      const summary = { error: ['badge--danger', 'Not ready'], warn: ['badge--warning', 'Almost ready'], ok: ['badge--success', 'Ready to play'], pending: ['', 'Checking'] }[worst];
      const ICON = { ok: 'check-circle-fill', warn: 'warning-fill', error: 'x-circle-fill', pending: 'circle-notch' };
      const SR = { ok: 'Passed', warn: 'Needs attention', error: 'Blocking', pending: 'Checking' };
      checksHost.replaceChildren(
        el('div', { class: 'card__header' },
          el('div', null, el('h2', { class: 'card__title', id: 'ov-ready-title' }, 'Readiness'), el('p', { class: 'card__sub' }, `${done} of ${checks.length} checks passed`)),
          el('span', { class: ['badge', 'badge--lg', summary[0]] }, summary[1])),
        el('div', { class: 'progress progress--thin ov-progress', role: 'progressbar', 'aria-label': 'Checks passed', 'aria-valuemin': '0', 'aria-valuemax': String(checks.length), 'aria-valuenow': String(done), style: { '--value': (done / checks.length) * 100 } }, el('div', { class: 'progress__bar' })),
        el('ul', { class: 'checklist', role: 'list' }, ...checks.map((c) => el('li', { class: 'check-row', dataset: { state: c.state, check: c.id } },
          el('span', { class: 'check-row__icon' }, icon(ICON[c.state], { spin: c.state === 'pending' })),
          el('div', { class: 'check-row__body' }, el('p', { class: 'check-row__title' }, c.title, el('span', { class: 'u-sr-only' }, ` (${SR[c.state]})`)), el('p', { class: 'check-row__detail' }, c.detail)),
          c.fix ? el('a', { class: 'btn btn--secondary btn--sm', href: c.fix.href }, c.fix.label, icon('arrow-right')) : null,
          c.action ? el('button', { type: 'button', class: 'btn btn--primary btn--sm', dataset: { action: 'status-live' } }, c.action.label) : null))));
    }

    // ---- hardest / easiest ------------------------------------------------------------------------
    function paintRank(host, key, titleId, title, sub, tone) {
      const list = st.stats?.[key];
      host.replaceChildren(
        el('div', { class: 'card__header' }, el('div', null, el('h2', { class: 'card__title', id: titleId }, title), el('p', { class: 'card__sub' }, sub))),
        !st.stats ? el('span', { class: 'skeleton skeleton--card', style: { blockSize: '8rem' } })
          : !list?.length ? el('p', { class: 'ov-empty' }, icon('chart-bar'), 'Not enough answers yet. A question needs at least 3 answers from completed games.')
            : el('ol', { class: 'rank-list' }, ...list.map((q, i) => el('li', { class: 'rank-row' },
              el('span', { class: 'rank-row__n' }, String(i + 1)),
              el('div', { class: 'rank-row__main' }, el('p', { class: 'rank-row__text' }, q.question_text_en),
                el('div', { class: ['progress progress--thin', tone], role: 'progressbar', 'aria-label': 'Correct rate', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(q.correct_rate * 100)), style: { '--value': q.correct_rate * 100 } }, el('div', { class: 'progress__bar' }))),
              el('div', { class: 'rank-row__stat' }, el('strong', null, formatPercent(q.correct_rate)), el('span', null, `${fmt(q.answered)} answers`))))));
    }
    function paintRanks() {
      const sig = JSON.stringify(st.stats ? [st.stats.hardest_questions, st.stats.easiest_questions] : null);
      if (sig === st.statsSig) return;
      st.statsSig = sig;
      paintRank(hardHost, 'hardest_questions', 'ov-hard-title', 'Hardest questions', 'Lowest share of correct answers.', 'progress--danger');
      paintRank(easyHost, 'easiest_questions', 'ov-easy-title', 'Easiest questions', 'Highest share of correct answers.', 'progress--success');
    }

    // ---- actions ----------------------------------------------------------------------------------
    disposers.push(delegate(root, 'click', '[data-action]', async (e, node) => {
      const a = node.dataset.action;
      if (a === 'copy') {
        const ok = await copyLink(ctx, node.dataset.url, node.dataset.what);
        if (ok) { const label = node.querySelector('span'); const prev = label.textContent; label.textContent = 'Copied'; node.classList.add('is-done'); setTimeout(() => { label.textContent = prev; node.classList.remove('is-done'); }, 1600); }
      } else if (a === 'qr') openQrDialog(ctx, ev(), node.dataset.kind);
      else if (a === 'duplicate') openDuplicateDialog(ctx, ev());
      else if (a === 'export') exportEvent(ctx, ev());
      else if (a === 'delete') { if (await deleteEvent(ctx, ev())) { await ctx.refreshEvents().catch(() => {}); ctx.navigate('#/events'); } }
      else if (a === 'status-live') { const u = await changeStatus(ctx, ev(), 'live'); if (u) ctx.reloadEvent().catch(() => {}); }
    }));

    // ---- data ---------------------------------------------------------------------------------------
    async function fetchQuestions(signal) {
      const out = [];
      for (;;) {
        const page = await ctx.api.get(`/admin/events/${id}/questions`, { query: { skip: out.length, limit: 500, include_inactive: true }, signal });
        out.push(...page.items);
        if (!page.items.length || out.length >= page.total || out.length >= MAX_SCAN) break;
      }
      return out;
    }

    async function refresh({ scan = false, manual = false } = {}) {
      if (st.loading) return;
      st.loading = true;
      abort.abort(); abort = new AbortController();
      const { signal } = abort;
      refreshBtn.disabled = true; refreshBtn.querySelector('svg')?.classList.add('icon--spin');
      liveDot.dataset.state = 'connecting';
      try {
        const [stats, event] = await Promise.all([ctx.api.get(`/admin/events/${id}/stats`, { signal }), ctx.reloadEvent()]);
        if (signal.aborted) return;
        st.stats = stats; st.statsError = null;
        const sig = `${event.counts.questions}/${event.counts.active_questions}/${event.counts.categories}/${(event.languages || []).join()}`;
        st.ticks += 1;
        if (scan || !st.scan || sig !== st.sig || st.ticks % SCAN_EVERY === 0) {
          try {
            const [categories, questions] = await Promise.all([ctx.api.get(`/admin/events/${id}/categories`, { signal }), fetchQuestions(signal)]);
            if (signal.aborted) return;
            st.scan = { categories, questions }; st.sig = sig;
          } catch (e) { if (signal.aborted) return; if (!st.scan) st.scan = { categories: [], questions: [], failed: true }; }
        }
        st.updatedAt = new Date(); st.lastRefresh = Date.now();
        paintStats(); paintRanks(); paintChecks();
        liveDot.dataset.state = 'on'; liveText.textContent = `Updated ${clockTime(st.updatedAt)}`;
        liveText.title = 'Refreshes every 30 seconds while this tab is visible';
      } catch (e) {
        if (signal.aborted) return;
        if (e.isUnauthorized) return;
        st.statsError = e;
        liveDot.dataset.state = 'error';
        liveText.textContent = st.updatedAt ? `Update failed · last ${clockTime(st.updatedAt)}` : 'Update failed';
        if (!st.stats) paintStats();
        if (manual) ctx.toast(errorText(e), { type: 'error' });
      } finally {
        st.loading = false;
        refreshBtn.disabled = false; refreshBtn.querySelector('svg')?.classList.remove('icon--spin');
      }
    }

    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - st.lastRefresh > REFRESH_MS) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
    disposers.push(() => { document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); abort.abort(); });

    // another part of the console changed the event (status, name, counts): repaint what depends on it
    const repaintEvent = () => {
      const sig = JSON.stringify(ev());
      if (sig !== st.eventSig) { st.eventSig = sig; paintHero(); paintLinks(); }
      paintChecks();
      if (st.stats) paintStats();
    };
    disposers.push(ctx.onEventChanged(repaintEvent));

    repaintEvent(); paintRanks();
    refresh({ scan: true });

    return { unmount() { disposers.forEach((d) => d()); } };
  },
};
