/**
 * (6) Admin: results table, answers, score correction and deletion, leads CSV export (CSV-injection safe), live refresh.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { admin, playViaApi, scoreboard } from '../support/api';
import { gotoTab, dialog, toast, downloadText } from '../support/admin';

test.use({ asAdmin: true });

interface Seeded { ev: TestEvent; ada: any; alan: any; grace: any }

/** Three completed games with distinct scores, phones and emails. */
async function seed(events: any, tag: string): Promise<Seeded> {
  const ev: TestEvent = await events.create({ tag, questions: 8, perGame: 4, timer: 10, collectPhone: 'optional', consentEn: 'I agree (results test).' });
  const ada = await playViaApi(ev.slug, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada.lovelace@e2e.example.com', phone_number: '+31 6 1111 1111', consent: true, green: 4, seconds: 1 });
  const alan = await playViaApi(ev.slug, { first_name: 'Alan', last_name: 'Turing', email: 'alan.turing@e2e.example.com', phone_number: '+31 6 2222 2222', consent: true, green: 3, seconds: 2 });
  const grace = await playViaApi(ev.slug, { first_name: 'Grace', last_name: 'Hopper', email: 'grace.hopper@e2e.example.com', consent: true, green: 1, skip: 1, seconds: 3 });
  return { ev, ada, alan, grace };
}
const row = (page: import('@playwright/test').Page, name: RegExp | string) => page.getByRole('row', { name });

test.describe('results table', () => {
  test('lists every completed game with contact details, sorts, searches and summarises', async ({ page, events }) => {
    const { ev, ada, alan, grace } = await seed(events, 'res-table');
    await gotoTab(page, ev, 'results');

    await expect(row(page, /Ada Lovelace/)).toBeVisible();
    await expect(row(page, /Alan Turing/)).toBeVisible();
    await expect(row(page, /Grace Hopper/)).toBeVisible();
    // admins see the leads: email, phone, consent
    await expect(row(page, /Ada Lovelace/)).toContainText('ada.lovelace@e2e.example.com');
    await expect(row(page, /Ada Lovelace/)).toContainText('+31 6 1111 1111');
    await expect(row(page, /Grace Hopper/)).toContainText('grace.hopper@e2e.example.com');
    await expect(row(page, /Ada Lovelace/)).toContainText(new RegExp(String(ada.result.game_session.total_score).replace(/(\d)(?=(\d{3})+$)/, '$1[,.\\s\\u202f\\u00a0]?')));
    await expect(row(page, /Ada Lovelace/).getByRole('cell', { name: '4 correct, 0 wrong, 0 unanswered' })).toBeVisible();
    await expect(row(page, /Grace Hopper/).getByRole('cell', { name: '1 correct, 2 wrong, 1 unanswered' })).toBeVisible();

    const summary = page.getByRole('group', { name: 'Results summary' });
    await expect(summary).toContainText(/Completed games\s*3/);
    await expect(summary).toContainText(String(ada.result.game_session.total_score)); // top score

    // sort by top score: Ada (4 correct, fastest) first, Grace last
    await page.getByRole('radiogroup', { name: 'Sort results' }).getByRole('radio', { name: 'Top score' }).check();
    const names = () => page.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => tr.querySelector('button')?.textContent?.trim()));
    await expect.poll(names).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);

    // search by name and by email
    await page.getByRole('searchbox', { name: 'Search players by name or email' }).fill('turing');
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await expect(row(page, /Alan Turing/)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search players by name or email' }).fill('grace.hopper@');
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await expect(row(page, /Grace Hopper/)).toBeVisible();
    expect(alan.result.rank).toBeGreaterThan(1);
    expect(grace.result.rank).toBe(3);
  });

  test('"Refresh now" picks up a game that finished meanwhile', async ({ page, events }) => {
    const { ev } = await seed(events, 'res-refresh');
    await gotoTab(page, ev, 'results');
    await expect(row(page, /Grace Hopper/)).toBeVisible();
    await playViaApi(ev.slug, { first_name: 'Linus', last_name: 'Torvalds', consent: true, green: 2 });
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(row(page, /Linus Torvalds/)).toBeVisible();
  });
});

