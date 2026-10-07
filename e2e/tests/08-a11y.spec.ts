/**
 * (8) Accessibility smoke with axe-core: no serious or critical violation on the hub, a landing page, the question
 * screen, the results, the scoreboard and the admin events list (dark and light themes).
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { playViaApi } from '../support/api';
import { expectNoSeriousA11yViolations as axe } from '../support/a11y';
import { gotoAdmin, gotoTab } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, fillRegistration, playButton, setThemeViaUi } from '../support/ui';
import type { Page, TestInfo } from '@playwright/test';

let ev: TestEvent;
test.beforeAll(async ({ events }) => {
  ev = await events.create({ tag: 'a11y', questions: 6, perGame: 3, timer: 20, twoChoices: 2, consentEn: 'I agree to the QA terms.', primary: '#FC5607', accent: '#FF9A52' });
  await playViaApi(ev.slug, { first_name: 'Ada', last_name: 'Lovelace', consent: true, green: 3, seconds: 1 });
  await playViaApi(ev.slug, { first_name: 'Alan', last_name: 'Turing', consent: true, green: 2, seconds: 2 });
  await playViaApi(ev.slug, { first_name: 'Grace', last_name: 'Hopper', consent: true, green: 1, seconds: 3 });
  await playViaApi(ev.slug, { first_name: 'Linus', last_name: 'Torvalds', consent: true, green: 1, skip: 1, seconds: 4 });
});

/** Scan the page in the dark theme, switch the theme with the app bar button (no reload) and scan again in the light theme. */
async function bothThemes(page: Page, testInfo: TestInfo, name: string) {
  await setThemeViaUi(page, 'dark');
  await axe(page, testInfo, `${name}-dark`);
  await setThemeViaUi(page, 'light');
  await axe(page, testInfo, `${name}-light`);
  await setThemeViaUi(page, 'dark');
}

test.describe('player app (dark and light theme)', () => {
  test('hub', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.locator('article.hub-card').first()).toBeVisible();
    await bothThemes(page, testInfo, 'hub');
  });

  test('event landing, registration form and rules', async ({ page }, testInfo) => {
    await openEvent(page, ev.slug);
    await expect(page.locator('[data-action="play"]')).toBeVisible();
    await bothThemes(page, testInfo, 'landing');
    await playButton(page).click();
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await bothThemes(page, testInfo, 'register');
    await fillRegistration(page, { first: 'Ax', last: 'E', consent: true });
    await page.locator('.ev-submit').click();
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await bothThemes(page, testInfo, 'rules');
  });

  test('question screen, results and review', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Ax', last: 'E', consent: true });
    await startGame(page);
    await bothThemes(page, testInfo, 'question');
    await playByKeyboard(page, ['g', 'r', 'g']);
    await readResults(page);
    await bothThemes(page, testInfo, 'results');
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('main[data-view="review"]')).toBeVisible();
    await bothThemes(page, testInfo, 'review');
  });

  test('scoreboard (podium, rows, rotating stats and the empty state)', async ({ page, events }, testInfo) => {
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await bothThemes(page, testInfo, 'scoreboard');
    await page.goto(`/${ev.slug}/scoreboard?rotate=1`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await bothThemes(page, testInfo, 'scoreboard-rotate');
    const empty = await events.create({ tag: 'a11y-empty', questions: 6, perGame: 3 });
    await page.goto(`/${empty.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'empty');
    await bothThemes(page, testInfo, 'scoreboard-empty');
  });
});

test.describe('admin console', () => {
  test('login screen', async ({ page }, testInfo) => {
    await gotoAdmin(page, '#/login');
    await expect(page.getByRole('heading', { name: 'Quiz Admin' })).toBeVisible();
    await axe(page, testInfo, 'admin-login');
  });

  test.describe('signed in', () => {
    test.use({ asAdmin: true });

    test('events list', async ({ page }, testInfo) => {
      await gotoAdmin(page, '#/events');
      await expect(page.locator('article.admin-event').first()).toBeVisible();
      await axe(page, testInfo, 'admin-events');
    });

    test('event tabs: overview, questions, results, settings', async ({ page }, testInfo) => {
      for (const tab of ['overview', 'questions', 'categories', 'results', 'settings', 'appearance'] as const) {
        await gotoTab(page, ev, tab);
        await expect(page.locator(`[data-view="${tab}"] h1`).first()).toBeVisible();
        await axe(page, testInfo, `admin-${tab}`);
      }
    });
  });
});
