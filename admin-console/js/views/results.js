/**
 * Results tab: players and their games for one event.
 *
 * Server-side pagination / search / sort (GET /admin/events/{id}/results), row details (answers),
 * score correction (PATCH), delete, leads CSV export, optional 15 s auto-refresh, responsive card layout.
 * Contract: docs/ARCHITECTURE.md section 5.3 (Results) and the admin view contract (mount / unmount).
 */
import { api as sharedApi } from '../../shared/js/api.js';
import {
  el, icon, hydrateIcons, debounce, uid, avatar, clamp, copyToClipboard, formatDateTime, formatNumber, formatDuration, relativeTime, setBusy,
} from '../../shared/js/dom.js';
import { openModal, announce } from '../../shared/js/ui.js';

const LANG = 'en';
const REFRESH_MS = 15000;
const TICK_MS = 30000;
const SIZES = [25, 50, 100];
const LS_AUTO = 'quiz.admin.results.auto';
const LS_SIZE = 'quiz.admin.results.size';
const RANK_LIMIT = 500;

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

const fmtN = (n) => formatNumber(n, { lang: LANG });
const fullName = (p) => `${p.first_name} ${p.last_name}`.trim();
const exactTime = (d) => formatDateTime(d, { lang: LANG, second: '2-digit' });

