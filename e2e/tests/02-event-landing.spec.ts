/**
 * (2) Event landing: live / draft (404 for the public, preview banner for an admin) / closed (ended, no play) / unknown slug.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { call, registerPlayer } from '../support/api';
import { openEvent, switchLang, horizontalOverflow } from '../support/ui';

let live: TestEvent;
let draft: TestEvent;
let closed: TestEvent;
let french: TestEvent;
let mono: TestEvent;

test.beforeAll(async ({ events }) => {
  live = await events.create({
    tag: 'land-live', name: 'Landing Summit', gameTitle: 'Orbit Masters', primary: '#E11D48', accent: '#F59E0B',
    perGame: 6, questions: 8, timer: 7, location: 'Utrecht', startsOn: '2026-10-07', endsOn: '2026-10-08',
    event: { hero_title_en: 'Become THE Orbit Champion!', hero_title_fr: 'Devenez LE champion de l’orbite !', description_en: 'Long description for the landing page.', description_fr: 'Longue description pour la page.' },
  });
  draft = await events.create({ tag: 'land-draft', status: 'draft', gameTitle: 'Secret Masters', perGame: 5, questions: 6 });
  closed = await events.create({ tag: 'land-closed', status: 'closed', gameTitle: 'Over Masters', perGame: 5, questions: 6 });
  french = await events.create({ tag: 'land-fr', gameTitle: 'Maitres FR', defaultLanguage: 'fr', perGame: 5, questions: 6 });
  mono = await events.create({ tag: 'land-mono', gameTitle: 'Solo Masters', languages: ['fr'], defaultLanguage: 'fr', perGame: 5, questions: 6 });
});

test.describe('live event', () => {
  test('landing is the clean booth screen: branded hero + Play / Scoreboard, nothing else', async ({ page }) => {
    await openEvent(page, live.slug);
    await expect(page.locator('h1.hero__title')).toHaveText('Become THE Orbit Champion!');
    await expect(page.locator('h1.hero__title em')).toHaveText('Orbit Champion');
    await expect(page.locator('.hero__eyebrow')).toContainText('Utrecht');
    await expect(page.locator('.hero__eyebrow')).toContainText('2026');
    await expect(page.locator('.hero__tagline')).toHaveText(`Tagline of ${live.name}`);

    // no description paragraph, no topics, no stat tiles and no keyboard hint on the landing page
    for (const sel of ['.ev-description', '.ev-topics', '.ev-chips', '.ev-stats', '.ev-keys-hint']) {
      await expect(page.locator(sel)).toHaveCount(0);
    }

    await expect(page.locator('[data-action="play"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Scoreboard' }).first()).toHaveAttribute('href', `/${live.slug}/scoreboard`);
    await expect(page.locator('.ev-closed')).toHaveCount(0);
    await expect(page.locator('.ev-draft')).toHaveCount(0);
  });

  test('page is branded with the event colours, title and Gravitee footer', async ({ page }) => {
    await openEvent(page, live.slug);
    await expect(page).toHaveTitle(/Orbit Masters/);
    await expect(page).toHaveTitle(/Landing Summit/);
    const brand = await page.evaluate(() => document.documentElement.style.getPropertyValue('--brand').trim().toLowerCase());
    expect(brand).toBe('#e11d48');
    await expect(page.locator('footer.footer')).toContainText('Powered by');
    await expect(page.locator('footer.footer img[alt="Gravitee"]').first()).toBeAttached();
    await expect(page.locator('a.brand')).toContainText('Orbit Masters');
  });

  test('French: ?lang=fr and the language switch translate the page and localise the event texts', async ({ page }) => {
    await openEvent(page, live.slug, '?lang=fr');
    await expect(page.locator('h1.hero__title')).toHaveText('Devenez LE champion de l’orbite !');
    await expect(page.locator('[data-action="play"]')).toContainText('Jouer maintenant');
    await expect(page.locator('.hero__tagline')).toHaveText(`Accroche de ${live.name}`);

    await switchLang(page, 'en');
    await expect(page.locator('h1.hero__title')).toHaveText('Become THE Orbit Champion!');
    await expect(page.locator('[data-action="play"]')).toContainText('Play now');
    // the choice survives a reload (localStorage)
    await page.goto(`/${live.slug}`);
    await expect(page.locator('h1.hero__title')).toHaveText('Become THE Orbit Champion!');
  });

  test('the default language of the event applies when the visitor has not chosen', async ({ page }) => {
    await openEvent(page, french.slug);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('[data-action="play"]')).toContainText('Jouer maintenant');
    // the explicit ?lang= wins over the event default
    await openEvent(page, french.slug, '?lang=en');
    await expect(page.locator('[data-action="play"]')).toContainText('Play now');
  });

  test('a single-language event offers no language switch', async ({ page }) => {
    await openEvent(page, mono.slug, '?lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('.lang-switch')).toHaveCount(0);
  });

  test('no horizontal scroll', async ({ page }) => {
    await openEvent(page, live.slug);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('Play leads to the registration form', async ({ page }) => {
    await openEvent(page, live.slug);
    await page.locator('[data-action="play"]').click();
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Who is playing?' })).toBeVisible();
  });
});

test.describe('draft event', () => {
  // the public gets a 404 from the API, which the browser logs as a console error
  test.use({ expectedConsole: /Failed to load resource|404/ });

  test('is a not-found page for the public (API and UI)', async ({ page, request }) => {
    const res = await request.get(`/api/events/${draft.slug}`);
    expect(res.status()).toBe(404);

    await openEvent(page, draft.slug);
    await expect(page.getByRole('heading', { name: 'We could not find this event' })).toBeVisible();
    await expect(page.locator('[data-action="play"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'See live events' })).toHaveAttribute('href', '/');
    // nothing about the event leaks into the page
    await expect(page.getByText('Secret Masters')).toHaveCount(0);
  });

  test('a draft cannot be played through the API either', async () => {
    const r = await call('POST', `/events/${draft.slug}/players`, { first_name: 'No', last_name: 'Way', email: 'no@way.io' }, { raw: true });
    expect(r.status).toBe(404);
  });
});

test.describe('draft event previewed by an admin', () => {
  test.use({ asAdmin: true });

  test('shows the preview banner and the full landing', async ({ page }) => {
    await openEvent(page, draft.slug);
    const banner = page.locator('.ev-draft');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Preview: draft event');
    await expect(page.locator('h1.hero__title')).toContainText('Secret Master');
    await expect(page.locator('[data-action="play"]')).toBeVisible();
  });
});

test.describe('closed event', () => {
  test('shows the ended state: no Play button, scoreboard still reachable', async ({ page }) => {
    await openEvent(page, closed.slug);
    await expect(page.locator('.ev-closed')).toBeVisible();
    await expect(page.locator('.ev-closed__title')).toHaveText('This event has ended');
    await expect(page.locator('.badge--warning')).toContainText('Ended');
    await expect(page.locator('[data-action="play"]')).toHaveCount(0);
    await expect(page.locator('.ev-closed').getByRole('link', { name: 'Scoreboard' })).toHaveAttribute('href', `/${closed.slug}/scoreboard`);
    // the "rules" tiles (questions / seconds) make no sense any more
    await expect(page.locator('.ev-stats .stat').filter({ hasText: 'Seconds each' })).toHaveCount(0);
  });

  test('registering and starting a game are refused with 403 event_closed', async () => {
    const reg = await call('POST', `/events/${closed.slug}/players`, { first_name: 'Late', last_name: 'Comer', email: 'late@comer.io' }, { raw: true });
    expect(reg.status).toBe(403);
    expect(reg.body).toEqual({ detail: 'event_closed' });
    const start = await call('POST', `/events/${closed.slug}/games`, { player_id: 1 }, { raw: true });
    expect([403, 404]).toContain(start.status);
  });
});

test.describe('event closed while a player is registering', () => {
  test.use({ expectedConsole: /Failed to load resource|403/ }); // the 403 of the refused registration is the point

  test('Start sends the player to the ended page instead of an error', async ({ page, events }) => {
    // the player opened the page while live; the admin closes the event; the next API call tells the app
    const ev = await events.create({ tag: 'land-flip', perGame: 5, questions: 6 });
    await openEvent(page, ev.slug);
    await page.locator('[data-action="play"]').click();
    await page.getByLabel('First name', { exact: true }).fill('Slow');
    await page.getByLabel('Last name', { exact: true }).fill('Player');
    await page.getByLabel('Email', { exact: true }).fill('slow.player@e2e.example.com');
    await page.locator('.ev-submit').click();
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await call('PUT', `/admin/events/${ev.id}`, { status: 'closed' }, { token: process.env.E2E_ADMIN_TOKEN });
    await page.locator('[data-action="start"]').click();
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    await expect(page.locator('.ev-closed__title')).toHaveText('This event has ended');
    await expect(page.locator('[data-action="play"]')).toHaveCount(0);
  });
});

test.describe('unknown event', () => {
  test.use({ expectedConsole: /Failed to load resource|404/ });

  test('an unknown slug shows the not-found page with a way back', async ({ page }) => {
    await page.goto('/no-such-event-qa-e2e');
    await expect(page.getByRole('heading', { name: 'We could not find this event' })).toBeVisible();
    await expect(page.locator('[data-action="play"]')).toHaveCount(0);
    await expect(page).toHaveTitle(/could not find this event/i);
    const back = page.getByRole('link', { name: 'See live events' });
    await expect(back).toHaveAttribute('href', '/');
    await back.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('h1.hero__title')).toContainText('Quiz Events');
  });

  test('a path that is not an event route returns the branded 404 page (HTTP 404)', async ({ page }) => {
    const res = await page.goto('/a/b/c');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See live events' })).toHaveAttribute('href', '/');
  });

  test('the scoreboard of an unknown event says so (and does not spin forever)', async ({ page }) => {
    await page.goto('/no-such-event-qa-e2e/scoreboard');
    await expect(page.locator('#sb-status-title')).toHaveText(/not found|introuvable|find/i);
    await expect(page.locator('#sb-status-action')).toBeVisible();
  });
});
