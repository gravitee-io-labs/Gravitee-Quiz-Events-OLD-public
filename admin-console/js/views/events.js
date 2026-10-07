/**
 * #/events - the events list: branded cards with status, counts and quick actions, search / status filter / sort,
 * and the "New event" flow (blank, duplicate, import).
 * ctx (global scope): { api, toast, confirm, navigate, listEvents, refreshEvents, onEventsChanged, setDirty, setBreadcrumb }
 */
import { el, icon, delegate, debounce, uid } from '../../shared/js/dom.js';
import { applyBranding } from '../../shared/js/branding.js';
import { initDropdowns } from '../../shared/js/ui.js';
import { eventUrl, scoreboardUrl } from '../../shared/js/config.js';
import { STATUS, STATUS_ORDER, dateRange, fmt, errorText, needsQuestions, medalContent, brandSwatch } from '../core/util.js';
import { changeStatus, copyLink, openQrDialog, openDuplicateDialog, openNewEventDialog, exportEvent, deleteEvent } from '../core/event-actions.js';

const PREFS_KEY = 'quiz.admin.events.prefs';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } };

const SORTS = {
  status: { label: 'Status (live first)', cmp: (a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || byUpdated(a, b) },
  updated: { label: 'Recently updated', cmp: byUpdated },
  name: { label: 'Name (A to Z)', cmp: (a, b) => a.name.localeCompare(b.name) },
  start: { label: 'Start date (newest)', cmp: (a, b) => String(b.starts_on || '').localeCompare(String(a.starts_on || '')) || byUpdated(a, b) },
  players: { label: 'Most players', cmp: (a, b) => (b.counts?.players || 0) - (a.counts?.players || 0) || byUpdated(a, b) },
};
function byUpdated(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); }

const FILTERS = [['all', 'All'], ['live', 'Live'], ['draft', 'Draft'], ['closed', 'Closed']];

