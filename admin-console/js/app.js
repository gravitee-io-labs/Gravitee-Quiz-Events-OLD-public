/**
 * Quiz Admin - application entry: auth, hash router, shell, view lifecycle and the `ctx` handed to every view.
 *
 * Routes (hash):  #/login · #/events · #/events/{id}/{overview|questions|categories|results|settings|appearance}
 * Anything else goes to #/events. Tab views live in js/views/<tab>.js and are imported lazily:
 *
 *   export default { id, title, icon, async mount(root, ctx) { ...; return { unmount() {} } } }
 *
 * ctx = { eventId, getEvent(), reloadEvent(), onEventChanged(cb), navigate(hash), toast(msg, opts), confirm(opts),
 *         api, setDirty(bool), setBreadcrumb(extra) }   (+ listEvents / refreshEvents / onEventsChanged, used by the shell views)
 */
import { api, getToken, clearToken, onUnauthorized } from '../shared/js/api.js';
import { initTheme } from '../shared/js/theme.js';
import { applyBranding } from '../shared/js/branding.js';
import { el, icon, hydrateIcons } from '../shared/js/dom.js';
import { toast, announce } from '../shared/js/ui.js';
import { createShell } from './core/shell.js';
import { confirmDialog, confirmLeave } from './core/dialogs.js';
import { TABS, TAB_IDS, errorText } from './core/util.js';
import { copyLink, openNewEventDialog } from './core/event-actions.js';
import login from './views/login.js';

const APP_NAME = 'Quiz Admin';
const appRoot = document.getElementById('app');

const state = {
  user: null,
  events: null,            // EventAdmin[] (list cache, feeds the switcher and the nav badges)
  eventsPromise: null,
  event: null,             // the event of the current route
  seq: 0,                  // navigation sequence: stale async work checks it
  mounted: null,           // the mounted view { name, root, tab, instance, alive, subs, ctx }
  dirty: false,
  forceLeave: false,
  shell: null,
  returnTo: null,
  committedHash: '',
  target: null,            // { id, tab } of the event route being shown
  navAbort: null,
  firstRender: true,
  eventSubs: new Set(),    // onEventChanged callbacks of the mounted view
  eventsSubs: new Set(),
  moduleFailures: new Map(),
  moduleUrls: new Map(),
};

// ---------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------
initTheme({ defaultTheme: 'system' });
applyBranding({ default_theme: 'system' }, { title: false });
document.documentElement.lang = 'en';

