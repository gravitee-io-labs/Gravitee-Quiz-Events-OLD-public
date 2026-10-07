/**
 * Questions tab: server-paginated data table with search / filters / sort, inline activation, bulk actions,
 * CSV export + import wizard and the spacious question editor (see ./content/).
 * Contract: admin view module (id, title, icon, mount(root, ctx) -> { unmount }).
 */
import { el, icon, debounce } from '../../shared/js/dom.js';
import { announce, initDropdowns } from '../../shared/js/ui.js';
import { openCategoryDialog } from './content/category-dialog.js';
import { openCsvImport } from './content/csv-import.js';
import { openQuestionEditor } from './content/question-editor.js';
import {
  DIFFICULTY, FORMAT_LABEL, closeAllPanels, confirm, correctLabel, describeError, fetchAllQuestions, frStatus, handoff, notify, pageList, plural, safeColor, supportsFr, trim,
} from './content/common.js';

const PREF_KEY = 'quiz.admin.questions.prefs';
const SIZES = [25, 50, 100, 200];
const SORTS = [
  ['id:asc', 'Oldest first'], ['id:desc', 'Newest first'], ['updated:desc', 'Recently edited'],
  ['text:asc', 'Question A to Z'], ['text:desc', 'Question Z to A'],
  ['category:asc', 'Category'], ['difficulty:asc', 'Easiest first'], ['difficulty:desc', 'Hardest first'],
];
const SHOW = [['all', 'All questions'], ['active', 'Active only'], ['inactive', 'Inactive only'], ['missing_fr', 'Missing French']];

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
function comparator(sort) {
  const [key, dir] = sort.split(':');
  const m = dir === 'desc' ? -1 : 1;
  const byId = (a, b) => a.id - b.id;
  switch (key) {
    case 'text': return (a, b) => m * collator.compare(a.question_text_en, b.question_text_en) || byId(a, b);
    case 'category': return (a, b) => {
      const an = a.category?.name, bn = b.category?.name;
      if (!an && bn) return 1; if (an && !bn) return -1;
      return m * collator.compare(an || '', bn || '') || byId(a, b);
    };
    case 'difficulty': return (a, b) => m * (a.difficulty - b.difficulty) || byId(a, b);
    case 'updated': return (a, b) => m * (new Date(a.updated_at) - new Date(b.updated_at)) || byId(a, b);
    default: return (a, b) => m * byId(a, b);
  }
}

