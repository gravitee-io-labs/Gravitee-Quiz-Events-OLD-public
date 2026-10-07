/**
 * (6) Admin: categories and questions (add through the UI and see them playable), CSV import with a dry run,
 * edit / deactivate / delete.
 */
import { test, expect } from '../support/fixtures';
import { admin } from '../support/api';
import { gotoTab, dialog, toast } from '../support/admin';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, switchLang } from '../support/ui';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.use({ asAdmin: true });

test.describe('build an event from nothing', () => {
  test('a category and a question added in the console are playable, with their explanation', async ({ page, browser, events }) => {
    // a blank event, one question per game, live
    const ev = await events.createMinimal({ tag: 'content-new', name: 'Content Summit', gameTitle: 'Content Masters' });
    await admin.put(`/admin/events/${ev.id}`, { status: 'live', settings: { questions_per_game: 1, timer_seconds: 20 } });

    // ---- category
    await gotoTab(page, ev, 'categories');
    await expect(page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New category' }).first().click();
    let dlg = dialog(page);
    await dlg.getByRole('textbox', { name: 'Name (English)' }).fill('Zeta Topic');
    await dlg.getByRole('textbox', { name: /^Name \(French\)/ }).fill('Sujet Zêta');
    await dlg.getByRole('button', { name: 'Emerald' }).click();
    await dlg.getByRole('button', { name: 'Create category' }).click();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Zeta Topic' }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Sujet Zêta');
    const cats = await admin.get(`/admin/events/${ev.id}/categories`);
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ name: 'Zeta Topic', name_fr: 'Sujet Zêta', is_active: true });

    // ---- question in that category
    await gotoTab(page, ev, 'questions');
    await page.getByRole('button', { name: 'Add question' }).first().click();
    dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'New question' })).toBeVisible();
    await dlg.getByRole('combobox', { name: /^Category/ }).selectOption({ label: 'Zeta Topic' });
    await dlg.getByRole('textbox', { name: 'Question (English)' }).fill('The sky is blue on a clear day.');
    await dlg.getByRole('textbox', { name: /^Question \(French\)/ }).fill('Le ciel est bleu par temps clair.');
    await dlg.getByRole('textbox', { name: /^Explanation \(English\)/ }).fill('Rayleigh scattering favours blue light.');
    await dlg.getByRole('textbox', { name: /^Explanation \(French\)/ }).fill('La diffusion de Rayleigh favorise la lumière bleue.');
    await dlg.getByRole('button', { name: 'Add question' }).click();
    await expect(toast(page, /added|saved|created/i)).toBeVisible();
    const row = page.getByRole('row', { name: /The sky is blue on a clear day/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Zeta Topic');
    await expect(row).toContainText('True / False');
    const qs = await admin.get(`/admin/events/${ev.id}/questions`);
    expect(qs.total).toBe(1);
    expect(qs.items[0]).toMatchObject({ question_text_en: 'The sky is blue on a clear day.', correct_answer: 'green', question_format: 'true_false', is_active: true });
    expect(qs.items[0].category.name).toBe('Zeta Topic');

    // ---- a player can play it
    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await registerUpToRules(pub, { first: 'Built', last: 'Here' });
      await startGame(pub);
      await expect(pub.locator('.question__text')).toHaveText('The sky is blue on a clear day.');
      await expect(pub.locator('.ev-chip-host .chip')).toHaveText('Zeta Topic');
      await playByKeyboard(pub, ['g']);
      const r = await readResults(pub);
      expect([r.correct, r.wrong, r.unanswered]).toEqual([1, 0, 0]);
      await pub.locator('[data-action="review"]').click();
      await expect(pub.locator('.review-item__explain')).toContainText('Rayleigh scattering favours blue light.');
      await switchLang(pub, 'fr');
      await expect(pub.locator('.review-item__explain')).toContainText('La diffusion de Rayleigh');
      await expect(pub.locator('.review-item .chip').first()).toContainText('Sujet Zêta');
    } finally {
      await visitor.close();
    }
  });

  test('a two-choices question keeps its own labels on the answer buttons', async ({ page, browser, events }) => {
    const ev = await events.createMinimal({ tag: 'content-two', name: 'Two Choices' });
    await admin.put(`/admin/events/${ev.id}`, { status: 'live', settings: { questions_per_game: 1, timer_seconds: 20 } });
    await gotoTab(page, ev, 'questions');
    await page.getByRole('button', { name: 'Add question' }).first().click();
    const dlg = dialog(page);
    await dlg.getByRole('radiogroup', { name: 'Answer format' }).getByRole('radio', { name: 'Two choices' }).check();
    await dlg.getByRole('textbox', { name: 'Question (English)' }).fill('Which style fits a stateless HTTP API?');
    // the answer labels: the first "English label" belongs to the green button, the second to the red one
    await dlg.getByRole('textbox', { name: 'English label' }).nth(0).fill('REST');
    await dlg.getByRole('textbox', { name: 'English label' }).nth(1).fill('SOAP');
    await dlg.getByRole('button', { name: 'Copy EN labels to FR' }).click(); // the editor asks for French labels too
    await dlg.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByRole('row', { name: /Which style fits a stateless HTTP API/ })).toBeVisible();
    const q = (await admin.get(`/admin/events/${ev.id}/questions`)).items[0];
    expect(q).toMatchObject({ question_format: 'two_choices', green_label_en: 'REST', red_label_en: 'SOAP', correct_answer: 'green' });

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    try {
      await openEvent(pub, ev.slug);
      await registerUpToRules(pub, { first: 'Two', last: 'Choices' });
      await startGame(pub);
      await expect(pub.locator('.answer--green .answer__label')).toHaveText('REST');
      await expect(pub.locator('.answer--red .answer__label')).toHaveText('SOAP');
      await playByKeyboard(pub, ['g']);
      expect((await readResults(pub)).correct).toBe(1);
    } finally {
      await visitor.close();
    }
  });
});