let lastExpiry = 0;
onUnauthorized(() => {
  if (Date.now() - lastExpiry < 2500) return;     // several requests in flight fail together: react once
  lastExpiry = Date.now();
  toast('Your session has expired. Please sign in again.', { type: 'warning' });
  goLogin();
});
document.querySelector('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('main')?.focus(); });   // not a hash link: the hash is the router
window.addEventListener('hashchange', onHashChange);
// Escape closes an open menu even when it was opened with the mouse (the design system only listens while the focus is inside the menu)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  const open = document.querySelector('[data-dropdown-trigger][aria-expanded="true"]');
  if (open) { e.preventDefault(); open.click(); open.focus(); }
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

if (!getToken() && location.hash && !/^#\/?login/.test(location.hash)) state.returnTo = location.hash;
render();

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------
function parseHash(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return { name: 'events', redirect: '#/events' };
  if (parts[0] === 'login') return { name: 'login' };
  if (parts[0] !== 'events') return { redirect: '#/events' };
  if (parts.length === 1) return { name: 'events' };
  // plain decimal ids only (Number() would also accept 1e3, 0x10, " 7" and ids that stringify as 1e+21 into the API path)
  const id = /^\d{1,9}$/.test(parts[1]) ? Number(parts[1]) : 0;
  if (!Number.isInteger(id) || id <= 0) return { redirect: '#/events' };
  if (parts.length === 2) return { redirect: `#/events/${id}/overview` };
  if (!TAB_IDS.includes(parts[2])) return { redirect: '#/events' };
  return { name: 'event', id, tab: parts[2] };
}

function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (target === location.hash) {
    // Re-navigating to where we already are (event switcher, a "Retry" button) re-mounts the view: never throw away unsaved edits for that
    if (state.dirty) return;
    render({ force: true });
  } else location.hash = target;
}

async function onHashChange() {
  const next = location.hash;
  if (next === state.committedHash) return;
  if (state.dirty && !onHashChange.leaving && !state.forceLeave) {
    // a hash change cannot be cancelled: restore the previous URL, ask, then replay the navigation
    onHashChange.leaving = true;
    history.replaceState(history.state, '', state.committedHash || '#/events');
    const ok = await confirmLeave();
    onHashChange.leaving = false;
    if (!ok) return;
    state.dirty = false;
    location.hash = next;
    return;
  }
  state.forceLeave = false;
  render();
}

function goLogin() {
  state.user = null; state.events = null; state.event = null; state.dirty = false;
  clearToken();
  if (!/^#\/?login/.test(location.hash)) state.returnTo = location.hash && location.hash !== '#/' ? location.hash : state.returnTo;
  if (location.hash === '#/login') render({ force: true });
  else location.hash = '#/login';
}

async function logout() {
  if (state.dirty && !(await confirmLeave())) return;
  try { await api.post('/auth/logout'); } catch { /* stateless token: nothing to revoke server side */ }
  clearToken();
  state.returnTo = null;
  state.user = null; state.events = null; state.event = null; state.dirty = false;
  toast('You have been signed out.', { type: 'info', duration: 3000 });
  if (location.hash === '#/login') render({ force: true });
  else location.hash = '#/login';
}

async function render({ force = false } = {}) {
  let route = parseHash(location.hash);
  if (route.redirect) { history.replaceState(null, '', route.redirect); route = parseHash(location.hash); }
  const authed = !!getToken();
  if (!authed && route.name !== 'login') {
    if (location.hash && !/^#\/?login/.test(location.hash)) state.returnTo = location.hash;
    history.replaceState(null, '', '#/login'); route = { name: 'login' };
  } else if (authed && route.name === 'login') {
    history.replaceState(null, '', state.returnTo || '#/events'); state.returnTo = null; route = parseHash(location.hash);
  }
  state.committedHash = location.hash;
  // same event + same tab (only the hash tail changed, e.g. a view's own sub-state): the view handles it, we do not remount
  if (!force && route.name === 'event' && state.target && state.target.id === route.id && state.target.tab === route.tab) return;
  const seq = ++state.seq;
  state.navAbort?.abort();                      // in-flight loads of a superseded navigation are cancelled
  state.navAbort = new AbortController();
  state.target = route.name === 'event' ? { id: route.id, tab: route.tab } : null;
  if (route.name === 'login') return showLogin(seq);
  return showApp(route, seq);
}

// ---------------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------------
async function showLogin(seq) {
  await unmountView();
  if (seq !== state.seq) return;
  state.shell?.dispose(); state.shell = null; state.event = null;
  document.title = `Sign in · ${APP_NAME}`;
  const root = el('div', { class: 'view view--login' });
  appRoot.replaceChildren(root);
  const { ctx, mount } = makeCtx({ scope: 'login' });
  ctx.loggedIn = (username) => {
    state.user = username;
    const to = state.returnTo || '#/events';
    state.returnTo = null;
    navigate(to);
  };
  state.mounted = { name: 'login', root, ctx, mount, instance: null, alive: true, subs: mount.subs };
  state.mounted.instance = (await login.mount(root, ctx)) || {};
  hydrateIcons(root);
}

// ---------------------------------------------------------------------------------------------
// the application (shell + view)
// ---------------------------------------------------------------------------------------------
function ensureShell() {
  if (state.shell) return state.shell;
  const shell = createShell({
    navigate, logout,
    newEvent: () => openNewEventDialog(baseCtx),
    copyLink: (url, what) => copyLink(baseCtx, url, what),
  });
  state.shell = shell;
  appRoot.replaceChildren(shell.root);
  shell.hydrate();
  if (state.user) shell.setUser(state.user);
  if (state.events) shell.setEvents(state.events);
  return shell;
}

async function loadUser(seq) {
  try {
    const me = await api.get('/auth/me');
    state.user = me?.username || 'admin';
    state.shell?.setUser(state.user);
    return true;
  } catch (e) {
    if (seq !== state.seq || e.isUnauthorized) return false;
    renderFatal(e);
    return false;
  }
}

async function showApp(route, seq) {
  if (!state.user) {
    // validate the stored token once (a tampered / expired one lands on the login screen through onUnauthorized)
    if (!appRoot.firstElementChild || appRoot.firstElementChild.classList.contains('view--login')) appRoot.replaceChildren(bootSplash());
    if (!(await loadUser(seq))) return;
    if (seq !== state.seq) return;
  }
  const shell = ensureShell();
  if (!state.events) refreshEvents().catch(() => {});
  shell.closeDrawer();
  if (route.name === 'events') return showEvents(shell, seq);
  return showEventTab(shell, route, seq);
}

async function showEvents(shell, seq) {
  state.event = null;
  shell.setRoute({ name: 'events' }, null);
  const { ctx, mount } = makeCtx({ scope: 'global' });
  await mountView(shell, 'events', ctx, mount, seq, { title: 'Events', page: 'Events' });
}

async function showEventTab(shell, route, seq) {
  const cached = state.events?.find((e) => e.id === route.id) || (state.event?.id === route.id ? state.event : null);
  shell.setRoute({ name: 'event', tab: route.tab }, cached);

  const timer = setTimeout(() => { if (seq === state.seq) shell.host.replaceChildren(skeleton()); }, 140);
  let event;
  try {
    event = await api.get(`/admin/events/${route.id}`, { signal: state.navAbort.signal });
  } catch (e) {
    clearTimeout(timer);
    if (seq !== state.seq || e.isUnauthorized) return;
    await unmountView();
    state.event = null;
    shell.setRoute({ name: 'events' }, null);
    const notFound = e.isNotFound;
    document.title = `${notFound ? 'Event not found' : 'Could not load the event'} · ${APP_NAME}`;
    shell.host.replaceChildren(statusCard({
      icon: notFound ? 'magnifying-glass' : 'warning', title: notFound ? 'Event not found' : 'Could not load this event',
      text: notFound ? 'It may have been deleted, or the link is wrong.' : errorText(e),
      actions: [
        !notFound && el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => navigate(location.hash) } }, icon('arrow-clockwise'), 'Retry'),
        el('a', { class: 'btn btn--secondary', href: '#/events' }, icon('squares-four'), 'All events'),
      ],
    }));
    shell.focusView();
    return;
  }
  clearTimeout(timer);
  if (seq !== state.seq) return;
  state.event = event;
  patchEventsCache(event);
  shell.setRoute({ name: 'event', tab: route.tab }, event);

  const tab = TABS.find((t) => t.id === route.tab);
  const { ctx, mount } = makeCtx({ scope: 'event', eventId: event.id, event });
  await mountView(shell, route.tab, ctx, mount, seq, { title: tab.title, page: `${tab.title} · ${event.name}`, tab: route.tab });
}

