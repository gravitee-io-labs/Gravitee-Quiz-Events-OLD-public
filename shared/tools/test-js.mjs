#!/usr/bin/env node
// Behavioural tests of the shared JS modules, run in a real Chromium against the styleguide (needs the static server + e2e/ Playwright):
//   cd <repo> && python3 -m http.server 8300 &   node shared/tools/test-js.mjs [--base http://localhost:8300]
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(join(here, '..', '..', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs')).href);
const args = process.argv.slice(2);
const BASE = args[args.indexOf('--base') + 1] || 'http://localhost:8300';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference', locale: 'fr-FR' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });

// ---- mock API (also used to test retry / headers / SSE reconnect) ---------------------------------
const calls = [];
let flaky = 0, sseHits = 0;
await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  calls.push({ method: req.method(), path: url.pathname + url.search, auth: req.headers()['authorization'] || null });
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const p = url.pathname;
  if (p === '/api/ok') return json(200, { ok: true });
  if (p === '/api/flaky') { flaky++; return flaky < 3 ? json(503, { detail: 'busy' }) : json(200, { n: flaky }); }
  if (p === '/api/post-503') return json(503, { detail: 'busy' });
  if (p === '/api/closed') return json(403, { detail: 'event_closed' });
  if (p === '/api/invalid') return json(422, { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'value_error' }] });
  if (p === '/api/unauth') return json(401, { detail: 'Invalid token' });
  if (p === '/api/nocontent') return route.fulfill({ status: 204 });
  if (p === '/api/slow') { await new Promise((r) => setTimeout(r, 1500)); return json(200, {}); }
  if (p === '/api/csv') return route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'content-disposition': 'attachment; filename="leads.csv"' }, body: 'a,b\n1,2\n' });
  if (p === '/api/stream') {
    sseHits++;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body: `data: {"entries":[],"total_players":${sseHits},"total_games":0}\n\n` });
  }
  return json(404, { detail: 'not found' });
});

await page.goto(`${BASE}/shared/styleguide.html`, { waitUntil: 'networkidle' });