function errorText(e) {
  if (!e) return 'Something went wrong';
  if (e.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
  if (e.isTimeout) return 'The server took too long to answer.';
  return typeof e.detail === 'string' && e.detail ? e.detail : e.message || 'Something went wrong';
}

export default {
  id: 'results',
  title: 'Results',
  icon: 'trophy',

  async mount(root, ctx) {
    const api = ctx.api || sharedApi;
    const eventId = ctx.eventId;

    const state = {
      items: [],
      total: 0,
      skip: 0,
      size: SIZES.includes(+lsGet(LS_SIZE)) ? +lsGet(LS_SIZE) : 25,
      search: '',
      order: 'recent',
      status: 'completed',
      auto: lsGet(LS_AUTO) !== 'off',
      loaded: false,
      loading: false,
      error: null,
      updatedAt: null,
      stats: null,
      ranks: new Map(),
      ranksTotal: 0,
      ranksDirty: true,
    };

    let alive = true;
    let abort = null;
    let loadSeq = 0;
    let lastSig = '';
    let restoreKey = null;    // data-focus-key to put the focus back on after the next render (a dialog just closed)
    let refreshTimer = null;
    let tickTimer = null;
    const openDialogs = new Set();
    const disposers = [];

    // ------------------------------------------------------------------------------------------
    // skeleton of the view
    // ------------------------------------------------------------------------------------------
    const ids = { heading: uid('rs-heading'), search: uid('rs-search'), status: uid('rs-status'), auto: uid('rs-auto'), order: uid('rs-order') };

    const statValue = (key) => el('div', { class: 'stat__value', dataset: { stat: key } }, '–');
    const stat = (label, ic, key, mod) => el('div', { class: ['stat', mod] },
      el('div', { class: 'stat__head' }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__icon' }, icon(ic))),
      statValue(key));
    const statsEl = el('div', { class: 'stats rs-stats', role: 'group', 'aria-label': 'Results summary' },
      stat('Completed games', 'trophy', 'completed', 'stat--glow'),
      stat('In progress', 'hourglass-medium', 'in_progress', 'stat--accent'),
      stat('Average score', 'chart-bar', 'avg', 'stat--success'),
      stat('Top score', 'medal', 'top'));

    const searchInput = el('input', {
      class: 'input', type: 'search', id: ids.search, placeholder: 'Search name or email', autocomplete: 'off', spellcheck: 'false',
      maxlength: '200', 'aria-label': 'Search players by name or email',
    });
    const orderGroup = el('div', { class: 'segmented segmented--sm', role: 'radiogroup', 'aria-label': 'Sort results' },
      ...[['recent', 'Recent'], ['score', 'Top score']].map(([v, label]) => el('label', null,
        el('input', { type: 'radio', name: ids.order, value: v, checked: state.order === v }), el('span', null, label))));
    const statusSelect = el('select', { class: 'select', id: ids.status, 'aria-label': 'Games to show' },
      el('option', { value: 'completed' }, 'Completed'),
      el('option', { value: 'in_progress' }, 'In progress'),
      el('option', { value: 'all' }, 'All games'));
    const autoSwitch = el('input', { type: 'checkbox', class: 'switch', role: 'switch', id: ids.auto, checked: state.auto });
    const liveDot = el('span', { class: 'status-dot', dataset: { state: state.auto ? 'on' : 'off' }, 'aria-hidden': 'true' });
    const updatedEl = el('span', { class: 'rs-updated' });
    const refreshBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': 'Refresh now', title: 'Refresh now' }, icon('arrows-clockwise'));
    const exportBtn = el('button', { type: 'button', class: 'btn btn--secondary', 'aria-label': 'Export leads as CSV', title: 'Download the leads of completed games as CSV' }, icon('file-csv'), el('span', null, 'Export leads'));

    const toolbar = el('div', { class: 'toolbar rs-toolbar' },
      el('div', { class: 'input-wrap rs-search' }, icon('magnifying-glass'), searchInput),
      orderGroup,
      statusSelect,
      el('span', { class: 'toolbar__spacer' }),
      el('label', { class: 'check rs-auto' }, autoSwitch, el('span', { class: 'check__text' }, 'Auto-refresh')),
      refreshBtn,
      exportBtn);

    const listHost = el('div', { class: 'rs-list' });
    const pagerHost = el('div', { class: 'rs-pager' });
    const liveLine = el('p', { class: 'rs-live' }, liveDot, updatedEl);
    const statusLine = el('p', { class: 'u-sr-only', role: 'status', 'aria-live': 'polite' });

    const head = el('header', { class: 'page-header' }, el('div', { class: 'page-header__main' },
      el('h1', { class: 'page-header__title', id: ids.heading, tabindex: '-1' }, 'Results'),
      el('p', { class: 'page-header__sub' }, 'Everyone who played this event: scores, answers and contact details. Correct a score or remove a result here.')));
    const view = el('section', { class: 'rs stack stack--lg', 'aria-labelledby': ids.heading }, head, statsEl, el('div', { class: 'stack' }, toolbar, listHost, pagerHost, liveLine, statusLine));
    root.replaceChildren(view);
    hydrateIcons(view);

    // ------------------------------------------------------------------------------------------
    // data
    // ------------------------------------------------------------------------------------------
    const hasConsentText = () => {
      const s = ctx.getEvent()?.settings || {};
      return !!(s.consent_text_en || s.consent_text_fr);
    };

    function needsRankMap() { return !(state.order === 'score' && !state.search && state.status === 'completed'); }

    function rankOf(r) {
      if (r.status !== 'completed') return null;
      if (!needsRankMap()) return state.skip + state.items.filter((x) => x.status === 'completed').indexOf(r) + 1;
      return state.ranks.get(r.id) ?? null;
    }

    async function fetchRanks(signal) {
      try {
        const page = await api.get(`/admin/events/${eventId}/results`, { query: { order: 'score', status: 'completed', limit: RANK_LIMIT }, signal });
        state.ranks = new Map(page.items.map((r, i) => [r.id, i + 1]));
        state.ranksTotal = page.total;
        state.ranksDirty = false;
      } catch (e) { if (!alive || e?.isTimeout) return; /* ranks are a nicety: ignore */ }
    }

    async function fetchStats(signal) {
      try { state.stats = await api.get(`/admin/events/${eventId}/stats`, { signal }); } catch { /* summary only */ }
    }

    async function load({ silent = false, keepPage = true } = {}) {
      if (!alive) return;
      abort?.abort();
      abort = new AbortController();
      const { signal } = abort;
      const seq = ++loadSeq;
      state.loading = true;
      state.error = null;
      refreshBtn.classList.add('is-spinning');
      if (!state.loaded && !silent) renderList();
      try {
        const query = { skip: state.skip, limit: state.size, order: state.order, status: state.status };
        if (state.search) query.search = state.search;
        const [page] = await Promise.all([
          api.get(`/admin/events/${eventId}/results`, { query, signal }),
          fetchStats(signal),
        ]);
        if (!alive || seq !== loadSeq) return;
        // the overall ranking is fetched only when needed: first time, after a change, or when a row it does not know shows up
        if (needsRankMap() && (state.ranksDirty || (state.ranksTotal <= RANK_LIMIT && page.items.some((r) => r.status === 'completed' && !state.ranks.has(r.id))))) {
          await fetchRanks(signal);
          if (!alive || seq !== loadSeq) return;
        }
        // deleted the last row of the last page: step back
        if (!page.items.length && page.total > 0 && state.skip > 0 && keepPage) {
          state.skip = Math.max(0, (Math.ceil(page.total / state.size) - 1) * state.size);
          state.loading = false;
          return load({ silent });
        }
        const sig = JSON.stringify([page, state.ranks.size, state.stats]);
        const changed = sig !== lastSig || !state.loaded;
        lastSig = sig;
        state.items = page.items;
        state.total = page.total;
        state.loaded = true;
        state.updatedAt = new Date();
        // new players arrived: keep the sidebar badge and the other tabs in step
        const known = ctx.getEvent()?.counts;
        if (state.stats && known && (state.stats.players !== known.players || state.stats.games_completed !== known.games_completed)) ctx.reloadEvent?.().catch(() => {});
        if (changed) { renderStats(); renderList(); renderPager(); statusLine.textContent = describeRange(); }
        renderUpdated();
      } catch (e) {
        if (!alive || seq !== loadSeq || signal.aborted) return;
        if (e?.isUnauthorized) return;
        state.error = e;
        state.loaded = true;
        liveDot.dataset.state = 'error';
        updatedEl.textContent = state.updatedAt ? `Update failed. Last update ${state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Update failed';
        renderList();
        renderPager();
      } finally {
        if (seq === loadSeq) { state.loading = false; refreshBtn.classList.remove('is-spinning'); }
      }
    }

    function describeRange() {
      if (!state.total) return 'No results';
      return `Showing ${state.skip + 1} to ${Math.min(state.skip + state.items.length, state.total)} of ${fmtN(state.total)} results`;
    }

    // ------------------------------------------------------------------------------------------
    // render: stats, updated label
    // ------------------------------------------------------------------------------------------
    function renderStats() {
      const s = state.stats;
      const set = (key, text) => { const n = statsEl.querySelector(`[data-stat="${key}"]`); if (n) n.textContent = text; };
      set('completed', s ? fmtN(s.games_completed) : '–');
      set('in_progress', s ? fmtN(s.games_in_progress) : '–');
      set('avg', s && s.games_completed ? fmtN(Math.round(s.avg_score)) : '–');
      set('top', s && s.games_completed ? fmtN(s.top_score) : '–');
    }

    function renderUpdated() {
      if (!state.updatedAt) { updatedEl.textContent = ''; return; }
      const t = state.updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });   // 24 h like the rest of the console
      updatedEl.textContent = state.auto ? `Live, refreshing every 15 s. Updated ${t}` : `Updated ${t}`;
      liveDot.dataset.state = state.auto ? 'on' : 'off';
    }

    // ------------------------------------------------------------------------------------------
    // render: list
    // ------------------------------------------------------------------------------------------
    function rankBadge(rank) {
      if (!rank) return el('span', { class: 'u-subtle', 'aria-label': 'Not ranked' }, '–');
      return el('span', { class: 'rs-rank', dataset: { rank: rank <= 3 ? rank : null }, title: `Rank ${rank}` }, el('span', { class: 'u-sr-only' }, 'Rank '), String(rank));
    }

    function consentBadge(p, { long = false } = {}) {
      if (p.consent_at) {
        return el('span', { class: 'badge badge--success', title: `Consent given on ${exactTime(p.consent_at)}` }, icon('check-circle'), long ? `Given on ${formatDateTime(p.consent_at, { lang: LANG })}` : 'Yes');
      }
      if (hasConsentText()) return el('span', { class: 'badge badge--warning', title: 'The player did not give consent' }, icon('warning'), long ? 'Not given' : 'No');
      return el('span', { class: 'badge', title: 'This event does not ask for consent' }, long ? 'Not asked for this event' : 'n/a');
    }

    function statusBadge(status) {
      if (status === 'completed') return el('span', { class: 'badge badge--success badge--dot' }, 'Completed');
      if (status === 'in_progress') return el('span', { class: 'badge badge--warning badge--dot' }, 'In progress');
      return el('span', { class: 'badge' }, 'Abandoned');
    }

    function relTime(iso) {
      if (!iso) return el('span', { class: 'u-subtle' }, '–');
      return el('time', { datetime: iso, title: exactTime(iso), dataset: { rel: iso } }, relativeTime(iso, LANG));
    }

    function copyButton(text, label) {
      const btn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm rs-copy', 'aria-label': label, title: 'Copy email' }, icon('copy-simple'));
      btn.addEventListener('click', async () => {
        const ok = await copyToClipboard(text);
        if (!ok) { ctx.toast('Could not copy. Select the email and copy it manually.', { type: 'error' }); return; }
        btn.replaceChildren(icon('check'));
        btn.classList.add('is-done');
        announce('Email copied');
        ctx.toast('Email copied', { type: 'success', duration: 2200 });
        setTimeout(() => { if (!btn.isConnected) return; btn.replaceChildren(icon('copy-simple')); btn.classList.remove('is-done'); }, 1600);
      });
      return btn;
    }

    /** email that wraps before the @ (never in the middle of the domain) */
    function emailText(email) {
      const at = email.indexOf('@');
      return el('span', { class: 'rs-email__text' }, at > 0 ? [email.slice(0, at), el('wbr'), email.slice(at)] : email);
    }

    function actionBtn(key, id, label, ic, onClick, extra) {
      const b = el('button', { type: 'button', class: ['btn btn--ghost btn--icon btn--sm', extra], 'aria-label': label, title: label, dataset: { focusKey: `${id}:${key}` } }, icon(ic));
      b.addEventListener('click', onClick);
      return b;
    }

    function rowFor(r) {
      const p = r.player;
      const name = fullName(p);
      const rank = rankOf(r);
      const answers = el('span', { class: 'rs-cwu', 'aria-label': `${r.correct_answers} correct, ${r.wrong_answers} wrong, ${r.unanswered} unanswered` },
        el('span', { class: 'rs-c', title: 'Correct' }, String(r.correct_answers)), el('span', { class: 'rs-sep', 'aria-hidden': 'true' }, '/'),
        el('span', { class: 'rs-w', title: 'Wrong' }, String(r.wrong_answers)), el('span', { class: 'rs-sep', 'aria-hidden': 'true' }, '/'),
        el('span', { class: 'rs-u', title: 'Unanswered' }, String(r.unanswered)));
      const nameBtn = el('button', { type: 'button', class: 'rs-name', dataset: { focusKey: `${r.id}:open` }, title: 'View answers' }, name || '(no name)');
      nameBtn.addEventListener('click', () => openDetails(r));
      return el('tr', { dataset: { id: r.id } },
        el('td', { class: 'rs-td--rank', dataset: { label: 'Rank' } }, rankBadge(rank)),
        el('td', { class: 'rs-td--player', dataset: { label: 'Player' } },
          el('div', { class: 'rs-player' }, avatar(name, { size: 'sm' }),
            el('div', { class: 'rs-player__text' }, nameBtn,
              el('div', { class: 'cell-sub rs-email' }, emailText(p.email), copyButton(p.email, `Copy email of ${name}`))))),
        el('td', { dataset: { label: 'Phone' } }, p.phone_number ? el('span', { class: 'u-tabular' }, p.phone_number) : el('span', { class: 'u-subtle' }, '–')),
        el('td', { dataset: { label: 'Consent' } }, consentBadge(p)),
        el('td', { class: 'num rs-td--score', dataset: { label: 'Score' } }, el('strong', { class: 'rs-score' }, fmtN(r.total_score))),
        el('td', { dataset: { label: 'Correct / wrong / none' } }, answers),
        el('td', { dataset: { label: 'Completed' } }, relTime(r.completed_at)),
        el('td', { dataset: { label: 'Status' } }, statusBadge(r.status)),
        el('td', { class: 'actions rs-actions' },
          actionBtn('open', r.id, `View answers of ${name}`, 'eye', () => openDetails(r)),
          actionBtn('edit', r.id, `Edit score of ${name}`, 'pencil-simple', () => editScore(r)),
          actionBtn('delete', r.id, `Delete result of ${name}`, 'trash', () => deleteResult(r), 'rs-danger')));
    }

    function sortHeader(label, order, cls) {
      const active = state.order === order;
      const btn = el('button', { type: 'button', class: 'rs-sort' }, label);
      btn.addEventListener('click', () => setOrder(order));
      return el('th', { scope: 'col', class: cls, 'aria-sort': active ? 'descending' : 'none' }, btn);
    }

    function tableEl() {
      return el('div', { class: 'table-wrap rs-table-wrap' },
        el('table', { class: 'table table--cards rs-table' },
          el('caption', { class: 'u-sr-only' }, 'Players and their game results'),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', class: 'rs-th--rank' }, 'Rank'),
            el('th', { scope: 'col' }, 'Player'),
            el('th', { scope: 'col' }, 'Phone'),
            el('th', { scope: 'col' }, 'Consent'),
            sortHeader('Score', 'score', 'num'),
            el('th', { scope: 'col', title: 'Correct / wrong / unanswered' }, 'Answers'),
            sortHeader('Completed', 'recent'),
            el('th', { scope: 'col' }, 'Status'),
            el('th', { scope: 'col', class: 'actions' }, el('span', { class: 'u-sr-only' }, 'Actions')))),
          el('tbody', null, state.items.map(rowFor))));
    }

    function skeleton() {
      return el('div', { class: 'table-wrap rs-skeleton', 'aria-busy': 'true', 'aria-label': 'Loading results' },
        ...Array.from({ length: 6 }, () => el('div', { class: 'rs-skeleton__row' }, el('span', { class: 'skeleton skeleton--circle', style: { inlineSize: '2rem' } }), el('span', { class: 'skeleton skeleton--text', style: { inlineSize: '38%' } }), el('span', { class: 'skeleton skeleton--text', style: { inlineSize: '14%' } }), el('span', { class: 'skeleton skeleton--text', style: { inlineSize: '10%' } }))));
    }

    function emptyState() {
      const filtered = !!state.search || state.status !== 'completed';
      if (state.search) {
        return el('div', { class: 'empty rs-empty' },
          el('div', { class: 'empty__icon' }, icon('magnifying-glass')),
          el('h3', { class: 'empty__title' }, 'No player matches your search'),
          el('p', { class: 'empty__text' }, `Nothing found for "${state.search}". Try a first name, a last name or part of an email.`),
          el('div', { class: 'empty__actions' }, el('button', { type: 'button', class: 'btn btn--secondary', on: { click: clearSearch } }, icon('x'), 'Clear search')));
      }
      if (filtered) {
        return el('div', { class: 'empty rs-empty' },
          el('div', { class: 'empty__icon' }, icon('funnel')),
          el('h3', { class: 'empty__title' }, 'No games in this view'),
          el('p', { class: 'empty__text' }, 'There is no game with this status yet.'),
          el('div', { class: 'empty__actions' }, el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => { statusSelect.value = 'completed'; state.status = 'completed'; state.skip = 0; load(); } } }, 'Show completed games')));
      }
      const slug = ctx.getEvent()?.slug;
      return el('div', { class: 'empty rs-empty' },
        el('div', { class: 'empty__icon' }, icon('trophy')),
        el('h3', { class: 'empty__title' }, 'No results yet'),
        el('p', { class: 'empty__text' }, 'As soon as players finish a game, they show up here with their score, answers and contact details.'),
        slug ? el('div', { class: 'empty__actions' },
          el('a', { class: 'btn btn--primary', href: `/${slug}`, target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Open the game'),
          el('a', { class: 'btn btn--secondary', href: `/${slug}/scoreboard`, target: '_blank', rel: 'noopener' }, icon('television'), 'Open the scoreboard')) : null);
    }

    function renderList() {
      const active = document.activeElement;
      let focusKey = active && listHost.contains(active) ? active.dataset?.focusKey : null;
      if (!focusKey && restoreKey && (!active || active === document.body)) focusKey = restoreKey;
      const hadRestore = !!restoreKey;
      restoreKey = null;
      if (!state.loaded) { listHost.replaceChildren(skeleton()); return; }
      const nodes = [];
      if (state.error) {
        nodes.push(el('div', { class: 'alert alert--danger', role: 'alert' }, el('span', { class: 'alert__icon' }, icon('warning-fill')),
          el('div', null, el('p', { class: 'alert__title' }, 'Could not load the results'), el('p', { class: 'alert__text' }, errorText(state.error))),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => load() } }, 'Try again')));
      }
      if (state.items.length) nodes.push(tableEl());
      else if (!state.error) nodes.push(el('div', { class: 'table-wrap' }, emptyState()));
      listHost.replaceChildren(...nodes);
      hydrateIcons(listHost);
      if (focusKey) {
        const target = listHost.querySelector(`[data-focus-key="${focusKey}"]`) || (hadRestore ? listHost.querySelector('[data-focus-key$=":open"]') || searchInput : null);
        target?.focus({ preventScroll: true });
      }
    }

    // ------------------------------------------------------------------------------------------
    // render: pagination
    // ------------------------------------------------------------------------------------------
    function pageList(current, last) {
      const set = new Set([1, last, current, current - 1, current + 1]);
      if (current <= 3) { set.add(2); set.add(3); }
      if (current >= last - 2) { set.add(last - 1); set.add(last - 2); }
      const nums = [...set].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
      const out = [];
      nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('…'); out.push(n); });
      return out;
    }

    function renderPager() {
      const hadFocus = pagerHost.contains(document.activeElement);
      const wasSelect = document.activeElement?.tagName === 'SELECT';
      if (!state.loaded || !state.total) { pagerHost.replaceChildren(); return; }
      const last = Math.max(1, Math.ceil(state.total / state.size));
      const current = Math.floor(state.skip / state.size) + 1;
      const info = state.total
        ? `${fmtN(state.skip + 1)}–${fmtN(Math.min(state.skip + state.items.length, state.total))} of ${fmtN(state.total)}`
        : '';
      const go = (n) => { state.skip = (clamp(n, 1, last) - 1) * state.size; load(); listHost.scrollIntoView?.({ block: 'nearest' }); };
      const sizeSel = el('select', { class: 'select select--sm', 'aria-label': 'Rows per page' }, SIZES.map((s) => el('option', { value: s, selected: s === state.size }, `${s} rows`)));
      sizeSel.addEventListener('change', () => { state.size = +sizeSel.value; lsSet(LS_SIZE, String(state.size)); state.skip = 0; load(); });
      const btn = (label, n, { disabled, current: isCur, aria } = {}) => el('button', {
        type: 'button', class: 'pagination__btn', disabled: !!disabled, 'aria-current': isCur ? 'page' : null, 'aria-label': aria || `Page ${label}`,
        on: { click: () => go(n) },
      }, label);
      const pages = last > 1 ? el('nav', { class: 'pagination__pages', 'aria-label': 'Pagination' },
        btn(icon('caret-left'), current - 1, { disabled: current === 1, aria: 'Previous page' }),
        ...pageList(current, last).map((p) => (p === '…' ? el('span', { class: 'rs-ellipsis', 'aria-hidden': 'true' }, '…') : btn(String(p), p, { current: p === current }))),
        btn(icon('caret-right'), current + 1, { disabled: current === last, aria: 'Next page' })) : null;
      pagerHost.replaceChildren(el('div', { class: 'pagination rs-pagination' }, el('div', { class: 'cluster' }, el('span', { class: 'pagination__info' }, info), sizeSel), pages));
      hydrateIcons(pagerHost);
      if (hadFocus) (wasSelect ? pagerHost.querySelector('select') : pagerHost.querySelector('[aria-current="page"]'))?.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------------------------------
    function track(ctl) {
      openDialogs.add(ctl);
      ctl.closed.then(() => openDialogs.delete(ctl));
      return ctl;
    }

    const focusKeyNow = () => document.activeElement?.dataset?.focusKey || null;

    async function openDetails(r) {
      const name = fullName(r.player);
      const body = el('div', { class: 'rs-detail' }, el('div', { class: 'stack' }, el('span', { class: 'skeleton skeleton--title' }), el('span', { class: 'skeleton skeleton--text' }), el('span', { class: 'skeleton skeleton--card' })));
      const ctl = track(openModal({
        title: name || 'Result', description: `Game #${r.id}`, icon: 'user-circle', size: 'lg', content: body,
        actions: [
          { label: 'Delete', variant: 'danger', value: 'delete' },
          { label: 'Edit score', variant: 'secondary', value: 'edit' },
          { label: 'Close', variant: 'primary', value: 'close', autofocus: true },
        ],
      }));
      try {
        const data = await api.get(`/admin/results/${r.id}`);
        if (!ctl.dialog.isConnected) return;
        body.replaceChildren(detailContent(data, rankOf(r)));
        hydrateIcons(body);
      } catch (e) {
        if (!ctl.dialog.isConnected) return;
        body.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, el('span', { class: 'alert__icon' }, icon('warning-fill')), el('div', null, el('p', { class: 'alert__title' }, 'Could not load the answers'), el('p', { class: 'alert__text' }, errorText(e)))));
        hydrateIcons(body);
      }
      const action = await ctl.closed;
      if (!alive) return;
      if (action === 'edit') editScore(r);
      else if (action === 'delete') deleteResult(r);
    }

    function detailContent(d, rank) {
      const p = d.player;
      const dur = d.completed_at ? Math.max(0, (new Date(d.completed_at) - new Date(d.started_at)) / 1000) : null;
      const kv = (label, content) => [el('dt', null, label), el('dd', null, content)];
      const contact = el('dl', { class: 'kv' },
        ...kv('Email', el('span', { class: 'rs-email rs-email--detail' }, el('a', { href: `mailto:${encodeURIComponent(String(p.email)).replace(/%40/g, '@')}` }, p.email), copyButton(p.email, `Copy email of ${fullName(p)}`))),
        ...kv('Phone', p.phone_number || el('span', { class: 'u-subtle' }, 'Not provided')),
        ...kv('Consent', consentBadge(p, { long: true })),
        ...kv('Started', exactTime(d.started_at)),
        ...kv('Completed', d.completed_at ? exactTime(d.completed_at) : el('span', { class: 'u-subtle' }, 'Not completed')));
      const tiles = el('div', { class: 'rs-tiles' },
        tile('Score', fmtN(d.total_score), 'rs-tile--score'),
        tile('Rank', rank ? `#${rank}` : '–'),
        tile('Correct', String(d.correct_answers), 'rs-tile--ok'),
        tile('Wrong', String(d.wrong_answers), 'rs-tile--ko'),
        tile('No answer', String(d.unanswered)),
        tile('Duration', dur === null ? '–' : formatDuration(dur)));
      const list = el('ol', { class: 'rs-answers', role: 'list' }, [...d.answers].sort((a, b) => a.question_order - b.question_order).map(answerItem));
      return el('div', { class: 'stack stack--lg' }, contact, tiles,
        el('div', { class: 'stack stack--sm' }, el('h3', { class: 'rs-h3' }, 'Answers'),
          d.answers.length ? list : el('p', { class: 'u-muted' }, 'No answer was recorded for this game.')));
    }

    function tile(label, value, mod) {
      return el('div', { class: ['rs-tile', mod] }, el('span', { class: 'rs-tile__label' }, label), el('span', { class: 'rs-tile__value' }, value));
    }

    function answerItem(a) {
      const answered = a.player_answer === 'green' || a.player_answer === 'red';
      const state_ = !answered ? 'missed' : a.is_correct ? 'correct' : 'wrong';
      const label = (which) => (which === 'green' ? a.green_label_en : a.red_label_en);
      const chip = (cls, kbdCls, which, prefix) => el('span', { class: `badge rs-ans ${cls}` }, prefix, el('span', { class: `kbd ${kbdCls}` }, which === 'green' ? 'G' : 'R'), label(which));
      const chips = [];
      if (answered) chips.push(chip(state_ === 'correct' ? 'badge--success' : 'badge--danger', kbdClass(a.player_answer), a.player_answer, 'Answered '));
      else chips.push(el('span', { class: 'badge badge--warning' }, icon('clock'), 'No answer'));
      if (state_ !== 'correct') chips.push(chip('badge--success', kbdClass(a.correct_answer), a.correct_answer, 'Correct '));
      if (a.time_taken !== null && a.time_taken !== undefined) chips.push(el('span', { class: 'badge' }, icon('timer'), `${Number(a.time_taken).toFixed(1)} s`));
      const ic = state_ === 'correct' ? 'check' : state_ === 'wrong' ? 'x' : 'minus';
      return el('li', { class: 'review-item', dataset: { state: state_ } },
        el('span', { class: 'review-item__icon', role: 'img', 'aria-label': state_ === 'correct' ? 'Correct' : state_ === 'wrong' ? 'Wrong' : 'Unanswered' }, icon(ic)),
        el('div', null, el('div', { class: 'review-item__q' }, el('span', { class: 'rs-qn' }, `Q${a.question_order}`), a.question_text_en),
          a.question_text_fr && a.question_text_fr !== a.question_text_en ? el('div', { class: 'u-muted u-text-sm', lang: 'fr' }, a.question_text_fr) : null),
        el('span', { class: 'review-item__points' }, `${a.points_earned > 0 ? '+' : ''}${fmtN(a.points_earned)}`),
        el('div', { class: 'review-item__answers' }, chips));
      function kbdClass(v) { return v === 'green' ? 'kbd--green' : 'kbd--red'; }
    }

    function editScore(r) {
      const name = fullName(r.player);
      const key = focusKeyNow();
      const inputId = uid('rs-score');
      const errId = uid('rs-score-err');
      const input = el('input', { class: 'input input--lg u-tabular', id: inputId, type: 'number', inputmode: 'numeric', min: '0', max: '10000000', step: '1', value: String(r.total_score), 'aria-describedby': `${errId} ${inputId}-help`, autofocus: '' });
      const err = el('p', { class: 'field__error', id: errId, hidden: true });
      const field = el('div', { class: 'field' }, el('label', { class: 'field__label', for: inputId }, 'Total score (points)'), input, err,
        el('p', { class: 'field__help', id: `${inputId}-help` }, 'The scoreboard updates immediately. The answers of the game are not changed.'));
      const form = el('form', { class: 'stack', novalidate: '' }, field);
      let saving = false;
      const ctl = track(openModal({
        title: 'Edit score', description: `${name}, currently ${fmtN(r.total_score)} points`, icon: 'pencil-simple', size: 'sm', content: form,
        actions: [{ label: 'Cancel', variant: 'secondary', value: 'cancel' }, { label: 'Save score', variant: 'primary', value: 'saved', closes: false, onClick: () => submit() }],
      }));
      const saveBtn = ctl.dialog.querySelector('.dialog__footer .btn--primary');
      const showError = (msg) => { err.textContent = msg; err.hidden = !msg; field.classList.toggle('field--invalid', !!msg); input.setAttribute('aria-invalid', String(!!msg)); };
      input.addEventListener('input', () => showError(''));
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      input.select?.();
      async function submit() {
        if (saving) return;
        const raw = input.value.trim();
        const n = Number(raw);
        if (raw === '' || !Number.isInteger(n)) { showError('Enter a whole number of points.'); input.focus(); return; }
        if (n < 0 || n > 10000000) { showError('The score must be between 0 and 10,000,000.'); input.focus(); return; }
        if (n === r.total_score) { ctl.close('cancel'); return; }
        saving = true; setBusy(saveBtn, true);
        try {
          await api.patch(`/admin/results/${r.id}/score`, { total_score: n });
          ctx.toast(`Score updated: ${fmtN(n)} points`, { type: 'success' });
          state.ranksDirty = true;
          restoreKey = key;
          ctl.close('saved');
          load({ silent: true });
        } catch (e) {
          showError(e?.fieldErrors?.total_score || errorText(e));
          input.focus();
        } finally { saving = false; if (saveBtn.isConnected) setBusy(saveBtn, false); }
      }
    }

    async function deleteResult(r) {
      const name = fullName(r.player);
      const key = focusKeyNow();
      const ok = await ctx.confirm({
        title: 'Delete this result?',
        message: `The game of ${name} (${fmtN(r.total_score)} points) and its answers are removed, and the scoreboard updates right away. This cannot be undone.`,
        confirmLabel: 'Delete result', danger: true,
      });
      if (!ok || !alive) return;
      try {
        await api.delete(`/admin/results/${r.id}`);
        ctx.toast('Result deleted', { type: 'success' });
        ctx.reloadEvent?.().catch(() => {});     // player / game counts in the sidebar and the other tabs
        state.ranksDirty = true;
        restoreKey = key;
        load({ silent: true });
      } catch (e) {
        ctx.toast(errorText(e), { type: 'error', title: 'Could not delete the result' });
      }
    }

    async function exportCsv() {
      setBusy(exportBtn, true);
      try {
        const name = await api.download(`/admin/events/${eventId}/results.csv`);
        ctx.toast(`Downloaded ${name}`, { type: 'success' });
      } catch (e) {
        ctx.toast(errorText(e), { type: 'error', title: 'Export failed' });
      } finally { if (exportBtn.isConnected) setBusy(exportBtn, false); }
    }

    // ------------------------------------------------------------------------------------------
    // toolbar wiring
    // ------------------------------------------------------------------------------------------
    function setOrder(order) {
      if (state.order === order) return;
      state.order = order;
      orderGroup.querySelectorAll('input').forEach((i) => { i.checked = i.value === order; });
      state.skip = 0;
      lastSig = '';
      load();
    }
    function clearSearch() { searchInput.value = ''; state.search = ''; state.skip = 0; load(); searchInput.focus(); }

    const onSearch = debounce(() => {
      const v = searchInput.value.trim();
      if (v === state.search) return;
      state.search = v; state.skip = 0; lastSig = ''; load();
    }, 300);
    searchInput.addEventListener('input', onSearch);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && searchInput.value) { e.stopPropagation(); clearSearch(); } });
    orderGroup.addEventListener('change', (e) => { if (e.target.name === ids.order) setOrder(e.target.value); });
    statusSelect.addEventListener('change', () => { state.status = statusSelect.value; state.skip = 0; lastSig = ''; load(); });
    refreshBtn.addEventListener('click', () => { lastSig = ''; state.ranksDirty = true; load(); });
    exportBtn.addEventListener('click', exportCsv);
    autoSwitch.addEventListener('change', () => {
      state.auto = autoSwitch.checked;
      lsSet(LS_AUTO, state.auto ? 'on' : 'off');
      renderUpdated();
      armRefresh();
      announce(state.auto ? 'Auto-refresh on, every 15 seconds' : 'Auto-refresh off');
    });

    // ------------------------------------------------------------------------------------------
    // timers
    // ------------------------------------------------------------------------------------------
    function armRefresh() {
      clearInterval(refreshTimer);
      refreshTimer = null;
      if (!state.auto) return;
      refreshTimer = setInterval(() => {
        if (!alive || state.loading || document.hidden) return;
        if (document.querySelector('dialog[open]')) return; // do not move things under an open dialog
        load({ silent: true });
      }, REFRESH_MS);
    }
    function tickRelative() {
      listHost.querySelectorAll('time[data-rel]').forEach((t) => { t.textContent = relativeTime(t.dataset.rel, LANG); });
    }
    const onVisible = () => { if (!document.hidden && state.auto && state.updatedAt && Date.now() - state.updatedAt.getTime() > REFRESH_MS) load({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    disposers.push(() => document.removeEventListener('visibilitychange', onVisible));
    tickTimer = setInterval(tickRelative, TICK_MS);

    // the consent badge wording depends on the event settings
    disposers.push(ctx.onEventChanged?.(() => { if (state.loaded) renderList(); }) || (() => {}));

    renderUpdated();
    armRefresh();
    await load();

    return {
      unmount() {
        alive = false;
        abort?.abort();
        clearInterval(refreshTimer);
        clearInterval(tickTimer);
        onSearch.cancel?.();
        disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        openDialogs.forEach((c) => { try { c.close(); } catch { /* ignore */ } });
        openDialogs.clear();
        root.replaceChildren();
      },
    };
  },
};
