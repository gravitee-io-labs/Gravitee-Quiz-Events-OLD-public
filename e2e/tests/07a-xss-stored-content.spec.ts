/**
 * (7) XSS regression, part 1: hostile text stored in the event, its categories and its questions (written for real
 * through the admin API), then read back by EVERY screen that shows it: hub, landing, game, results, review, scoreboard
 * and each admin view. Nothing may execute (no dialog, no window.__xss, document.title untouched, CSP quiet), no payload may
 * be parsed as HTML, and the text must show up literally.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { admin, playViaApi } from '../support/api';
import { buildBundle, uniqueSlug } from '../support/events';
import { assertNothingExecuted, VECTORS } from '../support/xss';
import { gotoAdmin, gotoTab, dialog, eventCard, toast } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, switchLang } from '../support/ui';
import type { Page } from '@playwright/test';

const H = {
  title: `PoC${VECTORS.img} Masters`,
  name: `PoC2<img src=x onerror="document.title='XSS-EXECUTED-'+document.domain"> Summit`,
  taglineEn: VECTORS.script,
  taglineFr: VECTORS.svg,
  descriptionEn: `${VECTORS.closeTitle} description`,
  descriptionFr: VECTORS.iframe,
  heroEn: `Become THE ${VECTORS.svg} Hacker!`,
  location: 'ZtestZ<x-probe-aa>',
  catAlpha: `Cat${VECTORS.img}`,
  catAlphaFr: `<svg onload=window.__xss=22>Chat`,
  catBeta: `${VECTORS.attr}Beta`,
  question: (i: number) => `Q${i}: is ${VECTORS.img} "safe" & ${VECTORS.bold} ok?`,
  questionFr: (i: number) => `Q${i} FR : ${VECTORS.svg} <script>window.__xss=23</script>`,
  explanation: (i: number) => `Because ${VECTORS.script} ${VECTORS.quote} (${i})`,
  explanationFr: (i: number) => `Parce que ${VECTORS.iframe} (${i})`,
  labelGreen: '<i>REST</i>',
  labelRed: '"><svg onload=window.__xss=24>',
  consent: `<a href="${VECTORS.js}">I agree</a> ${VECTORS.img}`,
};

let ev: TestEvent;
let eventId = 0;

test.beforeAll(async ({ events }) => {
  const slug = uniqueSlug('xss-stored');
  const bundle = buildBundle({
    slug, name: H.name, gameTitle: H.title, perGame: 3, questions: 3, timer: 20, location: H.location, twoChoices: 2,
    consentEn: H.consent,
    event: {
      tagline_en: H.taglineEn, tagline_fr: H.taglineFr, description_en: H.descriptionEn, description_fr: H.descriptionFr,
      hero_title_en: H.heroEn, hero_title_fr: H.heroEn,
    },
    categories: [
      { name: H.catAlpha, name_fr: H.catAlphaFr, description: VECTORS.script, description_fr: VECTORS.svg, color: '#7C5CFF', is_active: true },
      { name: H.catBeta, name_fr: null, description: null, description_fr: null, color: '#16A34A', is_active: true },
    ],
  });
  bundle.questions = bundle.questions.map((q: any, i: number) => ({
    ...q,
    category: i % 2 ? H.catBeta : H.catAlpha,
    question_text_en: H.question(i + 1), question_text_fr: H.questionFr(i + 1),
    explanation_en: H.explanation(i + 1), explanation_fr: H.explanationFr(i + 1),
    ...(q.question_format === 'two_choices' ? { green_label_en: H.labelGreen, green_label_fr: H.labelGreen, red_label_en: H.labelRed, red_label_fr: H.labelRed } : {}),
  }));
  const raw = await admin.post('/admin/events/import', { bundle, slug, name: H.name, status: 'live' });
  ev = { id: raw.id, slug: raw.slug, name: raw.name, gameTitle: raw.game_title, raw };
  eventId = raw.id;
  events.track(slug);
  // a finished game by a player whose name is hostile but accepted by the API (no < or >)
  await playViaApi(slug, { first_name: VECTORS.entity, last_name: VECTORS.attr, consent: true, green: 3 });
  await playViaApi(slug, { first_name: VECTORS.quote, last_name: '" autofocus onfocus="window.__xss=12', consent: true, green: 2 });
  await playViaApi(slug, { first_name: 'Third', last_name: VECTORS.template, consent: true, green: 1 });
  // every question has now been answered 3 times: the overview lists them as hardest / easiest
});

async function clean(page: Page, where: string) {
  await assertNothingExecuted(page, where);
}

test.describe('public pages', () => {
  test('hub card', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('article.hub-card').filter({ has: page.locator(`a.hub-card__link[href="/${ev.slug}"]`) });
    await expect(card).toBeVisible();
    await expect(card.locator('.hub-card__wordmark')).toHaveText(H.title);
    await expect(card.locator('.hub-card__event')).toHaveText(H.name);
    await expect(card.locator('.hub-card__tagline')).toHaveText(H.taglineEn);
    await expect(card.locator('.hub-card__meta')).toContainText(H.location);
    await clean(page, 'hub');
    await page.goto('/?lang=fr');
    await expect(card.locator('.hub-card__tagline')).toHaveText(H.taglineFr);
    await clean(page, 'hub (fr)');
  });

  test('landing page, both languages', async ({ page }) => {
    await openEvent(page, ev.slug);
    await expect(page.locator('h1.hero__title')).toHaveText(H.heroEn);
    await expect(page.locator('.hero__tagline')).toHaveText(H.taglineEn);
    await expect(page.locator('.hero__eyebrow')).toContainText(H.location);
    await expect(page).toHaveTitle(new RegExp('PoC'));
    expect(await page.title()).toContain(H.title); // shown as text in the tab title, not interpreted
    await clean(page, 'landing');
    await switchLang(page, 'fr');
    await expect(page.locator('.hero__tagline')).toHaveText(H.taglineFr);
    await clean(page, 'landing (fr)');
  });

  test('registration form, rules, every question, results and review', async ({ page }) => {
    test.setTimeout(90_000);
    await openEvent(page, ev.slug);
    await page.locator('[data-action="play"]').click();
    await expect(page.locator('.ev-consent')).toContainText('I agree'); // consent text is text, the link is inert
    await expect(page.locator('.ev-consent a')).toHaveCount(0);
    await clean(page, 'registration');
    await page.getByLabel('First name', { exact: true }).fill(VECTORS.entity);
    await page.getByLabel('Last name', { exact: true }).fill(VECTORS.attr);
    await page.getByLabel('Email', { exact: true }).fill('xss.tester@e2e.example.com');
    await page.locator('input[name="consent"]').check();
    await page.locator('.ev-submit').click();
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    // the name the player typed is shown as typed
    await expect(page.locator('.ev-sub')).toContainText(VECTORS.entity);
    await clean(page, 'rules');
    await startGame(page);
    await playByKeyboard(page, ['g', 'g', 'g'], async (i, p) => {
      await expect(p.locator('.question__text')).toContainText(/Q\d: is <img src=x onerror=window\.__xss=1> "safe" & <b>bold<\/b> ok\?/);
      await clean(p, `question ${i}`);
    });
    const r = await readResults(page);
    expect(r.correct).toBe(3);
    await expect(page.locator('.ev-title--result')).toContainText(VECTORS.entity);
    await clean(page, 'results');
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('.review-item')).toHaveCount(3);
    await expect(page.locator('.review-item__q').first()).toContainText('<img src=x onerror=window.__xss=1>');
    await expect(page.locator('.review-item__explain').first()).toContainText('<script>window.__xss=2</script>');
    await clean(page, 'review');
    await switchLang(page, 'fr');
    await expect(page.locator('.review-item__explain').first()).toContainText('<iframe srcdoc=');
    await clean(page, 'review (fr)');
  });

  test('two-choices labels with markup stay text on the answer buttons', async ({ page, events }) => {
    const slug = uniqueSlug('xss-labels');
    const bundle = buildBundle({ slug, perGame: 2, questions: 2, twoChoices: 2, timer: 20 });
    bundle.questions = bundle.questions.map((q: any) => ({ ...q, green_label_en: H.labelGreen, green_label_fr: H.labelGreen, red_label_en: H.labelRed, red_label_fr: H.labelRed }));
    await admin.post('/admin/events/import', { bundle, slug, name: bundle.event.name, status: 'live' });
    events.track(slug);
    await openEvent(page, slug);
    await registerUpToRules(page, { first: 'Label', last: 'Tester' });
    await startGame(page);
    await expect(page.locator('.answer--green .answer__label')).toHaveText(H.labelGreen);
    await expect(page.locator('.answer--red .answer__label')).toHaveText(H.labelRed);
    await clean(page, 'game labels');
    await page.keyboard.press('g');
    await page.keyboard.press('g').catch(() => {});
  });

  test('scoreboard: event texts and hostile (but accepted) player names', async ({ page }) => {
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#sb-title')).toHaveText(H.title);
    await expect(page.locator('#sb-event')).toHaveText(H.name);
    // "First L." keeps the first name in full: it is shown as text
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toContainText('&lt;img src=x');
    await clean(page, 'scoreboard');
    await page.goto(`/${ev.slug}/scoreboard?rotate=1&lang=fr`);
    await expect(page.locator('#sb')).toHaveAttribute('data-state', 'ready');
    await clean(page, 'scoreboard (fr)');
  });
});

test.describe('admin console', () => {
  test.use({ asAdmin: true });

  test('events list, status toast, menus and dialogs show the hostile names as text', async ({ page }) => {
    await gotoAdmin(page, '#/events');
    const card = eventCard(page, ev);
    await expect(card).toBeVisible();
    await expect(card.locator('.event-card__title')).toHaveText(H.name);
    await expect(card.locator('.admin-event__game')).toContainText(H.title);
    await clean(page, 'admin events list');

    // switcher
    await page.getByRole('button', { name: /Switch event/ }).click();
    await expect(page.getByRole('listbox', { name: 'Events' })).toContainText(H.name);
    await clean(page, 'admin switcher');
    await page.keyboard.press('Escape');

    // status change: the toast and its Undo carry the event name
    await card.getByRole('button', { name: /^Status:/ }).click();
    await card.getByRole('menuitemradio', { name: /Back to draft/ }).click();
    await expect(toast(page, 'is back to draft')).toContainText(H.name);
    await clean(page, 'admin toast');
    await toast(page, 'is back to draft').getByRole('button', { name: 'Undo' }).click();
    await expect(card.getByRole('button', { name: /^Status: Live/ })).toBeVisible();

    // duplicate / delete / QR dialogs
    await card.getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Duplicate…' }).click();
    await expect(dialog(page)).toContainText(H.name);
    await clean(page, 'duplicate dialog');
    await page.keyboard.press('Escape');
    await card.getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(dialog(page).getByRole('heading')).toContainText(H.name);
    await clean(page, 'delete dialog');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await card.getByRole('button', { name: `QR code for ${H.name}` }).click();
    await expect(dialog(page)).toContainText(H.title);
    await clean(page, 'qr dialog');
  });

  test('overview, categories, questions (and the editor preview)', async ({ page }) => {
    await gotoTab(page, eventId, 'overview');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(H.name);
    await expect(page.getByRole('region', { name: 'Hardest questions' })).toContainText('<img src=x onerror=window.__xss=1>');
    await clean(page, 'overview');

    await gotoTab(page, eventId, 'categories');
    await expect(page.getByRole('heading', { name: H.catAlpha })).toBeVisible();
    await clean(page, 'categories');

    await gotoTab(page, eventId, 'questions');
    await expect(page.getByRole('row').filter({ hasText: 'Q1: is <img src=x' })).toBeVisible();
    await clean(page, 'questions');
    const first = (await admin.get(`/admin/events/${eventId}/questions`, { query: { limit: 10 } })).items[0];
    await page.getByRole('button', { name: `Edit question ${first.id}` }).click();
    await expect(dialog(page).getByRole('textbox', { name: 'Question (English)' })).toHaveValue(first.question_text_en);
    await clean(page, 'question editor');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('appearance preview, settings, results (with hostile player names)', async ({ page }) => {
    await gotoTab(page, eventId, 'appearance');
    const aside = page.getByRole('complementary', { name: 'Live preview' });
    await expect(aside).toContainText('Hacker');
    await clean(page, 'appearance');

    await gotoTab(page, eventId, 'settings');
    await expect(page.getByRole('textbox', { name: 'Consent text (English)' })).toHaveValue(H.consent);
    await expect(page.getByText(H.catAlpha).first()).toBeVisible(); // category mix rows
    await clean(page, 'settings');

    await gotoTab(page, eventId, 'results');
    await expect(page.getByRole('row', { name: /&lt;img src=x onerror/ })).toBeVisible();
    await clean(page, 'results');
    await page.getByRole('button', { name: /View answers of/ }).first().click();
    await expect(dialog(page)).toContainText('<img src=x onerror=window.__xss=1>');
    await clean(page, 'result detail');
  });
});
