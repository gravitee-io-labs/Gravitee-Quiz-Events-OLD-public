/**
 * (10) Mobile viewport sanity: on a phone-sized screen no page scrolls sideways (even with very long names / texts) and the
 * controls are big enough to hit (44px on touch screens, the WCAG 2.5.8 minimum of 24px otherwise).
 * webkit-mobile runs with the real iPhone 14 profile; the desktop browsers are put in a 390x844 touch viewport.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { playViaApi, admin } from '../support/api';
import { buildBundle, uniqueSlug } from '../support/events';
import { measureTargets } from '../support/mobile';
import { gotoAdmin, gotoTab } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, fillRegistration, playButton } from '../support/ui';
import type { Page, TestInfo } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(2); // 68 characters without a space
const LONG_TEXT = 'This is a deliberately long question that keeps going so that the card has to wrap and scroll on a small phone screen without ever pushing the page sideways; '.repeat(3);

let ev: TestEvent;
test.beforeAll(async ({ events }) => {
  const slug = uniqueSlug('mobile');
  const bundle = buildBundle({
    slug, name: `Mobile ${LONG_WORD}`, gameTitle: LONG_WORD.slice(0, 60), perGame: 3, questions: 4, timer: 30, twoChoices: 2, location: LONG_WORD,
    consentEn: LONG_TEXT.slice(0, 300),
    event: { tagline_en: LONG_TEXT.slice(0, 250), description_en: LONG_TEXT, hero_title_en: `Become THE ${LONG_WORD}!` },
    categories: [
      { name: `Category ${LONG_WORD}`, name_fr: null, description: null, description_fr: null, color: '#7C5CFF', is_active: true },
      { name: 'Short', name_fr: null, description: null, description_fr: null, color: '#16A34A', is_active: true },
    ],
  });
  bundle.questions = bundle.questions.map((q: any, i: number) => ({
    ...q,
    category: i % 2 ? 'Short' : `Category ${LONG_WORD}`,
    question_text_en: `${i + 1}. ${LONG_TEXT}`, question_text_fr: `${i + 1}. ${LONG_TEXT}`,
    explanation_en: LONG_TEXT, explanation_fr: LONG_TEXT,
    ...(q.question_format === 'two_choices' ? { green_label_en: 'A rather long answer label of 40 chars!', green_label_fr: 'A rather long answer label of 40 chars!', red_label_en: 'Another really long label, 40 chars too', red_label_fr: 'Another really long label, 40 chars too' } : {}),
  }));
  const raw = await admin.post('/admin/events/import', { bundle, slug, name: bundle.event.name, status: 'live' });
  ev = { id: raw.id, slug, name: raw.name, gameTitle: raw.game_title, raw };
  events.track(slug);
  await playViaApi(slug, { first_name: LONG_WORD.slice(0, 60), last_name: LONG_WORD, consent: true, green: 3 });
  for (let i = 0; i < 12; i += 1) await playViaApi(slug, { first_name: `Player${i}`, last_name: 'Crowd', consent: true, green: i % 4, seconds: 1 + (i % 5) });
});

async function check(page: Page, testInfo: TestInfo, name: string, opts: { targets?: boolean } = {}) {
  const r = await measureTargets(page);
  await testInfo.attach(`targets-${name}.json`, { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  expect(r.overflow, `horizontal overflow on ${name} (${page.url()}): ${r.offenders.join(' ; ')}`).toBeLessThanOrEqual(1);
  if (opts.targets !== false) expect(r.small, `controls smaller than ${r.min}px on ${name} (${page.url()})`).toEqual([]);
}

test.describe('player app', () => {
  test('hub and landing', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.locator('article.hub-card').filter({ has: page.locator(`a[href="/${ev.slug}"]`) })).toBeVisible();
    await check(page, testInfo, 'hub');
    await openEvent(page, ev.slug);
    await expect(page.locator('[data-action="play"]')).toBeVisible();
    await check(page, testInfo, 'landing');
  });

  test('registration, rules, question, results and review with very long texts', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openEvent(page, ev.slug);
    await playButton(page).click();
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await check(page, testInfo, 'register');
    await fillRegistration(page, { first: LONG_WORD.slice(0, 60), last: LONG_WORD.slice(0, 60), consent: true });
    await page.locator('.ev-submit').click();
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await check(page, testInfo, 'rules');
    await startGame(page);
    await check(page, testInfo, 'question');
    // the answer buttons stay inside the viewport and are thumb sized
    for (const colour of ['green', 'red']) {
      const box = await page.locator(`.answer--${colour}`).boundingBox();
      expect(box!.height, `${colour} answer height`).toBeGreaterThanOrEqual(56);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    }
    await playByKeyboard(page, ['g', 'r', 'g']);
    await readResults(page);
    await check(page, testInfo, 'results');
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('main[data-view="review"]')).toBeVisible();
    await check(page, testInfo, 'review');
  });

  test('scoreboard: podium, ranking list, rotating stats, empty state', async ({ page, events }, testInfo) => {
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await check(page, testInfo, 'scoreboard');
    await page.goto(`/${ev.slug}/scoreboard?rotate=1&limit=20`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await check(page, testInfo, 'scoreboard-20');
    const empty = await events.create({ tag: 'mobile-empty', questions: 4, perGame: 3 });
    await page.goto(`/${empty.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'empty');
    await check(page, testInfo, 'scoreboard-empty');
  });
});

test.describe('admin console on a phone', () => {
  test('login', async ({ page }, testInfo) => {
    await gotoAdmin(page, '#/login');
    await expect(page.getByRole('heading', { name: 'Quiz Admin' })).toBeVisible();
    await check(page, testInfo, 'admin-login');
  });

  test.describe('signed in', () => {
    test.use({ asAdmin: true });

    test('events list and event tabs do not scroll sideways', async ({ page }, testInfo) => {
      await gotoAdmin(page, '#/events');
      await expect(page.locator('article.admin-event').first()).toBeVisible();
      await check(page, testInfo, 'admin-events');
      for (const tab of ['overview', 'questions', 'categories', 'results', 'settings', 'appearance'] as const) {
        await gotoTab(page, ev, tab);
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await check(page, testInfo, `admin-${tab}`, { targets: false });
      }
    });

    test('controls of the events list and the main navigation are tappable', async ({ page }, testInfo) => {
      await gotoAdmin(page, '#/events');
      await expect(page.locator('article.admin-event').first()).toBeVisible();
      await check(page, testInfo, 'admin-events-targets');
    });
  });
});