// ---------------------------------------------------------------------------------------------
// view lifecycle
// ---------------------------------------------------------------------------------------------
async function loadViewModule(name) {
  const base = new URL(`./views/${name}.js`, import.meta.url).href;
  const tries = state.moduleFailures.get(name) || 0;
  // a failed dynamic import is cached by the browser for the page lifetime: retry under a fresh URL, then keep using the one that worked
  const url = state.moduleUrls.get(name) || (tries ? `${base}?retry=${tries}-${Date.now()}` : base);
  try {
    const mod = await import(url);
    const def = mod.default;
    if (!def || typeof def.mount !== 'function') throw new Error(`views/${name}.js must export default { mount(root, ctx) }`);
    state.moduleFailures.delete(name);
    state.moduleUrls.set(name, url);
    return def;
  } catch (err) {
    state.moduleFailures.set(name, tries + 1);
    let missing = false;
    try { missing = (await fetch(base, { method: 'HEAD', cache: 'no-store' })).status === 404; } catch { /* offline: not "missing" */ }
    if (missing) { const e = new Error(`views/${name}.js is not deployed`); e.code = 'VIEW_MISSING'; throw e; }
    throw err;
  }
}

async function mountView(shell, name, ctx, mount, seq, { title, page, tab = null }) {
  await unmountView();
  if (seq !== state.seq) return;
  const root = el('div', { class: 'view', dataset: { view: name } }, skeleton());   // shown while the module is fetched
  shell.host.replaceChildren(root);
  const entry = { name, root, tab, ctx, mount, instance: null, alive: true, subs: mount.subs };

  let def;
  try { def = await loadViewModule(name); }
  catch (err) { if (seq === state.seq) showViewError(shell, root, name, title, err); return; }
  if (seq !== state.seq) return;
  root.replaceChildren();                                  // the view starts from an empty root

  state.mounted = entry;
  try {
    entry.instance = (await def.mount(root, ctx)) || {};
  } catch (err) {
    console.error(`[admin] view "${name}" failed to mount`, err);
    await teardown(entry, { keepRoot: true });          // release what the view registered before it threw
    root.replaceChildren();
    if (seq === state.seq) { shell.host.replaceChildren(root); showViewError(shell, root, name, title, err); }
    return;
  }
  if (seq !== state.seq || state.mounted !== entry) { await teardown(entry); return; }

  hydrateIcons(root);
  document.title = `${page} · ${APP_NAME}`;
  if (!state.firstRender) {
    announce(`${page}`);
    const ae = document.activeElement;
    if (!ae || ae === document.body || !shell.main.contains(ae)) shell.focusView();
  }
  state.firstRender = false;
}

