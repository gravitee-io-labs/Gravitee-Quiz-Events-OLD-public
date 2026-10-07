/**
 * Categories tab: colour-coded cards with EN/FR names, question counts, active toggle, create / edit / delete.
 * Contract: admin view module (id, title, icon, mount(root, ctx) -> { unmount }).
 */
import { el, icon, debounce } from '../../shared/js/dom.js';
import { announce } from '../../shared/js/ui.js';
import { openCategoryDialog } from './content/category-dialog.js';
import { closeAllPanels, confirm, describeError, handoff, notify, plural, safeColor, supportsFr, trim } from './content/common.js';

export default {
  id: 'categories',
  title: 'Categories',
  icon: 'tag',

  async mount(root, ctx) {
    const { api, eventId } = ctx;
    let categories = [];
    let uncategorised = 0;
    let frOn = supportsFr(ctx.getEvent?.());
    let alive = true;
    let loadError = null;
    let loading = true;

    // ---- static frame ----------------------------------------------------------------------
    const summary = el('p', { class: 'cv-summary', role: 'status', 'aria-live': 'polite' });
    const newBtn = el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => create() } }, icon('plus'), 'New category');
    const head = el('header', { class: 'page-header cv-head' },
      el('div', { class: 'page-header__main' },
        el('h1', { class: 'page-header__title', tabindex: '-1' }, 'Categories'),
        el('p', { class: 'page-header__sub' }, 'Questions are grouped into categories. Every game draws from the active categories, balanced by the weights set in Game rules.'),
        summary),
      el('div', { class: 'page-header__actions' }, newBtn));
    const body = el('div', { class: 'cv-body' });
    const frame = el('section', { class: 'cv', 'aria-label': 'Categories' }, head, body);
    root.replaceChildren(frame);

    const offEvent = ctx.onEventChanged?.(() => { const next = supportsFr(ctx.getEvent?.()); if (next !== frOn) { frOn = next; render(); } });

    // ---- data -------------------------------------------------------------------------------
    async function load({ quiet = false } = {}) {
      if (!quiet) { loading = true; render(); }
      try {
        const [list, none] = await Promise.all([
          api.get(`/admin/events/${eventId}/categories`),
          api.get(`/admin/events/${eventId}/questions`, { query: { category_id: 0, limit: 1, include_inactive: true } }),
        ]);
        if (!alive) return;
        categories = list;
        uncategorised = none?.total ?? 0;
        loadError = null;
      } catch (e) {
        if (!alive) return;
        loadError = describeError(e);
      }
      loading = false;
      render();
    }

    // keep the shell's sidebar badges / other tabs in step with what happened here
    let syncPending = false;
    const syncNow = () => { syncPending = false; ctx.reloadEvent?.().catch(() => {}); };
    const syncSoon = debounce(syncNow, 400);
    const syncEvent = () => { syncPending = true; syncSoon(); };

    function replaceInList(saved) {
      const i = categories.findIndex((c) => c.id === saved.id);
      if (i >= 0) categories[i] = { ...categories[i], ...saved }; else categories.push(saved);
    }

    // ---- actions ----------------------------------------------------------------------------
    async function create() {
      const saved = await openCategoryDialog(ctx, { categories, restoreFocus: () => newBtn });
      if (!saved || !alive) return;
      replaceInList(saved);
      render({ focusId: saved.id });
      syncEvent();
      notify(ctx, `Category “${saved.name}” created`, 'success');
      announce(`Category ${saved.name} created`);
    }

    async function edit(cat) {
      const saved = await openCategoryDialog(ctx, { category: cat, categories, restoreFocus: () => body.querySelector(`[data-id="${cat.id}"] [data-act="edit"]`) });
      if (!saved || !alive) return;
      replaceInList(saved);
      render({ focusId: cat.id });
      notify(ctx, `Category “${saved.name}” saved`, 'success');
    }

    async function remove(cat) {
      const n = cat.question_count || 0;
      const ok = await confirm(ctx, {
        title: `Delete “${cat.name}”?`,
        message: n
          ? `The ${plural(n, 'question')} in this category will not be deleted: they become uncategorised. The category is also removed from the game rules weights. This cannot be undone.`
          : 'This category has no questions. It is also removed from the game rules weights. This cannot be undone.',
        confirmLabel: 'Delete category',
        danger: true,
      });
      if (!ok || !alive) return;
      try {
        await api.delete(`/admin/categories/${cat.id}`);
        categories = categories.filter((c) => c.id !== cat.id);
        uncategorised += n;
        render({ focusAdd: true });
        syncEvent();
        notify(ctx, `Category “${cat.name}” deleted${n ? `, ${plural(n, 'question')} now uncategorised` : ''}`, 'success');
        announce(`Category ${cat.name} deleted`);
      } catch (e) {
        notify(ctx, describeError(e), 'error');
      }
    }

    async function toggleActive(cat, input, card) {
      const next = input.checked;
      cat.is_active = next;
      card.classList.toggle('is-inactive', !next);
      renderSummary();
      input.disabled = true;
      try {
        const saved = await api.put(`/admin/categories/${cat.id}`, { is_active: next });
        replaceInList(saved);
        syncEvent();
        notify(ctx, next ? `“${cat.name}” is active` : `“${cat.name}” is hidden from players`, 'success');
      } catch (e) {
        cat.is_active = !next;
        input.checked = !next;
        card.classList.toggle('is-inactive', next);
        renderSummary();
        notify(ctx, describeError(e), 'error');
      } finally { input.disabled = false; }
    }

    function showQuestions(categoryId) {
      handoff.questionFilter = { category: String(categoryId) };
      ctx.navigate?.(`#/events/${eventId}/questions`);
    }

    // ---- rendering --------------------------------------------------------------------------
    function renderSummary() {
      if (loading || loadError) { summary.textContent = ''; return; }
      const active = categories.filter((c) => c.is_active).length;
      const total = categories.reduce((n, c) => n + (c.question_count || 0), 0) + uncategorised;
      summary.textContent = categories.length
        ? `${plural(categories.length, 'category', 'categories')} · ${active} active · ${plural(total, 'question')}`
        : 'No categories yet';
    }

    function card(cat, index) {
      const missingName = frOn && !trim(cat.name_fr);
      const missingDesc = frOn && !!trim(cat.description) && !trim(cat.description_fr);
      const frGaps = [missingName && 'name', missingDesc && 'description'].filter(Boolean);
      const count = cat.question_count || 0;
      const toggleId = `cv-active-${cat.id}`;
      const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch', id: toggleId, checked: !!cat.is_active, 'aria-label': `Category ${cat.name} active` });
      const art = el('article', { class: ['card', 'qv-cat', !cat.is_active && 'is-inactive'], style: { '--cat': safeColor(cat.color), '--i': index }, dataset: { id: cat.id }, 'aria-label': cat.name },
        el('div', { class: 'qv-cat__head' },
          el('span', { class: 'qv-cat__disc', 'aria-hidden': 'true' }, icon('tag', { size: 'lg' })),
          el('div', { class: 'qv-cat__names' },
            el('h2', { class: 'qv-cat__name' }, cat.name),
            trim(cat.name_fr) ? el('p', { class: 'qv-cat__fr', lang: 'fr' }, cat.name_fr) : null),
          el('div', { class: 'qv-cat__actions' },
            el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': `Edit ${cat.name}`, title: 'Edit', dataset: { act: 'edit' }, on: { click: () => edit(cat) } }, icon('pencil-simple')),
            el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm qv-danger', 'aria-label': `Delete ${cat.name}`, title: 'Delete', dataset: { act: 'delete' }, on: { click: () => remove(cat) } }, icon('trash')))),
        el('div', { class: 'qv-cat__descs' },
          trim(cat.description)
            ? el('p', { class: 'qv-cat__desc' }, el('span', { class: 'qv-cat__lang' }, 'EN'), cat.description)
            : el('p', { class: 'qv-cat__desc is-empty' }, 'No description'),
          trim(cat.description_fr) ? el('p', { class: 'qv-cat__desc', lang: 'fr' }, el('span', { class: 'qv-cat__lang' }, 'FR'), cat.description_fr) : null),
        el('div', { class: 'qv-cat__tags' },
          el('span', { class: 'qv-cat__swatch', title: cat.color }, el('i'), cat.color),
          !cat.is_active ? el('span', { class: 'badge badge--warning' }, icon('eye-slash'), 'Hidden from players') : null,
          frGaps.length ? el('span', { class: 'badge badge--warning', title: 'Players playing in French see the English text' }, icon('translate'), `FR missing: ${frGaps.join(' + ')}`) : null),
        el('div', { class: 'qv-cat__foot' },
          el('button', {
            type: 'button', class: 'btn btn--secondary btn--sm qv-cat__count', 'aria-label': `${plural(count, 'question')}, view them in ${cat.name}`, disabled: count === 0 ? true : null,
            on: { click: () => showQuestions(cat.id) },
          }, el('strong', null, String(count)), ' ', count === 1 ? 'question' : 'questions', icon('arrow-right', { size: 'sm' })),
          el('label', { class: 'check qv-cat__toggle', for: toggleId }, input, el('span', { class: 'check__text' }, 'Active'))));
      input.addEventListener('change', () => toggleActive(cat, input, art));
      return art;
    }

    function render({ focusId, focusAdd } = {}) {
      renderSummary();
      newBtn.disabled = !!loadError;
      if (loading) {
        body.replaceChildren(el('div', { class: 'cv-grid', 'aria-busy': 'true', 'aria-label': 'Loading categories' },
          ...[0, 1, 2, 3].map(() => el('span', { class: 'skeleton skeleton--card qv-cat-skel' }))));
        return;
      }
      if (loadError) {
        body.replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' },
          icon('warning-fill', { class: 'alert__icon' }),
          el('div', null, el('p', { class: 'alert__title' }, 'Could not load the categories'), el('p', { class: 'alert__text' }, loadError)),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => load() } }, icon('arrow-clockwise'), 'Retry')));
        return;
      }
      if (!categories.length) {
        body.replaceChildren(el('div', { class: 'card qv-empty' }, el('div', { class: 'empty' },
          el('div', { class: 'empty__icon' }, icon('tag')),
          el('h2', { class: 'empty__title' }, 'No categories yet'),
          el('p', { class: 'empty__text' }, uncategorised
            ? `This event has ${plural(uncategorised, 'question')} without a category. Create categories to balance every game across topics, or import a CSV: categories are created for you.`
            : 'Create the topics of this event. Games are balanced across categories, so each one needs enough active questions.'),
          el('div', { class: 'empty__actions' },
            el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => create() } }, icon('plus'), 'New category'),
            uncategorised ? el('button', { type: 'button', class: 'btn btn--secondary', on: { click: () => showQuestions(0) } }, 'View uncategorised questions') : null))));
        return;
      }
      const grid = el('div', { class: 'cv-grid' }, categories.map(card));
      const nodes = [grid];
      if (uncategorised > 0) {
        nodes.push(el('div', { class: 'qv-uncat' },
          el('span', { class: 'qv-uncat__icon', 'aria-hidden': 'true' }, icon('question')),
          el('div', { class: 'qv-uncat__text' },
            el('strong', null, `${plural(uncategorised, 'question')} without a category`),
            el('span', null, 'They stay in the pool but cannot be balanced by category. Assign them from the Questions tab.')),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: () => showQuestions(0) } }, 'Review', icon('arrow-right', { size: 'sm' }))));
      }
      body.replaceChildren(...nodes);
      if (focusId) body.querySelector(`[data-id="${focusId}"] [data-act="edit"]`)?.focus();
      else if (focusAdd) newBtn.focus();
    }

    await load();

    return {
      unmount() {
        alive = false;
        syncSoon.cancel(); if (syncPending) syncNow();
        closeAllPanels();
        offEvent?.();
        root.replaceChildren();
      },
    };
  },
};
