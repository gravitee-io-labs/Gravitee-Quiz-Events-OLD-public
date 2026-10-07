/**
 * (6) Admin: the events list, creating an event (blank), duplicating, exporting a bundle and importing it under a new slug,
 * changing the status draft -> live -> closed, and deleting with the slug confirmation.
 */
import { test, expect } from '../support/fixtures';
import { admin, call, playViaApi } from '../support/api';
import { uniqueSlug } from '../support/events';
import { gotoAdmin, gotoTab, eventCard, dialog, toast, setStatusFromCard, downloadText } from '../support/admin';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

test.use({ asAdmin: true });

const idFromUrl = (page: Page) => Number(page.url().match(/#\/events\/(\d+)\//)?.[1]);

async function openNewEvent(page: Page) {
  await page.getByRole('button', { name: 'New event' }).click();
  await expect(dialog(page)).toBeVisible();
}

test.describe('events list', () => {
  test('shows every event with its counts, filters by status and searches', async ({ page, events }) => {
    const word = `Zorblax${Math.random().toString(36).slice(2, 6)}`;
    const live = await events.create({ tag: 'list-live', name: `${word} Live`, questions: 8, perGame: 5 });
    const draft = await events.create({ tag: 'list-draft', name: `${word} Draft`, status: 'draft', questions: 6, perGame: 5 });
    const closed = await events.create({ tag: 'list-closed', name: `${word} Closed`, status: 'closed', questions: 6, perGame: 5 });
    await playViaApi(live.slug, { first_name: 'Cnt', last_name: 'One' });

    await gotoAdmin(page, '#/events');
    await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search events' }).fill(word);
    for (const ev of [live, draft, closed]) await expect(eventCard(page, ev)).toBeVisible();
    await expect(page.locator('article.admin-event')).toHaveCount(3);

    // the counters of the card
    const counts = eventCard(page, live).locator('.ev-counts');
    await expect(counts.locator('div').filter({ hasText: 'Questions' }).locator('dd')).toHaveText('8');
    await expect(counts.locator('div').filter({ hasText: 'Categories' }).locator('dd')).toHaveText('2');
    await expect(counts.locator('div').filter({ hasText: 'Players' }).locator('dd')).toHaveText('1');
    await expect(counts.locator('div').filter({ hasText: 'Games' }).locator('dd')).toHaveText('1');
    await expect(eventCard(page, live).getByRole('button', { name: /^Status: Live/ })).toBeVisible();
    await expect(eventCard(page, draft).getByRole('button', { name: /^Status: Draft/ })).toBeVisible();
    await expect(eventCard(page, closed).getByRole('button', { name: /^Status: Closed/ })).toBeVisible();

    // status filter
    await page.getByRole('radiogroup', { name: 'Filter by status' }).getByRole('radio', { name: /^Draft/ }).check();
    await expect(page.locator('article.admin-event')).toHaveCount(1);
    await expect(eventCard(page, draft)).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Filter by status' }).getByRole('radio', { name: /^All/ }).check();
    await expect(page.locator('article.admin-event')).toHaveCount(3);

    // search by slug and no match
    await page.getByRole('searchbox', { name: 'Search events' }).fill(live.slug);
    await expect(page.locator('article.admin-event')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Search events' }).fill('no-such-event-anywhere-qa');
    await expect(page.getByRole('heading', { name: 'No event matches' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('article.admin-event').first()).toBeVisible();
  });
});

test.describe('create an event (blank)', () => {
  test('the form validates, then creates a draft and opens its settings', async ({ page, events }) => {
    const taken = await events.create({ tag: 'new-taken', perGame: 3, questions: 4 });
    const slug = uniqueSlug('new-blank');
    events.track(slug); // created through the UI below: make sure it is deleted

    await gotoAdmin(page, '#/events');
    await openNewEvent(page);
    const dlg = dialog(page);

    // nothing filled in
    await dlg.getByRole('button', { name: 'Create event' }).click();
    await expect(dlg.getByText('Give the event a name.')).toBeVisible();
    await expect(dlg.getByText('Give the game a title.')).toBeVisible();

    // slug rules: reserved word, invalid characters, already used
    await dlg.getByLabel('Event name', { exact: true }).fill('QA Blank Event');
    await dlg.getByLabel(/^Game title/).fill('Blank Masters');
    await dlg.getByLabel('URL slug').fill('admin');
    await dlg.getByRole('button', { name: 'Create event' }).click();
    await expect(dlg.locator('.field__help--bad')).toContainText('"admin" is reserved by the platform.');
    await dlg.getByLabel('URL slug').fill('Not A Slug!');
    await expect(dlg.locator('.field__help--bad')).toContainText(/Lowercase letters|characters/);
    await dlg.getByLabel('URL slug').fill(taken.slug);
    await expect(dlg.locator('.field__help--bad')).toContainText('Already used');

    // a good one
    await dlg.getByLabel('URL slug').fill(slug);
    await expect(dlg.locator('.field__help--ok')).toContainText('Available');
    await dlg.getByRole('button', { name: 'Create event' }).click();
    await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);
    await expect(toast(page, 'QA Blank Event created')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    // what the backend stored: a draft with the Gravitee defaults, nothing public
    const id = idFromUrl(page);
    const created = await admin.get(`/admin/events/${id}`);
    expect(created).toMatchObject({ slug, name: 'QA Blank Event', game_title: 'Blank Masters', status: 'draft' });
    expect(created.settings).toMatchObject({ questions_per_game: 15, timer_seconds: 20, collect_phone: 'optional' });
    expect(created.languages).toEqual(['en', 'fr']);
    expect(created.counts).toMatchObject({ questions: 0, categories: 0, players: 0 });
    expect((await call('GET', `/events/${slug}`, undefined, { raw: true })).status).toBe(404);

    // the list flags it as not ready
    await gotoAdmin(page, '#/events');
    await expect(eventCard(page, id).getByText('Needs questions')).toBeVisible();
  });

  test.describe('slug race', () => {
    test.use({ expectedConsole: /Failed to load resource|409/ }); // the 409 of the lost race is the point

    test('a slug taken by somebody else a moment earlier is reported, with a free one suggested', async ({ page, events }) => {
      const slug = uniqueSlug('new-race');
      events.track(slug);
      await gotoAdmin(page, '#/events');
      await openNewEvent(page);
      const dlg = dialog(page);
      await dlg.getByLabel('Event name', { exact: true }).fill('Race Event');
      await dlg.getByLabel(/^Game title/).fill('Race Masters');
      await dlg.getByLabel('URL slug').fill(slug);
      await expect(dlg.locator('.field__help--ok')).toContainText('Available');
      // meanwhile another admin (or a script) takes it: the console only learns about it from the server
      const rival = await admin.post('/admin/events', { slug, name: 'Rival', game_title: 'Rival Masters' });
      await dlg.getByRole('button', { name: 'Create event' }).click();
      await expect(dlg.getByText(/already|taken|used/i).first()).toBeVisible();
      await expect(dialog(page)).toHaveCount(1); // still open: nothing was created
      await expect(dlg.getByLabel('URL slug')).not.toHaveValue(slug); // a free slug was proposed
      expect((await admin.get(`/admin/events/${rival.id}`)).name).toBe('Rival'); // the rival is untouched
      // and the retry with the proposed slug works
      const proposed = await dlg.getByLabel('URL slug').inputValue();
      events.track(proposed);
      await dlg.getByRole('button', { name: 'Create event' }).click();
      await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);
    });
  });

  test('a double click on Create makes one event, not two', async ({ page, events }) => {
    const slug = uniqueSlug('new-dbl');
    events.track(slug);
    await gotoAdmin(page, '#/events');
    await openNewEvent(page);
    const dlg = dialog(page);
    await dlg.getByLabel('Event name', { exact: true }).fill('Double Click');
    await dlg.getByLabel(/^Game title/).fill('Double Masters');
    await dlg.getByLabel('URL slug').fill(slug);
    await dlg.getByRole('button', { name: 'Create event' }).dblclick();
    await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);
    const all = await admin.get('/admin/events');
    expect(all.filter((e: any) => e.slug === slug)).toHaveLength(1);
  });

  test('the slug follows the event name until you edit it yourself', async ({ page }) => {
    await gotoAdmin(page, '#/events');
    await openNewEvent(page);
    const dlg = dialog(page);
    await dlg.getByLabel('Event name', { exact: true }).fill('Zürich Summit 2027!');
    await expect(dlg.getByLabel('URL slug')).toHaveValue(/^zurich-summit-2027/);
    await dlg.getByLabel('URL slug').fill('my-own-slug');
    await dlg.getByLabel('Event name', { exact: true }).fill('Another name');
    await expect(dlg.getByLabel('URL slug')).toHaveValue('my-own-slug');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('duplicate', () => {
  test('copies branding, rules, categories and questions, never players or results', async ({ page, events }) => {
    const src = await events.create({
      tag: 'dup-src', name: 'Dup Source', gameTitle: 'Dup Masters', questions: 8, perGame: 5, timer: 9, pointsCorrect: 120, primary: '#E11D48', accent: '#F59E0B', collectPhone: 'required',
    });
    await playViaApi(src.slug, { first_name: 'Orig', last_name: 'Inal', phone_number: '0612345678' });
    const slug = uniqueSlug('dup-copy');
    events.track(slug);

    await gotoAdmin(page, '#/events');
    await eventCard(page, src).getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Duplicate…' }).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Duplicate event' })).toBeVisible();
    await expect(dlg.getByLabel('Event name', { exact: true })).toHaveValue('Dup Source (copy)');
    await dlg.getByLabel('URL slug').fill(slug);
    await dlg.getByRole('button', { name: 'Duplicate event' }).click();
    await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);

    const copy = await admin.get(`/admin/events/${idFromUrl(page)}`);
    expect(copy).toMatchObject({ slug, name: 'Dup Source (copy)', game_title: 'Dup Masters', status: 'draft' });
    expect(copy.counts).toMatchObject({ questions: 8, active_questions: 8, categories: 2, players: 0, games_completed: 0 });
    expect(copy.branding).toMatchObject({ primary_color: '#E11D48', accent_color: '#F59E0B' });
    expect(copy.settings).toMatchObject({ questions_per_game: 5, timer_seconds: 9, points_correct: 120, collect_phone: 'required' });
    // the source is untouched
    const original = await admin.get(`/admin/events/${src.id}`);
    expect(original.counts).toMatchObject({ questions: 8, players: 1, games_completed: 1 });

    // the copy has its own results page: empty
    await gotoTab(page, copy.id, 'results');
    await expect(page.getByRole('heading', { name: 'No results yet' })).toBeVisible();
  });

  test('"Categories and questions" can be left out', async ({ page, events }) => {
    const src = await events.create({ tag: 'dup-src2', questions: 6, perGame: 5 });
    const slug = uniqueSlug('dup-bare');
    events.track(slug);
    await gotoAdmin(page, '#/events');
    await eventCard(page, src).getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Duplicate…' }).click();
    const dlg = dialog(page);
    await dlg.getByRole('checkbox', { name: /Categories and questions/ }).uncheck();
    await dlg.getByLabel('URL slug').fill(slug);
    await dlg.getByRole('button', { name: 'Duplicate event' }).click();
    await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);
    const copy = await admin.get(`/admin/events/${idFromUrl(page)}`);
    expect(copy.counts).toMatchObject({ questions: 0, categories: 0 });
  });
});

test.describe('export a bundle and import it under a new slug', () => {
  test('round trip keeps the event, categories and questions and nothing personal', async ({ page, events }, testInfo) => {
    const src = await events.create({
      tag: 'bundle-src', name: 'Bundle Source', gameTitle: 'Bundle Masters', questions: 8, twoChoices: 2, perGame: 5, primary: '#0F766E', accent: '#2DD4BF',
      consentEn: 'I agree (bundle test).',
    });
    const { player } = await playViaApi(src.slug, { first_name: 'Private', last_name: 'Person', consent: true });

    // ---- export from the overview "More actions" menu
    await gotoTab(page, src, 'overview');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem', { name: 'Export bundle (JSON)' }).click();
      })(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const text = await downloadText(download);
    const bundle = JSON.parse(text);
    expect(bundle).toMatchObject({ format: 'gravitee-quiz-event', version: 1 });
    expect(bundle.event).toMatchObject({ slug: src.slug, name: 'Bundle Source', game_title: 'Bundle Masters' });
    expect(bundle.categories).toHaveLength(2);
    expect(bundle.questions).toHaveLength(8);
    expect(bundle.questions.filter((q: any) => q.question_format === 'two_choices')).toHaveLength(2);
    // no personal data in a bundle
    expect(text).not.toMatch(/@e2e\.example\.com|Private|Person|player_id|phone_number|"email"/);
    expect(player.id).toBeTruthy();
    const file = join(mkdtempSync(join(tmpdir(), 'qa-bundle-')), 'bundle.json');
    await download.saveAs(file);
    testInfo.attach('bundle.json', { path: file, contentType: 'application/json' });

    // ---- import it under a new slug
    const slug = uniqueSlug('bundle-copy');
    events.track(slug);
    await gotoAdmin(page, '#/events');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('radio', { name: 'Import' })).toBeChecked();
    await dlg.locator('input[type=file]').setInputFiles(file);
    await expect(dlg.locator('.bundle-summary')).toContainText('Bundle Source');
    await expect(dlg.locator('.bundle-summary')).toContainText('8 questions');
    await expect(dlg.locator('.bundle-summary')).toContainText('2 categories');
    // the proposed slug is already taken by the source: the dialog suggests a free one
    await expect(dlg.getByLabel('URL slug')).not.toHaveValue(src.slug);
    await dlg.getByLabel('Event name', { exact: true }).fill('Bundle Imported');
    await dlg.getByLabel('URL slug').fill(slug);
    await dlg.getByRole('button', { name: 'Import event' }).click();
    await expect(page).toHaveURL(/#\/events\/\d+\/settings$/);

    const imported = await admin.get(`/admin/events/${idFromUrl(page)}`);
    expect(imported).toMatchObject({ slug, name: 'Bundle Imported', game_title: 'Bundle Masters', status: 'draft' });
    expect(imported.counts).toMatchObject({ questions: 8, categories: 2, players: 0, games_completed: 0 });
    expect(imported.branding).toMatchObject({ primary_color: '#0F766E', accent_color: '#2DD4BF' });
    expect(imported.settings.consent_text_en).toBe('I agree (bundle test).');
    // the imported questions are the exported ones
    const qs = await admin.get(`/admin/events/${imported.id}/questions`, { query: { limit: 100 } });
    expect(qs.total).toBe(8);
    expect(qs.items.map((q: any) => q.question_text_en).sort()).toEqual(bundle.questions.map((q: any) => q.question_text_en).sort());
  });

  test('a file that is not a bundle is refused with an explanation', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-badbundle-'));
    const notJson = join(dir, 'not-json.json');
    const wrong = join(dir, 'wrong.json');
    writeFileSync(notJson, 'this is { not json');
    writeFileSync(wrong, JSON.stringify({ hello: 'world' }));
    await gotoAdmin(page, '#/events');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dlg = dialog(page);
    await dlg.locator('input[type=file]').setInputFiles(notJson);
    await expect(dlg.locator('.alert--danger')).toContainText('not valid JSON');
    await dlg.locator('input[type=file]').setInputFiles(wrong);
    await expect(dlg.locator('.alert--danger')).toContainText('Not an event bundle');
    await dlg.getByRole('button', { name: 'Import event' }).click();
    await expect(dlg.locator('.alert--danger')).toContainText('Choose a bundle file first.');
    await expect(dialog(page)).toHaveCount(1); // still open, nothing created
  });
});