async function teardown(entry, { keepRoot = false } = {}) {
  entry.alive = false;
  entry.mount.alive = false;
  try { await entry.instance?.unmount?.(); } catch (e) { console.error('[admin] unmount failed', e); }
  entry.subs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  entry.subs.clear();
  if (!keepRoot) entry.root.remove();
  if (state.mounted === entry) state.mounted = null;
}

async function unmountView() {
  const m = state.mounted;
  state.dirty = false;
  state.eventSubs.clear(); state.eventsSubs.clear();
  state.shell?.setBreadcrumb(null);
  if (m) await teardown(m);
}

function showViewError(shell, root, name, title, err) {
  const missing = err?.code === 'VIEW_MISSING';
  const retry = el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => navigate(location.hash) } }, icon('arrow-clockwise'), 'Retry');
  const back = state.event ? el('a', { class: 'btn btn--secondary', href: `#/events/${state.event.id}/overview` }, icon('chart-bar'), 'Back to overview') : el('a', { class: 'btn btn--secondary', href: '#/events' }, icon('squares-four'), 'All events');
  root.replaceChildren(statusCard({
    icon: missing ? 'puzzle-piece' : 'warning',
    title: missing ? `${title} is not available yet` : `${title} could not be displayed`,
    text: missing ? 'This part of the console has not been deployed in this build. Try again in a moment.' : `${errorText(err, 'An unexpected error occurred.')} The rest of the console keeps working.`,
    actions: [retry, name === 'overview' ? null : back],
    detail: missing ? null : String(err?.message || err),
  }));
  hydrateIcons(root);
  if (!state.firstRender) shell.focusView();
  state.firstRender = false;
  document.title = `${title} · ${APP_NAME}`;
}

// ---------------------------------------------------------------------------------------------
// data: events list + current event
// ---------------------------------------------------------------------------------------------
function notify(set, arg) { for (const cb of [...set]) { try { cb(arg); } catch (e) { console.error(e); } } }

function refreshEvents() {
  if (state.eventsPromise) return state.eventsPromise;
  state.eventsPromise = api.get('/admin/events').then((list) => {
    state.events = list;
    state.shell?.setEvents(list);
    if (state.event) {
      const fresh = list.find((e) => e.id === state.event.id);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.event)) {
        state.event = fresh;
        state.shell?.setEvent(fresh);
        notify(state.eventSubs, fresh);
      }
    }
    notify(state.eventsSubs, list);
    return list;
  }).finally(() => { state.eventsPromise = null; });
  return state.eventsPromise;
}
const listEvents = ({ force = false } = {}) => (state.events && !force ? Promise.resolve(state.events) : refreshEvents());

function patchEventsCache(event) {
  if (!state.events) return;
  const i = state.events.findIndex((e) => e.id === event.id);
  if (i >= 0) state.events[i] = event; else state.events.unshift(event);
  state.shell?.setEvents(state.events);
}

async function reloadEvent(id) {
  let event;
  try { event = await api.get(`/admin/events/${id}`); }
  catch (e) { if (e?.isNotFound) eventGone(id); throw e; }
  if (state.event?.id === id) {
    state.event = event;
    patchEventsCache(event);
    state.shell?.setEvent(event);
    notify(state.eventSubs, event);
  }
  return event;
}

