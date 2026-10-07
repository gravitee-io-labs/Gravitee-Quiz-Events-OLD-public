#!/usr/bin/env node
// Loads the styleguide (docs + every ?screen=) under the production Content-Security-Policy of ARCHITECTURE section 7 and fails on any
// violation, missing font, missing icon or console error. The policy is injected by Playwright (no extra server/port needed).
//   cd <repo> && python3 -m http.server 8300 &   node shared/tools/test-csp.mjs [--base http://localhost:8300] [--page /shared/styleguide.html]
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(join(here, '..', '..', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs')).href);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8300');
const PAGE = opt('page', '/shared/styleguide.html');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const browser = await chromium.launch();
let failed = 0;
for (const query of ['', '?screen=landing', '?screen=game', '?screen=results', '?screen=scoreboard', '?screen=hub', '?screen=admin', '?screen=branding']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if ((headers['content-type'] || '').includes('text/html')) headers['content-security-policy'] = CSP;
    await route.fulfill({ response: res, headers });
  });
  const hosts = new Set();
  page.on('request', (r) => hosts.add(new URL(r.url()).origin));
  await page.goto(`${BASE}${PAGE}${query}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({
    csp: window.__csp,
    inter: document.fonts.check('16px Inter'), display: document.fonts.check('700 32px "Bricolage Grotesque"'),
    icons: [...document.querySelectorAll('svg.icon')].filter((s) => s.getBoundingClientRect().width > 4).length,
    iconPainted: (() => { const s = [...document.querySelectorAll('svg.icon')].find((x) => x.getBoundingClientRect().width > 4); try { return !!s && s.querySelector('use').getBBox().width > 0; } catch { return false; } })(),
    sheets: document.styleSheets.length,
  }));
  if (info.csp.length) problems.push('CSP violations: ' + info.csp.join('; '));
  if (!info.inter || !info.display) problems.push(`fonts not loaded (Inter ${info.inter}, Bricolage ${info.display})`);
  if (info.icons < 1 || !info.iconPainted) problems.push(`icons missing (${info.icons} rendered)`);
  if (hosts.size > 1) problems.push('requests to other origins: ' + [...hosts].join(', '));
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${PAGE}${query || ''}  icons:${info.icons} fonts:${info.inter && info.display}`);
  problems.slice(0, 8).forEach((p) => console.log('   - ' + p));
  failed += problems.length;
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} problem(s)` : 'CSP OK: zero violations, same-origin only');
process.exit(failed ? 1 : 0);
