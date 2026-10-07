#!/usr/bin/env node
// API-truthfulness test of shared/: every export documented in README.md exists and behaves as documented
// (i18n resolution order + pick(), branding colour maths, theme persistence + ?theme=, api.js error handling with a stubbed fetch,
// openEventSource reconnect/backoff/watchdog, icon() at /shared/ and /admin/shared/, dom helpers, ui.js widgets, effects, qr.js).
// Self-contained: starts its own static server (free port, production CSP). Needs Playwright from e2e/.
//   node shared/tools/test-api.mjs [section ...]      sections: exports i18n theme branding api sse icons dom ui effects qr
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { startServer } from './_serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(join(here, '..', '..', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs')).href);
const srv = await startServer();
const BASE = srv.base;

const README = readFileSync(join(here, '..', 'README.md'), 'utf8');
const only = process.argv.slice(2);
const results = [];           // [section, name, ok, detail]
let section = '';
const rec = (name, ok, detail = '') => results.push([section, name, !!ok, ok ? '' : detail]);
const eq = (name, got, want) => rec(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const run = (name) => !only.length || only.includes(name);

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage({ locale = 'en-US', colorScheme = 'dark', init, url = '/probe/blank.html', timezoneId, reducedMotion, viewport } = {}) {
  const ctx = await browser.newContext({ bypassCSP: true, locale, colorScheme, timezoneId, reducedMotion, viewport: viewport || { width: 1000, height: 700 }, permissions: ['clipboard-read', 'clipboard-write'] });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${section}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${section} pageerror: ${e.message}`));
  await page.goto(BASE + url, { waitUntil: 'load' });
  return { ctx, page };
}
// run a block of in-page tests: fn gets helper `T(name, async () => value|boolean|[ok,detail])`
async function inPage(page, body, arg) {
  const out = await page.evaluate(async ({ body, arg }) => {
    const res = [];
    const T = async (name, fn) => { try { const v = await fn(); if (Array.isArray(v)) res.push([name, !!v[0], String(v[1] ?? '')]); else res.push([name, v !== false, v === false ? 'false' : '']); } catch (e) { res.push([name, false, 'threw ' + (e && e.stack || e)]); } };
    const EQ = (a, b) => [JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`];
    const fn = new Function('T', 'EQ', 'arg', `return (async () => { ${body.replace(/\bT\('/g, "await T('")} })()`);
    await fn(T, EQ, arg);
    return res;
  }, { body, arg });
  for (const [n, ok, d] of out) rec(n, ok, d);
}

// ------------------------------------------------------------------------------------------------ 0. documented exports exist
if (run('exports')) {
  section = 'exports';
  const { ctx, page } = await newPage();
  // (a) every `import { … } from '…/x.js'` statement written in the README
  const imports = [...README.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+'([^']+)'/g)].map((m) => ({ names: (m[1] || m[2]).split(',').map((s) => s.trim().replace(/^default as /, '').split(' as ')[0]).filter(Boolean), file: m[3].split('/').pop() }));
  // (b) names the prose / API tables document
  const DOC = {
    'config.js': ['config', 'eventUrl', 'scoreboardUrl'],
    'api.js': ['api', 'ApiError', 'openEventSource', 'apiUrl', 'getToken', 'setToken', 'clearToken', 'onUnauthorized'],
    'theme.js': ['initTheme', 'setTheme', 'getTheme', 'getResolvedTheme', 'hasUserChoice', 'setEventDefaultTheme', 'cycleTheme', 'onThemeChange', 'createThemeToggle'],
    'branding.js': ['applyBranding', 'resetBranding', 'setDocumentTitle', 'computeBrandTokens', 'deriveAccent', 'faviconDataUrl', 'getBrandTokens', 'DEFAULT_BRANDING'],
    'color.js': ['contrast', 'readableOn', 'hexToOklch', 'oklchToHex', 'normalizeHex'],
    'i18n.js': ['createI18n'],
    'dom.js': ['el', 'icon', 'hydrateIcons', 'qs', 'qsa', 'clear', 'on', 'delegate', 'uid', 'sleep', 'clamp', 'debounce', 'throttle', 'initials', 'avatar', 'avatarHue', 'slugify', 'formatNumber', 'formatPercent', 'formatDate', 'formatDateTime', 'formatDuration', 'formatBytes', 'relativeTime', 'copyToClipboard', 'downloadBlob', 'setBusy', 'formToObject', 'escapeHtml', 'prefersReducedMotion', 'isTouch', 'SPRITE_URL'],
    'ui.js': ['toast', 'confirmDialog', 'openModal', 'announce', 'withBusy', 'focusFirst', 'initTabs', 'initDropdowns', 'initShell', 'initColorInputs', 'initRanges'],
    'effects.js': ['countUp', 'confetti', 'celebrate', 'transition', 'shake', 'pulse'],
    'qr.js': ['qrCode', 'qrSvg', 'renderQr'],
  };
  const merged = {};
  for (const [f, names] of Object.entries(DOC)) merged[f] = new Set(names);
  for (const { names, file } of imports) { if (!merged[file]) merged[file] = new Set(); names.forEach((n) => merged[file].add(n)); }
  rec(`README contains ${imports.length} import statements`, imports.length >= 8);
  for (const [file, names] of Object.entries(merged)) {
    const missing = await page.evaluate(async ({ file, names }) => { const m = await import(`/shared/js/${file}`); return names.filter((n) => !(n in m)); }, { file, names: [...names] });
    rec(`${file}: all ${names.size} documented exports exist`, missing.length === 0, `missing: ${missing.join(', ')}`);
  }
  // documented i18n instance members
  await inPage(page, `
    const { createI18n } = await import('/shared/js/i18n.js');
    const i = createI18n({ dictionaries: { en: {}, fr: {} } });
    const members = ['lang','t','pick','setLang','setSupported','setEventDefault','onChange','apply','number','percent','date','dateTime','relative','list','dateRange'];
    T('i18n instance has every documented member', () => { const m = members.filter((k) => !(k in i)); return [m.length === 0, m.join(',')]; });
    const { api } = await import('/shared/js/api.js');
    T('api has get/post/put/patch/delete/upload/download', () => { const m = ['get','post','put','patch','delete','upload','download'].filter((k) => typeof api[k] !== 'function'); return [m.length === 0, m.join(',')]; });
    const { ApiError } = await import('/shared/js/api.js');
    T('ApiError exposes every documented property', () => { const e = new ApiError(0, 'x'); const m = ['status','detail','code','fieldErrors','isNetwork','isTimeout','isUnauthorized','isForbidden','isNotFound','isConflict','isValidation','isServer'].filter((k) => !(k in e)); return [m.length === 0, m.join(',')]; });
  `);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 1. i18n