// ---------------------------------------------------------------------------------------------
// the current event disappeared (deleted from another browser, another admin, a script)
// ---------------------------------------------------------------------------------------------
let goneAt = 0;
function eventGone(id) {
  if (!state.event || state.event.id !== id || Date.now() - goneAt < 3000) return;
  goneAt = Date.now();
  state.dirty = false;                      // there is nothing left to save the edits to...
  state.forceLeave = true;                  // ...so the unsaved-changes guard must not hold the navigation back (a failing save re-arms it)
  toast('This event no longer exists: it was deleted elsewhere.', { type: 'warning' });
  state.events = null;
  refreshEvents().catch(() => {});
  navigate('#/events');
}
/** The api handed to the views: a 404 on the current event's own endpoints means it is gone, so leave its tabs instead of showing a broken page. */
function guardApi(raw) {
  const wrap = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) {
      if (e?.isNotFound && state.event && new RegExp(`/admin/events/${state.event.id}(?:/|\\?|$)`).test(e.url || '')) eventGone(state.event.id);
      throw e;
    }
  };
  return { ...raw, get: wrap(raw.get), post: wrap(raw.post), put: wrap(raw.put), patch: wrap(raw.patch), delete: wrap(raw.delete), upload: wrap(raw.upload), download: wrap(raw.download) };
}

// ---------------------------------------------------------------------------------------------
// ctx
// ---------------------------------------------------------------------------------------------
/** Context for helpers that live outside any view (shell menus, the "new event" dialog). */
const baseCtx = {
  api: guardApi(api), navigate,
  toast: (message, opts) => toast(message, opts),
  confirm: confirmDialog,
  listEvents, refreshEvents, peekEvents: () => state.events,
};

function makeCtx({ scope, eventId = null, event = null }) {
  const mount = { alive: true, subs: new Set(), event };
  const live = (fn) => (...args) => (mount.alive ? fn(...args) : undefined);
  const ctx = {
    ...baseCtx,
    setDirty: live((v) => { state.dirty = !!v; }),
    setBreadcrumb: live((extra) => state.shell?.setBreadcrumb(extra)),
    onEventsChanged(cb) { state.eventsSubs.add(cb); const off = () => state.eventsSubs.delete(cb); mount.subs.add(off); return off; },
  };
  if (scope === 'event') {
    Object.assign(ctx, {
      eventId,
      // the live event while we are on its route; the last known one if a view still asks during a navigation
      getEvent: () => { if (state.event?.id === eventId) mount.event = state.event; return mount.event; },
      reloadEvent: () => reloadEvent(eventId),
      onEventChanged(cb) { state.eventSubs.add(cb); const off = () => state.eventSubs.delete(cb); mount.subs.add(off); return off; },
    });
  }
  return { ctx, mount };
}

// ---------------------------------------------------------------------------------------------
// small renderers
// ---------------------------------------------------------------------------------------------
function skeleton() {
  return el('div', { class: 'view-skeleton', role: 'status', 'aria-label': 'Loading' },
    el('span', { class: 'skeleton skeleton--title' }), el('span', { class: 'skeleton skeleton--text', style: { inlineSize: '38%' } }),
    el('div', { class: 'stats u-mt-6' }, ...[0, 1, 2, 3].map(() => el('span', { class: 'skeleton skeleton--card', style: { blockSize: '6.5rem' } }))),
    el('span', { class: 'skeleton skeleton--card u-mt-6', style: { blockSize: '15rem' } }));
}

function statusCard({ icon: iconName, title, text, actions = [], detail }) {
  return el('div', { class: 'view-error' },
    el('div', { class: 'empty card' },
      el('div', { class: 'empty__icon' }, icon(iconName)),
      el('h1', { class: 'empty__title' }, title),
      el('p', { class: 'empty__text' }, text),
      detail ? el('p', { class: 'view-error__detail' }, el('code', null, detail)) : null,
      el('div', { class: 'empty__actions' }, ...actions.filter(Boolean))));
}

function bootSplash() {
  return el('div', { class: 'boot', role: 'status', 'aria-label': 'Loading' }, el('div', { class: 'spinner' }));
}

/** Server unreachable at start-up: a retry screen instead of a blank page. */
function renderFatal(err) {
  state.shell?.dispose(); state.shell = null;
  const card = statusCard({
    icon: 'wifi-slash', title: 'Cannot reach the server', text: errorText(err),
    actions: [el('button', { type: 'button', class: 'btn btn--primary', on: { click: () => { appRoot.replaceChildren(bootSplash()); render({ force: true }); } } }, icon('arrow-clockwise'), 'Retry')],
  });
  appRoot.replaceChildren(el('div', { class: 'boot' }, card));
  hydrateIcons(appRoot);
  appRoot.querySelector('h1')?.focus?.();
}
