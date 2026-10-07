/**
 * (6) Admin: game rules, scoring, category mix, registration and languages are saved and change what players get.
 */
import { test, expect } from '../support/fixtures';
import { admin } from '../support/api';
import { gotoTab, toast, dialog } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, playButton } from '../support/ui';
import type { Page } from '@playwright/test';

test.use({ asAdmin: true });

const save = (page: Page) => page.getByRole('button', { name: 'Save changes' });
const num = (page: Page, label: string) => page.getByRole('spinbutton', { name: label, exact: true });
const seg = (page: Page, group: string) => page.getByRole('radiogroup', { name: group, exact: true });

/** Click Save and wait until the backend has answered (the toast), then until the form is clean again. */
async function saveSettings(page: Page) {
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(toast(page, 'Settings saved')).toBeVisible();
  await expect(save(page)).toBeDisabled();
}

test.describe('game rules and scoring', () => {
  test('questions per game, timer and points are applied to the next game (and to its score)', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'set-rules', questions: 8, perGame: 5, timer: 5, pointsCorrect: 100, timeBonusMax: 50 });
    await gotoTab(page, ev, 'settings');
    await expect(save(page)).toBeDisabled();

    await num(page, 'Questions per game').fill('3');
    await num(page, 'Seconds per question').fill('9');
    await num(page, 'Points for a correct answer').fill('200');
    await num(page, 'Points for a wrong answer').fill('10');
    await num(page, 'Maximum time bonus').fill('0');
    await seg(page, 'Question order').getByRole('radio', { name: 'Easy to hard' }).check();
    await saveSettings(page);

    const stored = await admin.get(`/admin/events/${ev.id}`);
    expect(stored.settings).toMatchObject({ questions_per_game: 3, timer_seconds: 9, points_correct: 200, points_wrong: 10, time_bonus_max: 0, question_order: 'easy_to_hard' });

    // a player gets exactly that game: 3 questions, 9 s, 200 points flat (no time bonus), 10 for a wrong answer
    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await registerUpToRules(pub, { first: 'Rule', last: 'Follower' });
      await expect(pub.getByText('A correct answer earns 200 points.')).toBeVisible();
      await expect(pub.getByText('A wrong answer earns 10 points.')).toBeVisible();
      await expect(pub.locator('.ev-rule__title').first()).toHaveText('3 questions');
      await startGame(pub);
      await playByKeyboard(pub, ['g', 'r', 'g']);
      const r = await readResults(pub);
      expect([r.correct, r.wrong]).toEqual([2, 1]);
      expect(r.score).toBe(2 * 200 + 10);
    } finally {
      await visitor.close();
    }
  });

  test('values outside the allowed range are refused and nothing is saved', async ({ page, events }) => {
    const ev = await events.create({ tag: 'set-range', questions: 8, perGame: 5 });
    await gotoTab(page, ev, 'settings');
    await num(page, 'Questions per game').fill('99');
    await num(page, 'Seconds per question').fill('1');
    await save(page).click();
    await expect(page.locator('.field--invalid').first()).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).settings).toMatchObject({ questions_per_game: 5, timer_seconds: 5 });
    await page.getByRole('button', { name: 'Reset changes' }).click();
    await expect(num(page, 'Questions per game')).toHaveValue('5');
  });

  test('an equal split can be replaced by weights: only weighted categories are drawn', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'set-mix', questions: 10, perGame: 3, timer: 6 });
    await gotoTab(page, ev, 'settings');
    await page.getByRole('switch', { name: /Equal split/ }).uncheck();
    await num(page, 'Weight of QA Alpha').fill('100');
    await num(page, 'Weight of QA Beta').fill('0');
    await saveSettings(page);
    const stored = await admin.get(`/admin/events/${ev.id}`);
    const dist = stored.settings.category_distribution;
    expect(Object.keys(dist)).toHaveLength(1);

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await registerUpToRules(pub, { first: 'Mix', last: 'Test' });
      const [res] = await Promise.all([
        pub.waitForResponse((r) => /\/games$/.test(r.url()) && r.request().method() === 'POST'),
        pub.locator('[data-action="start"]').click(),
      ]);
      const game = await res.json();
      expect(game.questions).toHaveLength(3);
      expect(game.questions.every((q: any) => q.category.name === 'QA Alpha')).toBe(true);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('registration settings', () => {
  test('phone number mode and the consent text change the registration form', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'set-reg', questions: 6, perGame: 3, collectPhone: 'optional' });
    await gotoTab(page, ev, 'settings');
    await seg(page, 'Phone number').getByRole('radio', { name: 'Required' }).check();
    await page.getByRole('textbox', { name: 'Consent text (English)' }).fill('I accept the QA rules.');
    await page.getByRole('tab', { name: 'Français' }).click();
    await page.getByRole('textbox', { name: 'Consent text (Français)' }).fill('J’accepte les règles QA.');
    await saveSettings(page);
    expect((await admin.get(`/admin/events/${ev.id}`)).settings).toMatchObject({ collect_phone: 'required', consent_text_en: 'I accept the QA rules.', consent_text_fr: 'J’accepte les règles QA.' });

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await playButton(pub).click();
      await expect(pub.getByLabel(/^Phone number/)).toBeVisible();
      await expect(pub.locator('label[for]').filter({ hasText: 'Phone number' }).locator('.field__optional')).toHaveCount(0);
      await expect(pub.locator('.ev-consent')).toContainText('I accept the QA rules.');
    } finally {
      await visitor.close();
    }

    // and back: phone not asked, no consent box
    await seg(page, 'Phone number').getByRole('radio', { name: 'Not asked' }).check();
    await page.getByRole('textbox', { name: 'Consent text (Français)' }).fill('');
    await page.getByRole('tab', { name: 'English' }).click();
    await page.getByRole('textbox', { name: 'Consent text (English)' }).fill('');
    await saveSettings(page);
    const visitor2 = await browser.newContext();
    const pub2 = await visitor2.newPage();
    try {
      await openEvent(pub2, ev.slug);
      await playButton(pub2).click();
      await expect(pub2.getByLabel('Email', { exact: true })).toBeVisible();
      await expect(pub2.getByLabel(/^Phone number/)).toHaveCount(0);
      await expect(pub2.locator('input[name="consent"]')).toHaveCount(0);
    } finally {
      await visitor2.close();
    }
  });
});

