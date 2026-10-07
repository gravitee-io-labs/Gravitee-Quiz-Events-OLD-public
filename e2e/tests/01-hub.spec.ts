/**
 * (1) Hub: lists the live events as branded cards; draft and closed events are never listed.
 * Other agents / the seeded events also live on this stack: assertions look for OUR events by slug, never for counts.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { setStatus } from '../support/events';
import { horizontalOverflow, switchLang } from '../support/ui';

let live: TestEvent;
let live2: TestEvent;
let draft: TestEvent;
let closed: TestEvent;

test.beforeAll(async ({ events }) => {
  live = await events.create({
    tag: 'hub-live', name: 'Hub Live Summit', gameTitle: 'Rose Masters', primary: '#E11D48', accent: '#F59E0B', perGame: 5, questions: 6,
    location: 'Rotterdam', event: { tagline_en: 'Pink is the new orange', tagline_fr: 'Le rose est le nouvel orange' },
  });
  live2 = await events.create({ tag: 'hub-live2', name: 'Hub Second Summit', gameTitle: 'Teal Masters', primary: '#0F766E', accent: '#2DD4BF', background: 'plain', perGame: 5, questions: 6 });
  draft = await events.create({ tag: 'hub-draft', status: 'draft', gameTitle: 'Hidden Draft Masters', perGame: 5, questions: 6 });
  closed = await events.create({ tag: 'hub-closed', status: 'closed', gameTitle: 'Finished Closed Masters', perGame: 5, questions: 6 });
});

const card = (page: import('@playwright/test').Page, ev: TestEvent) =>
  page.locator('article.hub-card').filter({ has: page.locator(`a.hub-card__link[href="/${ev.slug}"]`) });

test.describe('hub', () => {
  test('lists live events as individually branded cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1.hero__title')).toContainText('Quiz Events');

    const a = card(page, live);
    await expect(a).toBeVisible();
    await expect(a.locator('.hub-card__wordmark')).toHaveText('Rose Masters');
    await expect(a.locator('.hub-card__event')).toHaveText('Hub Live Summit');
    await expect(a.locator('.hub-card__tagline')).toHaveText('Pink is the new orange');
    await expect(a.locator('.hub-card__meta')).toContainText('Rotterdam');
    await expect(a.locator('.hub-card__meta')).toContainText('2026');
    await expect(a.getByRole('link', { name: /^Play/ })).toHaveAttribute('href', `/${live.slug}`);
    await expect(a.getByRole('link', { name: /Scoreboard/ })).toHaveAttribute('href', `/${live.slug}/scoreboard`);

    const b = card(page, live2);
    await expect(b).toBeVisible();
    await expect(b.locator('.hub-card__wordmark')).toHaveText('Teal Masters');

    // each card carries its OWN brand colours (scoped CSS variables), not the page's
    const brandOf = (c: import('@playwright/test').Locator) => c.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--brand').trim().toLowerCase());
    expect(await brandOf(a)).toBe('#e11d48');
    expect(await brandOf(b)).toBe('#0f766e');
    await expect(a).toHaveAttribute('data-brand-scope', '');
  });

  test('draft and closed events are not listed (UI and API)', async ({ page, request }) => {
    await page.goto('/');
    await expect(card(page, live)).toBeVisible(); // the list is rendered
    await expect(page.locator(`a[href="/${draft.slug}"]`)).toHaveCount(0);
    await expect(page.locator(`a[href="/${closed.slug}"]`)).toHaveCount(0);
    await expect(page.getByText('Hidden Draft Masters')).toHaveCount(0);
    await expect(page.getByText('Finished Closed Masters')).toHaveCount(0);

    const list = await (await request.get('/api/events')).json();
    const slugs = list.map((e: any) => e.slug);
    expect(slugs).toContain(live.slug);
    expect(slugs).not.toContain(draft.slug);
    expect(slugs).not.toContain(closed.slug);
    expect(list.every((e: any) => e.status === 'live')).toBe(true);
  });

  test('an event appears when it goes live and disappears when it is closed', async ({ page, events }) => {
    const ev = await events.create({ tag: 'hub-flip', status: 'draft', gameTitle: 'Flip Masters', perGame: 5, questions: 6 });
    await page.goto('/');
    await expect(card(page, live)).toBeVisible();
    await expect(card(page, ev)).toHaveCount(0);

    await setStatus(ev, 'live');
    await page.reload();
    await expect(card(page, ev)).toBeVisible();

    await setStatus(ev, 'closed');
    await page.reload();
    await expect(card(page, live)).toBeVisible();
    await expect(card(page, ev)).toHaveCount(0);
  });

  test('Play on a card opens that event', async ({ page }) => {
    await page.goto('/');
    await card(page, live).getByRole('link', { name: /^Play/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${live.slug}$`));
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    await expect(page.locator('[data-action="play"]')).toBeVisible();
  });

  test('French: translated chrome and localised event texts', async ({ page }) => {
    await page.goto('/?lang=fr');
    const a = card(page, live);
    await expect(a.locator('.hub-card__tagline')).toHaveText('Le rose est le nouvel orange');
    await expect(page.locator('.hero__eyebrow')).toContainText('Événements en direct');
    await expect(a.getByRole('link', { name: /^Jouer/ })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('language switch on the hub re-renders without reloading', async ({ page }) => {
    await page.goto('/');
    await expect(card(page, live)).toBeVisible();
    await page.evaluate(() => { (window as any).__marker = 1; });
    await switchLang(page, 'fr');
    await expect(card(page, live).locator('.hub-card__tagline')).toHaveText('Le rose est le nouvel orange');
    expect(await page.evaluate(() => (window as any).__marker)).toBe(1);
    await switchLang(page, 'en');
    await expect(card(page, live).locator('.hub-card__tagline')).toHaveText('Pink is the new orange');
  });

  test('the language chosen on the hub follows the player into the event', async ({ page }) => {
    await page.goto('/');
    await expect(card(page, live)).toBeVisible();
    await switchLang(page, 'fr');
    await card(page, live).getByRole('link', { name: /^Jouer/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${live.slug}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('[data-action="play"]')).toContainText('Jouer maintenant');
  });

  test('empty state when no event is live', async ({ page }) => {
    await page.route('**/api/events', (route) => route.fulfill({ json: [] }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No live event right now' })).toBeVisible();
    await expect(page.locator('article.hub-card')).toHaveCount(0);
  });

  test('no horizontal scroll', async ({ page }) => {
    await page.goto('/');
    await expect(card(page, live)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('hub when the API is down', () => {
  // the browser logs the failed requests themselves: that is exactly what this test provokes
  test.use({ expectedConsole: /Failed to load resource|503/ });

  test('error state with a working retry', async ({ page }) => {
    let fail = true;
    await page.route('**/api/events', (route) => (fail ? route.fulfill({ status: 503, json: { detail: 'down' } }) : route.continue()));
    await page.goto('/');
    await expect(page.getByRole('alert').getByRole('heading', { name: /could not load the events/ })).toBeVisible({ timeout: 20_000 });
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, live)).toBeVisible();
  });
});