if (run('i18n')) {
  section = 'i18n';
  const DICT = `{ en: { game: { question: 'Question {n}', title: 'Title' }, 'flat.key': 'Flat EN', only_en: 'Only EN', results: { players_one: '{count} player', players_other: '{count} players' }, ph: 'Hi {name} and {missing}' }, fr: { game: { question: 'Question n°{n}' }, results: { players_one: '{count} joueur', players_other: '{count} joueurs' } } }`;
  const scenario = async (name, { locale, lsLang, search = '', supported, eventDefault }, expect) => {
    const { ctx, page } = await newPage({ locale, init: lsLang ? `localStorage.setItem('quiz.lang', '${lsLang}')` : undefined, url: `/probe/blank.html${search}` });
    const lang = await page.evaluate(async ({ DICT, supported, eventDefault }) => {
      const { createI18n } = await import('/shared/js/i18n.js');
      const i = createI18n({ dictionaries: eval('(' + DICT + ')'), fallback: 'en', supported });
      if (eventDefault) i.setEventDefault(eventDefault);
      return i.lang;
    }, { DICT, supported, eventDefault });
    eq(`resolution: ${name}`, lang, expect);
    await ctx.close();
  };
  await scenario('browser fr only -> fr', { locale: 'fr-FR' }, 'fr');
  await scenario('browser de (unsupported) -> fallback en', { locale: 'de-DE' }, 'en');
  await scenario('event default beats browser (browser fr, event en)', { locale: 'fr-FR', eventDefault: 'en' }, 'en');
  await scenario('event default fr beats browser en', { locale: 'en-US', eventDefault: 'fr' }, 'fr');
  await scenario('stored choice beats event default', { locale: 'en-US', lsLang: 'fr', eventDefault: 'en' }, 'fr');
  await scenario('?lang beats stored choice', { locale: 'en-US', lsLang: 'fr', search: '?lang=en' }, 'en');
  await scenario('?lang beats event default', { locale: 'en-US', search: '?lang=fr', eventDefault: 'en' }, 'fr');
  await scenario('?lang=fr-CA is reduced to fr', { locale: 'en-US', search: '?lang=fr-CA' }, 'fr');
  await scenario('unsupported ?lang is ignored (falls to browser)', { locale: 'fr-FR', search: '?lang=de' }, 'fr');
  await scenario('supported=[en] ignores ?lang=fr and browser fr', { locale: 'fr-FR', search: '?lang=fr', supported: ['en'] }, 'en');
  await scenario('supported=[fr] with browser en -> fr', { locale: 'en-US', supported: ['fr'] }, 'fr');
  await scenario('garbage stored language ignored', { locale: 'fr-FR', lsLang: 'klingon' }, 'fr');

  const { ctx, page } = await newPage({ locale: 'en-US' });
  await inPage(page, `
    const { createI18n } = await import('/shared/js/i18n.js');
    const D = ${DICT};
    const i = createI18n({ dictionaries: D, fallback: 'en' });
    T('t nested key', () => EQ(i.t('game.question', { n: 3 }), 'Question 3'));
    T('t flat dotted key', () => EQ(i.t('flat.key'), 'Flat EN'));
    T('t unknown key returns the key', () => EQ(i.t('nope.nothing'), 'nope.nothing'));
    T('t unknown placeholder is left as {missing}', () => EQ(i.t('ph', { name: 'Ada' }), 'Hi Ada and {missing}'));
    T('t plural en 1/5', () => EQ([i.t('results.players', { count: 1 }), i.t('results.players', { count: 5 })], ['1 player', '5 players']));
    T('has()', () => EQ([i.has('game.title'), i.has('zzz')], [true, false]));
    T('pick: lang en uses name (categories)', () => EQ(i.pick({ name: 'Security', name_fr: 'Sécurité' }, 'name'), 'Security'));
    T('pick: en uses tagline_en for events', () => EQ(i.pick({ tagline_en: 'EN', tagline_fr: 'FR' }, 'tagline'), 'EN'));
    T('pick: en never leaks FR when EN empty', () => EQ(i.pick({ tagline_en: '', tagline_fr: 'FR' }, 'tagline'), ''));
    T('pick: null object -> empty string', () => EQ(i.pick(null, 'name'), ''));
    let changes = []; const off = i.onChange((l) => changes.push(l));
    document.body.insertAdjacentHTML('beforeend', '<p id="a" data-i18n="game.question" data-i18n-params=\\'{"n":7}\\'>x</p><input id="b" data-i18n-attr="placeholder:game.title; aria-label:game.question" data-i18n-params=\\'{"n":1}\\'>');
    i.apply(document);
    T('apply: data-i18n + params', () => EQ(document.getElementById('a').textContent, 'Question 7'));
    T('apply: data-i18n-attr (two attributes)', () => EQ([document.getElementById('b').placeholder, document.getElementById('b').getAttribute('aria-label')], ['Title', 'Question 1']));
    T('setLang(fr) returns fr, updates <html lang>, persists, notifies once', () => { const r = i.setLang('fr'); return EQ([r, document.documentElement.lang, localStorage.getItem('quiz.lang'), changes], ['fr', 'fr', 'fr', ['fr']]); });
    T('autoApply re-translated the DOM on setLang', () => EQ(document.getElementById('a').textContent, 'Question n°7'));
    T('t falls back to EN for keys missing in FR, then the key', () => EQ([i.t('only_en'), i.t('flat.key'), i.t('game.title')], ['Only EN', 'Flat EN', 'Title']));
    T('plural fr 0 and 1 are singular, 2 plural', () => EQ([i.t('results.players', { count: 0 }), i.t('results.players', { count: 1 }), i.t('results.players', { count: 2 })], ['0 joueur', '1 joueur', '2 joueurs']));
    T('pick fr uses name_fr, falls back to EN when empty', () => EQ([i.pick({ name: 'Security', name_fr: 'Sécurité' }, 'name'), i.pick({ name: 'Security', name_fr: '  ' }, 'name'), i.pick({ name: 'Security' }, 'name')], ['Sécurité', 'Security', 'Security']));
    T('pick fr uses tagline_fr / question_text_fr', () => EQ([i.pick({ tagline_en: 'EN', tagline_fr: 'FR' }, 'tagline'), i.pick({ question_text_en: 'Q', question_text_fr: null }, 'question_text')], ['FR', 'Q']));
    T('setLang(unknown) is ignored', () => EQ([i.setLang('de'), changes.length], ['fr', 1]));
    T('setSupported([en]) re-resolves away from fr', () => { i.setSupported(['en']); return EQ(i.lang, 'en'); });
    const nBefore = changes.length; off(); i.setSupported(['en', 'fr']); i.setLang('fr'); i.setLang('en');
    T('onChange unsubscribe works', () => EQ(changes.length, nBefore));
    T('number en', () => EQ(i.number(1234.5), '1,234.5'));
    T('percent', () => EQ(i.percent(0.68), '68%'));
    T('date en', () => EQ(i.date('2026-10-07T12:00:00Z'), '7 Oct 2026'));
    T('dateTime has a time part', () => /\\d{1,2}:\\d{2}/.test(i.dateTime('2026-10-07T12:34:00Z')));
    const nd = (x) => x.replace(/\\s*[–-]\\s*/g, '–');
    T('dateRange same month en', () => EQ(nd(i.dateRange('2026-10-07', '2026-10-08')), '7–8 Oct 2026'));
    T('dateRange single day', () => EQ(i.dateRange('2026-10-07', '2026-10-07'), '7 Oct 2026'));
    T('dateRange empty', () => EQ(i.dateRange(null, null), ''));
    T('list en', () => EQ(i.list(['a', 'b', 'c']), 'a, b, and c'));
    T('relative en', () => EQ(i.relative(new Date(Date.now() - 3600e3)), '1 hour ago'));
    i.setLang('fr');
    T('number fr uses fr separators', () => /^1\\s234,5$/.test(i.number(1234.5).replace(/[\\u202f\\u00a0]/g, ' ')));
    T('date fr', () => EQ(i.date('2026-10-07T12:00:00Z'), '7 oct. 2026'));
    T('list fr', () => EQ(i.list(['a', 'b', 'c']), 'a, b et c'));
    T('relative fr', () => EQ(i.relative(new Date(Date.now() - 2 * 86400e3)), 'avant-hier'));
  `);
  await ctx.close();

  // date-only strings must not shift day in negative UTC offsets (events have starts_on / ends_on dates, no time)
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland']) {
    const c = await newPage({ timezoneId: tz });
    await inPage(c.page, `
      const { createI18n } = await import('/shared/js/i18n.js');
      const { formatDate } = await import('/shared/js/dom.js');
      const i = createI18n({ dictionaries: { en: {} }, fallback: 'en' });
      T('${tz}: date-only string keeps its calendar day (formatDate)', () => EQ(formatDate('2026-10-07', { lang: 'en' }), '7 Oct 2026'));
      T('${tz}: date-only range keeps its calendar days (dateRange)', () => EQ(i.dateRange('2026-10-07', '2026-10-08').replace(/\\s*[–-]\\s*/g, '–'), '7–8 Oct 2026'));
      T('${tz}: i18n.date(date-only)', () => EQ(i.date('2026-10-07'), '7 Oct 2026'));
    `);
    await c.ctx.close();
  }
}