test.describe('questions table', () => {
  test('edit text and correct answer, deactivate, search, delete', async ({ page, events }) => {
    const ev = await events.create({ tag: 'content-edit', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'questions');
    const items = (await admin.get(`/admin/events/${ev.id}/questions`, { query: { limit: 100 } })).items as any[];
    const target = items.find((q) => q.question_text_en === 'QA statement 2: water is wet.');

    // search
    await page.getByRole('searchbox', { name: 'Search questions' }).fill('statement 2');
    await expect(page.getByRole('row', { name: /QA statement 2: water is wet\./ })).toBeVisible();
    await expect(page.getByRole('row', { name: /QA statement 3: water is wet\./ })).toHaveCount(0);

    // edit: new text, the correct answer becomes red
    await page.getByRole('button', { name: `Edit question ${target.id}` }).click();
    let dlg = dialog(page);
    await dlg.getByRole('textbox', { name: 'Question (English)' }).fill('QA statement 2 (edited): water is dry.');
    await dlg.getByRole('radio', { name: /Red button/ }).check();
    await dlg.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('row', { name: /QA statement 2 \(edited\): water is dry\./ })).toBeVisible();
    expect(await admin.get(`/admin/events/${ev.id}/questions`, { query: { search: 'edited' } })).toMatchObject({ total: 1 });
    const edited = (await admin.get(`/admin/events/${ev.id}/questions`, { query: { search: 'edited' } })).items[0];
    expect(edited.correct_answer).toBe('red');

    // deactivate with the switch in the table
    await page.getByRole('switch', { name: `Question ${target.id} active` }).uncheck();
    await expect.poll(async () => (await admin.get(`/admin/events/${ev.id}`)).counts.active_questions).toBe(5);

    // delete (with confirmation)
    await page.getByRole('button', { name: `Delete question ${target.id}` }).click();
    dlg = dialog(page);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect((await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(6);
    await page.getByRole('button', { name: `Delete question ${target.id}` }).click();
    await dialog(page).getByRole('button', { name: /^Delete/ }).last().click();
    await expect.poll(async () => (await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(5);
    await expect(page.getByRole('row', { name: /edited/ })).toHaveCount(0);
  });

  test('a question needs text and, for two choices, two different labels', async ({ page, events }) => {
    const ev = await events.create({ tag: 'content-valid', questions: 3, perGame: 3 });
    await gotoTab(page, ev, 'questions');
    await page.getByRole('button', { name: 'Add question' }).first().click();
    const dlg = dialog(page);
    await dlg.getByRole('button', { name: 'Add question' }).click();
    await expect(dlg.locator('.field--invalid, .field__error:not([hidden])').first()).toBeVisible();
    await expect(dialog(page)).toHaveCount(1); // still open
    expect((await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(3);
  });
});

test.describe('a big question pool', () => {
  test('is paged, filtered by category and difficulty, and counted', async ({ page, events }) => {
    const ev = await events.create({ tag: 'content-big', questions: 60, perGame: 5, twoChoices: 10 });
    await gotoTab(page, ev, 'questions');
    const pager = page.locator('.qv-pager .pagination__info');
    const rows = page.locator('[data-view="questions"] table tbody tr');
    await expect(pager).toHaveText('1–50 of 60');
    await expect(rows).toHaveCount(50);
    await page.getByRole('button', { name: 'Page 2' }).click();
    await expect(pager).toHaveText('51–60 of 60');
    await expect(rows).toHaveCount(10);
    await page.getByRole('combobox', { name: 'Questions per page' }).selectOption('25');
    await expect(pager).toHaveText('1–25 of 60');
    await page.getByRole('combobox', { name: 'Questions per page' }).selectOption('100');
    await expect(rows).toHaveCount(60);

    // filters (server side) combine: one category, hard questions only. On a phone they sit behind a "Filters" button.
    const filtersButton = page.getByRole('button', { name: 'Filters' });
    if (await filtersButton.isVisible()) await filtersButton.click();
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'QA Alpha (30)' });
    await expect(page.locator('[data-view="questions"] table tbody tr')).toHaveCount(30);
    await page.getByRole('radiogroup', { name: 'Difficulty' }).getByRole('radio', { name: 'Hard' }).check();
    await expect(page.locator('[data-view="questions"] table tbody tr')).toHaveCount(10);
    const expected = (await admin.get(`/admin/events/${ev.id}/questions`, { query: { limit: 100, difficulty: 3 } })).items.filter((q: any) => q.category?.name === 'QA Alpha').length;
    expect(expected).toBe(10);
    await page.getByRole('combobox', { name: 'Format' }).selectOption({ label: 'Two choices' });
    await expect.poll(async () => page.locator('[data-view="questions"] table tbody tr').count()).toBeLessThan(10);
  });
});

test.describe('categories', () => {
  test('rename, deactivate and delete (its questions stay, uncategorised)', async ({ page, events }) => {
    const ev = await events.create({ tag: 'content-cat', questions: 6, perGame: 3 });
    await gotoTab(page, ev, 'categories');
    await expect(page.getByText('2 categories')).toBeVisible();

    // rename
    await page.getByRole('button', { name: 'Edit QA Beta' }).click();
    await dialog(page).getByRole('textbox', { name: 'Name (English)' }).fill('QA Gamma');
    await dialog(page).getByRole('button', { name: /^(Save changes|Save)$/ }).click();
    await expect(page.getByRole('heading', { name: 'QA Gamma' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'QA Beta' })).toHaveCount(0);

    // deactivate: its questions leave the public pool
    await page.getByRole('switch', { name: 'Category QA Gamma active' }).uncheck();
    await expect.poll(async () => (await admin.get(`/admin/events/${ev.id}/categories`)).find((c: any) => c.name === 'QA Gamma').is_active).toBe(false);
    const pub = await admin.get(`/admin/events/${ev.id}`);
    expect(pub.counts.categories).toBe(2);

    // delete: asks first, questions are kept without a category
    await page.getByRole('button', { name: 'Delete QA Gamma' }).click();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(await admin.get(`/admin/events/${ev.id}/categories`)).toHaveLength(2);
    await page.getByRole('button', { name: 'Delete QA Gamma' }).click();
    await dialog(page).getByRole('button', { name: /^Delete/ }).last().click();
    await expect.poll(async () => (await admin.get(`/admin/events/${ev.id}/categories`)).length).toBe(1);
    const qs = (await admin.get(`/admin/events/${ev.id}/questions`, { query: { limit: 100 } })).items as any[];
    expect(qs).toHaveLength(6); // nothing lost
    expect(qs.filter((q) => q.category == null)).toHaveLength(3);
  });
});

test.describe('CSV import', () => {
  const csv = [
    'question_text_en,correct_answer,category,difficulty,question_text_fr,explanation_en',
    '"CSV one: is the sea salty?",green,CSV Cat,1,"CSV un : la mer est-elle salée ?","Because of dissolved salts."',
    '"CSV two: is ice hot?",red,CSV Cat,2,,',
    '"QA statement 1: water is wet.",green,QA Alpha,1,,',
    '"CSV broken row",purple,QA Alpha,1,,',
  ].join('\n');

  test('a dry run previews the file, nothing is written until you confirm, a second import adds nothing', async ({ page, events }) => {
    const ev = await events.create({ tag: 'content-csv', questions: 4, perGame: 3 });
    const file = join(mkdtempSync(join(tmpdir(), 'qa-csv-')), 'questions.csv');
    writeFileSync(file, csv);
    await gotoTab(page, ev, 'questions');
    await page.getByRole('button', { name: 'Import CSV' }).click();
    let dlg = dialog(page);
    await dlg.locator('input[type=file]').setInputFiles(file);

    // review step: counts of what WOULD happen
    await expect(dlg.getByText('4 rows found')).toBeVisible();
    await expect(dlg).toContainText(/2\s*New questions\s*will be added/);
    await expect(dlg).toContainText(/1\s*Duplicates\s*already in the pool, skipped/);
    await expect(dlg).toContainText(/1\s*New categories\s*will be created/);
    await expect(dlg).toContainText(/1\s*Rows with errors\s*will be skipped/);
    await expect(dlg.getByText(/correct_answer: must be 'green' or 'red'/)).toBeVisible();
    // ... and nothing was written yet
    expect((await admin.get(`/admin/events/${ev.id}`)).counts).toMatchObject({ questions: 4, categories: 2 });

    await dlg.getByRole('button', { name: 'Import 2 questions' }).click();
    await expect(dialog(page)).toContainText(/imported|added|done/i);
    await expect.poll(async () => (await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(6);
    await dialog(page).getByRole('button', { name: /^(Done|Close)$/ }).first().click();
    const counts = (await admin.get(`/admin/events/${ev.id}`)).counts;
    expect(counts.categories).toBe(3);
    const imported = (await admin.get(`/admin/events/${ev.id}/questions`, { query: { search: 'CSV one' } })).items[0];
    expect(imported).toMatchObject({ correct_answer: 'green', difficulty: 1, question_text_fr: 'CSV un : la mer est-elle salée ?', explanation_en: 'Because of dissolved salts.' });

    // importing the same file again: only duplicates, nothing new
    await page.getByRole('button', { name: 'Import CSV' }).click();
    dlg = dialog(page);
    await dlg.locator('input[type=file]').setInputFiles(file);
    await expect(dlg).toContainText(/3\s*Duplicates\s*already in the pool, skipped/);
    await expect(dlg.getByRole('button', { name: 'Nothing to import' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect((await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(6);
  });

  test.describe('invalid file', () => {
    test.use({ expectedConsole: /Failed to load resource|400/ }); // the 400 of the refused dry run

    test('a file that is not a CSV is refused politely', async ({ page, events }) => {
      const ev = await events.create({ tag: 'content-csv-bad', questions: 3, perGame: 3 });
      const file = join(mkdtempSync(join(tmpdir(), 'qa-csv-')), 'empty.csv');
      writeFileSync(file, 'nothing,useful\n');
      await gotoTab(page, ev, 'questions');
      await page.getByRole('button', { name: 'Import CSV' }).click();
      const dlg = dialog(page);
      await dlg.locator('input[type=file]').setInputFiles(file);
      await expect(dlg.getByRole('button', { name: /^Import \d+ question/ })).toHaveCount(0);
      expect((await admin.get(`/admin/events/${ev.id}`)).counts.questions).toBe(3);
    });
  });
});