test.describe('status: draft -> live -> closed', () => {
  test('from the overview: the hub and the public page follow every change', async ({ page, events, browser }) => {
    const ev = await events.create({ tag: 'status-ov', status: 'draft', name: 'Status Overview', questions: 8, perGame: 5 });
    const anon = await browser.newContext();
    const pub = await anon.newPage();
    try {
      await gotoTab(page, ev, 'overview');
      const group = page.getByRole('radiogroup', { name: 'Event status' });
      await expect(group.getByRole('radio', { name: 'Draft' })).toBeChecked();
      await expect(page.getByText('Hidden from the hub.')).toBeVisible();

      // -> live
      await group.getByRole('radio', { name: 'Live' }).check();
      await expect(group.getByRole('radio', { name: 'Live' })).toBeChecked();
      await expect(toast(page, /is now live/)).toBeVisible();
      expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('live');
      await pub.goto('/');
      await expect(pub.locator(`a.hub-card__link[href="/${ev.slug}"]`)).toBeVisible();
      await pub.goto(`/${ev.slug}`);
      await expect(pub.locator('[data-action="play"]')).toBeVisible();

      // -> closed (asks for confirmation)
      await group.getByRole('radio', { name: 'Closed' }).check();
      const confirm = dialog(page);
      await expect(confirm.getByRole('heading', { name: /Close "Status Overview"\?/ })).toBeVisible();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(group.getByRole('radio', { name: 'Live' })).toBeChecked(); // cancelled: unchanged
      await group.getByRole('radio', { name: 'Closed' }).check();
      await dialog(page).getByRole('button', { name: 'Close event' }).click();
      await expect(toast(page, /is closed/)).toBeVisible();
      expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('closed');
      await pub.goto('/');
      await expect(pub.locator('article.hub-card').first()).toBeVisible();
      await expect(pub.locator(`a.hub-card__link[href="/${ev.slug}"]`)).toHaveCount(0);
      await pub.goto(`/${ev.slug}`);
      await expect(pub.locator('.ev-closed__title')).toHaveText('This event has ended');
    } finally {
      await anon.close();
    }
  });

  test('from the list: "Set live" with enough questions, Undo brings it back', async ({ page, events }) => {
    const ev = await events.create({ tag: 'status-list', status: 'draft', name: 'Status List', questions: 8, perGame: 5 });
    await gotoAdmin(page, '#/events');
    await setStatusFromCard(page, ev, 'Set live');
    await expect(toast(page, 'Status List is now live')).toBeVisible();
    await expect(eventCard(page, ev).getByRole('button', { name: /^Status: Live/ })).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('live');
    await toast(page, 'Status List is now live').getByRole('button', { name: 'Undo' }).click();
    await expect(eventCard(page, ev).getByRole('button', { name: /^Status: Draft/ })).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('draft');
  });

  test('going live with too few questions warns first', async ({ page, events }) => {
    const ev = await events.create({ tag: 'status-few', status: 'draft', name: 'Status Few', questions: 3, perGame: 3 });
    await admin.put(`/admin/events/${ev.id}`, { settings: { questions_per_game: 10 } });
    await gotoAdmin(page, '#/events');
    await setStatusFromCard(page, ev, 'Set live');
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Not enough active questions' })).toBeVisible();
    await expect(dlg).toContainText('Each game needs 10 questions but only 3 are active');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('draft');
    await setStatusFromCard(page, ev, 'Set live');
    await dialog(page).getByRole('button', { name: 'Go live anyway' }).click();
    await expect(eventCard(page, ev).getByRole('button', { name: /^Status: Live/ })).toBeVisible();
  });
});