test.describe('many results', () => {
  test('are paged, sortable and the page size can change', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev: TestEvent = await events.create({ tag: 'res-paging', questions: 8, perGame: 3, timer: 10 });
    await Promise.all(Array.from({ length: 30 }, (_, i) => playViaApi(ev.slug, { first_name: `Pager${String(i).padStart(2, '0')}`, last_name: 'Test', green: i % 4, seconds: 1 + (i % 7) })));
    await gotoTab(page, ev, 'results');
    const info = page.locator('.rs-pagination .pagination__info');
    await expect(info).toHaveText('1–25 of 30');
    await expect(page.locator('table tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: 'Page 2' }).click();
    await expect(info).toHaveText('26–30 of 30');
    await expect(page.locator('table tbody tr')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(info).toHaveText('1–25 of 30');
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption('50');
    await expect(page.locator('table tbody tr')).toHaveCount(30);
    // top score first: the best possible game (3 correct, fastest) leads the list
    await page.getByRole('radiogroup', { name: 'Sort results' }).getByRole('radio', { name: 'Top score' }).check();
    const scoresOnScreen = async () => (await page.locator('table tbody tr td:nth-child(5) strong').allInnerTexts()).map((t) => Number(t.replace(/\D/g, '')));
    await expect.poll(async () => {
      const n = await scoresOnScreen();
      return n.length === 30 && n.every((v, i) => i === 0 || n[i - 1] >= v);
    }, { message: 'rows sorted by score, best first' }).toBe(true);
  });
});

test.describe('a single result', () => {
  test('shows the answers question by question', async ({ page, events }) => {
    const { ev } = await seed(events, 'res-answers');
    await gotoTab(page, ev, 'results');
    await page.getByRole('button', { name: 'View answers of Grace Hopper' }).click();
    const dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Grace Hopper' })).toBeVisible();
    await expect(dlg).toContainText('grace.hopper@e2e.example.com');
    await expect(dlg.getByRole('img', { name: 'Correct' })).toHaveCount(1);
    await expect(dlg.getByRole('img', { name: 'Wrong' })).toHaveCount(2);
    await expect(dlg.getByRole('img', { name: 'Unanswered' })).toHaveCount(1);
    await expect(dlg).toContainText('QA statement');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('correcting a score updates the table and the public scoreboard immediately', async ({ page, browser, events }) => {
    const { ev, grace } = await seed(events, 'res-score');
    const pub = await (await browser.newContext()).newPage();
    try {
      await pub.goto(`/${ev.slug}/scoreboard`);
      await expect(pub.locator('#sb')).toHaveAttribute('data-transport', 'sse', { timeout: 15_000 });
      await expect(pub.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Ada L.');

      await gotoTab(page, ev, 'results');
      await page.getByRole('button', { name: 'Edit score of Grace Hopper' }).click();
      const dlg = dialog(page);
      await expect(dlg).toContainText(`currently ${grace.result.game_session.total_score} points`);
      await dlg.getByRole('spinbutton', { name: 'Total score (points)' }).fill('9999');
      await dlg.getByRole('button', { name: 'Save score' }).click();
      await expect(row(page, /Grace Hopper/)).toContainText(/9[,.\s\u202f\u00a0]?999/);

      const board = await scoreboard(ev.slug);
      expect(board[0]).toMatchObject({ player_name: 'Grace H.', score: 9999, rank: 1 });
      // the open TV scoreboard follows without a reload
      await expect(pub.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Grace H.');
    } finally {
      await pub.context().close();
    }
  });

  test('a negative or empty score is refused', async ({ page, events }) => {
    const { ev, ada } = await seed(events, 'res-badscore');
    await gotoTab(page, ev, 'results');
    await page.getByRole('button', { name: 'Edit score of Ada Lovelace' }).click();
    const dlg = dialog(page);
    await dlg.getByRole('spinbutton', { name: 'Total score (points)' }).fill('-5');
    await dlg.getByRole('button', { name: 'Save score' }).click();
    await expect(dialog(page)).toHaveCount(1);
    expect((await scoreboard(ev.slug))[0].score).toBe(ada.result.game_session.total_score);
  });

  test('deleting a result asks first and updates the scoreboard', async ({ page, events }) => {
    const { ev, ada } = await seed(events, 'res-delete');
    await gotoTab(page, ev, 'results');
    await page.getByRole('button', { name: 'Delete result of Ada Lovelace' }).click();
    let dlg = dialog(page);
    await expect(dlg.getByRole('heading', { name: 'Delete this result?' })).toBeVisible();
    await expect(dlg).toContainText(`${ada.result.game_session.total_score} points`);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(await scoreboard(ev.slug)).toHaveLength(3);

    await page.getByRole('button', { name: 'Delete result of Ada Lovelace' }).click();
    dlg = dialog(page);
    await dlg.getByRole('button', { name: 'Delete result' }).click();
    await expect(row(page, /Ada Lovelace/)).toHaveCount(0);
    const board = await scoreboard(ev.slug);
    expect(board).toHaveLength(2);
    expect(board[0].player_name).toBe('Alan T.');
    expect((await admin.get(`/admin/events/${ev.id}`)).counts.games_completed).toBe(2);
  });
});

test.describe('leads export', () => {
  test('downloads a CSV with rank, contact details and consent', async ({ page, events }) => {
    const { ev } = await seed(events, 'res-csv');
    await gotoTab(page, ev, 'results');
    await expect(row(page, /Ada Lovelace/)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export leads as CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const csv = await downloadText(download);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(4); // header + 3 players
    expect(lines[0].toLowerCase()).toMatch(/rank.*first.*last.*email.*phone.*consent.*score/);
    expect(csv).toContain('ada.lovelace@e2e.example.com');
    expect(csv).toContain('+31 6 1111 1111');
    // ranked 1..3 in order
    expect(lines[1]).toMatch(/^"?1"?,.*Ada/);
    expect(lines[3]).toMatch(/Grace/);
  });

  test('cells that start with = + - @ are neutralised so a spreadsheet never runs them (CSV injection)', async ({ events }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'HTTP-level check, identical in every browser');
    const ev: TestEvent = await events.create({ tag: 'res-inj', questions: 6, perGame: 3 });
    await playViaApi(ev.slug, { first_name: '=HYPERLINK("http://evil.example/","click")', last_name: 'Formula', email: 'formula@e2e.example.com' });
    await playViaApi(ev.slug, { first_name: '+CMD', last_name: 'Plus', email: 'plus@e2e.example.com' });
    const res = await fetch(`${process.env.BASE_URL || 'http://localhost:8080'}/api/admin/events/${ev.id}/results.csv`, { headers: { Authorization: `Bearer ${process.env.E2E_ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    const csv = await res.text();
    // no cell may begin with a formula character
    const cells = csv.split(/\r?\n/).flatMap((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    for (const cell of cells) expect(cell, `cell ${JSON.stringify(cell)} must not start with a formula character`).not.toMatch(/^[=+\-@]/);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+CMD");
  });
});

test.describe('overview numbers', () => {
  test('live numbers follow the games played', async ({ page, events }) => {
    const { ev } = await seed(events, 'res-overview');
    await gotoTab(page, ev, 'overview');
    const numbers = page.locator('[data-view="overview"]');
    await expect(numbers).toContainText(/Players\s*3/);
    await expect(numbers).toContainText(/Games completed\s*3/);
    const stats = await admin.get(`/admin/events/${ev.id}/stats`);
    expect(stats).toMatchObject({ players: 3, games_completed: 3 });
    expect(stats.top_score).toBeGreaterThan(stats.avg_score - 1);
  });
});
