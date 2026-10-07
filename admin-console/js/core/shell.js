/**
 * core/shell.js - the admin application shell: top bar (brand, event switcher, theme, account), sidebar
 * (collapsible on desktop, drawer on tablets / phones), bottom navigation on phones, breadcrumb and the host
 * element the views mount into.
 *
 * It renders; app.js decides. All behaviour goes back to app.js through the `app` callbacks:
 *   app.navigate(hash) · app.logout() · app.newEvent() · app.copyLink(url, what)
 */
import { el, icon, avatar, uid, debounce, hydrateIcons } from '../../shared/js/dom.js';
import { initShell, initDropdowns } from '../../shared/js/ui.js';
import { createThemeToggle } from '../../shared/js/theme.js';
import { eventUrl } from '../../shared/js/config.js';
import { TABS, STATUS, STATUS_ORDER, statusBadge, fmt, safeColor } from './util.js';

const MARK_URL = new URL('../../shared/img/gravitee-mark.svg', import.meta.url).href;
const LS_SIDEBAR = 'quiz.admin.sidebar';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function createShell(app) {
  const S = { events: [], event: null, route: { name: 'events', tab: null }, extra: [], user: '' };

  // ---------------------------------------------------------------------------------------
  // top bar
  // ---------------------------------------------------------------------------------------
  const burger = el('button', { type: 'button', class: 'btn btn--ghost btn--icon shell__burger', 'data-shell-toggle': '', 'aria-label': 'Open navigation', 'aria-expanded': 'false', 'aria-controls': 'sidebar' }, icon('list'));
  const collapseBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon shell__collapse', 'aria-pressed': 'false', 'aria-label': 'Collapse sidebar', title: 'Collapse sidebar', on: { click: () => setCollapsed(!collapsed()) } }, icon('sidebar-simple'));
  const brand = el('a', { class: 'brand', href: '#/events', 'aria-label': 'Quiz Admin, all events' },
    el('img', { class: 'brand__mark', src: MARK_URL, alt: '', width: 30, height: 30 }), el('span', { class: 'brand__name' }, 'Quiz Admin'));

  const switcher = createSwitcher();
  const themeToggle = createThemeToggle({ variant: 'button', labels: { theme: 'Theme' } });
  themeToggle.classList.add('topbar__theme');

  const accountBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon account__btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-dropdown-trigger': '', 'aria-label': 'Account menu' });
  const accountLabel = el('div', { class: 'menu__label' }, 'Signed in');
  const account = el('div', { class: 'dropdown dropdown--end account' }, accountBtn,
    el('div', { class: 'menu', role: 'menu', hidden: true },
      accountLabel,
      el('a', { class: 'menu__item', role: 'menuitem', href: '/', target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Open the player site'),
      el('hr', { class: 'menu__sep' }),
      el('button', { type: 'button', class: 'menu__item menu__item--danger', role: 'menuitem', on: { click: () => app.logout() } }, icon('sign-out'), 'Sign out')));

  const topbar = el('header', { class: 'shell__topbar' },
    burger, collapseBtn, brand, el('span', { class: 'brand__sep topbar__sep', 'aria-hidden': 'true' }), switcher.root,
    el('span', { class: 'shell__spacer' }), themeToggle, account);

  // ---------------------------------------------------------------------------------------
  // sidebar + bottom nav
  // ---------------------------------------------------------------------------------------
  const eventsLink = navLink('#/events', 'squares-four', 'All events', el('span', { class: 'nav__badge', hidden: true }));
  const eventSection = el('div', { class: 'nav__group', hidden: true });
  const nav = el('nav', { class: 'nav', 'aria-label': 'Admin' }, el('p', { class: 'nav__section' }, el('span', { class: 'nav__label' }, 'Workspace')), eventsLink.a, eventSection);

  const sideEventStatus = el('span', { class: 'sidebar-event__status' });
  const sideEventUrl = el('p', { class: 'sidebar-event__url' });
  const sideEvent = el('div', { class: 'glass sidebar-event', hidden: true },
    el('div', { class: 'cluster cluster--between' }, sideEventStatus, el('span', { class: 'u-eyebrow' }, 'Public link')), sideEventUrl,
    el('button', { type: 'button', class: 'btn btn--secondary btn--sm btn--block', on: { click: () => S.event && app.copyLink(eventUrl(S.event.slug), 'Game link') } }, icon('copy'), 'Copy link'));
  const sideTheme = el('div', { class: 'sidebar-theme u-show-sm' }, el('span', { class: 'u-eyebrow' }, 'Theme'), createThemeToggle({ variant: 'segmented', labels: { theme: 'Theme' } }));

  const sidebar = el('aside', { class: 'shell__sidebar', id: 'sidebar', 'aria-label': 'Sidebar' }, nav, sideEvent, sideTheme);
  const bottomNav = el('nav', { class: 'bottom-nav', 'aria-label': 'Event sections', hidden: true });
  const scrim = el('div', { class: 'shell__scrim', 'aria-hidden': 'true' });

  // ---------------------------------------------------------------------------------------
  // main
  // ---------------------------------------------------------------------------------------
  const crumbs = el('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb', hidden: true });
  const host = el('div', { class: 'view-host' });
  const main = el('main', { class: 'shell__main', id: 'main', tabindex: '-1' }, el('div', { class: 'container' }, crumbs, host));

  const root = el('div', { class: 'shell', dataset: { sidebar: 'closed' } }, topbar, sidebar, scrim, main, bottomNav);

  // ---------------------------------------------------------------------------------------
  // collapse (desktop)
  // ---------------------------------------------------------------------------------------
  const collapsed = () => root.dataset.collapsed === 'true';
  function setCollapsed(on, persist = true) {
    root.dataset.collapsed = String(on);
    collapseBtn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Expand sidebar' : 'Collapse sidebar';
    collapseBtn.setAttribute('aria-label', label); collapseBtn.title = label;
    if (persist) lsSet(LS_SIDEBAR, on ? 'collapsed' : 'open');
  }
  setCollapsed(lsGet(LS_SIDEBAR) === 'collapsed', false);

  // ---------------------------------------------------------------------------------------
  // behaviours
  // ---------------------------------------------------------------------------------------
  const disposers = [initShell(root), initDropdowns(root)];
  burger.addEventListener('click', () => setTimeout(() => { if (root.dataset.sidebar === 'open') sidebar.querySelector('a[href]')?.focus(); }, 80));
  // while the drawer is open the page behind it is inert (tablets / phones)
  const mql = matchMedia('(max-width: 62rem)');
  const syncInert = () => { const open = root.dataset.sidebar === 'open' && mql.matches; main.inert = open; bottomNav.inert = open; burger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation'); };
  const mo = new MutationObserver(syncInert);
  mo.observe(root, { attributes: true, attributeFilter: ['data-sidebar'] });
  mql.addEventListener('change', syncInert);
  disposers.push(() => { mo.disconnect(); mql.removeEventListener('change', syncInert); });

  // ---------------------------------------------------------------------------------------
  // nav helpers
  // ---------------------------------------------------------------------------------------
  function navLink(href, iconName, label, badge) {
    const a = el('a', { class: 'nav__item', href, title: label }, icon(iconName), el('span', { class: 'nav__label' }, label), badge || null);
    return { a, badge };
  }
  const eventNav = new Map();   // tab id -> { a, badge, b: bottom item }

  function buildEventNav(event) {
    eventNav.clear();
    const section = el('p', { class: 'nav__section nav__section--event' }, el('span', { class: 'nav__label' }, event.game_title));
    const links = [];
    const bottom = [];
    for (const t of TABS) {
      const badge = el('span', { class: 'nav__badge', hidden: true });
      const { a } = navLink(`#/events/${event.id}/${t.id}`, t.icon, t.title, badge);
      const b = el('a', { class: 'bottom-nav__item', href: `#/events/${event.id}/${t.id}`, 'aria-label': t.title }, icon(t.icon), el('span', null, t.title));
      eventNav.set(t.id, { a, badge, b });
      links.push(a); bottom.push(b);
    }
    eventSection.replaceChildren(section, ...links);
    bottomNav.replaceChildren(...bottom);
    eventSection.dataset.eventId = String(event.id);
  }

  function paintNav() {
    const ev = S.event;
    const inEvent = S.route.name === 'event' && !!ev;
    eventSection.hidden = !inEvent;
    sideEvent.hidden = !inEvent;
    bottomNav.hidden = !inEvent;
    root.dataset.scope = inEvent ? 'event' : 'workspace';
    if (S.route.name === 'events') eventsLink.a.setAttribute('aria-current', 'page'); else eventsLink.a.removeAttribute('aria-current');
    eventsLink.badge.hidden = !S.events.length;
    eventsLink.badge.textContent = fmt(S.events.length);
    if (!inEvent) return;
    if (eventSection.dataset.eventId !== String(ev.id)) buildEventNav(ev);
    eventSection.querySelector('.nav__section .nav__label').textContent = ev.game_title;
    const counts = ev.counts || {};
    const badgeFor = { questions: counts.questions, categories: counts.categories, results: counts.players };
    for (const [id, { a, badge, b }] of eventNav) {
      const current = S.route.tab === id;
      if (current) { a.setAttribute('aria-current', 'page'); b.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); b.removeAttribute('aria-current'); }
      const n = badgeFor[id];
      badge.hidden = !n;
      badge.textContent = n ? fmt(n) : '';
    }
    sideEventStatus.replaceChildren(statusBadge(ev.status));
    sideEventUrl.textContent = eventUrl(ev.slug).replace(/^https?:\/\//, '');
  }

  // ---------------------------------------------------------------------------------------
  // breadcrumb
  // ---------------------------------------------------------------------------------------
  function paintCrumbs() {
    const ev = S.event;
    if (S.route.name !== 'event' || !ev) { crumbs.hidden = true; crumbs.replaceChildren(); return; }
    const tab = TABS.find((t) => t.id === S.route.tab);
    const items = [{ label: 'Events', href: '#/events' }, { label: ev.name, href: `#/events/${ev.id}/overview` }];
    if (tab) items.push({ label: tab.title, href: `#/events/${ev.id}/${tab.id}` });
    for (const x of S.extra) items.push(x);
    crumbs.replaceChildren(...items.map((c, i) => {
      const last = i === items.length - 1;
      return last || !c.href ? el('span', { 'aria-current': 'page' }, c.label) : el('a', { href: c.href }, c.label);
    }));
    crumbs.hidden = false;
  }

  // ---------------------------------------------------------------------------------------
  // event switcher (searchable combobox)
  // ---------------------------------------------------------------------------------------
  function createSwitcher() {
    const listId = uid('switcher-list');
    const chip = el('span', { class: 'chip chip--plain switcher__chip' });
    const label = el('span', { class: 'switcher__label' });
    // (no aria-label: the accessible name is the visible text + the hint, so it passes "label in name")
    const btn = el('button', { type: 'button', class: 'btn btn--secondary btn--sm switcher__btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, chip, label, el('span', { class: 'u-sr-only' }, '. Switch event'), icon('caret-up-down', { size: 'sm' }));
    const search = el('input', { class: 'input input--sm', type: 'search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Find an event', placeholder: 'Find an event', autocomplete: 'off', spellcheck: 'false' });
    const list = el('div', { class: 'switcher__list', id: listId, role: 'listbox', 'aria-label': 'Events' });
    const panel = el('div', { class: 'switcher__panel', role: 'dialog', 'aria-label': 'Switch event', hidden: true },
      el('div', { class: 'input-wrap switcher__search' }, icon('magnifying-glass'), search), list,
      el('hr', { class: 'menu__sep' }),
      el('a', { class: 'menu__item', href: '#/events', on: { click: () => close() } }, icon('squares-four'), 'All events'),
      el('button', { type: 'button', class: 'menu__item', on: { click: () => { close(); app.newEvent(); } } }, icon('plus'), 'New event'));
    const rootEl = el('div', { class: 'dropdown switcher' }, btn, panel);
    let active = -1;
    let options = [];

    const sorted = () => [...S.events].sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.name.localeCompare(b.name));
    function render() {
      const q = search.value.trim().toLowerCase();
      const items = sorted().filter((e) => !q || `${e.name} ${e.game_title} ${e.slug} ${e.location || ''}`.toLowerCase().includes(q));
      options = items;
      list.replaceChildren(...(items.length ? items.map((e, i) => el('div', {
        class: 'menu__item switcher__opt', role: 'option', id: `${listId}-${e.id}`, 'aria-selected': String(S.event?.id === e.id), dataset: { id: e.id },
        on: { click: () => choose(e), pointermove: () => setActive(i, false) },
      }, el('span', { class: 'ev-dot', dataset: { status: e.status }, title: STATUS[e.status]?.label }),
      el('span', { class: 'switcher__opt-main' }, el('span', { class: 'switcher__opt-name' }, e.name), el('span', { class: 'switcher__opt-sub' }, `${e.game_title} · ${e.slug}`)),
      el('span', { class: 'u-sr-only' }, STATUS[e.status]?.label || '')))
        : [el('p', { class: 'switcher__empty', role: 'status' }, S.events.length ? 'No event matches your search.' : 'No events yet.')]));
      const cur = items.findIndex((e) => e.id === S.event?.id);
      setActive(items.length ? (cur >= 0 && !q ? cur : 0) : -1, true);
    }
    function setActive(i, scroll = true) {
      active = i;
      list.querySelectorAll('.switcher__opt').forEach((n, idx) => n.classList.toggle('is-active', idx === i));
      const node = list.querySelectorAll('.switcher__opt')[i];
      if (node) { search.setAttribute('aria-activedescendant', node.id); if (scroll) node.scrollIntoView({ block: 'nearest' }); } else search.removeAttribute('aria-activedescendant');
    }
    function choose(e) {
      close(false);
      const tab = S.route.name === 'event' && S.route.tab ? S.route.tab : 'overview';
      app.navigate(`#/events/${e.id}/${tab}`);
      btn.focus();
    }
    function open() {
      if (!panel.hidden) return;
      panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
      search.value = ''; render(); search.focus();
      document.addEventListener('pointerdown', onOutside, true);
    }
    function close(returnFocus = true) {
      if (panel.hidden) return;
      panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      if (returnFocus) btn.focus();
    }
    const onOutside = (e) => { if (!rootEl.contains(e.target)) close(false); };
    btn.addEventListener('click', () => (panel.hidden ? open() : close()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && panel.hidden) { e.preventDefault(); open(); } });
    search.addEventListener('input', debounce(render, 80));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (options.length) setActive((active + 1) % options.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (options.length) setActive((active - 1 + options.length) % options.length); }
      else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) choose(options[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') close(false);
    });
    rootEl.addEventListener('focusout', (e) => { if (!panel.hidden && e.relatedTarget && !rootEl.contains(e.relatedTarget)) close(false); });

    function paint() {
      const ev = S.event;
      if (ev) {
        chip.hidden = false; chip.textContent = ev.game_title;
        chip.style.setProperty('--chip', safeColor(ev.branding?.primary_color, 'var(--brand-solid)'));
        label.textContent = ev.name;
      } else {
        chip.hidden = true; label.textContent = S.events.length ? 'Select an event' : 'Events';
      }
      if (!panel.hidden) render();
    }
    return { root: rootEl, paint, close };
  }

  // ---------------------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------------------
  const api = {
    root, host, main,
    setUser(username) {
      S.user = username || '';
      accountBtn.replaceChildren(avatar(S.user || 'Admin', { size: 'sm' }));
      accountLabel.textContent = S.user ? `Signed in as ${S.user}` : 'Signed in';
    },
    setEvents(list) { S.events = list || []; paintNav(); switcher.paint(); },
    /** @param {object|null} event  @param {{name:string, tab?:string}} route */
    setRoute(route, event = null) {
      S.route = route; S.event = event; S.extra = [];
      paintNav(); paintCrumbs(); switcher.paint();
    },
    setEvent(event) { S.event = event; paintNav(); paintCrumbs(); switcher.paint(); },
    setBreadcrumb(extra) {
      const list = extra == null ? [] : Array.isArray(extra) ? extra : [extra];
      S.extra = list.filter(Boolean).map((x) => (typeof x === 'string' ? { label: x } : x));
      paintCrumbs();
    },
    /** Move keyboard focus to the new view (first heading), after an in-app navigation. */
    focusView() {
      const h = host.querySelector('h1') || main;
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: false });
    },
    closeDrawer() { root.dataset.sidebar = 'closed'; burger.setAttribute('aria-expanded', 'false'); },
    hydrate() { hydrateIcons(root); },
    dispose() { switcher.close(false); disposers.forEach((d) => d()); },
  };
  return api;
}