const results = await page.evaluate(async () => {
  const out = [];
  const t = (name, ok, extra = '') => out.push({ name, ok: !!ok, extra: ok ? '' : String(extra).slice(0, 240) });
  const eq = (name, a, b) => t(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  const base = '/shared/js/';
  const dom = await import(base + 'dom.js');
  const { createI18n } = await import(base + 'i18n.js');
  const { api, ApiError, openEventSource, apiUrl, setToken, getToken, onUnauthorized } = await import(base + 'api.js');
  const theme = await import(base + 'theme.js');
  const branding = await import(base + 'branding.js');
  const ui = await import(base + 'ui.js');
  const fx = await import(base + 'effects.js');
  const qr = await import(base + 'qr.js');
  const cfg = await import(base + 'config.js');
  const color = await import(base + 'color.js');

  // ---------- dom
  const evil = dom.el('div', { class: ['a', { b: true, c: false }], dataset: { id: 7 }, aria: { label: 'x' }, style: { '--v': 3 } }, '<img src=x onerror=alert(1)>', 42, null, false, [dom.el('b', null, 'in')]);
  t('el: text is escaped (no HTML injection)', evil.querySelector('img') === null && evil.textContent.includes('<img src=x'));
  eq('el: class/dataset/aria/custom property', [evil.className, evil.dataset.id, evil.getAttribute('aria-label'), evil.style.getPropertyValue('--v')], ['a b', '7', 'x', '3']);
  const svgIcon = dom.icon('trophy', { size: 'lg', label: 'Winner' });
  t('icon: svg + use href resolved from import.meta.url', svgIcon.namespaceURI.includes('svg') && svgIcon.querySelector('use').getAttribute('href').endsWith('/shared/icons/sprite.svg#trophy') && svgIcon.getAttribute('role') === 'img' && svgIcon.classList.contains('icon--lg'));
  eq('initials', [dom.initials('Jean-Pierre Dupont'), dom.initials('alex'), dom.initials(''), dom.initials('élodie  Ñuñez')], ['JD', 'A', '?', 'ÉÑ']);
  eq('slugify', dom.slugify('World AI Summit – Amsterdam 2026'), 'world-ai-summit-amsterdam-2026');
  eq('formatDuration', [dom.formatDuration(75), dom.formatDuration(3723)], ['1:15', '1:02:03']);
  eq('formatNumber en/fr', [dom.formatNumber(1234.5, { lang: 'en' }), dom.formatNumber(1234.5, { lang: 'fr' }).replace(/\s/g, ' ')], ['1,234.5', '1 234,5']);
  t('escapeHtml', dom.escapeHtml('<a href="x">&\'</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  const host = document.createElement('div'); host.innerHTML = '<span data-icon="check" data-icon-size="sm"></span>'; document.body.append(host); dom.hydrateIcons(host);
  t('hydrateIcons', host.querySelector('svg.icon.icon--sm use'));
  host.remove();
  let n = 0; const d = dom.debounce(() => n++, 30); d(); d(); d(); await dom.sleep(80); eq('debounce', n, 1);

  // ---------- i18n
  localStorage.removeItem('quiz.lang');
  const dict = { en: { hello: 'Hello {name}', nested: { k: 'Nested' }, 'flat.key': 'Flat', n_one: '{count} item', n_other: '{count} items' }, fr: { hello: 'Bonjour {name}', n_one: '{count} élément', n_other: '{count} éléments' } };
  const i = createI18n({ dictionaries: dict, fallback: 'en', autoApply: false });
  eq('i18n: browser language fr-FR picked when nothing else', i.lang, 'fr');
  eq('i18n: t + interpolation', i.t('hello', { name: 'Ada' }), 'Bonjour Ada');
  eq('i18n: fallback to en for missing fr key + nested + flat', [i.t('nested.k'), i.t('flat.key'), i.t('nope.key')], ['Nested', 'Flat', 'nope.key']);
  eq('i18n: plural', [i.t('n', { count: 1 }), i.t('n', { count: 3 })], ['1 élément', '3 éléments']);
  i.setEventDefault('en'); eq('i18n: event default beats browser', i.lang, 'en');
  i.setLang('fr'); eq('i18n: user choice persisted + wins over event default', [i.lang, localStorage.getItem('quiz.lang'), document.documentElement.lang], ['fr', 'fr', 'fr']);
  eq('i18n: pick', [i.pick({ name: 'Cats', name_fr: 'Chats' }, 'name'), i.pick({ name: 'Cats', name_fr: '  ' }, 'name'), i.pick({ tagline_en: 'EN', tagline_fr: 'FR' }, 'tagline'), i.pick({ tagline_en: 'EN', tagline_fr: null }, 'tagline')], ['Chats', 'Cats', 'FR', 'EN']);
  i.setSupported(['en']); eq('i18n: unsupported stored language is ignored', i.lang, 'en');
  i.setSupported(['en', 'fr']);
  history.replaceState(null, '', '?lang=en'); i.resolve(); eq('i18n: ?lang= beats localStorage', i.lang, 'en'); history.replaceState(null, '', location.pathname);
  const probe = document.createElement('div'); probe.innerHTML = '<p data-i18n="hello" data-i18n-params=\'{"name":"Bob"}\'></p><input data-i18n-attr="placeholder:hello; aria-label:nested.k" data-i18n-params=\'{"name":"Z"}\'>'; i.setLang('fr', { persist: false }); i.apply(probe);
  eq('i18n: apply text + attrs', [probe.querySelector('p').textContent, probe.querySelector('input').placeholder, probe.querySelector('input').getAttribute('aria-label')], ['Bonjour Bob', 'Bonjour Z', 'Nested']);
  localStorage.removeItem('quiz.lang');

  // ---------- theme
  localStorage.removeItem('quiz.theme');
  theme.setTheme(null); theme.setEventDefaultTheme('light');
  eq('theme: event default applies when user has not chosen', [document.documentElement.dataset.theme, theme.hasUserChoice()], ['light', false]);
  theme.setTheme('dark'); theme.setEventDefaultTheme('light');
  eq('theme: user choice persisted and beats event default', [document.documentElement.dataset.theme, localStorage.getItem('quiz.theme')], ['dark', 'dark']);
  theme.setTheme('light', { persist: false });
  eq('theme: non persisted override', [document.documentElement.dataset.theme, localStorage.getItem('quiz.theme')], ['light', 'dark']);
  theme.setTheme('system'); t('theme: system resolves to dark|light', ['dark', 'light'].includes(document.documentElement.dataset.theme));
  let seen = null; const off = theme.onThemeChange((x) => { seen = x; }); theme.setTheme('dark'); off();
  eq('theme: onThemeChange', seen, { preference: 'dark', resolved: 'dark' });
  theme.setTheme(null); theme.setEventDefaultTheme('dark');

  // ---------- branding
  const r = branding.applyBranding({ name: 'World AI Summit', game_title: 'AI Masters', branding: { primary_color: '#7C5CFF', accent_color: '#22D3EE', background_style: 'grid', default_theme: 'dark' } });
  const root = document.documentElement;
  eq('branding: raw colours + data-bg + title', [root.style.getPropertyValue('--brand'), root.style.getPropertyValue('--brand-accent'), root.dataset.bg, document.title], ['#7C5CFF', '#22D3EE', 'grid', 'AI Masters · World AI Summit']);
  t('branding: derived roles set for both themes', ['--brand-solid-d', '--brand-solid-l', '--on-brand-d', '--brand-text-l', '--green-d', '--red-l', '--aurora-strength-d'].every((k) => root.style.getPropertyValue(k)));
  t('branding: theme-color meta + favicon', document.querySelector('meta[name="theme-color"]')?.content.startsWith('#') && document.querySelector('link#quiz-favicon')?.href.startsWith('data:image/svg+xml'));
  const cs = getComputedStyle(root);
  t('branding: tokens.css maps themed role per data-theme', (theme.setTheme('light', { persist: false }), cs.getPropertyValue('--brand-solid').trim().toUpperCase() === root.style.getPropertyValue('--brand-solid-l').toUpperCase()) && (theme.setTheme('dark', { persist: false }), cs.getPropertyValue('--brand-solid').trim().toUpperCase() === root.style.getPropertyValue('--brand-solid-d').toUpperCase()));
  const card = document.createElement('div'); document.body.append(card);
  branding.applyBranding({ branding: { primary_color: '#FFD60A', accent_color: '#FF006E' } }, { root: card });
  eq('branding: scoped root gets brand-scope + own tokens, document untouched', [card.hasAttribute('data-brand-scope'), getComputedStyle(card).getPropertyValue('--brand-solid').trim().toUpperCase(), root.style.getPropertyValue('--brand')], [true, card.style.getPropertyValue('--brand-solid-d').toUpperCase(), '#7C5CFF']);
  card.remove();
  const bad = branding.computeBrandTokens('not a colour', undefined);
  eq('branding: invalid input falls back to Gravitee orange', bad.brand, '#FC5607');
  branding.applyBranding(null); eq('branding: null = defaults', root.style.getPropertyValue('--brand'), '#FC5607');
  eq('branding: setDocumentTitle', [branding.setDocumentTitle({ game_title: 'API Masters', name: 'API Masters' }), branding.setDocumentTitle({ game_title: 'AI Masters', name: 'Summit' }, 'Scoreboard')], ['API Masters', 'Scoreboard · AI Masters · Summit']);
  t('color: contrast(black, white) = 21', Math.abs(color.contrast('#000', '#fff') - 21) < 0.01);

  // ---------- config + api
  eq('config: defaults', [cfg.config.apiBase, cfg.eventUrl('ai-masters', { lang: 'fr' }).endsWith('/ai-masters?lang=fr')], ['/api', true]);
  eq('apiUrl', apiUrl('/events/x', { limit: 10, q: '', z: undefined }), '/api/events/x?limit=10');
  localStorage.removeItem('quiz.admin.token');
  eq('api.get ok', await api.get('/ok'), { ok: true });
  eq('api.get retries 503 with backoff then succeeds', (await api.get('/flaky')).n, 3);
  let e1; try { await api.post('/post-503', {}); } catch (e) { e1 = e; }
  t('api.post: ApiError(503), not retried', e1 instanceof ApiError && e1.status === 503 && e1.detail === 'busy' && e1.isServer);
  let e2; try { await api.get('/closed'); } catch (e) { e2 = e; }
  eq('ApiError code/detail/isForbidden', [e2.status, e2.detail, e2.code, e2.isForbidden], [403, 'event_closed', 'event_closed', true]);
  let e3; try { await api.post('/invalid', {}); } catch (e) { e3 = e; }
  eq('ApiError 422 fieldErrors', [e3.status, e3.fieldErrors], [422, { email: 'value is not a valid email address' }]);
  eq('api 204 -> null', await api.delete('/nocontent'), null);
  let e4; try { await api.get('/slow', { timeout: 200, retries: 0 }); } catch (e) { e4 = e; }
  t('api timeout -> ApiError(-1)', e4 instanceof ApiError && e4.isTimeout);
  setToken('abc.def.ghi'); await api.get('/ok'); await api.get('/ok', { auth: false });
  let unauth = 0; onUnauthorized(() => { unauth++; });
  let e5; try { await api.get('/unauth'); } catch (e) { e5 = e; }
  eq('api 401 with token: ApiError, token cleared, listener fired', [e5.isUnauthorized, getToken(), unauth], [true, null, 1]);
  const names = new Set();
  const origCreate = URL.createObjectURL; URL.createObjectURL = (b) => { names.add(b.size); return origCreate(b); };
  const fname = await api.download('/csv'); URL.createObjectURL = origCreate;
  eq('api.download uses Content-Disposition filename', fname, 'leads.csv');

  // ---------- SSE reconnect
  const statuses = []; const msgs = [];
  const es = openEventSource(apiUrl('/stream', { limit: 3 }), { minDelay: 50, maxDelay: 200, onStatus: (s) => statuses.push(s), onMessage: (m) => msgs.push(m.total_players) });
  await dom.sleep(1200); es.close();
  t('SSE: parses messages and reconnects after the stream ends', msgs.length >= 2 && msgs[1] > msgs[0], JSON.stringify(msgs));
  t('SSE: status sequence includes connecting/open/reconnecting/closed', ['connecting', 'open', 'reconnecting', 'closed'].every((s) => statuses.includes(s)), statuses.join());

  // ---------- ui: toast, dialogs, tabs, dropdown
  const tt = ui.toast('Hello toast', { type: 'success', duration: 0 });
  t('toast: rendered in live region', document.querySelector('.toast-region[aria-live] .toast--success .toast__title')?.textContent === 'Hello toast');
  tt.dismiss(); await dom.sleep(500); t('toast: dismissed', !document.querySelector('.toast--success'));
  const p1 = ui.confirmDialog({ title: 'Delete?', message: 'Sure?', tone: 'danger', confirmLabel: 'Yes' });
  await dom.sleep(50);
  const dlg = document.querySelector('dialog.dialog[open]');
  t('confirmDialog: native dialog open, focus on the safe button for danger', dlg && document.activeElement.textContent === 'Cancel', document.activeElement?.textContent);
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Yes').click();
  eq('confirmDialog resolves true', await p1, true);
  t('dialog removed from DOM after close', !document.querySelector('dialog.dialog'));
  const p2 = ui.confirmDialog({ title: 'x' }); await dom.sleep(30);
  document.querySelector('dialog.dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })); document.querySelector('dialog.dialog[open]').close();
  eq('confirmDialog resolves false when dismissed', await p2, false);
  const m = ui.openModal({ title: 'Form', content: dom.el('input', { class: 'input', id: 'm-in' }), actions: [{ label: 'Save', variant: 'primary', value: { saved: 1 } }] });
  await dom.sleep(30); t('openModal: first input focused', document.activeElement?.id === 'm-in', document.activeElement?.tagName);
  [...document.querySelectorAll('dialog .btn--primary')].find((b) => b.textContent === 'Save').click();
  eq('openModal resolves with the action value', await m.closed, { saved: 1 });

  const tabsRoot = document.createElement('div');
  tabsRoot.innerHTML = '<div role="tablist"><button role="tab" id="ta" aria-controls="pa" aria-selected="true">A</button><button role="tab" id="tb" aria-controls="pb" aria-selected="false">B</button></div><div id="pa" role="tabpanel">a</div><div id="pb" role="tabpanel">b</div>';
  document.body.append(tabsRoot); ui.initTabs(tabsRoot);
  const ta = tabsRoot.querySelector('#ta'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  eq('tabs: arrow key selects next, panel visibility, roving tabindex', [tabsRoot.querySelector('#tb').getAttribute('aria-selected'), tabsRoot.querySelector('#pa').hidden, tabsRoot.querySelector('#pb').hidden, tabsRoot.querySelector('#ta').tabIndex, document.activeElement.id], ['true', true, false, -1, 'tb']);
  tabsRoot.remove();
  const dd = document.createElement('div');
  dd.innerHTML = '<div class="dropdown"><button data-dropdown-trigger aria-haspopup="menu" aria-expanded="false">Go</button><div class="menu" role="menu" hidden><button class="menu__item" role="menuitem">One</button><button class="menu__item" role="menuitem">Two</button></div></div>';
  document.body.append(dd); const offDd = ui.initDropdowns(dd);
  const trig = dd.querySelector('[data-dropdown-trigger]'); trig.click();
  eq('dropdown: opens', [trig.getAttribute('aria-expanded'), dd.querySelector('.menu').hidden], ['true', false]);
  dd.querySelector('.menu__item').focus(); dd.querySelector('.menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  eq('dropdown: ArrowDown moves focus', document.activeElement.textContent, 'Two');
  dd.querySelector('.menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  eq('dropdown: Escape closes and returns focus', [trig.getAttribute('aria-expanded'), document.activeElement === trig], ['false', true]);
  offDd(); dd.remove();
  const ci = document.createElement('div'); ci.innerHTML = '<div class="color-input"><input type="color" class="color-input__swatch" value="#ff0000"><input class="input color-input__hex" value="#FF0000"></div>'; document.body.append(ci); ui.initColorInputs(ci);
  const hexIn = ci.querySelector('.color-input__hex'); hexIn.value = '#0af'; hexIn.dispatchEvent(new Event('input', { bubbles: true })); hexIn.dispatchEvent(new Event('change', { bubbles: true }));
  eq('colour input: hex shorthand syncs swatch + normalises', [ci.querySelector('.color-input__swatch').value, hexIn.value], ['#00aaff', '#00AAFF']);
  hexIn.value = 'zzz'; hexIn.dispatchEvent(new Event('input', { bubbles: true })); eq('colour input: invalid flagged', hexIn.getAttribute('aria-invalid'), 'true'); ci.remove();
  ui.announce('Correct!'); await dom.sleep(120); eq('announce: aria-live region', [document.querySelector('#quiz-announcer')?.getAttribute('aria-live'), document.querySelector('#quiz-announcer')?.textContent], ['polite', 'Correct!']);

  // ---------- effects + qr
  const span = document.createElement('span'); document.body.append(span);
  await fx.countUp(span, 1340, { duration: 200 }).finished; eq('countUp ends on the exact value', span.textContent.replace(/\s/g, ' '), new Intl.NumberFormat(document.documentElement.lang || 'en').format(1340).replace(/\s/g, ' ')); span.remove();
  const c = fx.confetti({ count: 20, duration: 300 }); t('confetti: canvas created', document.querySelector('canvas[aria-hidden="true"][style*="fixed"]')); await c.finished; t('confetti: canvas removed when done', !document.querySelector('canvas[aria-hidden="true"][style*="fixed"]'));
  const q = qr.qrCode('https://quiz.events.gravitee.io/world-ai-summit-2026?lang=fr&x=é');
  const path = q.querySelector('svg path');
  t('qr: svg with a non-empty path, viewBox square', path && path.getAttribute('d').length > 200 && /^0 0 (\d+) \1$/.test(q.querySelector('svg').getAttribute('viewBox')), q.outerHTML.slice(0, 120));
  document.body.append(q);
  const bb = q.querySelector('svg').getBoundingClientRect(); t('qr: renders with size', bb.width > 100 && Math.abs(bb.width - bb.height) < 2, JSON.stringify(bb)); q.remove();
  return out;
});

let failed = 0;
for (const r of results) { if (!r.ok) { failed++; console.log(`  FAIL ${r.name}  ${r.extra}`); } }
console.log(`${results.length - failed}/${results.length} behaviour checks passed`);
if (pageErrors.length) { failed += pageErrors.length; console.log('  PAGE ERRORS:\n   ' + [...new Set(pageErrors)].join('\n   ')); }
await browser.close();
process.exit(failed ? 1 : 0);
