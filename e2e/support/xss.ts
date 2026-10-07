/**
 * XSS regression helpers: hostile strings, "did anything execute?" checks, and API interception helpers that feed
 * hostile data to the apps.
 *
 * Markers: every payload that would run sets window.__xss to a number or rewrites document.title to
 * "XSS-EXECUTED-<domain>". None of them may ever fire. Native dialogs (alert / confirm) and CSP violations are caught by the
 * `guard` fixture for every test; the checks below add the DOM side: nothing was parsed as HTML.
 */
import { expect, type Page, type Route } from '@playwright/test';

/** The payloads left by the external security tester in the production players table (verbatim). */
export const REAL_PROBES = [
  'PoC<img src=x onerror=alert(document.domain)>',
  'PoC2<img src=x onerror="document.title=\'XSS-EXECUTED-\'+document.domain">',
  'ZtestZ<x-probe-aa>',
];

/** More classic vectors, one per injection context. */
export const VECTORS = {
  img: '<img src=x onerror=window.__xss=1>',
  script: '"><script>window.__xss=2</script>',
  svg: '<svg onload=window.__xss=3>',
  closeTitle: '</title><img src=x onerror=window.__xss=4>',
  iframe: '<iframe srcdoc="<script>parent.__xss=5</script>"></iframe>',
  attr: '" onmouseover="window.__xss=6" x="',
  quote: "';window.__xss=7;//",
  js: 'javascript:window.__xss=8',
  template: '{{constructor.constructor("window.__xss=9")()}} ${window.__xss=10}',
  entity: '&lt;img src=x onerror=window.__xss=11&gt;',
  customTag: '<x-probe-aa>',
  bold: '<b>bold</b>',
  rtl: '‮gnp.exe‬',
};

/** Selectors of elements that can only exist if a payload was parsed as markup. */
const INJECTED = [
  'img[src="x"]', 'x-probe-aa', 'iframe[srcdoc]', 'script:not([src])', 'svg[onload]', 'b:not([class])',
  '[onerror]', '[onload]', '[onmouseover]', '[onclick]', 'a[href^="javascript:"]',
].join(', ');

export interface XssState { flag: unknown; title: string; injected: number; handlers: string[]; }

export async function xssState(page: Page): Promise<XssState> {
  return page.evaluate((selector) => ({
    flag: (window as any).__xss,
    title: document.title,
    injected: document.querySelectorAll(selector).length,
    handlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.outerHTML.slice(0, 120)),
  }), INJECTED);
}

/** Nothing executed and nothing was injected into the DOM of the page as it is now. */
export async function assertNothingExecuted(page: Page, where = page.url()) {
  const s = await xssState(page);
  expect(s.flag, `window.__xss was set on ${where}`).toBeUndefined();
  expect(s.title, `document.title was rewritten by a payload on ${where}`).not.toMatch(/XSS-EXECUTED-(localhost|127\.0\.0\.1)/);
  expect(s.injected, `injected elements on ${where}`).toBe(0);
  expect(s.handlers, `inline event handler attributes on ${where}`).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// interception helpers
// ---------------------------------------------------------------------------------------------
const sseBody = (entries: unknown[]) => `data: ${JSON.stringify({ entries, total_players: entries.length, total_games: entries.length })}\n\n`;

export function entry(id: number, rank: number, name: string, score = 1000 - rank * 10) {
  return { id, rank, player_name: name, score, correct_answers: 10, wrong_answers: 5, completed_at: new Date(Date.now() - rank * 60_000).toISOString() };
}

/** Make the scoreboard of a page (REST + SSE) return exactly these entries. */
export async function stubScoreboard(page: Page, entries: unknown[]) {
  await page.route(/\/api\/events\/[^/]+\/scoreboard\/stream/, (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: sseBody(entries),
  }));
  await page.route(/\/api\/events\/[^/]+\/scoreboard(\?.*)?$/, (route) => route.fulfill({ json: entries }));
}

/** Rewrite the player part of the admin results responses (list and detail) with hostile values. */
export async function hostilePlayersInAdminResults(page: Page, who: { first_name: string; last_name: string; email: string; phone_number?: string }) {
  const patch = async (route: Route) => {
    try {
      const res = await route.fetch();
      const json = await res.json();
      const rewrite = (item: any) => { if (item?.player) Object.assign(item.player, who); };
      if (Array.isArray(json?.items)) json.items.forEach(rewrite); else rewrite(json);
      await route.fulfill({ response: res, json });
    } catch {
      // the page navigated away or the test ended while this request was in flight: nothing left to answer
    }
  };
  await page.route(/\/api\/admin\/events\/\d+\/results(\?.*)?$/, patch);
  await page.route(/\/api\/admin\/results\/\d+$/, patch);
}

/**
 * Serve the API of a page from ANOTHER backend (the production-data copy): same paths, the admin calls carry that
 * backend's own token, the SSE stream is synthesised from its REST scoreboard (route.fetch cannot stream).
 */
export async function proxyApiTo(page: Page, base: string, adminToken: string) {
  await page.route('**/api/**', async (route) => {
    try {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, '');
      const stream = path.match(/^\/events\/([^/]+)\/scoreboard\/stream\/?$/);
      if (stream) {
        const limit = url.searchParams.get('limit') || '10';
        const rows = await (await fetch(`${base}/events/${stream[1]}/scoreboard?limit=${limit}`)).json();
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: sseBody(rows) });
        return;
      }
      const headers = { ...route.request().headers() };
      delete headers.host;
      if (path.startsWith('/admin') || path.startsWith('/auth')) headers.authorization = `Bearer ${adminToken}`;
      const res = await route.fetch({ url: `${base}${path}${url.search}`, headers });
      await route.fulfill({ response: res });
    } catch {
      // the page navigated away or the test ended while this request was in flight: nothing left to answer
    }
  });
}

export async function prodCopy(): Promise<{ base: string; token: string } | null> {
  const base = (process.env.PROD_COPY_API || 'http://localhost:8190/api').replace(/\/+$/, '');
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    if (!health.ok) return null;
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: process.env.PROD_COPY_USER || 'admin', password: process.env.PROD_COPY_PASSWORD || 'admin' }),
      signal: AbortSignal.timeout(2500),
    });
    if (!login.ok) return null;
    return { base, token: (await login.json()).access_token };
  } catch {
    return null;
  }
}
