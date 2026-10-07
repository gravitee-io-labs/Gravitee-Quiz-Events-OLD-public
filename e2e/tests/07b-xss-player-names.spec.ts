/**
 * (7) XSS regression, part 2: hostile PLAYER names.
 *
 * The hardened backend refuses markup characters in names (422), so a new probe like the ones the external tester left
 * in production cannot be registered any more. But those rows still exist in the production database and the public
 * scoreboard prints "First L." with the first name in full. So the front ends must stay safe on their own:
 *   - the registration form and the API refuse the three real probes;
 *   - the scoreboard (REST + SSE) and the admin results (list + detail) are fed the real probe names by intercepting the
 *     API responses, exactly as the legacy rows would be served, and must show them as inert text.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { call, playViaApi } from '../support/api';
import { assertNothingExecuted, entry, hostilePlayersInAdminResults, REAL_PROBES, stubScoreboard, VECTORS } from '../support/xss';
import { gotoTab, dialog } from '../support/admin';
import { openEvent, fillRegistration, playButton, submitRegistration, horizontalOverflow } from '../support/ui';
import type { Page } from '@playwright/test';

let ev: TestEvent;
test.beforeAll(async ({ events }) => {
  ev = await events.create({ tag: 'xss-names', questions: 6, perGame: 3, timer: 10 });
  await playViaApi(ev.slug, { first_name: 'Normal', last_name: 'Person', green: 3 });
});

const LEGACY_ROWS = [
  entry(9001, 1, `${REAL_PROBES[0].slice(0, 30)} X.`, 900),
  entry(9002, 2, `${REAL_PROBES[1].slice(0, 30)} X.`, 800),
  entry(9003, 3, `${REAL_PROBES[2]} P.`, 700),
  entry(9004, 4, `${VECTORS.svg} S.`, 600),
  entry(9005, 5, `${VECTORS.script.slice(0, 40)} Q.`, 500),
  entry(9006, 6, `${VECTORS.iframe.slice(0, 40)} I.`, 400),
  entry(9007, 7, `${VECTORS.closeTitle} T.`, 300),
  entry(9008, 8, `${VECTORS.rtl} R.`, 200),
  entry(9009, 9, `${'W'.repeat(60)} L.`, 100),
];

test.describe('registration refuses the real probes', () => {
  test('API: 422 on first and last name, nothing is stored', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'HTTP-level check, identical in every browser');
    for (const probe of REAL_PROBES) {
      for (const field of ['first_name', 'last_name'] as const) {
        const body = { first_name: 'Probe', last_name: 'Tester', email: 'probe@e2e.example.com', [field]: probe };
        const res = await call('POST', `/events/${ev.slug}/players`, body, { raw: true });
        expect(res.status, `${field}=${probe}`).toBe(422);
      }
    }
  });

  test('form: the same probes are caught before any request is sent', async ({ page }) => {
    let registrations = 0;
    page.on('request', (r) => { if (/\/players$/.test(r.url()) && r.method() === 'POST') registrations += 1; });
    await openEvent(page, ev.slug);
    await playButton(page).click();
    for (const probe of REAL_PROBES) {
      await fillRegistration(page, { first: probe, last: 'Tester' });
      await submitRegistration(page);
      await expect(page.locator('main[data-view="register"]')).toBeVisible();
      await expect(page.locator('.field--invalid').first()).toBeVisible();
      await assertNothingExecuted(page, 'registration with a probe');
    }
    expect(registrations).toBe(0);
  });
});

async function expectLegacyNames(page: Page) {
  const board = page.locator('#sb');
  await expect(board).toHaveAttribute('data-state', 'ready');
  // the probes are on screen as TEXT
  await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toContainText('PoC<img src=x onerror=alert(do');
  await expect(page.locator('.podium__place[data-rank="3"] .podium__name')).toHaveText('ZtestZ<x-probe-aa> P.');
  await expect(page.locator('.lb__row[data-rank="4"] .lb__name')).toContainText('<svg onload=window.__xss=3>');
  await assertNothingExecuted(page, 'scoreboard with probe names');
  // the layout survives 60-character names
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
}

test.describe('scoreboard fed with the legacy rows', () => {
  test('SSE snapshot', async ({ page }) => {
    await stubScoreboard(page, LEGACY_ROWS);
    await page.goto(`/${ev.slug}/scoreboard`);
    await expectLegacyNames(page);
  });

  test('rotating stats view and the French / light variants', async ({ page }) => {
    await stubScoreboard(page, LEGACY_ROWS);
    await page.goto(`/${ev.slug}/scoreboard?rotate=1&lang=fr&theme=light`);
    await expectLegacyNames(page);
  });
});

test.describe('scoreboard fed with the legacy rows, stream unavailable', () => {
  // the browser logs the refused stream connections: that is the point of this test
  test.use({ expectedConsole: /Failed to load resource|404|ERR_FAILED|NetworkError|establish a connection|stream/i });

  test('polling fallback', async ({ page }) => {
    // REST only: the stream answers 404 so the page falls back to polling
    await page.route(/\/scoreboard\/stream/, (route) => route.fulfill({ status: 404, json: { detail: 'Not found' } }));
    await page.route(/\/api\/events\/[^/]+\/scoreboard(\?.*)?$/, (route) => route.fulfill({ json: LEGACY_ROWS }));
    await page.goto(`/${ev.slug}/scoreboard`);
    await expectLegacyNames(page);
  });

});

test.describe('admin results fed with the legacy rows', () => {
  test.use({ asAdmin: true });

  test('list, search, detail dialog and score editor show the probes as text', async ({ page }) => {
    await hostilePlayersInAdminResults(page, { first_name: REAL_PROBES[1], last_name: REAL_PROBES[0], email: 'ZtestZ<x-probe-aa>@e2e.example.com', phone_number: VECTORS.svg });
    await gotoTab(page, ev, 'results');
    const row = page.getByRole('row', { name: /PoC2<img src=x onerror=/ });
    await expect(row).toBeVisible();
    await assertNothingExecuted(page, 'admin results list');
    // the search runs on the server against the real rows (the player is really called "Normal Person")
    await page.getByRole('searchbox', { name: 'Search players by name or email' }).fill('Normal');
    await expect(row).toBeVisible();
    await assertNothingExecuted(page, 'admin results search');
    await page.getByRole('button', { name: /View answers of PoC2/ }).click();
    await expect(dialog(page)).toContainText(REAL_PROBES[1]);
    await assertNothingExecuted(page, 'admin result detail');
    await dialog(page).getByRole('button', { name: 'Edit score' }).click();
    await expect(dialog(page)).toContainText('currently');
    await assertNothingExecuted(page, 'admin score editor');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Delete result of PoC2/ }).click();
    await expect(dialog(page)).toContainText(REAL_PROBES[1]);
    await assertNothingExecuted(page, 'admin delete result dialog');
  });
});

test.describe('names that the API does accept but that look dangerous', () => {
  test('are shown as plain text everywhere a player sees them', async ({ page }) => {
    test.setTimeout(60_000);
    const first = VECTORS.entity; // "&lt;img src=x onerror=window.__xss=11&gt;"
    await openEvent(page, ev.slug);
    await playButton(page).click();
    await fillRegistration(page, { first, last: VECTORS.attr });
    await submitRegistration(page);
    await expect(page.locator('.ev-sub')).toContainText(first);
    await assertNothingExecuted(page, 'rules');
    // the literal text "&lt;" stays literal: it was not decoded into "<"
    expect(await page.locator('.ev-sub').innerText()).toContain('&lt;img src=x');
    expect(await page.locator('.ev-sub').innerText()).not.toContain('<img');
  });
});
