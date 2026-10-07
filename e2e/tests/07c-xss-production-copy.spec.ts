/**
 * (7) XSS regression, part 3: the REAL production data.
 *
 * A copy of the production database lives in a separate backend (default http://localhost:8190/api, override with
 * PROD_COPY_API / PROD_COPY_USER / PROD_COPY_PASSWORD). It holds the stored-XSS probes the external tester left behind
 * (players "PoC<img src=x onerror=alert(document.domain)>", "PoC2<img ... document.title ...>", "ZtestZ<x-probe-aa>", each
 * with a completed game) next to 8 genuine results and 140 real questions.
 *
 * The apps are served by the normal stack but every /api call of the page is answered by that copy (support/xss.ts
 * proxyApiTo), so the real rows are rendered by the real code. The suite is skipped when the copy is not running.
 */
import { test, expect } from '../support/fixtures';
import { assertNothingExecuted, prodCopy, proxyApiTo } from '../support/xss';
import { dialog } from '../support/admin';
import { horizontalOverflow } from '../support/ui';
import type { Page } from '@playwright/test';

let prod: { base: string; token: string } | null = null;
let eventId = 1;

test.beforeAll(async () => {
  prod = await prodCopy();
  if (prod) {
    const list = await (await fetch(`${prod.base}/events`)).json();
    const live = list.find((e: any) => e.slug === 'api-masters') || list[0];
    if (live) {
      const admin = await (await fetch(`${prod.base}/admin/events`, { headers: { Authorization: `Bearer ${prod.token}` } })).json();
      eventId = admin.find((e: any) => e.slug === live.slug)?.id ?? 1;
    }
  }
});

test.beforeEach(async ({ page }) => {
  test.skip(!prod, 'the production-data copy is not running (set PROD_COPY_API, default http://localhost:8190/api)');
  await proxyApiTo(page, prod!.base, prod!.token);
});

test.describe('public pages rendered from production data', () => {
  test('scoreboard shows the probe players as inert text', async ({ page }) => {
    await page.goto('/api-masters/scoreboard?limit=20');
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    const names = await page.locator('.podium__name, .lb__name').allInnerTexts();
    expect(names.join('\n')).toContain('PoC<img src=x onerror=alert(do');
    expect(names.join('\n')).toContain('ZtestZ<x-probe-aa> P.');
    await assertNothingExecuted(page, 'production scoreboard');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    // and the rotating statistics view (top scorer name etc.)
    await page.goto('/api-masters/scoreboard?limit=20&rotate=1&lang=fr&theme=light');
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await assertNothingExecuted(page, 'production scoreboard (rotate)');
  });

  test('hub and landing page of the production event', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('article.hub-card').first()).toBeVisible();
    await assertNothingExecuted(page, 'production hub');
    await page.goto('/api-masters');
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    await assertNothingExecuted(page, 'production landing');
  });
});

test.describe('admin console rendered from production data', () => {
  test.use({ asAdmin: true });

  const open = async (page: Page, tab: string) => {
    await page.goto(`/admin/#/events/${eventId}/${tab}`);
    await expect(page.locator(`[data-view="${tab}"]`)).toBeVisible();
  };

  test('results: every real row, the probes included, then search and the detail dialogs', async ({ page }) => {
    await open(page, 'results');
    await page.getByRole('combobox', { name: 'Games to show' }).selectOption({ label: 'All games' });
    await expect(page.getByRole('row', { name: /PoC<img src=x onerror=alert\(document\.domain\)>/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /ZtestZ<x-probe-aa>/ })).toBeVisible();
    await assertNothingExecuted(page, 'production results');

    await page.getByRole('searchbox', { name: 'Search players by name or email' }).fill('PoC');
    await expect(page.locator('table tbody tr')).toHaveCount(2);
    await assertNothingExecuted(page, 'production results (search)');

    for (const label of [/View answers of PoC<img/, /View answers of PoC2/]) {
      await page.getByRole('button', { name: label }).first().click();
      await expect(dialog(page)).toBeVisible();
      await assertNothingExecuted(page, 'production result detail');
      await dialog(page).getByRole('button', { name: 'Close' }).last().click();
    }
    await page.getByRole('button', { name: /Edit score of PoC2/ }).click();
    await assertNothingExecuted(page, 'production score editor');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Delete result of PoC2/ }).click();
    await assertNothingExecuted(page, 'production delete dialog');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  });

  test('events list, overview, categories, questions, settings and appearance', async ({ page }) => {
    await page.goto('/admin/#/events');
    await expect(page.locator('article.admin-event').first()).toBeVisible();
    await assertNothingExecuted(page, 'production events list');
    for (const tab of ['overview', 'categories', 'questions', 'settings', 'appearance']) {
      await open(page, tab);
      await assertNothingExecuted(page, `production ${tab}`);
    }
  });
});