test.describe('the event disappears while it is open', () => {
  test.use({ expectedConsole: /Failed to load resource|404/ }); // the 404 of the event that is gone is the point

  test('deleted from another place: the console says so and returns to the list', async ({ page, events }) => {
    const ev = await events.create({ tag: 'gone', name: 'Gone Elsewhere', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'overview');
    await expect(page.getByRole('heading', { name: 'Gone Elsewhere', level: 1 })).toBeVisible();
    await admin.del(`/admin/events/${ev.id}`, { query: { confirm: ev.slug } }); // another admin / a script
    // the overview refreshes itself (and on demand): either way the 404 of the vanished event is noticed
    await page.getByRole('button', { name: 'Refresh now' }).dispatchEvent('click', undefined, { timeout: 2_000 }).catch(() => {});
    await expect(toast(page, 'no longer exists')).toBeVisible({ timeout: 40_000 });
    await expect(page).toHaveURL(/#\/events$/);
    await expect(eventCard(page, ev)).toHaveCount(0);
  });
});

test.describe('delete an event', () => {
  test('needs the slug typed in full, then removes everything', async ({ page, events, request }) => {
    const ev = await events.create({ tag: 'del', name: 'Delete Me', questions: 6, perGame: 5 });
    await playViaApi(ev.slug, { first_name: 'Soon', last_name: 'Gone' });

    await gotoAdmin(page, '#/events');
    await eventCard(page, ev).getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Delete "Delete Me"?' })).toBeVisible();
    // what is about to be lost
    await expect(dlg).toContainText('6 questions');
    await expect(dlg).toContainText('1 player');
    await expect(dlg).toContainText('1 completed game');
    const confirmBtn = dlg.getByRole('button', { name: 'Delete event' });
    await expect(confirmBtn).toBeDisabled();
    const field = dlg.getByLabel(`Type the slug ${ev.slug} to confirm`);
    await field.fill(ev.slug.slice(0, -1));
    await expect(confirmBtn).toBeDisabled();
    await field.fill(ev.slug);
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    await expect(toast(page, 'Deleted Delete Me')).toBeVisible();
    await expect(eventCard(page, ev)).toHaveCount(0);
    expect((await call('GET', `/admin/events/${ev.id}`, undefined, { raw: true, token: process.env.E2E_ADMIN_TOKEN })).status).toBe(404);
    expect((await request.get(`/api/events/${ev.slug}`)).status()).toBe(404);
    expect((await request.get(`/api/events/${ev.slug}/scoreboard`)).status()).toBe(404);
  });

  test('cancel keeps the event', async ({ page, events }) => {
    const ev = await events.create({ tag: 'del-cancel', name: 'Keep Me', questions: 6, perGame: 5 });
    await gotoAdmin(page, '#/events');
    await eventCard(page, ev).getByRole('button', { name: /More actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(eventCard(page, ev)).toBeVisible();
  });
});