export default {
  id: 'events',
  title: 'Events',
  icon: 'squares-four',

  async mount(root, ctx) {
    const prefs = loadPrefs();
    const st = {
      events: ctx.peekEvents?.() || null, loading: true, error: null,
      q: '', status: FILTERS.some(([v]) => v === prefs.status) ? prefs.status : 'all', sort: typeof prefs.sort === 'string' && Object.hasOwn(SORTS, prefs.sort) ? prefs.sort : 'status',   // own keys only: "constructor" / "__proto__" from storage must not pass
      animate: true,
    };
    const disposers = [];
    const ids = { search: uid('ev-search'), sort: uid('ev-sort') };
    const byId = (id) => st.events?.find((e) => e.id === Number(id));

    // ---- static structure ---------------------------------------------------------------
    const sub = el('p', { class: 'page-header__sub' }, 'Every quiz you run, in one place.');
    const header = el('div', { class: 'page-header' },
      el('div', { class: 'page-header__main' }, el('p', { class: 'page-header__eyebrow' }, 'Workspace'), el('h1', { class: 'page-header__title' }, 'Events'), sub),
      el('div', { class: 'page-header__actions' },
        el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => openNewEventDialog(ctx, { mode: 'import' }) } }, icon('file-arrow-up'), 'Import'),
        el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => openNewEventDialog(ctx) } }, icon('plus-bold'), 'New event')));

    const search = el('input', { class: 'input', id: ids.search, type: 'search', placeholder: 'Search events', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search events' });
    const statusName = uid('ev-status');
    const segInputs = new Map();   // status -> count node
    const radios = new Map();      // status -> radio input
    const seg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Filter by status' },
      ...FILTERS.map(([value, label]) => {
        const count = el('small', { class: 'segmented__count' });
        const input = el('input', { type: 'radio', name: statusName, value, checked: st.status === value, on: { change: () => { st.status = value; persist(); paintList(); } } });
        segInputs.set(value, count);
        radios.set(value, input);
        return el('label', null, input, el('span', null, label, count));
      }));
    const sort = el('select', { class: 'select', id: ids.sort, 'aria-label': 'Sort events', on: { change: (e) => { st.sort = e.target.value; persist(); paintList(); } } },
      ...Object.entries(SORTS).map(([value, s]) => el('option', { value, selected: st.sort === value }, s.label)));
    const toolbar = el('div', { class: 'toolbar ev-toolbar', role: 'search' },
      el('div', { class: 'input-wrap' }, icon('magnifying-glass'), search), seg, sort);
    const live = el('p', { class: 'u-sr-only', role: 'status' });
    const list = el('div', { class: 'ev-list' });
    root.replaceChildren(header, toolbar, live, list);

    search.addEventListener('input', debounce(() => { st.q = search.value; paintList(); }, 120));
    const persist = () => savePrefs({ status: st.status, sort: st.sort });
    disposers.push(initDropdowns(root));

    // ---- painting -----------------------------------------------------------------------
    function visible() {
      const q = st.q.trim().toLowerCase();
      return (st.events || [])
        .filter((e) => st.status === 'all' || e.status === st.status)
        .filter((e) => !q || `${e.name} ${e.game_title} ${e.slug} ${e.location || ''}`.toLowerCase().includes(q))
        .sort(SORTS[st.sort].cmp);
    }

    function paintSummary() {
      const all = st.events || [];
      const n = all.length, liveN = all.filter((e) => e.status === 'live').length;
      sub.textContent = !st.events ? 'Every quiz you run, in one place.'
        : n ? `${fmt(n)} event${n === 1 ? '' : 's'} · ${fmt(liveN)} live` : 'Every quiz you run, in one place.';
      for (const [value, node] of segInputs) node.textContent = st.events ? fmt(value === 'all' ? n : all.filter((e) => e.status === value).length) : '';
    }

    function paintList() {
      paintSummary();
      if (st.loading && !st.events) { list.replaceChildren(el('div', { class: 'event-grid', 'aria-busy': 'true' }, ...[0, 1, 2].map(() => el('span', { class: 'skeleton skeleton--card ev-skel' })))); return; }
      if (st.error && !st.events) {
        list.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, icon('warning-fill', { class: 'alert__icon' }),
          el('div', null, el('p', { class: 'alert__title' }, 'Could not load the events'), el('p', { class: 'alert__text' }, errorText(st.error))),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => load() } }, icon('arrow-clockwise'), 'Retry')));
        return;
      }
      if (!st.events.length) {
        list.replaceChildren(el('div', { class: 'empty card' },
          el('div', { class: 'empty__icon' }, icon('trophy')),
          el('h2', { class: 'empty__title' }, 'Create your first event'),
          el('p', { class: 'empty__text' }, 'An event is one quiz with its own branding, questions, rules and scoreboard. Start from scratch or import a bundle.'),
          el('div', { class: 'empty__actions' },
            el('button', { type: 'button', class: 'btn btn--primary btn--lg', on: { click: () => openNewEventDialog(ctx) } }, icon('plus-bold'), 'New event'),
            el('button', { type: 'button', class: 'btn btn--secondary btn--lg', on: { click: () => openNewEventDialog(ctx, { mode: 'import' }) } }, icon('file-arrow-up'), 'Import a bundle'))));
        toolbar.hidden = true;
        return;
      }
      toolbar.hidden = false;
      const items = visible();
      live.textContent = `${items.length} event${items.length === 1 ? '' : 's'} shown`;
      if (!items.length) {
        list.replaceChildren(el('div', { class: 'empty card' },
          el('div', { class: 'empty__icon' }, icon('magnifying-glass')),
          el('h2', { class: 'empty__title' }, 'No event matches'),
          el('p', { class: 'empty__text' }, 'Try another search or show every status.'),
          el('div', { class: 'empty__actions' }, el('button', { type: 'button', class: 'btn btn--secondary', on: { click: clearFilters } }, 'Clear filters'))));
        return;
      }
      list.replaceChildren(el('div', { class: 'event-grid ev-grid' }, ...items.map((e, i) => card(e, st.animate ? i : null))));
      st.animate = false;
    }

    function clearFilters() {
      st.q = ''; st.status = 'all'; search.value = ''; radios.get('all').checked = true;
      persist(); paintList(); search.focus();
    }

    function card(ev, animIndex) {
      const s = STATUS[ev.status] || STATUS.draft;
      const idBase = `ev-${ev.id}`;
      const c = ev.counts || {};
      const warn = ev.status !== 'closed' && needsQuestions(ev);

      const statusItem = (key) => {
        const m = STATUS[key];
        return el('button', { type: 'button', class: 'menu__item', role: 'menuitemradio', 'aria-checked': String(ev.status === key), dataset: { action: 'status', status: key, id: ev.id } },
          icon(m.icon), el('span', { class: 'menu__text' }, el('span', null, key === 'live' ? 'Set live' : key === 'draft' ? 'Back to draft' : 'Close event'), el('span', { class: 'menu__hint' }, m.hint)));
      };
      const statusDd = el('div', { class: 'dropdown dropdown--end admin-event__status' },
        el('button', { type: 'button', class: 'status-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-dropdown-trigger': '', 'aria-label': `Status: ${s.label}. Change status` },
          el('span', { class: 'ev-dot', dataset: { status: ev.status } }), s.label, icon('caret-down', { size: 'xs' })),
        el('div', { class: 'menu menu--wide', role: 'menu', hidden: true }, el('div', { class: 'menu__label' }, 'Status'), statusItem('live'), statusItem('draft'), statusItem('closed')));

      const moreDd = el('div', { class: 'dropdown dropdown--end dropdown--up' },
        el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-dropdown-trigger': '', 'aria-label': `More actions for ${ev.name}`, title: 'More actions' }, icon('dots-three-vertical')),
        el('div', { class: 'menu', role: 'menu', hidden: true },
          el('a', { class: 'menu__item', role: 'menuitem', href: scoreboardUrl(ev.slug), target: '_blank', rel: 'noopener' }, icon('television'), 'Open scoreboard'),
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'copy-scoreboard', id: ev.id } }, icon('copy'), 'Copy scoreboard link'),
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'qr-scoreboard', id: ev.id } }, icon('qr-code'), 'Scoreboard QR code'),
          el('hr', { class: 'menu__sep' }),
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'duplicate', id: ev.id } }, icon('copy-simple'), 'Duplicate…'),
          el('button', { type: 'button', class: 'menu__item', role: 'menuitem', dataset: { action: 'export', id: ev.id } }, icon('download-simple'), 'Export bundle (JSON)'),
          el('hr', { class: 'menu__sep' }),
          el('button', { type: 'button', class: 'menu__item menu__item--danger', role: 'menuitem', dataset: { action: 'delete', id: ev.id } }, icon('trash'), 'Delete…')));

      const meta = [
        ev.location ? ['map-pin', ev.location] : null,
        dateRange(ev.starts_on, ev.ends_on) ? ['calendar-blank', dateRange(ev.starts_on, ev.ends_on)] : null,
        ['translate', (ev.languages || []).map((l) => l.toUpperCase()).join(' · ')],
      ].filter(Boolean);

      const count = (label, value, extra) => el('div', null, el('dt', null, label), el('dd', null, fmt(value || 0), extra ? el('small', null, extra) : null));
      const node = el('article', {
        class: ['event-card', 'admin-event', animIndex !== null && 'u-rise'], style: animIndex !== null ? { '--i': Math.min(animIndex, 8) } : null,
        dataset: { id: ev.id, status: ev.status }, 'aria-labelledby': `${idBase}-title`,
      },
      el('div', { class: 'event-card__banner' },
        el('span', { class: 'event-card__medallion' }, medalContent(ev.branding))),
      statusDd,
      el('div', { class: 'event-card__body' },
        el('div', { class: 'admin-event__kicker' },
          el('span', { class: 'event-card__kicker admin-event__game', title: `Brand colours ${ev.branding?.primary_color} and ${ev.branding?.accent_color}` }, brandSwatch(ev.branding, { size: '0.9rem' }), ev.game_title),
          warn ? el('span', { class: 'badge badge--warning', title: `Each game needs ${ev.settings?.questions_per_game} questions` }, icon('warning'), 'Needs questions') : null),
        el('h2', { class: 'event-card__title', id: `${idBase}-title` }, el('a', { class: 'admin-event__link', href: `#/events/${ev.id}/overview` }, ev.name)),
        el('div', { class: 'event-card__meta' }, ...meta.map(([ic, text]) => el('span', null, icon(ic, { size: 'sm' }), text))),
        el('p', { class: 'admin-event__slug' }, el('code', null, `/${ev.slug}`)),
        el('dl', { class: 'ev-counts' },
          count('Questions', c.active_questions, c.questions !== c.active_questions ? `/${fmt(c.questions)}` : null),
          count('Categories', c.categories), count('Players', c.players), count('Games', c.games_completed))),
      el('div', { class: 'event-card__footer admin-event__footer' },
        el('a', { class: 'btn btn--primary btn--sm admin-event__manage', href: `#/events/${ev.id}/overview`, 'aria-label': `Manage ${ev.name}` }, icon('gear-six'), 'Manage'),
        el('div', { class: 'admin-event__tools' },
          el('a', { class: 'btn btn--ghost btn--icon btn--sm', href: eventUrl(ev.slug), target: '_blank', rel: 'noopener', 'aria-label': `Open the game of ${ev.name} in a new tab`, title: ev.status === 'live' ? 'Open the game' : 'Open the game (preview while signed in)' }, icon('arrow-square-out')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', dataset: { action: 'copy', id: ev.id }, 'aria-label': `Copy the game link of ${ev.name}`, title: 'Copy the game link' }, icon('link-simple')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', dataset: { action: 'qr', id: ev.id }, 'aria-label': `QR code for ${ev.name}`, title: 'QR code' }, icon('qr-code')),
          moreDd)));
      applyBranding(ev, { root: node });
      return node;
    }

    // ---- actions ------------------------------------------------------------------------
    const actions = {
      status: (ev, el_) => changeStatus(ctx, ev, el_.dataset.status).then((u) => u && ctx.refreshEvents().catch(() => {})),
      copy: (ev) => copyLink(ctx, eventUrl(ev.slug), 'Game link'),
      'copy-scoreboard': (ev) => copyLink(ctx, scoreboardUrl(ev.slug), 'Scoreboard link'),
      qr: (ev) => openQrDialog(ctx, ev, 'game'),
      'qr-scoreboard': (ev) => openQrDialog(ctx, ev, 'scoreboard'),
      duplicate: (ev) => openDuplicateDialog(ctx, ev),
      export: (ev) => exportEvent(ctx, ev),
      delete: async (ev) => { if (await deleteEvent(ctx, ev)) await ctx.refreshEvents().catch(() => {}); },
    };
    disposers.push(delegate(list, 'click', '[data-action]', (e, node) => {
      const ev = byId(node.dataset.id);
      const fn = actions[node.dataset.action];
      if (ev && fn) fn(ev, node);
    }));

    // ---- data ---------------------------------------------------------------------------
    async function load() {
      st.loading = true; st.error = null;
      if (!st.events) paintList();
      try { st.events = await ctx.refreshEvents(); } catch (e) { st.error = e; }
      st.loading = false;
      paintedSig = JSON.stringify(st.events);
      paintList();
    }
    // The shell refreshes the list from many places: repaint only when something changed, and never under an open menu
    let paintedSig = '';
    function onList(events) {
      st.events = events;
      const sig = JSON.stringify(events);
      if (sig === paintedSig) return;
      if (paintedSig && list.querySelector('.menu:not([hidden])')) { st.stale = true; return; }   // do not rip a menu away from under the user's hand
      paintedSig = sig; st.stale = false;
      paintList();
    }
    disposers.push(ctx.onEventsChanged(onList));
    list.addEventListener('focusout', () => { setTimeout(() => { if (st.stale && st.events && !list.querySelector('.menu:not([hidden])')) onList(st.events); }, 200); });

    // numbers move during an event (players, games): keep the cards fresh while the tab is visible
    let last = Date.now();
    const tick = () => { if (document.visibilityState === 'visible' && Date.now() - last >= 29_000) { last = Date.now(); ctx.refreshEvents().catch(() => {}); } };
    const timer = setInterval(tick, 30_000);
    const onVisible = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    disposers.push(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); });

    paintList();
    load();

    return {
      unmount() { disposers.forEach((d) => d()); },
    };
  },
};