export default {
  id: 'questions',
  title: 'Questions',
  icon: 'question',

  async mount(root, ctx) {
    const { api, eventId } = ctx;
    const prefs = lsGet(PREF_KEY) || {};
    const q = {
      search: '', category: '', difficulty: '', format: '', show: 'all',
      sort: SORTS.some(([v]) => v === prefs.sort) ? prefs.sort : 'id:asc',
      page: 1, size: SIZES.includes(prefs.size) ? prefs.size : 50,
    };
    if (handoff.questionFilter) { Object.assign(q, handoff.questionFilter); handoff.questionFilter = null; }

    let alive = true;
    let frOn = supportsFr(ctx.getEvent?.());
    let categories = [];
    let categoriesLoaded = false;
    let rows = [];
    let total = 0;
    let stats = null;
    let loading = true;
    let loadError = null;
    let seq = 0;
    let aborter = null;
    let clientCache = null;      // { key, items } for the "client mode" (every match, fetched once)
    const selected = new Set();
    let lastChecked = null;
    let exporting = false;

    // ===========================================================================================
    // static frame
    // ===========================================================================================
    const addBtn = el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => openEditor() } }, icon('plus'), 'Add question');
    const importBtn = el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => importCsv() } }, icon('upload-simple'), 'Import CSV');
    const exportBtn = el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => exportCsv() } }, icon('download-simple'), 'Export');
    const head = el('header', { class: 'page-header qv-head' },
      el('div', { class: 'page-header__main' },
        el('h1', { class: 'page-header__title', tabindex: '-1' }, 'Questions'),
        el('p', { class: 'page-header__sub' }, 'The question pool. Every game draws a balanced random selection of the active questions.')),
      el('div', { class: 'page-header__actions' }, importBtn, exportBtn, addBtn));

    const statsEl = el('div', { class: 'stats qv-stats', 'aria-label': 'Pool summary' });

    // ---- toolbar -----------------------------------------------------------------------------
    const searchIn = el('input', { class: 'input', type: 'search', id: 'qv-search', placeholder: 'Search English or French text…', 'aria-label': 'Search questions', autocomplete: 'off', value: q.search, enterkeyhint: 'search' });
    const searchWrap = el('div', { class: 'input-wrap qv-search' }, icon('magnifying-glass'), searchIn);
    const catSel = el('select', { class: 'select', id: 'qv-cat', 'aria-label': 'Category' });
    const diffRadios = [['', 'All'], ['1', 'Easy'], ['2', 'Medium'], ['3', 'Hard']].map(([v, label]) => {
      const input = el('input', { type: 'radio', name: 'qv-diff', value: v, checked: q.difficulty === v });
      input.addEventListener('change', () => { if (input.checked) { q.difficulty = v; q.page = 1; refetch(); } });
      return { v, input, node: el('label', null, input, el('span', null, label)) };
    });
    const diffSeg = el('div', { class: 'segmented segmented--sm qv-diffseg', role: 'radiogroup', 'aria-label': 'Difficulty' }, ...diffRadios.map((r) => r.node));
    const fmtSel = el('select', { class: 'select', id: 'qv-fmt', 'aria-label': 'Format' },
      el('option', { value: '' }, 'Any format'), el('option', { value: 'true_false' }, FORMAT_LABEL.true_false), el('option', { value: 'two_choices' }, FORMAT_LABEL.two_choices));
    const showSel = el('select', { class: 'select', id: 'qv-show', 'aria-label': 'Status' }, ...SHOW.map(([v, l]) => el('option', { value: v }, l)));
    const sortSel = el('select', { class: 'select', id: 'qv-sort', 'aria-label': 'Sort by' }, ...SORTS.map(([v, l]) => el('option', { value: v }, l)));
    const sortWrap = el('div', { class: 'input-wrap qv-sortwrap', title: 'Sort order' }, icon('arrows-down-up'), sortSel);
    const clearBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm qv-clear', hidden: true, on: { click: () => clearFilters() } }, icon('x', { size: 'sm' }), 'Clear filters');
    const filtersToggle = el('button', { type: 'button', class: 'btn btn--secondary qv-filters-toggle', 'aria-expanded': 'false', 'aria-controls': 'qv-filters' }, icon('funnel'), el('span', { class: 'qv-filters-toggle__label' }, 'Filters'));
    const filters = el('div', { class: 'qv-filters', id: 'qv-filters' }, catSel, diffSeg, fmtSel, showSel, sortWrap, el('span', { class: 'qv-break', 'aria-hidden': 'true' }), clearBtn);
    const toolbar = el('div', { class: 'toolbar qv-toolbar', role: 'search' }, searchWrap, filtersToggle, filters);
    filtersToggle.addEventListener('click', () => {
      const open = filtersToggle.getAttribute('aria-expanded') !== 'true';
      filtersToggle.setAttribute('aria-expanded', String(open));
      toolbar.classList.toggle('is-open', open);
    });

    // ---- bulk bar ----------------------------------------------------------------------------
    const bulk = el('div', { class: 'qv-bulk', role: 'region', 'aria-label': 'Bulk actions', hidden: true });

    // Escape closes an open bulk menu even while the focus is still on its trigger button
    bulk.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = bulk.querySelector('[data-dropdown-trigger][aria-expanded="true"]');
      if (open) { e.preventDefault(); e.stopPropagation(); open.click(); open.focus(); }
    });

    // ---- table ---------------------------------------------------------------------------------
    const headCheck = el('input', { type: 'checkbox', class: 'checkbox', 'aria-label': 'Select all questions on this page' });
    headCheck.addEventListener('change', () => {
      for (const r of rows) headCheck.checked ? selected.add(r.id) : selected.delete(r.id);
      syncSelectionUi({ rowsToo: true });
    });
    const sortTh = (key, label, cls) => {
      const th = el('th', { scope: 'col', class: cls, 'aria-sort': 'none', dataset: { sort: key } });
      th.append(el('button', { type: 'button', class: 'qv-sort', on: { click: () => cycleSort(key) } }, label));
      return th;
    };
    const thead = el('thead', null, el('tr', null,
      el('th', { scope: 'col', class: 'qv-c-sel' }, el('label', { class: 'qv-hit' }, headCheck)),
      sortTh('text', 'Question', 'qv-c-text'),
      sortTh('category', 'Category', 'qv-c-cat'),
      el('th', { scope: 'col', class: 'qv-c-fmt' }, 'Format'),
      el('th', { scope: 'col', class: 'qv-c-ans' }, 'Correct'),
      sortTh('difficulty', 'Level', 'qv-c-diff'),
      el('th', { scope: 'col', class: 'qv-c-active' }, 'Active'),
      el('th', { scope: 'col', class: 'qv-c-actions' }, el('span', { class: 'u-sr-only' }, 'Actions'))));
    const tbody = el('tbody');
    const table = el('table', { class: 'table qv-table' }, el('caption', { class: 'u-sr-only' }, 'Questions of this event'), thead, tbody);
    const tableWrap = el('div', { class: 'table-wrap qv-tablewrap' }, table);
    const stateBox = el('div', { class: 'qv-state' });
    const pager = el('div', { class: 'pagination qv-pager' });
    const live = el('p', { class: 'u-sr-only', role: 'status', 'aria-live': 'polite' });
    const hints = el('p', { class: 'qv-hints u-hide-sm' },
      el('span', { class: 'kbd' }, '/'), ' search', el('span', { class: 'qv-hints__sep', 'aria-hidden': 'true' }, '·'), el('span', { class: 'kbd' }, 'N'), ' new question');

    const frame = el('section', { class: 'qv', 'aria-label': 'Questions' }, head, statsEl, toolbar, bulk, tableWrap, stateBox, pager, hints, live);
    root.replaceChildren(frame);
    const disposeDropdowns = initDropdowns(root);

    // ===========================================================================================
    // data
    // ===========================================================================================
    const serverFilters = () => ({
      category_id: q.category === '' ? undefined : Number(q.category),
      difficulty: q.difficulty || undefined,
      question_format: q.format || undefined,
      search: trim(q.search) || undefined,
    });
    const clientMode = () => q.sort !== 'id:asc' || q.show === 'inactive' || q.show === 'missing_fr';
    const passesShow = (r) => (q.show === 'active' ? r.is_active : q.show === 'inactive' ? !r.is_active : q.show === 'missing_fr' ? !trim(r.question_text_fr) : true);

    async function matchingItems(signal) {
      const key = JSON.stringify(serverFilters());
      if (!clientCache || clientCache.key !== key) clientCache = { key, items: await fetchAllQuestions(api, eventId, serverFilters(), { signal }) };
      return clientCache.items.filter(passesShow);
    }

    async function load({ quiet = false } = {}) {
      const mySeq = ++seq;
      aborter?.abort();
      aborter = new AbortController();
      const { signal } = aborter;
      if (!quiet) { loading = true; renderBody(); }
      else tableWrap.setAttribute('aria-busy', 'true');
      try {
        let items;
        let count;
        if (clientMode()) {
          const all = (await matchingItems(signal)).slice().sort(comparator(q.sort));
          if (mySeq !== seq) return;
          count = all.length;
          const pages = Math.max(1, Math.ceil(count / q.size));
          q.page = Math.min(q.page, pages);
          items = all.slice((q.page - 1) * q.size, q.page * q.size);
        } else {
          const res = await api.get(`/admin/events/${eventId}/questions`, {
            query: { ...serverFilters(), include_inactive: q.show !== 'active', skip: (q.page - 1) * q.size, limit: q.size }, signal,
          });
          if (mySeq !== seq) return;
          count = res.total;
          items = res.items;
          const pages = Math.max(1, Math.ceil(count / q.size));
          if (!items.length && count > 0 && q.page > pages) { q.page = pages; return load({ quiet }); }
        }
        rows = items;
        total = count;
        loadError = null;
      } catch (e) {
        if (mySeq !== seq || !alive) return;
        loadError = describeError(e);
      }
      if (mySeq !== seq || !alive) return;
      loading = false;
      tableWrap.removeAttribute('aria-busy');
      renderBody();
    }

    function refetch(opts) { clientCache = clientCache && opts?.keepCache ? clientCache : null; syncControls(); return load(opts); }

    async function loadCategories() {
      try { categories = await api.get(`/admin/events/${eventId}/categories`); } catch (e) { notify(ctx, `Categories: ${describeError(e)}`, 'error'); }
      categoriesLoaded = true;
      if (!alive) return;
      renderCategoryFilter();
      renderStats();
    }

    let statsSeq = 0;
    async function loadStats() {
      const my = ++statsSeq;
      try {
        const all = await fetchAllQuestions(api, eventId, {});
        if (my !== statsSeq || !alive) return;
        const active = all.filter((r) => r.is_active);
        stats = {
          total: all.length, active: active.length,
          missingFr: all.filter((r) => !trim(r.question_text_fr)).length,
          uncategorised: all.filter((r) => r.category_id == null).length,
          diff: [1, 2, 3].map((d) => active.filter((r) => r.difficulty === d).length),
          inactive: all.length - active.length,
        };
      } catch { if (my === statsSeq) stats = stats || null; }
      if (alive) { renderStats(); if (!loading && !loadError) renderBody(); }
    }
    const loadStatsSoon = debounce(loadStats, 450);

    /** Something changed on the server: refetch the visible page, stats and categories counts. */
    function changed() { clientCache = null; load({ quiet: true }); loadStatsSoon(); refreshCategoryCounts(); syncEvent(); }
    // the shell's sidebar badges and every other tab read the event counts: tell the shell something changed
    let syncPending = false;
    const syncNow = () => { syncPending = false; ctx.reloadEvent?.().catch(() => {}); };
    const syncSoon = debounce(syncNow, 500);
    const syncEvent = () => { syncPending = true; syncSoon(); };
    const refreshCategoryCounts = debounce(async () => {
      try { categories = await api.get(`/admin/events/${eventId}/categories`); renderCategoryFilter(); renderStats(); } catch { /* keep old */ }
    }, 600);

    // ===========================================================================================
    // rendering: controls
    // ===========================================================================================
    function syncControls() {
      // (the search box is never rewritten here: a background render must not eat what the user is typing)
      const frOpt = showSel.querySelector('option[value="missing_fr"]');   // no "Missing French" filter when French is not enabled
      if (frOpt) { frOpt.hidden = !frOn; frOpt.disabled = !frOn; }
      if (!frOn && q.show === 'missing_fr') q.show = 'all';
      catSel.value = q.category;
      if (categoriesLoaded && catSel.value !== q.category) { q.category = ''; catSel.value = ''; }
      fmtSel.value = q.format;
      showSel.value = q.show;
      sortSel.value = q.sort;
      for (const r of diffRadios) r.input.checked = r.v === q.difficulty;
      const active = hasFilters();
      clearBtn.hidden = !active;
      const n = [q.search, q.category, q.difficulty, q.format, q.show !== 'all' ? q.show : ''].filter(Boolean).length;
      filtersToggle.querySelector('.qv-filters-toggle__label').textContent = n ? `Filters (${n})` : 'Filters';
      // header sort arrows
      const [key, dir] = q.sort.split(':');
      for (const th of thead.querySelectorAll('th[data-sort]')) th.setAttribute('aria-sort', th.dataset.sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      lsSet(PREF_KEY, { sort: q.sort, size: q.size });
    }
    const hasFilters = () => !!(trim(q.search) || q.category || q.difficulty || q.format || q.show !== 'all');

    function renderCategoryFilter() {
      const keep = q.category;
      catSel.replaceChildren(
        el('option', { value: '' }, 'All categories'),
        el('option', { value: '0' }, 'Uncategorised'),
        ...categories.map((c) => el('option', { value: String(c.id) }, `${c.name} (${c.question_count ?? 0})`)));
      catSel.value = keep;
      if (catSel.value !== keep) catSel.value = '';
    }

    function statTile({ label, value, sub, iconName, tone, onClick, title }) {
      const inner = [
        el('div', { class: 'stat__head' }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__icon' }, icon(iconName))),
        el('div', { class: 'stat__value' }, value),
        el('div', { class: 'stat__sub' }, sub),
      ];
      const cls = ['stat', 'qv-stat', tone && `stat--${tone}`];
      if (onClick) return el('button', { type: 'button', class: [...cls, 'is-action'], title, on: { click: onClick } }, ...inner);
      return el('div', { class: cls }, ...inner);
    }

    function renderStats() {
      const s = stats;
      const dash = '–';
      const needs = frOn ? (s ? s.missingFr : null) : (s ? s.inactive : null);
      statsEl.replaceChildren(
        statTile({ label: 'Active questions', value: s ? String(s.active) : dash, sub: s ? `of ${s.total} total` : 'loading…', iconName: 'question' }),
        statTile({ label: 'Categories', value: String(categories.length || (s ? 0 : dash)), sub: s && s.uncategorised ? `${s.uncategorised} uncategorised` : (s && !s.total ? 'none yet' : 'every question has one'), iconName: 'tag', tone: 'accent' }),
        statTile({ label: 'Easy · Medium · Hard', value: s ? s.diff.join(' · ') : dash, sub: 'active questions', iconName: 'chart-bar', tone: 'success' }),
        frOn
          ? statTile({
            label: 'Needs review', value: needs == null ? dash : String(needs), sub: needs === 0 ? 'every question is translated' : 'missing French text', iconName: needs === 0 ? 'check-circle' : 'translate', tone: needs ? 'danger' : 'success',
            onClick: needs ? () => setShow('missing_fr') : null, title: needs ? 'Show the questions without French text' : undefined,
          })
          : statTile({ label: 'Inactive', value: needs == null ? dash : String(needs), sub: 'not drawn in games', iconName: 'eye-slash', onClick: needs ? () => setShow('inactive') : null }));
    }

    // ===========================================================================================
    // rendering: table
    // ===========================================================================================
    function ansChip(r) {
      const side = r.correct_answer === 'red' ? 'red' : 'green';
      const label = correctLabel(r);
      return el('span', { class: `qv-ans qv-ans--${side}`, title: `Correct answer: ${label} (${side} button)` },
        // TRUE / FALSE read naturally with a tick / cross; on a two-choice question a red cross next to the CORRECT answer looks like "wrong", so both get a tick
        icon(side === 'green' || r.question_format !== 'true_false' ? 'check-circle-fill' : 'x-circle-fill', { size: 'sm' }),
        el('span', { class: 'qv-ans__label' }, label),
        el('span', { class: 'u-sr-only' }, `, ${side} button is correct`));
    }

    function frBadge(r) {
      if (!frOn) return null;
      const st = frStatus(r);
      if (st === 'missing') return el('span', { class: 'badge badge--warning qv-fr', title: 'No French question text: players in French see English' }, icon('translate'), 'No French');
      if (st === 'partial') return el('span', { class: 'badge badge--info qv-fr', title: 'French explanation missing' }, icon('translate'), 'FR partial');
      return el('span', { class: 'badge badge--success qv-fr', title: 'French translation complete' }, icon('check'), 'FR');
    }

    function rowEl(r, index) {
      const cat = r.category;
      const gap = frOn && !trim(r.question_text_fr);
      const text = trim(r.question_text_en);
      const check = el('input', { type: 'checkbox', class: 'checkbox qv-check', checked: selected.has(r.id), 'aria-label': `Select question ${r.id}`, dataset: { index } });
      const active = el('input', { type: 'checkbox', class: 'switch qv-active', role: 'switch', checked: !!r.is_active, 'aria-label': `Question ${r.id} active` });
      const tr = el('tr', { class: [selected.has(r.id) && 'is-selected', !r.is_active && 'is-inactive', gap && 'has-gap'], dataset: { id: r.id } },
        el('td', { class: 'qv-c-sel' }, el('label', { class: 'qv-hit' }, check)),
        el('td', { class: 'qv-c-text', 'data-label': 'Question' },
          el('button', { type: 'button', class: 'qv-qtext', title: 'Edit this question', dataset: { act: 'edit' } }, text),
          el('div', { class: 'cell-sub qv-sub' }, frBadge(r), !r.is_active ? el('span', { class: 'badge qv-off' }, 'Inactive') : null, el('span', { class: 'qv-id' }, `#${r.id}`))),
        el('td', { class: 'qv-c-cat', 'data-label': 'Category' }, cat ? el('span', { class: 'chip qv-chip', style: { '--chip': safeColor(cat.color) }, title: cat.name }, el('span', { class: 'qv-chip__text' }, cat.name)) : el('span', { class: 'qv-none' }, 'Uncategorised')),
        el('td', { class: 'qv-c-fmt', 'data-label': 'Format' }, el('span', { class: 'badge' }, FORMAT_LABEL[r.question_format] || r.question_format)),
        el('td', { class: 'qv-c-ans', 'data-label': 'Correct' }, ansChip(r)),
        el('td', { class: 'qv-c-diff', 'data-label': 'Level' }, el('span', { class: 'difficulty', 'data-level': Math.min(r.difficulty, 3), role: 'img', 'aria-label': DIFFICULTY[r.difficulty] || `Level ${r.difficulty}`, title: DIFFICULTY[r.difficulty] || `Level ${r.difficulty}` })),
        el('td', { class: 'qv-c-active', 'data-label': 'Active' }, active),
        el('td', { class: 'actions qv-c-actions' },
          el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': `Edit question ${r.id}`, title: 'Edit', dataset: { act: 'edit' } }, icon('pencil-simple')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': `Duplicate question ${r.id}`, title: 'Duplicate', dataset: { act: 'duplicate' } }, icon('copy')),
          el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm qv-danger', 'aria-label': `Delete question ${r.id}`, title: 'Delete', dataset: { act: 'delete' } }, icon('trash'))));
      return tr;
    }

    function skeletonRows() {
      return Array.from({ length: 6 }, () => el('tr', { class: 'qv-skel' }, el('td', { colspan: 8 }, el('span', { class: 'skeleton skeleton--text' }), el('span', { class: 'skeleton skeleton--text', style: { inlineSize: '55%' } }))));
    }

    function renderBody() {
      syncControls();
      renderPager();
      const filtered = hasFilters();
      frame.classList.remove('is-empty');
      stateBox.replaceChildren();
      tableWrap.hidden = false;
      if (loading) {
        tbody.replaceChildren(...skeletonRows());
        tableWrap.setAttribute('aria-busy', 'true');
        bulk.hidden = true;
        return;
      }
      tableWrap.removeAttribute('aria-busy');
      if (loadError) {
        tableWrap.hidden = true;
        stateBox.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, icon('warning-fill', { class: 'alert__icon' }),
          el('div', null, el('p', { class: 'alert__title' }, 'Could not load the questions'), el('p', { class: 'alert__text' }, loadError)),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => load() } }, icon('arrow-clockwise'), 'Retry')));
        return;
      }
      if (!rows.length) {
        tableWrap.hidden = true;
        const emptyPool = !filtered && total === 0;
        frame.classList.toggle('is-empty', emptyPool);
        stateBox.replaceChildren(el('div', { class: 'card qv-empty' }, el('div', { class: 'empty' },
          el('div', { class: 'empty__icon' }, icon(emptyPool ? 'question' : 'magnifying-glass')),
          el('h3', { class: 'empty__title' }, emptyPool ? 'No questions yet' : 'No question matches'),
          el('p', { class: 'empty__text' }, emptyPool
            ? 'Write the first question, or import a spreadsheet to add dozens at once. Games need at least as many active questions as the number of questions per game.'
            : 'Try another search or clear the filters.'),
          el('div', { class: 'empty__actions' },
            emptyPool ? el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => openEditor() } }, icon('plus'), 'Add a question') : el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => clearFilters() } }, icon('x'), 'Clear filters'),
            emptyPool ? el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => importCsv() } }, icon('upload-simple'), 'Import CSV') : null))));
        syncSelectionUi();
        live.textContent = emptyPool ? 'No questions yet' : 'No question matches your filters';
        return;
      }
      tbody.replaceChildren(...rows.map(rowEl));
      syncSelectionUi();
      const from = (q.page - 1) * q.size + 1;
      live.textContent = `Showing ${from} to ${from + rows.length - 1} of ${plural(total, 'question')}`;
    }

    function renderPager() {
      const pages = Math.max(1, Math.ceil(total / q.size));
      const from = total ? (q.page - 1) * q.size + 1 : 0;
      const to = Math.min(total, q.page * q.size);
      const sizeSel = el('select', { class: 'select select--sm qv-size', 'aria-label': 'Questions per page' }, ...SIZES.map((n) => el('option', { value: String(n), selected: n === q.size }, `${n} / page`)));
      sizeSel.addEventListener('change', () => { q.size = Number(sizeSel.value); q.page = 1; load(); });
      const go = (p) => { q.page = p; load(); tableWrap.scrollIntoView?.({ block: 'nearest' }); };
      const btnP = (label, p, { disabled, aria, current } = {}) => el('button', { type: 'button', class: 'pagination__btn', disabled, 'aria-label': aria, 'aria-current': current ? 'page' : null, on: { click: () => go(p) } }, label);
      const pageBtns = pageList(q.page, pages).map((p) => (p === '…' ? el('span', { class: 'pagination__btn qv-ellipsis', 'aria-hidden': 'true' }, '…') : btnP(String(p), p, { aria: `Page ${p}`, current: p === q.page })));
      pager.replaceChildren(
        el('span', { class: 'pagination__info' }, total ? `${from}–${to} of ${total}` : 'No results'),
        pages > 1 ? el('div', { class: 'pagination__pages', role: 'navigation', 'aria-label': 'Pagination' },
          btnP(icon('caret-left'), q.page - 1, { disabled: q.page <= 1, aria: 'Previous page' }), ...pageBtns, btnP(icon('caret-right'), q.page + 1, { disabled: q.page >= pages, aria: 'Next page' })) : el('span'),
        sizeSel);
      pager.hidden = loading && !total;
    }

    // ===========================================================================================
    // selection + bulk actions
    // ===========================================================================================
    function syncSelectionUi({ rowsToo = false } = {}) {
      if (rowsToo) for (const tr of tbody.querySelectorAll('tr[data-id]')) {
        const on = selected.has(Number(tr.dataset.id));
        tr.classList.toggle('is-selected', on);
        const c = tr.querySelector('.qv-check'); if (c) c.checked = on;
      }
      const onPage = rows.filter((r) => selected.has(r.id)).length;
      headCheck.checked = rows.length > 0 && onPage === rows.length;
      headCheck.indeterminate = onPage > 0 && onPage < rows.length;
      renderBulk();
    }

    function menuButton(label, iconName, items) {
      const trigger = el('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-dropdown-trigger': '' }, icon(iconName), label, icon('caret-down', { size: 'sm' }));
      const menu = el('div', { class: 'menu', role: 'menu', hidden: true }, ...items);
      return el('div', { class: 'dropdown' }, trigger, menu);
    }
    const menuItem = (label, onClick, { dot, iconName, danger } = {}) => el('button', { type: 'button', class: ['menu__item', danger && 'menu__item--danger'], role: 'menuitem', on: { click: onClick } },
      dot ? el('span', { class: 'qv-dot', style: { '--chip': dot } }) : (iconName ? icon(iconName) : null), label);

    function renderBulk() {
      const n = selected.size;
      bulk.hidden = n === 0;
      if (!n) { bulk.replaceChildren(); return; }
      const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
      const canSelectAll = pageAll && total > rows.length && n < total;
      const catItems = [
        ...categories.map((c) => menuItem(c.name, () => bulkRun('set_category', { category_id: c.id }, `Moved to “${c.name}”`), { dot: safeColor(c.color) })),
        menuItem('Uncategorised', () => bulkRun('set_category', { category_id: null }, 'Moved to Uncategorised'), { iconName: 'question' }),
        el('hr', { class: 'menu__sep' }),
        menuItem('New category…', () => bulkNewCategory(), { iconName: 'plus' }),
      ];
      const diffItems = [1, 2, 3].map((d) => el('button', { type: 'button', class: 'menu__item', role: 'menuitem', on: { click: () => bulkRun('set_difficulty', { difficulty: d }, `Difficulty set to ${DIFFICULTY[d]}`) } }, el('span', { class: 'difficulty', 'data-level': d, 'aria-hidden': 'true' }), DIFFICULTY[d]));
      bulk.replaceChildren(
        el('div', { class: 'qv-bulk__count' },
          el('strong', null, `${n} selected`),
          canSelectAll ? el('button', { type: 'button', class: 'btn btn--link btn--sm', on: { click: selectAllMatching } }, `Select all ${total} matching`) : null,
          (n === total && total > rows.length) ? el('span', { class: 'u-muted' }, 'every match') : null),
        el('div', { class: 'qv-bulk__actions' },
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => bulkRun('activate', {}, 'Activated') } }, icon('eye'), 'Activate'),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => bulkRun('deactivate', {}, 'Deactivated') } }, icon('eye-slash'), 'Deactivate'),
          menuButton('Set category', 'tag', catItems),
          menuButton('Set difficulty', 'gauge', diffItems),
          el('button', { type: 'button', class: 'btn btn--danger btn--sm', on: { click: bulkDelete } }, icon('trash'), 'Delete'),
          el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: () => { selected.clear(); syncSelectionUi({ rowsToo: true }); } } }, icon('x'), 'Clear')));
    }

    async function selectAllMatching() {
      try {
        const items = await matchingItems();
        items.forEach((r) => selected.add(r.id));
        syncSelectionUi({ rowsToo: true });
        announce(`${selected.size} questions selected`);
      } catch (e) { notify(ctx, describeError(e), 'error'); }
    }

    async function bulkRun(action, extra, doneMessage) {
      const ids = [...selected];
      if (!ids.length) return;
      bulk.setAttribute('aria-busy', 'true');
      try {
        const res = await api.post(`/admin/events/${eventId}/questions/bulk`, { ids, action, ...extra });
        const n = res?.affected ?? ids.length;
        notify(ctx, `${doneMessage}: ${plural(n, 'question')}`, 'success');
        announce(`${doneMessage}: ${plural(n, 'question')}`);
        if (action === 'delete') ids.forEach((id) => selected.delete(id)); else selected.clear();
        changed();
        syncSelectionUi({ rowsToo: true });
      } catch (e) {
        notify(ctx, describeError(e), 'error');
      } finally { bulk.removeAttribute('aria-busy'); }
    }

    async function bulkDelete() {
      const n = selected.size;
      const ok = await confirm(ctx, {
        title: `Delete ${plural(n, 'question')}?`,
        message: `They are removed from the pool, together with the answers recorded for them in past games. This cannot be undone.${n > 1 ? ' Consider deactivating them instead if you might need them again.' : ''}`,
        confirmLabel: `Delete ${plural(n, 'question')}`, danger: true, requireText: n >= 10 ? 'DELETE' : undefined,
      });
      if (ok) { await bulkRun('delete', {}, 'Deleted'); selected.clear(); syncSelectionUi({ rowsToo: true }); }
    }

    async function bulkNewCategory() {
      const created = await openCategoryDialog(ctx, { categories, restoreFocus: () => bulk.querySelector('[data-dropdown-trigger]') });
      if (!created) return;
      categories.push(created);
      renderCategoryFilter();
      await bulkRun('set_category', { category_id: created.id }, `Moved to “${created.name}”`);
    }

    // ===========================================================================================
    // actions
    // ===========================================================================================
    const rowFocus = (id) => () => tbody.querySelector(`tr[data-id="${id}"] .qv-qtext`) || addBtn;
    const editorCommon = () => ({
      categories,
      onSaved: () => changed(),
      onDeleted: (r) => { selected.delete(r.id); changed(); },
      onCategoryCreated: () => { renderCategoryFilter(); refreshCategoryCounts(); },
    });

    function openEditor(question = null, draft = null) {
      const defaults = draft || (question ? null : {
        category_id: q.category && q.category !== '0' ? Number(q.category) : null,
        difficulty: q.difficulty ? Number(q.difficulty) : 1,
        question_format: q.format || 'true_false',
      });
      return openQuestionEditor(ctx, { ...editorCommon(), question, draft: defaults, restoreFocus: question ? rowFocus(question.id) : () => addBtn });
    }

    function duplicateQuestion(r) {
      return openEditor(null, { ...r, __duplicate: true });
    }

    async function deleteQuestion(r) {
      const text = trim(r.question_text_en);
      const ok = await confirm(ctx, {
        title: 'Delete this question?',
        message: `“${text.length > 120 ? `${text.slice(0, 117)}…` : text}” will be removed from the pool. Answers recorded for it in past games are removed too. This cannot be undone.`,
        confirmLabel: 'Delete question', danger: true,
      });
      if (!ok) return;
      try {
        await api.delete(`/admin/questions/${r.id}`);
        selected.delete(r.id);
        notify(ctx, 'Question deleted', 'success');
        announce('Question deleted');
        changed();
        addBtn.focus({ preventScroll: true });
      } catch (e) { notify(ctx, describeError(e), 'error'); }
    }

    async function toggleActive(r, input, tr) {
      const next = input.checked;
      r.is_active = next;
      tr.classList.toggle('is-inactive', !next);
      input.disabled = true;
      try {
        const saved = await api.put(`/admin/questions/${r.id}`, { is_active: next });
        Object.assign(r, saved);
        if (clientCache) { const c = clientCache.items.find((x) => x.id === r.id); if (c) Object.assign(c, saved); }
        notify(ctx, next ? 'Question activated' : 'Question deactivated', 'success');
        loadStatsSoon(); syncEvent();
        // the row may no longer match the status filter: refresh quietly after the switch animation
        if (q.show === 'active' || q.show === 'inactive') setTimeout(() => { if (alive) load({ quiet: true }); }, 450);
      } catch (e) {
        r.is_active = !next; input.checked = !next; tr.classList.toggle('is-inactive', next);
        notify(ctx, describeError(e), 'error');
      } finally { input.disabled = false; }
    }

    async function exportCsv() {
      if (exporting) return;
      exporting = true;
      exportBtn.disabled = true; exportBtn.classList.add('is-loading');
      try {
        const name = await api.download(`/admin/events/${eventId}/questions/export.csv`);
        notify(ctx, `Exported ${name}`, 'success');
      } catch (e) { notify(ctx, `Export failed: ${describeError(e)}`, 'error'); }
      finally { exporting = false; exportBtn.disabled = false; exportBtn.classList.remove('is-loading'); }
    }

    async function importCsv() {
      const result = await openCsvImport(ctx, { onImported: () => { changed(); loadCategories(); }, restoreFocus: () => importBtn });
      if (result && alive) announce('Import finished');
    }

    function setShow(v) { q.show = v; q.page = 1; refetch(); }
    function clearFilters() { Object.assign(q, { search: '', category: '', difficulty: '', format: '', show: 'all', page: 1 }); searchIn.value = ''; refetch(); searchIn.focus(); }
    function cycleSort(key) {
      const [k, d] = q.sort.split(':');
      q.sort = k !== key ? `${key}:asc` : d === 'asc' ? `${key}:desc` : 'id:asc';
      q.page = 1;
      refetch({ keepCache: true });
    }

    // ===========================================================================================
    // events
    // ===========================================================================================
    const onSearch = debounce(() => { q.search = searchIn.value; q.page = 1; refetch(); }, 280);
    searchIn.addEventListener('input', onSearch);
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { onSearch.cancel(); q.search = searchIn.value; q.page = 1; refetch(); } });
    catSel.addEventListener('change', () => { q.category = catSel.value; q.page = 1; refetch(); });
    fmtSel.addEventListener('change', () => { q.format = fmtSel.value; q.page = 1; refetch(); });
    showSel.addEventListener('change', () => { q.show = showSel.value; q.page = 1; refetch({ keepCache: true }); });
    sortSel.addEventListener('change', () => { q.sort = sortSel.value; q.page = 1; refetch({ keepCache: true }); });

    const findRow = (target) => {
      const tr = target.closest('tr[data-id]');
      return tr ? { tr, r: rows.find((x) => x.id === Number(tr.dataset.id)) } : {};
    };
    tbody.addEventListener('click', (e) => {
      const { tr, r } = findRow(e.target);
      if (!r) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (e.target.closest('.qv-check')) {
        const checkbox = e.target.closest('.qv-check');
        const idx = Number(checkbox.dataset.index);
        if (e.shiftKey && lastChecked !== null) {
          const [a, b] = [Math.min(lastChecked, idx), Math.max(lastChecked, idx)];
          for (let i = a; i <= b; i++) checkbox.checked ? selected.add(rows[i].id) : selected.delete(rows[i].id);
          syncSelectionUi({ rowsToo: true });
        } else {
          checkbox.checked ? selected.add(r.id) : selected.delete(r.id);
          tr.classList.toggle('is-selected', checkbox.checked);
          syncSelectionUi();
        }
        lastChecked = idx;
        return;
      }
      if (e.target.closest('.qv-active')) return;
      if (act === 'duplicate') duplicateQuestion(r);
      else if (act === 'delete') deleteQuestion(r);
      else if (act === 'edit') openEditor(r);
      else if (!e.target.closest('button, a, input, label, select')) openEditor(r);
    });
    tbody.addEventListener('change', (e) => {
      const sw = e.target.closest('.qv-active');
      if (!sw) return;
      const { tr, r } = findRow(sw);
      if (r) toggleActive(r, sw, tr);
    });

    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === '/') { e.preventDefault(); searchIn.focus(); searchIn.select(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); openEditor(); }
    };
    document.addEventListener('keydown', onKey);
    const offEvent = ctx.onEventChanged?.(() => { const next = supportsFr(ctx.getEvent?.()); if (next !== frOn) { frOn = next; syncControls(); renderStats(); if (!loading) renderBody(); } });

    // ===========================================================================================
    // boot
    // ===========================================================================================
    syncControls();
    renderStats();
    renderBody();
    loadCategories().then(syncControls);
    loadStats();
    await load();

    return {
      unmount() {
        alive = false;
        closeAllPanels();
        aborter?.abort();
        document.removeEventListener('keydown', onKey);
        offEvent?.();
        disposeDropdowns?.();
        onSearch.cancel(); loadStatsSoon.cancel(); refreshCategoryCounts.cancel(); syncSoon.cancel(); if (syncPending) syncNow();
        root.replaceChildren();
      },
    };
  },
};