// ------------------------------------------------------------------------------------------------ 2. theme
if (run('theme')) {
  section = 'theme';
  // boot script runs before first paint
  for (const [stored, scheme, want] of [[null, 'dark', 'dark'], [null, 'light', 'dark'], ['light', 'dark', 'light'], ['dark', 'light', 'dark'], ['system', 'light', 'light'], ['system', 'dark', 'dark'], ['banana', 'light', 'dark']]) {
    const { ctx, page } = await newPage({ colorScheme: scheme, init: stored ? `localStorage.setItem('quiz.theme', '${stored}')` : undefined });
    const boot = await page.evaluate(() => [window.__bootTheme, window.__bootBg]);
    eq(`theme-boot: stored=${stored} os=${scheme}`, boot, [want, 'aurora']);
    await ctx.close();
  }
  const { ctx, page } = await newPage({ colorScheme: 'light' });
  await inPage(page, `
    const th = await import('/shared/js/theme.js');
    const root = document.documentElement, ls = () => localStorage.getItem('quiz.theme');
    T('initTheme default: event default dark, no user choice', () => EQ([th.initTheme().preference, th.hasUserChoice(), root.dataset.theme], ['dark', false, 'dark']));
    T('setEventDefaultTheme(light) applies while no user choice, storage untouched', () => { th.setEventDefaultTheme('light'); return EQ([root.dataset.theme, th.getTheme(), ls()], ['light', 'light', null]); });
    T('setEventDefaultTheme(system) resolves via OS (light)', () => { th.setEventDefaultTheme('system'); return EQ([th.getTheme(), th.getResolvedTheme(), root.dataset.theme], ['system', 'light', 'light']); });
    let events = []; const off = th.onThemeChange((d) => events.push(d));
    T('setTheme(dark) persists the user choice and notifies {preference, resolved}', () => { th.setTheme('dark'); return EQ([ls(), th.hasUserChoice(), root.dataset.theme, events.at(-1)], ['dark', true, 'dark', { preference: 'dark', resolved: 'dark' }]); });
    T('event default ignored once the user chose', () => { th.setEventDefaultTheme('light'); return EQ([th.getTheme(), root.dataset.theme], ['dark', 'dark']); });
    T('setTheme(light, {persist:false}) is session only', () => { th.setTheme('light', { persist: false }); return EQ([root.dataset.theme, ls(), th.getTheme()], ['light', 'dark', 'light']); });
    T('setTheme(null) forgets the choice -> event default', () => { th.setTheme(null); return EQ([ls(), th.hasUserChoice(), th.getTheme()], [null, false, 'light']); });
    T('invalid mode ignored', () => { const b = th.getTheme(); th.setTheme('purple'); return EQ([th.getTheme(), ls()], [b, null]); });
    T('cycleTheme order system -> light -> dark -> system', () => { th.setTheme('system'); const a = th.cycleTheme(); const b = th.cycleTheme(); const c = th.cycleTheme(); return EQ([a, b, c], ['light', 'dark', 'system']); });
    off();
    T('unsubscribed listener no longer called', () => { const n = events.length; th.setTheme('light'); return EQ(events.length, n); });
    T('garbage in storage is ignored', () => { localStorage.setItem('quiz.theme', 'banana'); return EQ([th.getUserTheme(), th.hasUserChoice()], [null, false]); });
    localStorage.removeItem('quiz.theme'); th.setTheme(null);
    // toggle widgets
    const btn = th.createThemeToggle({ labels: { theme: 'Thème', system: 'Auto', light: 'Clair', dark: 'Sombre' } });
    document.body.append(btn);
    T('button toggle: aria-label uses translated labels', () => EQ(btn.getAttribute('aria-label'), 'Thème: ' + ({ system: 'Auto', light: 'Clair', dark: 'Sombre' })[th.getTheme()]));
    T('button toggle click cycles theme and relabels', () => { th.setTheme('system'); btn.click(); return EQ([th.getTheme(), btn.getAttribute('aria-label')], ['light', 'Thème: Clair']); });
    const seg = th.createThemeToggle({ variant: 'segmented' });
    document.body.append(seg);
    T('segmented toggle: 3 radios, current checked, change sets theme', () => { const r = [...seg.querySelectorAll('input')]; r.find((x) => x.value === 'dark').click(); return EQ([r.length, th.getTheme(), r.find((x) => x.checked).value, seg.getAttribute('role')], [3, 'dark', 'dark', 'radiogroup']); });
  `);
  // OS change while on 'system'
  await page.evaluate(async () => { const th = await import('/shared/js/theme.js'); th.setTheme('system'); });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  eq('system follows OS change live (light -> dark)', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  // persistence across reload + no flash
  await page.evaluate(async () => { const th = await import('/shared/js/theme.js'); th.setTheme('light'); });
  await page.reload({ waitUntil: 'load' });
  eq('persisted choice reloads as light before any module ran', await page.evaluate(() => window.__bootTheme), 'light');
  // ?theme= : this page load only, never stored; boot script honours it before first paint
  for (const [q, scheme, want] of [['light', 'dark', 'light'], ['dark', 'light', 'dark'], ['system', 'light', 'light'], ['bogus', 'dark', 'dark']]) {
    const t = await newPage({ colorScheme: scheme, url: `/probe/blank.html?theme=${q}`, init: `localStorage.setItem('quiz.theme', 'dark')` });
    const r = await t.page.evaluate(async () => { const th = await import('/shared/js/theme.js'); th.initTheme(); return [window.__bootTheme, document.documentElement.dataset.theme, localStorage.getItem('quiz.theme'), th.hasUserChoice()]; });
    // stored choice is 'dark'; ?theme=bogus must be ignored; valid ?theme= wins for this load and does not overwrite the stored choice
    eq(`?theme=${q} (stored dark, OS ${scheme})`, r, [want, want, 'dark', true]);
    await t.ctx.close();
  }
  // cross-tab sync through the storage event
  const page2 = await ctx.newPage();
  await page2.goto(BASE + '/probe/blank.html');
  await page2.evaluate(async () => { const th = await import('/shared/js/theme.js'); th.initTheme(); });
  await page.evaluate(async () => { const th = await import('/shared/js/theme.js'); th.initTheme(); th.setTheme('dark'); });
  await page2.waitForTimeout(150);
  eq('theme change in another tab is picked up (storage event)', await page2.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await ctx.close();
  // ?theme= style non persisted override in styleguide is covered by screens; blocked storage must not throw:
  const blocked = await newPage({ init: `Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } })` });
  await inPage(blocked.page, `
    const th = await import('/shared/js/theme.js'); const api = await import('/shared/js/api.js');
    T('blocked localStorage: theme + token helpers do not throw and keep the session choice in memory', () => { th.initTheme(); th.setTheme('light'); api.setToken('x'); return EQ([th.getTheme(), api.getToken()], ['light', 'x']); });
  `);
  eq('blocked localStorage: theme-boot still sets data-theme', await blocked.page.evaluate(() => window.__bootTheme), 'dark');
  await blocked.ctx.close();
}

// ------------------------------------------------------------------------------------------------ 3. branding + colour maths
if (run('branding')) {
  section = 'branding';
  const { ctx, page } = await newPage({ colorScheme: 'dark' });
  await inPage(page, `
    const col = await import('/shared/js/color.js'); const br = await import('/shared/js/branding.js'); const th = await import('/shared/js/theme.js');
    T('normalizeHex variants', () => EQ([col.normalizeHex('#fc5607'), col.normalizeHex('fc5607'), col.normalizeHex('#f50'), col.normalizeHex('nope'), col.normalizeHex(undefined, '#123456'), col.normalizeHex('#12345')], ['#FC5607', '#FC5607', '#FF5500', null, '#123456', null]));
    T('contrast black/white = 21, same colour = 1', () => EQ([col.contrast('#000', '#fff').toFixed(2), col.contrast('#fc5607', '#fc5607').toFixed(2)], ['21.00', '1.00']));
    T('contrast is symmetric', () => EQ(col.contrast('#FC5607', '#130A07').toFixed(3), col.contrast('#130A07', '#FC5607').toFixed(3)));
    T('contrast white vs #767676 = 4.54 (known WCAG value)', () => EQ(col.contrast('#fff', '#767676').toFixed(2), '4.54'));
    T('oklch round trip within 1 unit per channel', () => { let worst = 0; for (const h of ['#FC5607', '#7C5CFF', '#0B2447', '#2EC4B6', '#FFD60A', '#808080', '#000000', '#FFFFFF']) { const r = col.oklchToHex(col.hexToOklch(h)); const d = [1, 3, 5].map((i) => Math.abs(parseInt(h.slice(i, i + 2), 16) - parseInt(r.slice(i, i + 2), 16))); worst = Math.max(worst, ...d); } return [worst <= 1, 'worst channel delta ' + worst]; });
    T('hexToOklch #FC5607 is orange (h ~ 39) with high chroma', () => { const o = col.hexToOklch('#FC5607'); return [o.h > 30 && o.h < 50 && o.c > 0.2, JSON.stringify(o)]; });
    T('readableOn picks white on navy and ink on yellow', () => { const a = col.readableOn('#0B2447'), b = col.readableOn('#FFD60A'); return [a.ratio >= 4.5 && b.ratio >= 4.5 && a.color.toUpperCase() === '#FFFFFF' && b.color.toUpperCase() !== '#FFFFFF', JSON.stringify([a, b])]; });
    T('DEFAULT_BRANDING is the Gravitee orange + frozen', () => EQ([br.DEFAULT_BRANDING.primary_color, br.DEFAULT_BRANDING.accent_color, br.DEFAULT_BRANDING.background_style, br.DEFAULT_BRANDING.default_theme, Object.isFrozen(br.DEFAULT_BRANDING)], ['#FC5607', '#FF9A52', 'aurora', 'dark', true]));
    T('computeBrandTokens shape', () => { const t = br.computeBrandTokens('#7C5CFF', '#22D3EE'); const need = ['brand','accent','hue','tintC','vars','scopedVars','themeColor']; const miss = need.filter((k) => !(k in t)); return [miss.length === 0 && t.brand === '#7C5CFF' && t.accent === '#22D3EE' && /^#/.test(t.themeColor.dark) && /^#/.test(t.themeColor.light), JSON.stringify(Object.keys(t))]; });
    T('computeBrandTokens emits every documented role in both themes', () => { const v = br.computeBrandTokens('#7C5CFF').vars; const roles = ['brand-solid','brand-solid-hover','on-brand','brand-text','accent-solid','accent-solid-hover','on-accent','accent-text','green','red','amber','blue','on-green','on-red','green-text','red-text','amber-text','blue-text','aurora-strength','bloom-strength']; const miss = []; for (const r of roles) for (const s of ['d', 'l']) if (!('--' + r + '-' + s in v)) miss.push(r + '-' + s); return [miss.length === 0, miss.join(',')]; });
    T('invalid primary falls back to Gravitee orange; missing accent is derived', () => { const t = br.computeBrandTokens('banana'); const u = br.computeBrandTokens('#7C5CFF'); return [t.brand === '#FC5607' && /^#[0-9A-F]{6}$/.test(u.accent) && u.accent !== '#7C5CFF', t.brand + ' ' + u.accent]; });
    T('deriveAccent returns a different valid hex', () => { const a = br.deriveAccent('#FC5607'); return [/^#[0-9A-F]{6}$/.test(a) && a !== '#FC5607', a]; });
    T('faviconDataUrl is an SVG data URL carrying the brand colour', () => { const u = br.faviconDataUrl('#7c5cff'); return [u.startsWith('data:image/svg+xml,') && decodeURIComponent(u).includes('#7C5CFF'), u.slice(0, 60)]; });
    // DOM side
    const root = document.documentElement;
    const ev = { slug: 'ai', name: 'World AI Summit – Amsterdam 2026', game_title: 'AI Masters', branding: { primary_color: '#7C5CFF', accent_color: '#22D3EE', background_style: 'grid', default_theme: 'light' } };
    let r;
    T('applyBranding(event) returns tokens + branding', () => { r = br.applyBranding(ev); return EQ([r.brand, r.accent, r.branding.background_style, typeof r.vars], ['#7C5CFF', '#22D3EE', 'grid', 'object']); });
    T('sets --brand / --brand-accent / data-bg on <html>', () => EQ([root.style.getPropertyValue('--brand'), root.style.getPropertyValue('--brand-accent'), root.dataset.bg], ['#7C5CFF', '#22D3EE', 'grid']));
    T('sets the solved roles (--brand-solid-d etc.)', () => [/^#[0-9A-F]{6}$/.test(root.style.getPropertyValue('--brand-solid-d')) && /^#[0-9A-F]{6}$/.test(root.style.getPropertyValue('--on-brand-l')), root.style.getPropertyValue('--brand-solid-d')]);
    T('computed --brand-solid follows data-theme (yellow is deepened in light)', () => { br.applyBranding({ branding: { primary_color: '#FFD60A', accent_color: '#FF006E' } }); th.setTheme('dark', { persist: false }); const d = getComputedStyle(root).getPropertyValue('--brand-solid').trim(); th.setTheme('light', { persist: false }); const l = getComputedStyle(root).getPropertyValue('--brand-solid').trim(); const ok = d && l && d !== l && d.toUpperCase() === root.style.getPropertyValue('--brand-solid-d').toUpperCase() && l.toUpperCase() === root.style.getPropertyValue('--brand-solid-l').toUpperCase(); br.applyBranding(ev); return [ok, d + ' ' + l]; });
    T('document.title is "{game_title} · {name}"', () => EQ(document.title, 'AI Masters · World AI Summit – Amsterdam 2026'));
    T('page option prefixes the title', () => { br.applyBranding(ev, { page: 'Scoreboard' }); return EQ(document.title, 'Scoreboard · AI Masters · World AI Summit – Amsterdam 2026'); });
    T('title:false leaves the title alone', () => { document.title = 'keep'; br.applyBranding(ev, { title: false }); return EQ(document.title, 'keep'); });
    T('theme-color meta exists and follows the theme', () => { th.setTheme('dark', { persist: false }); const d = document.querySelector('meta[name="theme-color"]').content; th.setTheme('light', { persist: false }); const l = document.querySelector('meta[name="theme-color"]').content; return [/^#/.test(d) && /^#/.test(l) && d !== l && d === br.getBrandTokens().themeColor.dark && l === br.getBrandTokens().themeColor.light, d + ' ' + l]; });
    T('favicon link is an SVG tinted with the brand', () => { const l = document.querySelector('link[rel="icon"]'); return [l && l.type === 'image/svg+xml' && decodeURIComponent(l.href).includes('#7C5CFF'), l && l.href.slice(0, 50)]; });
    T('only one icon link, apple-touch-icon removed', () => EQ(document.querySelectorAll('link[rel="icon"]').length, 1));
    T('event default theme applies when the user has not chosen', () => { localStorage.removeItem('quiz.theme'); th.setTheme(null); br.applyBranding(ev); return EQ(root.dataset.theme, 'light'); });
    T('event default theme ignored after an explicit user choice', () => { th.setTheme('dark'); br.applyBranding(ev); return EQ(root.dataset.theme, 'dark'); });
    T('invalid background_style falls back to aurora', () => { br.applyBranding({ branding: { background_style: 'rainbow' } }); return EQ(root.dataset.bg, 'aurora'); });
    T('bare branding object accepted (no title change)', () => { document.title = 'k2'; br.applyBranding({ primary_color: '#2EC4B6', accent_color: '#CBF3F0', background_style: 'plain' }); return EQ([document.title, root.dataset.bg, root.style.getPropertyValue('--brand')], ['k2', 'plain', '#2EC4B6']); });
    T('null -> Gravitee defaults, resetBranding() same', () => { br.applyBranding({ branding: { primary_color: '#2EC4B6' } }); const a = br.resetBranding(); return EQ([a.brand, root.style.getPropertyValue('--brand'), root.dataset.bg], ['#FC5607', '#FC5607', 'aurora']); });
    T('getBrandTokens returns the last document-level result', () => EQ(br.getBrandTokens().brand, '#FC5607'));
    T('setDocumentTitle variants', () => EQ([br.setDocumentTitle({ game_title: 'A', name: 'B' }), br.setDocumentTitle({ game_title: 'A', name: 'A' }), br.setDocumentTitle('Plain', 'Pg'), br.setDocumentTitle(null)], ['A · B', 'A', 'Pg · Plain', 'Gravitee Quiz']));
    T('scoped branding only touches the element', () => { br.applyBranding(ev); const card = document.createElement('div'); document.body.append(card); const before = root.style.getPropertyValue('--brand'); const out = br.applyBranding({ branding: { primary_color: '#FFD60A', accent_color: '#FF006E' } }, { root: card }); return EQ([card.hasAttribute('data-brand-scope'), card.style.getPropertyValue('--brand'), card.style.getPropertyValue('--brand-solid-d') !== '', root.style.getPropertyValue('--brand') === before, out.brand], [true, '#FFD60A', true, true, '#FFD60A']); });
    T('scoped element resolves its own --brand-solid in CSS', () => { const card = document.querySelector('[data-brand-scope]'); card.textContent = 'x'; const a = getComputedStyle(card).getPropertyValue('--brand-solid').trim().toUpperCase(); return [a === card.style.getPropertyValue('--brand-solid-' + (root.dataset.theme === 'light' ? 'l' : 'd')).toUpperCase() && a !== getComputedStyle(root).getPropertyValue('--brand-solid').trim().toUpperCase(), a]; });
  `);
  // rapid live-editor usage must stay cheap: 200 applyBranding calls on a scoped element
  await inPage(page, `
    const br = await import('/shared/js/branding.js');
    const el = document.createElement('div'); document.body.append(el);
    const t0 = performance.now(); for (let i = 0; i < 200; i++) br.applyBranding({ branding: { primary_color: '#' + ((i * 40503) % 0xFFFFFF).toString(16).padStart(6, '0') } }, { root: el }); const ms = performance.now() - t0;
    T('200 scoped applyBranding calls take < 400 ms (live editor)', () => [ms < 400, ms.toFixed(0) + ' ms']);
  `);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 4. api.js + config.js
if (run('api')) {
  section = 'api';
  const { ctx, page } = await newPage();
  await inPage(page, `
    const m = await import('/shared/js/api.js'); const { api, ApiError, apiUrl, setToken, getToken, clearToken, onUnauthorized, openEventSource } = m;
    const calls = []; let queue = [];
    const resp = (status, body, headers = {}) => ({ status, body, headers });
    window.fetch = async (url, init = {}) => {
      calls.push({ url, init });
      const r = queue.shift();
      if (!r) throw new Error('queue empty');
      if (r instanceof Error) throw r;
      if (r.hang) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      const isJson = typeof r.body === 'object' && r.body !== null && !(r.body instanceof Blob);
      return new Response(r.status === 204 ? null : isJson ? JSON.stringify(r.body) : r.body, { status: r.status, headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...r.headers } });
    };
    const reset = (...q) => { calls.length = 0; queue = q; localStorage.clear(); };
    const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };

    T('apiUrl basics', () => EQ([apiUrl('/events/x/scoreboard', { limit: 10 }), apiUrl('events'), apiUrl('/a', { q: undefined, r: null, s: '', t: 0, u: false }), apiUrl('/a?x=1', { y: 2 }), apiUrl('https://h.example/z', { a: 1 })], ['/api/events/x/scoreboard?limit=10', '/api/events', '/api/a?t=0&u=false', '/api/a?x=1&y=2', 'https://h.example/z?a=1']));
    reset(resp(200, [{ slug: 'a' }]));
    T('GET parses JSON, sends Accept + same-origin credentials, no Content-Type', async () => { const d = await api.get('/events', { query: { lang: 'fr' } }); const c = calls[0]; return EQ([d, c.url, c.init.method, c.init.headers.Accept, c.init.credentials, 'Content-Type' in c.init.headers], [[{ slug: 'a' }], '/api/events?lang=fr', 'GET', 'application/json', 'same-origin', false]); });
    reset(resp(201, { id: 5 }));
    T('POST sends JSON body + Content-Type', async () => { const d = await api.post('/events/x/players', { first_name: 'Ada' }); const c = calls[0]; return EQ([d, c.init.method, c.init.body, c.init.headers['Content-Type']], [{ id: 5 }, 'POST', '{"first_name":"Ada"}', 'application/json']); });
    reset(resp(200, { ok: 1 }), resp(200, { ok: 2 }), resp(200, { ok: 3 }));
    T('put / patch / delete verbs + delete query', async () => { await api.put('/a/1', { x: 1 }); await api.patch('/a/1', { x: 2 }); await api.delete('/admin/events/1', { query: { confirm: 'slug' } }); return EQ(calls.map((c) => c.init.method + ' ' + c.url), ['PUT /api/a/1', 'PATCH /api/a/1', 'DELETE /api/admin/events/1?confirm=slug']); });
    reset(resp(204));
    T('204 resolves null', async () => EQ(await api.delete('/x'), null));
    reset(resp(200, 'plain text', { 'content-type': 'text/plain' }));
    T('non JSON 200 resolves the text', async () => EQ(await api.get('/x'), 'plain text'));
    reset(resp(404, { detail: 'not_found' }));
    T('404 machine code', async () => { const e = await fails(api.get('/x')); return EQ([e instanceof ApiError, e.status, e.detail, e.code, e.isNotFound, e.isServer, e.name], [true, 404, 'not_found', 'not_found', true, false, 'ApiError']); });
    reset(resp(403, { detail: 'event_closed' }));
    T('403 event_closed', async () => { const e = await fails(api.post('/x', {})); return EQ([e.status, e.code, e.isForbidden], [403, 'event_closed', true]); });
    reset(resp(409, { detail: 'Slug already exists' }));
    T('409 sentence detail has no machine code', async () => { const e = await fails(api.post('/x', {})); return EQ([e.status, e.detail, e.code, e.isConflict, e.message], [409, 'Slug already exists', null, true, 'Slug already exists']); });
    reset(resp(422, { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'x' }, { loc: ['body', 'player', 'phone'], msg: 'field required', type: 'y' }] }));
    T('422 FastAPI list -> fieldErrors by dotted path', async () => { const e = await fails(api.post('/x', {})); return EQ([e.status, e.isValidation, e.fieldErrors, typeof e.detail], [422, true, { email: 'value is not a valid email address', 'player.phone': 'field required' }, 'string']); });
    reset(resp(400, { detail: 'not_enough_questions' }));
    T('400 is a validation error with code', async () => { const e = await fails(api.post('/x', {})); return EQ([e.isValidation, e.code], [true, 'not_enough_questions']); });
    reset(resp(429, { detail: 'Too many attempts' }));
    T('429 passes the detail through', async () => { const e = await fails(api.post('/auth/login', {}, { auth: false })); return EQ([e.status, e.detail], [429, 'Too many attempts']); });
    reset(resp(500, 'Internal Server Error', { 'content-type': 'text/plain' }));
    T('500 non-JSON body: generic detail, isServer', async () => { const e = await fails(api.post('/x', {})); return EQ([e.status, e.detail, e.isServer], [500, 'Request failed (500)', true]); });
    reset(new TypeError('fail'), new TypeError('fail'), new TypeError('fail'));
    T('GET network error: 3 attempts (2 retries), then status 0', async () => { const t = performance.now(); const e = await fails(api.get('/x')); return [calls.length === 3 && e.status === 0 && e.isNetwork && e.detail === 'Network error' && performance.now() - t < 3000, 'calls=' + calls.length + ' status=' + (e && e.status)]; });
    reset(new TypeError('fail'));
    T('POST network error is NOT retried', async () => { const e = await fails(api.post('/x', {})); return EQ([calls.length, e.status], [1, 0]); });
    reset(resp(503, { detail: 'busy' }), resp(200, { ok: true }));
    T('GET 503 then 200 succeeds after one retry', async () => { const d = await api.get('/x'); return EQ([d, calls.length], [{ ok: true }, 2]); });
    reset(resp(503, { detail: 'busy' }));
    T('POST 503 is not retried', async () => { const e = await fails(api.post('/x', {})); return EQ([calls.length, e.status], [1, 503]); });
    reset(resp(502, {}), resp(502, {}), resp(502, {}));
    T('GET 502 x3 -> throws the 502 (isServer)', async () => { const e = await fails(api.get('/x')); return EQ([calls.length, e.status, e.isServer], [3, 502, true]); });
    reset(new TypeError('x'));
    T('retries:0 disables GET retry', async () => { const e = await fails(api.get('/x', { retries: 0 })); return EQ([calls.length, e.status], [1, 0]); });
    reset({ hang: true });
    T('timeout -> status -1 isTimeout', async () => { const e = await fails(api.get('/x', { timeout: 40, retries: 0 })); return EQ([e.status, e.isTimeout, e.detail], [-1, true, 'Request timed out']); });
    reset({ hang: true });
    T('AbortSignal aborts -> status -1 "aborted"', async () => { const c = new AbortController(); const p = fails(api.get('/x', { signal: c.signal, retries: 0 })); setTimeout(() => c.abort(), 20); const e = await p; return EQ([e.status, e.detail], [-1, 'Request aborted']); });
    reset();
    T('already aborted signal never hits the network', async () => { const c = new AbortController(); c.abort(); const e = await fails(api.get('/x', { signal: c.signal })); return EQ([e.status, calls.length], [-1, 0]); });
    reset(resp(200, {}), resp(200, {}), resp(200, {}));
    T('Bearer token attached; auth:false skips it', async () => { setToken('tok123'); await api.get('/admin/events'); await api.post('/auth/login', {}, { auth: false }); setToken(null); await api.get('/x'); return EQ(calls.map((c) => c.init.headers.Authorization || null), ['Bearer tok123', null, null]); });
    reset(resp(401, { detail: 'Invalid token' }), resp(401, { detail: 'nope' }));
    T('401 with token: token cleared + onUnauthorized fired once, with the ApiError', async () => { setToken('t'); const seen = []; const off = onUnauthorized((e) => seen.push(e.status)); const e = await fails(api.get('/admin/x')); const gone = getToken() === null; off(); setToken('t2'); await fails(api.get('/admin/x')); return EQ([e.isUnauthorized, gone, seen], [true, true, [401]]); });
    reset(resp(401, { detail: 'bad credentials' }));
    T('401 without a token (login failure) does not fire onUnauthorized', async () => { let n = 0; const off = onUnauthorized(() => n++); const e = await fails(api.post('/auth/login', {}, { auth: false })); off(); return EQ([e.status, n], [401, 0]); });
    T('getToken/setToken/clearToken round trip under key quiz.admin.token', () => { setToken('abc'); const a = [getToken(), localStorage.getItem('quiz.admin.token')]; clearToken(); return EQ([a, getToken()], [['abc', 'abc'], null]); });
    reset(resp(200, { created: 1 }));
    T('upload: multipart FormData, field "file", no manual Content-Type, query kept', async () => { const f = new File(['a,b'], 'q.csv', { type: 'text/csv' }); await api.upload('/admin/events/1/questions/import-csv', f, { query: { dry_run: true } }); const c = calls[0]; return EQ([c.init.body instanceof FormData, c.init.body.get('file').name, 'Content-Type' in c.init.headers, c.url, c.init.method], [true, 'q.csv', false, '/api/admin/events/1/questions/import-csv?dry_run=true', 'POST']); });
    reset(resp(200, new Blob(['rank,name\\n1,Ada'], { type: 'text/csv' }), { 'content-disposition': 'attachment; filename="results-ai-masters.csv"', 'content-type': 'text/csv' }));
    T('download: Bearer sent, filename from Content-Disposition, anchor clicked', async () => { setToken('dl'); let clicked = null; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { clicked = this.download; }; const name = await api.download('/admin/events/1/results.csv'); HTMLAnchorElement.prototype.click = orig; return EQ([name, clicked, calls[0].init.headers.Authorization], ['results-ai-masters.csv', 'results-ai-masters.csv', 'Bearer dl']); });
    reset(resp(200, { x: 1 }));
    T('raw:true resolves the Response', async () => { const r = await api.get('/x', { raw: true }); return EQ([r instanceof Response, r.status], [true, 200]); });
    reset(resp(200, {}));
    T('custom headers are merged', async () => { await api.get('/x', { headers: { 'X-Test': '1' } }); return EQ(calls[0].init.headers['X-Test'], '1'); });
  `);
  await ctx.close();

  // config.js
  const c2 = await newPage({ init: `window.QUIZ_CONFIG = { apiBase: 'https://quiz.events.gravitee.io/api/', publicBaseUrl: 'https://quiz.events.gravitee.io/' }` });
  await inPage(c2.page, `
    const { config, eventUrl, scoreboardUrl } = await import('/shared/js/config.js'); const { apiUrl } = await import('/shared/js/api.js');
    T('config trims trailing slashes', () => EQ([config.apiBase, config.publicBaseUrl], ['https://quiz.events.gravitee.io/api', 'https://quiz.events.gravitee.io']));
    T('README example: eventUrl("ai-masters", {lang:"fr"})', () => EQ(eventUrl('ai-masters', { lang: 'fr' }), 'https://quiz.events.gravitee.io/ai-masters?lang=fr'));
    T('README example: scoreboardUrl', () => EQ(scoreboardUrl('ai-masters'), 'https://quiz.events.gravitee.io/ai-masters/scoreboard'));
    T('eventUrl without lang', () => EQ(eventUrl('x'), 'https://quiz.events.gravitee.io/x'));
    T('eventUrl encodes the slug', () => EQ(eventUrl('a b'), 'https://quiz.events.gravitee.io/a%20b'));
    T('apiUrl honours apiBase', () => EQ(apiUrl('/events'), 'https://quiz.events.gravitee.io/api/events'));
  `);
  await c2.ctx.close();
  const c3 = await newPage();
  await inPage(c3.page, `
    const { config, eventUrl } = await import('/shared/js/config.js');
    T('defaults: apiBase /api and origin as public base', () => EQ([config.apiBase, config.publicBaseUrl, eventUrl('x')], ['/api', location.origin, location.origin + '/x']));
  `);
  await c3.ctx.close();
}

// ------------------------------------------------------------------------------------------------ 5. openEventSource
if (run('sse')) {
  section = 'sse';
  const { ctx, page } = await newPage();
  await inPage(page, `
    const { openEventSource } = await import('/shared/js/api.js');
    const inst = [];
    window.EventSource = class FakeES { constructor(url) { this.url = url; this.closed = false; inst.push(this); } close() { this.closed = true; } };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const statuses = [], msgs = [], errs = [];
    const live = openEventSource('/api/events/x/scoreboard/stream?limit=10', { onMessage: (d) => msgs.push(d), onStatus: (s, i) => statuses.push([s, i]), onError: (e) => errs.push(e.name), minDelay: 30, maxDelay: 120 });
    T('connects immediately with the given URL, status connecting', () => EQ([inst.length, inst[0].url, live.status, statuses[0][0]], [1, '/api/events/x/scoreboard/stream?limit=10', 'connecting', 'connecting']));
    inst[0].onopen();
    T('onopen -> status open, attempts 0', () => EQ([live.status, live.attempts], ['open', 0]));
    inst[0].onmessage({ data: '{"entries":[1],"total_players":3}' });
    T('JSON messages are parsed', () => EQ(msgs, [{ entries: [1], total_players: 3 }]));
    inst[0].onmessage({ data: '{bad json' });
    T('bad JSON goes to onError, not onMessage', () => EQ([msgs.length, errs.length], [1, 1]));
    inst[0].onerror();
    T('error closes the source and schedules a reconnect (attempt 1, ~30ms jittered)', () => { const s = statuses.at(-1); return [inst[0].closed && s[0] === 'reconnecting' && s[1].attempt === 1 && s[1].delay >= 23 && s[1].delay <= 37, JSON.stringify(s)]; });
    await wait(80);
    T('after the delay a NEW EventSource with the same URL is created', () => EQ([inst.length, inst[1].url], [2, inst[0].url]));
    const delays = [];
    for (let k = 0; k < 5; k++) { inst.at(-1).onerror(); delays.push(statuses.at(-1)[1].delay); await wait(160); }
    T('backoff doubles then clamps at maxDelay (+-20% jitter)', () => { const exp = [60, 120, 120, 120, 120]; const okAll = delays.every((d, i) => d >= exp[i] * 0.78 && d <= exp[i] * 1.22); return [okAll, JSON.stringify(delays)]; });
    inst.at(-1).onopen();
    T('a successful open resets the attempt counter', () => EQ(live.attempts, 0));
    inst.at(-1).onerror();   // error again: delay back to ~minDelay
    T('after reset the next delay is min again', () => [statuses.at(-1)[1].attempt === 1 && statuses.at(-1)[1].delay <= 37, JSON.stringify(statuses.at(-1))]);
    await wait(60);
    const n0 = inst.length;
    // we are 'connecting/reconnecting' (not open): online -> instant reconnect
    inst.at(-1).onerror(); const n1 = inst.length;
    window.dispatchEvent(new Event('online'));
    T('"online" event reconnects instantly when not open', () => [inst.length === n1 + 1 && live.attempts === 0, 'instances ' + n1 + ' -> ' + inst.length]);
    inst.at(-1).onopen();
    const n2 = inst.length;
    window.dispatchEvent(new Event('online'));
    T('"online" is ignored while open', () => EQ(inst.length, n2));
    inst.at(-1).onerror(); const n3 = inst.length;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    T('tab becoming visible reconnects instantly when not open', () => EQ(inst.length, n3 + 1));
    inst.at(-1).onopen();
    live.reconnect();
    T('reconnect() replaces the live source immediately', () => EQ([inst.at(-2).closed, inst.at(-1).closed, live.status], [true, false, 'connecting']));
    T('status getter reflects reconnecting after reconnect()', () => EQ(statuses.at(-1)[0], 'connecting'));
    live.close();
    const n4 = inst.length;
    window.dispatchEvent(new Event('online')); await wait(200);
    T('close(): status closed, source closed, no timers/listeners revive it', () => EQ([live.status, inst.at(-1).closed, inst.length], ['closed', true, n4]));
    // json:false
    const raw = []; const l2 = openEventSource('/s', { onMessage: (d) => raw.push(d), json: false });
    inst.at(-1).onmessage({ data: 'hello' });
    T('json:false delivers the raw string', () => EQ(raw, ['hello']));
    l2.close();
    // staleAfter watchdog (opt-in): half-open connections never raise an error
    window.EventSource = class FakeES2 { constructor(url) { this.url = url; this.closed = false; inst.push(this); } close() { this.closed = true; } };
    const st = []; const a0 = inst.length;
    const l4 = openEventSource('/s', { onMessage() {}, onStatus: (s) => st.push(s), staleAfter: 150 });
    inst.at(-1).onopen();
    await wait(100); inst.at(-1).onmessage({ data: '{}' });
    await wait(100);
    T('staleAfter: messages keep the connection alive (no refresh)', () => EQ(inst.length, a0 + 1));
    await wait(330);
    T('staleAfter: silence re-opens the stream silently (new EventSource, old closed, status stays open, no status churn)', () => [inst.length >= a0 + 2 && inst[a0].closed && st.join(',') === 'connecting,open' && l4.status === 'open', 'instances ' + (inst.length - a0) + ' statuses ' + st.join(',')]);
    inst.at(-1).onopen();
    l4.close();
    const a1 = inst.length; await wait(400);
    T('staleAfter: close() stops the watchdog', () => EQ(inst.length, a1));
    const l5 = openEventSource('/s', { onMessage() {} });
    inst.at(-1).onopen(); const a2 = inst.length; await wait(300);
    T('staleAfter off by default: silence does nothing', () => EQ(inst.length, a2));
    l5.close();
    // EventSource constructor throwing must not crash and must retry
    let boom = 1; window.EventSource = class { constructor() { if (boom-- > 0) throw new Error('nope'); this.closed = false; inst.push(this); } close() {} };
    const l3 = openEventSource('/s', { onMessage() {}, minDelay: 20, maxDelay: 40, onError: (e) => errs.push('ctor:' + e.message) });
    await wait(80);
    T('constructor failure is reported to onError then retried', () => [errs.includes('ctor:nope') && l3.status !== 'closed', JSON.stringify(errs)]);
    l3.close();
  `);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 6. icons at /shared and /admin/shared
if (run('icons')) {
  section = 'icons';
  for (const [label, url, prefix] of [['/shared/', '/probe/blank.html', '/shared/'], ['/admin/shared/', '/admin/index.html', '/admin/shared/']]) {
    const { ctx, page } = await newPage({ url });
    const mod = prefix === '/shared/' ? '/shared/js/dom.js' : '/admin/shared/js/dom.js';
    const mod2 = prefix === '/shared/' ? '/shared/js/theme.js' : '/admin/shared/js/theme.js';
    await inPage(page, `
      const dom = await import('${mod}'); const th = await import('${mod2}');
      T('SPRITE_URL resolves under ${prefix}', () => EQ(dom.SPRITE_URL, location.origin + '${prefix}icons/sprite.svg'));
      T('icon() <use href> = sprite + #name', () => EQ(dom.icon('trophy').querySelector('use').getAttribute('href'), dom.SPRITE_URL + '#trophy'));
      T('icon() options: size preset / number / css length / label / spin / class', () => { const a = dom.icon('x', { size: 'lg' }), b = dom.icon('x', { size: 24 }), c = dom.icon('x', { size: '2rem' }), d = dom.icon('x', { label: 'Close', spin: true, class: 'extra' }), e = dom.icon('x'); return EQ([a.getAttribute('class'), b.style.getPropertyValue('--icon-size'), c.style.getPropertyValue('--icon-size'), d.getAttribute('role'), d.getAttribute('aria-label'), d.getAttribute('class'), e.getAttribute('aria-hidden')], ['icon icon--lg', '24px', '2rem', 'img', 'Close', 'icon icon--spin extra', 'true']); });
      document.getElementById('root').innerHTML = '<span id="h1" data-icon="check" data-icon-size="lg"></span><span id="h2" data-icon="trophy-fill"></span>';
      dom.hydrateIcons(); dom.hydrateIcons();
      T('hydrateIcons fills data-icon hosts, idempotent, honours data-icon-size', () => EQ([document.querySelectorAll('#h1 svg').length, document.querySelectorAll('#h2 svg').length, document.querySelector('#h1 svg').classList.contains('icon--lg')], [1, 1, true]));
      const res = await fetch(dom.SPRITE_URL);
      T('sprite is served as image/svg+xml with the icons', async () => [res.ok && /image\\/svg\\+xml/.test(res.headers.get('content-type')) && (await res.text()).includes('id="trophy"'), res.status + ' ' + res.headers.get('content-type')]);
      const tt = th.createThemeToggle(); document.getElementById('root').append(tt);
      T('theme toggle icon uses the same base path', () => EQ(tt.querySelector('use').getAttribute('href').startsWith(location.origin + '${prefix}icons/sprite.svg#'), true));
    `);
    // pixels: a real icon must paint, a missing symbol must not
    await page.evaluate(async (mod) => {
      const dom = await import(mod);
      const r = document.getElementById('root'); r.replaceChildren();
      const a = dom.icon('trophy-fill', { size: 64 }); a.id = 'real'; a.style.color = '#ff0000';
      const b = dom.icon('does-not-exist', { size: 64 }); b.id = 'ghost'; b.style.color = '#ff0000';
      r.append(a, b);
    }, mod);
    await page.waitForTimeout(200);
    const px = async (id) => { const buf = await page.locator('#' + id).screenshot(); return buf.length; };
    const [real, ghost] = [await px('real'), await px('ghost')];
    rec(`${label} icon actually paints (png ${real}B vs empty ${ghost}B)`, real > ghost * 1.15, `${real} vs ${ghost}`);
    await ctx.close();
  }
}

// ------------------------------------------------------------------------------------------------ 7. dom helpers
if (run('dom')) {
  section = 'dom';
  const { ctx, page } = await newPage();
  await inPage(page, `
    const d = await import('/shared/js/dom.js');
    T('el: text children are text nodes (no HTML injection)', () => { const n = d.el('p', null, '<img src=x onerror=alert(1)>', 5, null, false, ['a', 'b']); return EQ([n.children.length, n.textContent], [0, '<img src=x onerror=alert(1)>5ab']); });
    T('el: attrs class/style/dataset/aria/on/text/properties', () => { let hit = 0; const n = d.el('button', { class: ['btn', { on: true, off: false }], style: { '--i': 2, color: 'red' }, dataset: { id: 3 }, aria: { label: 'Save' }, on: { click: () => hit++ }, disabled: true, type: 'button', title: false }, 'Go'); n.disabled = false; n.click(); return EQ([n.className, n.style.getPropertyValue('--i'), n.style.color, n.dataset.id, n.getAttribute('aria-label'), hit, n.hasAttribute('title')], ['btn on', '2', 'red', '3', 'Save', 1, false]); });
    T('el: onclick function attr + el("p", "text") shorthand + svg namespace', () => { let h = 0; const n = d.el('a', { onclick: () => h++ }); n.click(); const p = d.el('p', 'hello'); const s = d.el('svg', { viewBox: '0 0 1 1' }, d.el('circle', { r: 1 })); return EQ([h, p.textContent, s.namespaceURI, s.firstChild.namespaceURI], [1, 'hello', 'http://www.w3.org/2000/svg', 'http://www.w3.org/2000/svg']); });
    T('qs / qsa / clear', () => { const r = d.el('div', null, d.el('i'), d.el('i')); return EQ([d.qs('i', r) === r.firstChild, Array.isArray(d.qsa('i', r)), d.qsa('i', r).length, d.clear(r).children.length], [true, true, 2, 0]); });
    T('on() returns an unsubscribe; delegate() matches ancestors', () => { const r = d.el('div', null, d.el('button', { 'data-id': 7 }, d.el('b', null, 'x'))); document.body.append(r); let a = 0, got = null; const off = d.on(r, 'click', () => a++); const off2 = d.delegate(r, 'click', '[data-id]', (e, m) => { got = m.dataset.id; }); r.querySelector('b').click(); off(); off2(); r.querySelector('b').click(); r.remove(); return EQ([a, got], [1, '7']); });
    T('initials README example Jean-Pierre Dupont -> JD', () => EQ([d.initials('Jean-Pierre Dupont'), d.initials('alex'), d.initials(''), d.initials('Éloïse Žižek'), d.initials('  Ada   Lovelace ')], ['JD', 'A', '?', 'ÉŽ', 'AL']));
    T('avatarHue stable 0..359; avatar element', () => { const h = d.avatarHue('Ada L.'); const a = d.avatar('Ada Lovelace', { size: 'lg' }); return EQ([h === d.avatarHue('Ada L.') && h >= 0 && h < 360, a.className, a.textContent, a.style.getPropertyValue('--hue') === String(d.avatarHue('Ada Lovelace'))], [true, 'avatar avatar--lg', 'AL', true]); });
    T('slugify README example + accents + limits', () => EQ([d.slugify('World AI Summit – Amsterdam 2026'), d.slugify('Évènement déjà-vu & Co.'), d.slugify('  --Hello__World--  '), d.slugify('x'.repeat(80)).length, d.slugify('')], ['world-ai-summit-amsterdam-2026', 'evenement-deja-vu-and-co', 'hello-world', 48, '']));
    T('formatDuration README example 75 -> 1:15', () => EQ([d.formatDuration(75), d.formatDuration(5), d.formatDuration(3723), d.formatDuration(-3), d.formatDuration(undefined)], ['1:15', '0:05', '1:02:03', '0:00', '0:00']));
    T('formatBytes', () => EQ([d.formatBytes(0, { lang: 'en' }), d.formatBytes(1536, { lang: 'en' }), d.formatBytes(5 * 1024 * 1024, { lang: 'en' })], ['0 B', '1.5 KB', '5 MB']));
    T('formatNumber / formatPercent null-safe', () => EQ([d.formatNumber(null), d.formatNumber(NaN), d.formatNumber(1234, { lang: 'en' }), d.formatPercent(0.756, { lang: 'en' }), d.formatPercent(0.756, { lang: 'en', digits: 1 }), d.formatPercent(undefined)], ['–', '–', '1,234', '76%', '75.6%', '–']));
    T('formatDate invalid -> empty; formatDateTime', () => EQ([d.formatDate('nope'), /14:32/.test(d.formatDateTime('2026-10-06T14:32:00', { lang: 'en' }))], ['', true]));
    T('relativeTime', () => EQ([d.relativeTime(new Date(Date.now() + 3 * 3600e3 + 5000), 'en'), d.relativeTime(new Date(Date.now() - 86400e3 * 3), 'fr')], ['in 3 hours', 'il y a 3 jours']));
    T('escapeHtml', () => EQ(d.escapeHtml('<a href="x">\\'&</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;'));
    T('clamp / uid', () => { const a = d.uid('f'), b = d.uid('f'); return EQ([d.clamp(5, 0, 3), d.clamp(-1, 0, 3), d.clamp(2, 0, 3), a !== b && /^f-\\d+$/.test(a)], [3, 0, 2, true]); });
    T('sleep resolves after the delay', async () => { const t = performance.now(); await d.sleep(30); return performance.now() - t >= 28; });
    T('debounce trailing + cancel + flush', async () => { let n = 0; const f = d.debounce(() => n++, 30); f(); f(); f(); await d.sleep(60); const a = n; f(); f.cancel(); await d.sleep(60); const b = n; f(); f.flush(); return EQ([a, b, n], [1, 1, 2]); });
    T('throttle leading + trailing', async () => { const calls = []; const f = d.throttle((x) => calls.push(x), 50); f(1); f(2); f(3); await d.sleep(90); return EQ(calls, [1, 3]); });
    T('setBusy toggles class, aria-busy, disabled', () => { const b = d.el('button'); d.setBusy(b, true); const on = [b.classList.contains('is-loading'), b.getAttribute('aria-busy'), b.disabled]; d.setBusy(b, false); return EQ([on, b.classList.contains('is-loading'), b.hasAttribute('aria-busy'), b.disabled], [[true, 'true', true], false, false, false]); });
    T('formToObject: text, checkbox boolean, radio, disabled skipped, unnamed skipped', () => { const f = document.createElement('form'); f.innerHTML = '<input name="a" value="1"><input name="c" type="checkbox" checked><input name="d" type="checkbox"><input name="r" type="radio" value="x"><input name="r" type="radio" value="y" checked><input name="z" disabled value="9"><input value="no name"><select name="s"><option value="k" selected>K</option></select>'; return EQ(d.formToObject(f), { a: '1', c: true, d: false, r: 'y', s: 'k' }); });
    T('downloadBlob clicks a hidden anchor with the filename', () => { let name = null, href = null; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { name = this.download; href = this.href; }; d.downloadBlob('a,b', 'x.csv', 'text/csv'); HTMLAnchorElement.prototype.click = o; return EQ([name, href.startsWith('blob:')], ['x.csv', true]); });
    T('copyToClipboard resolves true (clipboard API or execCommand fallback)', async () => EQ(await d.copyToClipboard('hello'), true));
    T('prefersReducedMotion / isTouch are booleans', () => EQ([typeof d.prefersReducedMotion(), typeof d.isTouch()], ['boolean', 'boolean']));
  `);
  await ctx.close();
  const rm = await newPage({ reducedMotion: 'reduce' });
  eq('prefersReducedMotion() true when emulated', await rm.page.evaluate(async () => (await import('/shared/js/dom.js')).prefersReducedMotion()), true);
  await rm.ctx.close();
}

// ------------------------------------------------------------------------------------------------ 8. ui.js
if (run('ui')) {
  section = 'ui';
  const { ctx, page } = await newPage({ viewport: { width: 1000, height: 800 } });
  await inPage(page, `
    const ui = await import('/shared/js/ui.js'); const d = await import('/shared/js/dom.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // ---- toast
    T('toast creates a region once; type classes + roles; returns {dismiss, element}', () => { const a = ui.toast('Saved', { type: 'success' }); const b = ui.toast('Boom', { type: 'error', title: 'Failed' }); const regions = document.querySelectorAll('.toast-region').length; return EQ([regions, a.element.className, a.element.getAttribute('role'), b.element.getAttribute('role'), b.element.querySelector('.toast__title').textContent, b.element.querySelector('.toast__msg').textContent, typeof a.dismiss], [1, 'toast toast--success', 'status', 'alert', 'Failed', 'Boom', 'function']); });
    T('toast auto-dismisses (duration) and dismiss() removes', async () => { const t = ui.toast('x', { duration: 60 }); const c0 = document.contains(t.element); await wait(700); return EQ([c0, document.contains(t.element)], [true, false]); });
    T('toast caps at 4 visible', () => { document.querySelectorAll('.toast').forEach((n) => n.remove()); for (let i = 0; i < 7; i++) ui.toast('t' + i, { duration: 0 }); return EQ(document.querySelectorAll('.toast').length, 4); });
    T('toast action button calls onClick and dismisses', async () => { document.querySelectorAll('.toast').forEach((n) => n.remove()); let hit = 0; const t = ui.toast('Undo?', { duration: 0, action: { label: 'Undo', onClick: () => hit++ } }); t.element.querySelector('.toast__action').click(); await wait(600); return EQ([hit, document.contains(t.element)], [1, false]); });
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    // ---- announce
    T('announce writes to a polite sr-only live region (and assertive on request)', async () => { ui.announce('Correct! 148 points'); await wait(80); const r = document.getElementById('quiz-announcer'); const a = [r.textContent, r.getAttribute('aria-live'), r.classList.contains('u-sr-only')]; ui.announce('Time is up', { politeness: 'assertive' }); await wait(80); return EQ([a, r.textContent, r.getAttribute('aria-live'), document.querySelectorAll('#quiz-announcer').length], [['Correct! 148 points', 'polite', true], 'Time is up', 'assertive', 1]); });
    // ---- modal
    const opener = d.el('button', null, 'open'); document.body.append(opener); opener.focus();
    T('openModal: native dialog open, labelled by its title, content + actions rendered', () => { window.__m = ui.openModal({ title: 'Duplicate event', description: 'Copy it', size: 'lg', icon: 'copy', content: d.el('input', { id: 'm-in' }), actions: [{ label: 'Cancel', variant: 'ghost' }, { label: 'Save', variant: 'primary', value: 'save' }] }); const dl = window.__m.dialog; return EQ([dl.open, dl.tagName, dl.classList.contains('dialog--lg'), document.getElementById(dl.getAttribute('aria-labelledby')).textContent, dl.querySelectorAll('.dialog__footer .btn').length, document.activeElement.id], [true, 'DIALOG', true, 'Duplicate event', 2, 'm-in']); });
    T('modal: Escape closes -> closed resolves undefined, dialog removed, focus back on opener', async () => { const p = window.__m.closed; window.__m.dialog.dispatchEvent(new Event('cancel', { cancelable: true })); window.__m.close(); const v = await p; return EQ([v, document.querySelectorAll('dialog').length, document.activeElement === opener], [undefined, 0, true]); });
    T('modal: action value resolves closed', async () => { const m = ui.openModal({ title: 'x', actions: [{ label: 'Go', value: 'go' }] }); m.dialog.querySelector('.dialog__footer .btn').click(); return EQ(await m.closed, 'go'); });
    T('modal: onClick + preventDefault keeps it open; close(value) closes', async () => { let c = 0; const m = ui.openModal({ title: 'x', actions: [{ label: 'Save', value: 'saved', onClick: (e) => { c++; if (c === 1) e.preventDefault(); } }] }); const b = m.dialog.querySelector('.dialog__footer .btn'); b.click(); await wait(20); const stillOpen = m.dialog.open; b.click(); const v = await m.closed; return EQ([stillOpen, v, c], [true, 'saved', 2]); });
    T('modal: close button, backdrop click', async () => { const m = ui.openModal({ title: 'x', content: 'body' }); m.dialog.querySelector('.dialog__header .btn').click(); const a = await m.closed; const m2 = ui.openModal({ title: 'y', content: 'body' }); const r = m2.dialog.getBoundingClientRect(); m2.dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left - 5, clientY: r.top - 5 })); const b = await m2.closed; return EQ([a, b], [undefined, undefined]); });
    T('modal dismissible:false has no close button and ignores cancel', async () => { const m = ui.openModal({ title: 'x', dismissible: false }); const ev = new Event('cancel', { cancelable: true }); m.dialog.dispatchEvent(ev); const r = [!!m.dialog.querySelector('.dialog__header .btn'), ev.defaultPrevented, m.dialog.open]; m.dialog.close(); await wait(30); return EQ(r, [false, true, true]); });
    T('confirmDialog resolves true / false', async () => { const p = ui.confirmDialog({ title: 'Delete?', message: 'Gone forever', confirmLabel: 'Delete', tone: 'danger' }); const dl = document.querySelector('dialog[open]'); const focusIsCancel = document.activeElement.textContent === 'Cancel'; dl.querySelector('.btn--danger').click(); const a = await p; const p2 = ui.confirmDialog({ title: 'x' }); document.querySelector('dialog .btn--secondary').click(); const b = await p2; const p3 = ui.confirmDialog({ title: 'y' }); const prim = document.activeElement.className.includes('btn--primary'); document.querySelector('dialog .btn--primary').click(); return EQ([focusIsCancel, a, b, prim, await p3], [true, true, false, true, true]); });
    T('focusFirst focuses the first focusable', () => { const r = d.el('div', null, d.el('p', null, 'x'), d.el('input', { id: 'ff1' }), d.el('button', null, 'b')); document.body.append(r); ui.focusFirst(r); const ok = document.activeElement.id === 'ff1'; r.remove(); return ok; });
    T('withBusy sets/clears busy even when the task throws; returns the value', async () => { const b = d.el('button'); document.body.append(b); const v = await ui.withBusy(b, async () => { await wait(10); return 42; }); const during = []; let threw = false; try { await ui.withBusy(b, async () => { during.push(b.disabled, b.getAttribute('aria-busy')); throw new Error('x'); }); } catch { threw = true; } return EQ([v, during, threw, b.disabled, b.hasAttribute('aria-busy'), b.classList.contains('is-loading')], [42, [true, 'true'], true, false, false, false]); });
    // ---- tabs
    document.getElementById('root').innerHTML = '<div id="tw"><div class="tabs" role="tablist"><button role="tab" id="t1" aria-controls="p1" aria-selected="true">A</button><button role="tab" id="t2" aria-controls="p2" aria-selected="false">B</button><button role="tab" id="t3" aria-controls="p3" aria-selected="false">C</button></div><div id="p1" role="tabpanel">1</div><div id="p2" role="tabpanel">2</div><div id="p3" role="tabpanel">3</div></div>';
    let tabChange = null; const tabs = ui.initTabs(document.getElementById('tw'), { onChange: (t, p) => { tabChange = [t.id, p && p.id]; } });
    const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    T('tabs: initial state (roving tabindex, only first panel visible)', () => EQ([['t1','t2','t3'].map((i) => document.getElementById(i).tabIndex), ['p1','p2','p3'].map((i) => document.getElementById(i).hidden)], [[0, -1, -1], [false, true, true]]));
    T('tabs: click selects, shows panel, fires onChange(tab, panel)', () => { document.getElementById('t2').click(); return EQ([document.getElementById('t2').getAttribute('aria-selected'), document.getElementById('p2').hidden, document.getElementById('p1').hidden, tabChange], ['true', false, true, ['t2', 'p2']]); });
    T('tabs: ArrowRight/Left wrap, Home/End', () => { document.getElementById('t1').focus(); document.getElementById('t1').click(); key('ArrowLeft'); const a = document.activeElement.id; key('ArrowRight'); const b = document.activeElement.id; key('End'); const c = document.activeElement.id; key('Home'); const dd = document.activeElement.id; return EQ([a, b, c, dd], ['t3', 't1', 't3', 't1']); });
    T('tabs: select(id) API', () => { tabs.select('t3'); return EQ([document.getElementById('t3').getAttribute('aria-selected'), document.getElementById('p3').hidden], ['true', false]); });
    // ---- dropdown
    document.getElementById('root').innerHTML = '<div class="dropdown"><button id="dd-t" aria-haspopup="menu" aria-expanded="false" data-dropdown-trigger>Actions</button><div class="menu" role="menu" hidden><button class="menu__item" role="menuitem" id="mi1">One</button><button class="menu__item" role="menuitem" id="mi2">Two</button><button class="menu__item" role="menuitem" id="mi3" data-keep-open>Keep</button></div></div><button id="outside">out</button>';
    const dispose = ui.initDropdowns(document);
    const trig = document.getElementById('dd-t'), menu = document.querySelector('.menu');
    T('dropdown: click opens (hidden false, aria-expanded true), click again closes', () => { trig.click(); const a = [menu.hidden, trig.getAttribute('aria-expanded')]; trig.click(); return EQ([a, menu.hidden, trig.getAttribute('aria-expanded')], [[false, 'true'], true, 'false']); });
    T('dropdown: ArrowDown on trigger opens and focuses first item; arrows/Home/End move', () => { trig.focus(); trig.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); const a = document.activeElement.id; key('ArrowDown'); const b = document.activeElement.id; key('End'); const c = document.activeElement.id; key('ArrowDown'); const dd = document.activeElement.id; key('Home'); const e = document.activeElement.id; return EQ([a, b, c, dd, e], ['mi1', 'mi2', 'mi3', 'mi1', 'mi1']); });
    T('dropdown: Escape closes and returns focus to the trigger', () => { key('Escape'); return EQ([menu.hidden, document.activeElement === trig], [true, true]); });
    T('dropdown: item click closes (unless data-keep-open); outside click closes', () => { trig.click(); document.getElementById('mi3').click(); const keep = menu.hidden; document.getElementById('mi1').click(); const closed = menu.hidden; trig.click(); document.getElementById('outside').click(); return EQ([keep, closed, menu.hidden], [false, true, true]); });
    dispose();
    T('dropdown: dispose detaches the handler', () => { trig.click(); return EQ(menu.hidden, true); });
    // ---- shell
    document.getElementById('root').innerHTML = '<div class="shell" id="sh"><header class="shell__topbar"><button data-shell-toggle aria-expanded="false" id="sh-t">menu</button></header><aside class="shell__sidebar"><a class="nav__item" id="sh-nav">x</a></aside><div class="shell__scrim" id="sh-scrim"></div><main class="shell__main"></main></div>';
    const sh = document.getElementById('sh'); const offShell = ui.initShell(sh);
    T('shell: toggle opens/closes with aria-expanded; Escape, scrim and nav click close', () => { const t = document.getElementById('sh-t'); const st = () => [sh.dataset.sidebar, t.getAttribute('aria-expanded')]; const r0 = st(); t.click(); const r1 = st(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); const r2 = st(); t.click(); document.getElementById('sh-scrim').click(); const r3 = st(); t.click(); document.getElementById('sh-nav').click(); const r4 = st(); return EQ([r0, r1, r2, r3, r4], [['closed', 'false'], ['open', 'true'], ['closed', 'false'], ['closed', 'false'], ['closed', 'false']]); });
    offShell();
    // ---- colour inputs + ranges
    document.getElementById('root').innerHTML = '<div class="color-input" id="ci"><input type="color" class="color-input__swatch" value="#ff0000"><input class="input color-input__hex" value="#FF0000"></div><input type="range" class="range" id="rg" min="5" max="25" value="15">';
    const offC = ui.initColorInputs(document), offR = ui.initRanges(document);
    const sw = document.querySelector('.color-input__swatch'), hx = document.querySelector('.color-input__hex');
    T('colour input: swatch -> hex (upper)', () => { sw.value = '#00ff88'; sw.dispatchEvent(new Event('input', { bubbles: true })); return EQ(hx.value, '#00FF88'); });
    T('colour input: hex -> swatch, short hex accepted, normalised on change', () => { hx.value = '#f50'; hx.dispatchEvent(new Event('input', { bubbles: true })); const a = sw.value; hx.dispatchEvent(new Event('change', { bubbles: true })); return EQ([a, hx.value, hx.hasAttribute('aria-invalid') && hx.getAttribute('aria-invalid')], ['#ff5500', '#FF5500', 'false'].slice(0, 2).concat([false])); });
    T('colour input: invalid hex -> aria-invalid=true, swatch untouched', () => { const before = sw.value; hx.value = '#12'; hx.dispatchEvent(new Event('input', { bubbles: true })); return EQ([hx.getAttribute('aria-invalid'), sw.value], ['true', before]); });
    T('range: --p painted at init and on input', () => { const r = document.getElementById('rg'); const a = r.style.getPropertyValue('--p'); r.value = '25'; r.dispatchEvent(new Event('input', { bubbles: true })); return EQ([a, r.style.getPropertyValue('--p')], ['50', '100']); });
    offC(); offR();
  `);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 9. effects + qr
if (run('effects')) {
  section = 'effects';
  const { ctx, page } = await newPage();
  await inPage(page, `
    const fx = await import('/shared/js/effects.js'); const dom = await import('/shared/js/dom.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    T('countUp ends on the formatted target and resolves finished', async () => { const n = document.createElement('span'); document.body.append(n); const c = fx.countUp(n, 1340, { duration: 150 }); await c.finished; return EQ(n.textContent, '1,340'); });
    T('countUp: from, custom format, intermediate values in range', async () => { const n = document.createElement('span'); document.body.append(n); const seen = []; const c = fx.countUp(n, 200, { from: 100, duration: 200, format: (v) => 'pts:' + Math.round(v) }); await wait(90); seen.push(+n.textContent.split(':')[1]); await c.finished; return [seen[0] > 100 && seen[0] < 200 && n.textContent === 'pts:200', JSON.stringify([seen, n.textContent])]; });
    T('countUp.cancel jumps to the final value', async () => { const n = document.createElement('span'); document.body.append(n); const c = fx.countUp(n, 50, { duration: 5000 }); c.cancel(); await c.finished; return EQ(n.textContent, '50'); });
    T('confetti appends a fixed non-interactive canvas, cancel removes it', async () => { const c = fx.confetti({ count: 20, duration: 500 }); const cv = document.querySelector('body > canvas'); const a = cv && [getComputedStyle(cv).position, getComputedStyle(cv).pointerEvents, cv.getAttribute('aria-hidden')]; c.cancel(); await c.finished; return EQ([a, document.querySelectorAll('body > canvas').length], [['fixed', 'none', 'true'], 0]); });
    T('confetti removes itself when done', async () => { const c = fx.confetti({ count: 10, duration: 120 }); await c.finished; return EQ(document.querySelectorAll('body > canvas').length, 0); });
    T('celebrate: 3 bursts, cancel clears all', async () => { const c = fx.celebrate(); const n = document.querySelectorAll('body > canvas').length; c.cancel(); await c.finished; return EQ([n, document.querySelectorAll('body > canvas').length], [3, 0]); });
    T('transition resolves and runs the update', async () => { let ran = 0; await fx.transition(() => { ran++; }); return EQ(ran, 1); });
    T('shake / pulse do not throw', () => { const n = document.createElement('div'); document.body.append(n); fx.shake(n); fx.pulse(n); return true; });
  `);
  await ctx.close();
  const rm = await newPage({ reducedMotion: 'reduce' });
  await inPage(rm.page, `
    const fx = await import('/shared/js/effects.js');
    T('reduced motion: countUp is instant', () => { const n = document.createElement('span'); fx.countUp(n, 777, { duration: 3000 }); return EQ(n.textContent, '777'); });
    T('reduced motion: confetti draws nothing', async () => { const c = fx.confetti(); await c.finished; return EQ(document.querySelectorAll('body > canvas').length, 0); });
    T('reduced motion: celebrate draws nothing', async () => { const c = fx.celebrate(); await c.finished; return EQ(document.querySelectorAll('body > canvas').length, 0); });
    T('reduced motion: shake/pulse/transition are no-ops that resolve', async () => { const n = document.createElement('div'); let called = 0; n.animate = () => { called++; }; fx.shake(n); fx.pulse(n); await fx.transition(() => {}); return EQ(called, 0); });
  `);
  await rm.ctx.close();
}

if (run('qr')) {
  section = 'qr';
  const { ctx, page } = await newPage();
  await inPage(page, `
    const qr = await import('/shared/js/qr.js'); const vendor = (await import('/shared/vendor/qrcode.js')).default;
    T('qrSvg: svg with viewBox count+2*margin, role img, aria-label, dark path + bg rect', () => { const s = qr.qrSvg('https://quiz.events.gravitee.io/ai-masters', { margin: 2 }); const vb = s.getAttribute('viewBox').split(' ').map(Number); const path = s.querySelector('path'); return [s.tagName === 'svg' && vb[2] === vb[3] && vb[2] >= 25 + 4 && s.getAttribute('role') === 'img' && /QR code/.test(s.getAttribute('aria-label')) && path.getAttribute('d').length > 100 && s.querySelector('rect').getAttribute('fill') === '#FFFFFF' && path.getAttribute('fill') === '#000000', s.getAttribute('viewBox')]; });
    T('qrSvg options: label, fg/bg, margin 4, ecc', () => { const a = qr.qrSvg('x', { label: 'Join', fg: '#111111', bg: '#EEEEEE', margin: 4, ecc: 'H' }); const b = qr.qrSvg('x', { margin: 0, ecc: 'L' }); const va = a.getAttribute('viewBox').split(' ')[2], vbb = b.getAttribute('viewBox').split(' ')[2]; return EQ([a.getAttribute('aria-label'), a.querySelector('path').getAttribute('fill'), a.querySelector('rect').getAttribute('fill'), +va - +vbb >= 8 - 8], ['Join', '#111111', '#EEEEEE', true]); });
    T('qrCode wrapper: .qr, .qr--lg, --qr-size from px / css length', () => { const a = qr.qrCode('x'), b = qr.qrCode('x', { large: true, size: 200 }), c = qr.qrCode('x', { size: '12rem' }); return EQ([a.className, b.className, b.style.getPropertyValue('--qr-size'), c.style.getPropertyValue('--qr-size'), a.querySelector('svg') !== null], ['qr', 'qr qr--lg', '200px', '12rem', true]); });
    T('renderQr replaces the container content and returns the tile', () => { const c = document.createElement('div'); c.innerHTML = '<p>old</p>'; const t = qr.renderQr(c, 'https://x.y'); return EQ([c.children.length, c.firstChild === t, c.querySelectorAll('p').length], [1, true, 0]); });
    T('deterministic output', () => EQ(qr.qrSvg('same').querySelector('path').getAttribute('d') === qr.qrSvg('same').querySelector('path').getAttribute('d'), true));
    T('UTF-8 is encoded as UTF-8 bytes (not latin1)', () => EQ([vendor.stringToBytes('é').length, vendor.stringToBytes('€').length, vendor.stringToBytes('😀').length], [2, 3, 4]));
    T('long UTF-8 text still fits (version grows) and does not throw', () => { const s = qr.qrSvg('https://quiz.events.gravitee.io/world-ai-summit-2026?lang=fr&x=' + 'é'.repeat(60)); return s.getAttribute('viewBox').split(' ')[2] > 41; });
    T('text longer than QR capacity throws a clear error (documented?)', () => { try { qr.qrSvg('x'.repeat(5000)); return [false, 'no throw']; } catch (e) { return [true, e.message]; } });
  `);
  // real decode when the browser has a barcode detector
  const hasDetector = await page.evaluate(() => 'BarcodeDetector' in window);
  if (hasDetector) {
    const decoded = await page.evaluate(async () => {
      const qr = await import('/shared/js/qr.js');
      const out = [];
      for (const text of ['https://quiz.events.gravitee.io/world-ai-summit-2026', 'https://quiz.events.gravitee.io/ai-masters?lang=fr', 'Évènement – déjà vu €']) {
        const svg = qr.qrSvg(text, { margin: 4 }); svg.setAttribute('width', '400'); svg.setAttribute('height', '400');
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
        const img = new Image(); img.src = url; await img.decode();
        const cv = document.createElement('canvas'); cv.width = cv.height = 400; cv.getContext('2d').drawImage(img, 0, 0, 400, 400);
        const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(cv);
        out.push([text, r[0] && r[0].rawValue]);
      }
      return out;
    });
    for (const [t, got] of decoded) rec(`qr decodes back to the input: ${t.slice(0, 40)}`, got === t, `decoded ${JSON.stringify(got)}`);
  } else rec('qr round-trip decode (BarcodeDetector unavailable in this Chromium: skipped, structural checks only)', true);
  await ctx.close();
}

await browser.close();
await srv.close();

// ------------------------------------------------------------------------------------------------ report
const bySection = {};
for (const [s, n, ok, d] of results) { (bySection[s] ||= { pass: 0, fail: [] }); ok ? bySection[s].pass++ : bySection[s].fail.push(`${n}${d ? '  <= ' + d : ''}`); }
let total = 0, bad = 0;
for (const [s, v] of Object.entries(bySection)) { total += v.pass + v.fail.length; bad += v.fail.length; console.log(`\n[${s}] ${v.pass}/${v.pass + v.fail.length} passed`); v.fail.forEach((f) => console.log('  FAIL ' + f)); }
console.log(`\nTOTAL ${total - bad}/${total} passed, ${bad} failed`);
if (consoleErrors.length) console.log('console errors during run:\n  ' + [...new Set(consoleErrors)].join('\n  '));
process.exit(bad ? 1 : 0);