test.describe('languages', () => {
  test('disabling French removes the switch; the default language applies to new visitors', async ({ page, browser, events }) => {
    const ev = await events.create({ tag: 'set-lang', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'settings');
    await page.getByRole('group', { name: 'Enabled languages' }).getByRole('checkbox', { name: 'Français' }).uncheck();
    await expect(seg(page, 'Default language').getByRole('radio', { name: 'English' })).toBeChecked();
    await saveSettings(page);
    expect((await admin.get(`/admin/events/${ev.id}`)).languages).toEqual(['en']);

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug, '?lang=fr'); // French is not offered any more: English wins
      await expect(pub.locator('.lang-switch')).toHaveCount(0);
      await expect(pub.locator('[data-action="play"]')).toContainText('Play now');
    } finally {
      await visitor.close();
    }

    // French back on and made the default
    await page.getByRole('group', { name: 'Enabled languages' }).getByRole('checkbox', { name: 'Français' }).check();
    await seg(page, 'Default language').getByRole('radio', { name: 'Français' }).check();
    await saveSettings(page);
    const visitor2 = await browser.newContext();
    const pub2 = await visitor2.newPage();
    try {
      await openEvent(pub2, ev.slug);
      await expect(pub2.locator('html')).toHaveAttribute('lang', 'fr');
      await expect(pub2.locator('[data-action="play"]')).toContainText('Jouer maintenant');
    } finally {
      await visitor2.close();
    }
  });

  test('at least one language must stay enabled', async ({ page, events }) => {
    const ev = await events.create({ tag: 'set-lang1', questions: 6, perGame: 3, languages: ['en'] });
    await gotoTab(page, ev, 'settings');
    await page.getByRole('group', { name: 'Enabled languages' }).getByRole('checkbox', { name: 'English' }).uncheck();
    await save(page).click();
    await expect(page.getByText('Keep at least one language enabled.')).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).languages).toEqual(['en']);
  });
});

test.describe('status from the settings tab', () => {
  test('changing it asks for confirmation, then is saved with the rest', async ({ page, events }) => {
    const ev = await events.create({ tag: 'set-status', status: 'draft', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'settings');
    await seg(page, 'Status').getByRole('radio', { name: 'Live' }).check();
    await save(page).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Change the status from Draft to Live?' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('draft');
    await save(page).click();
    await dialog(page).getByRole('button', { name: 'Set to Live' }).click();
    await expect(toast(page, 'Settings saved')).toBeVisible();
    expect((await admin.get(`/admin/events/${ev.id}`)).status).toBe('live');
  });
});
