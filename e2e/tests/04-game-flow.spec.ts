/**
 * (4) A complete game from the keyboard (G / R), with one timeout, results (score, rank), the review page with
 * explanations, and the FR / EN switch in the middle of the flow. Plus resume after a reload and the "first answer wins" rule.
 *
 * Fixture facts (support/events.ts): every question is TRUE (green is right), so with a plan of 10 x G, 4 x R and one
 * timeout the result is exactly 10 correct / 4 wrong / 1 unanswered whatever order the server draws the questions in.
 */
import { test, expect } from '../support/fixtures';
import { scoreboard } from '../support/api';
import { setStatus } from '../support/events';
import {
  openEvent, registerUpToRules, startGame, playByKeyboard, readResults, switchLang, emailFor, fillRegistration, playButton, submitRegistration,
  type Step,
} from '../support/ui';

test.describe('full 15-question game', () => {
  test.setTimeout(120_000);

  test('keyboard game with a timeout, FR <-> EN switches, results, review with explanations', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-full', questions: 20, perGame: 15, timer: 5, twoChoices: 3, name: 'Flow Summit', gameTitle: 'Flow Masters' });
    const plan: Step[] = ['g', 'g', 'r', 'g', 'g', 'g', 'r', 'timeout', 'g', 'r', 'g', 'g', 'r', 'g', 'g'];
    expect(plan.filter((s) => s === 'g')).toHaveLength(10);

    // ---- landing -> registration, switch to French while filling the form
    await openEvent(page, ev.slug);
    await expect(page.locator('[data-action="play"]')).toContainText('Play now');
    await playButton(page).click();
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await fillRegistration(page, { first: 'Ada', last: 'Lovelace', email: emailFor('flow') });
    await switchLang(page, 'fr');
    await expect(page.getByRole('heading', { name: 'Qui joue ?' })).toBeVisible();
    await expect(page.getByLabel('Prénom', { exact: true })).toHaveValue('Ada');
    await submitRegistration(page);

    // ---- rules in French, then the game
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Comment jouer' })).toBeVisible();
    await expect(page.locator('.ev-sub')).toContainText('Ada');
    await expect(page.locator('.ev-rule__title').first()).toContainText('15 questions');
    await startGame(page);

    // first question is French: statement, Vrai / Faux (or the two_choices labels), nothing reveals the answer
    await expect(page.locator('.question__text')).toContainText(/Affirmation QA \d+ : l'eau est mouillée\./);
    await expect(page.locator('.game-counter')).toContainText('1 / 15');
    await expect(page.locator('.ring')).toHaveAttribute('role', 'timer');

    await playByKeyboard(page, plan, async (i, p) => {
      if (i === 1) {
        await expect(p.locator('.answer--green .answer__label')).toHaveText(/Vrai|Alfa \d+/);
        await expect(p.locator('.answer--red .answer__label')).toHaveText(/Faux|Oméga \d+/);
      }
      if (i === 5) {
        // switch to English in the middle of the game: the question re-renders in English, the clock and progress are kept
        await switchLang(p, 'en');
        await expect(p.locator('.question__text')).toContainText(/QA statement \d+: water is wet\./);
        await expect(p.locator('.game-counter')).toContainText('5 / 15');
      }
      // correctness is never revealed while playing
      await expect(p.locator('.answer.is-correct, .answer.is-wrong')).toHaveCount(0);
    });

    // ---- results (English now)
    const r = await readResults(page);
    expect(r.correct).toBe(10);
    expect(r.wrong).toBe(4);
    expect(r.unanswered).toBe(1);
    // 100 points + a time bonus of up to 50 per correct answer
    expect(r.score).toBeGreaterThanOrEqual(10 * 100);
    expect(r.score).toBeLessThanOrEqual(10 * 150);
    expect(r.rank).toMatch(/Rank #1 of 1/);
    await expect(page.locator('.ev-title--result')).toHaveText('Great game, Ada!');
    await expect(page.locator('[data-action="review"]')).toBeVisible();
    await expect(page.locator('[data-action="scoreboard"]')).toHaveAttribute('href', `/${ev.slug}/scoreboard`);

    // the server agrees, and the public row is "First L."
    const rows = await scoreboard(ev.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ player_name: 'Ada L.', rank: 1, score: r.score, correct_answers: 10, wrong_answers: 4 });

    // ---- review: every question, the correct answer, the explanation
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('main[data-view="review"]')).toBeVisible();
    const items = page.locator('.ev-review-list > li .review-item');
    await expect(items).toHaveCount(15);
    await expect(page.locator('.review-item[data-state="correct"]')).toHaveCount(10);
    await expect(page.locator('.review-item[data-state="wrong"]')).toHaveCount(4);
    await expect(page.locator('.review-item[data-state="missed"]')).toHaveCount(1);
    await expect(page.locator('.review-item__explain').first()).toContainText(/Why: Explanation \d+: water is indeed wet\./);
    await expect(page.locator('.review-item[data-state="missed"]')).toContainText('No answer');
    await expect(page.locator('.review-item[data-state="wrong"]').first()).toContainText('Correct answer');
    await expect(page.locator('.review-item__explain')).toHaveCount(15);

    // "Mistakes only" keeps the 4 wrong answers and the timeout
    await page.getByRole('radio', { name: 'Mistakes only (5)' }).check();
    await expect(items).toHaveCount(5);
    await page.getByRole('radio', { name: 'All (15)' }).check();
    await expect(items).toHaveCount(15);

    // the review follows the language: French explanations and category names
    await switchLang(page, 'fr');
    await expect(page.getByRole('heading', { name: 'Vos réponses en détail' }).or(page.locator('.ev-title'))).toBeVisible();
    await expect(page.locator('.review-item__explain').first()).toContainText(/Explication \d+ : l'eau est bien mouillée\./);
    await expect(page.locator('.review-item .chip').filter({ hasText: /QA (Alfa|Bêta)/ }).first()).toBeVisible();
    await switchLang(page, 'en');

    // back to the results, then the next player starts clean
    await page.getByRole('button', { name: 'Back to results' }).first().click();
    await expect(page.locator('main[data-view="results"]')).toBeVisible();
    await page.locator('[data-action="again"]').click();
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    await playButton(page).click();
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  });
});

test.describe('short games', () => {
  test('first answer wins: a second key in the same instant is ignored', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-first', questions: 6, perGame: 3, timer: 10 });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Fast', last: 'Fingers' });
    await startGame(page);
    for (let i = 1; i <= 3; i += 1) {
      await expect(page.locator('.game-counter')).toContainText(`${i} / 3`);
      await expect(page.locator('.answer--green')).toBeEnabled();
      // G then R without waiting: only G counts
      await page.keyboard.press('g');
      await page.keyboard.press('r');
      await expect(page.locator('.ev-lock')).toBeVisible();
      await expect(page.locator('.answer--green')).toHaveClass(/is-selected/);
      await expect(page.locator('.answer--red')).not.toHaveClass(/is-selected/);
    }
    const r = await readResults(page);
    expect([r.correct, r.wrong, r.unanswered]).toEqual([3, 0, 0]);
  });

  test('tapping the answer buttons works as well as the keyboard', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-tap', questions: 6, perGame: 3, timer: 10 });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Tap', last: 'Tapper' });
    await startGame(page);
    for (let i = 1; i <= 3; i += 1) {
      await expect(page.locator('.game-counter')).toContainText(`${i} / 3`);
      await expect(page.locator('.answer--red')).toBeEnabled();
      await page.locator(i === 2 ? '.answer--red' : '.answer--green').click();
    }
    const r = await readResults(page);
    expect([r.correct, r.wrong, r.unanswered]).toEqual([2, 1, 0]);
  });

  test('a reload in the middle of a game offers to resume it; the browser Back button never abandons it', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-resume', questions: 6, perGame: 4, timer: 20 });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Resu', last: 'Mer' });
    await startGame(page);
    await playByKeyboard(page, ['g', 'g'], null, { total: 4 }); // answers 1 and 2 of 4 are locked in

    // Back is swallowed while a game is running
    await page.goBack().catch(() => {});
    await expect(page.locator('main[data-view="game"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    const resume = page.locator('.ev-resume');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText('Game in progress');
    await expect(resume).toContainText('of 4');
    await resume.getByRole('button', { name: 'Resume game' }).click();
    await expect(page.locator('main[data-view="game"]')).toBeVisible();
    // it continues where it stopped: 3 of 4 (answered questions are not asked again)
    await expect(page.locator('.game-counter')).toContainText(/3\s*\/\s*4/);
    await expect(page.locator('.answer--green')).toBeEnabled();
    await page.keyboard.press('g');
    await expect(page.locator('.game-counter')).toContainText(/4\s*\/\s*4/);
    await expect(page.locator('.answer--green')).toBeEnabled();
    await page.keyboard.press('r');
    const r = await readResults(page);
    expect([r.correct, r.wrong, r.unanswered]).toEqual([3, 1, 0]);
  });

  test('"Start over" on the resume card discards the unfinished game', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-discard', questions: 6, perGame: 3, timer: 20 });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Dis', last: 'Card' });
    await startGame(page);
    await playByKeyboard(page, ['g'], null, { total: 3 });
    await page.reload();
    await expect(page.locator('.ev-resume')).toBeVisible();
    await page.locator('.ev-resume').getByRole('button', { name: 'Start over' }).click();
    await expect(page.locator('.ev-resume')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
    await expect(page.locator('.ev-resume')).toHaveCount(0);
  });

  test('the game never exposes the answers before submitting (API payload check)', async ({ page, events }) => {
    const ev = await events.create({ tag: 'flow-noleak', questions: 6, perGame: 3, timer: 20 });
    let started: any = null;
    page.on('response', async (res) => {
      if (/\/api\/events\/[^/]+\/games$/.test(res.url()) && res.request().method() === 'POST') started = await res.json();
    });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'No', last: 'Leak' });
    await startGame(page);
    expect(started).not.toBeNull();
    const dump = JSON.stringify(started.questions);
    expect(dump).not.toMatch(/correct_answer|explanation_en|explanation_fr|Explanation \d/);
    expect(started.questions).toHaveLength(3);
  });
});

test.describe('a flaky network at the end of the game', () => {
  // the browser logs the requests we make fail: that is the point of these tests
  test.use({ expectedConsole: /Failed to load resource|ERR_FAILED|NetworkError|Load failed|network/i });

  async function playThree(page: import('@playwright/test').Page, slug: string, name: string) {
    await openEvent(page, slug);
    await registerUpToRules(page, { first: name, last: 'Network' });
    await startGame(page);
    await playByKeyboard(page, ['g', 'g', 'r']);
  }

  test('a failed submit is retried automatically and the score is saved once', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev = await events.create({ tag: 'flow-blip', questions: 6, perGame: 3, timer: 20 });
    let calls = 0;
    await page.route('**/games/*/submit', (route) => { calls += 1; return calls === 1 ? route.abort('failed') : route.continue(); });
    await playThree(page, ev.slug, 'Blip');
    // the first attempt failed: the player is told, nothing is lost
    await expect(page.getByText(/Connection trouble|Trying again/i).first()).toBeVisible({ timeout: 15_000 });
    const r = await readResults(page);
    expect([r.correct, r.wrong, r.unanswered]).toEqual([2, 1, 0]);
    expect(calls).toBe(2);
    const rows = await scoreboard(ev.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(r.score);
  });

  test('the server scored the game but the answer never arrived: the retry reads the result instead of a dead end', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev = await events.create({ tag: 'flow-lost', questions: 6, perGame: 3, timer: 20 });
    let calls = 0;
    await page.route('**/games/*/submit', async (route) => {
      calls += 1;
      if (calls === 1) { await route.fetch(); await route.abort('failed'); return; } // processed by the server, response lost
      await route.continue();
    });
    await playThree(page, ev.slug, 'Lost');
    const r = await readResults(page); // full results, rank and review, not "already saved"
    expect([r.correct, r.wrong, r.unanswered]).toEqual([2, 1, 0]);
    expect(r.rank).toMatch(/Rank #1 of 1/);
    await page.locator('[data-action="review"]').click();
    await expect(page.locator('.review-item')).toHaveCount(3);
    // exactly one game was recorded
    const rows = await scoreboard(ev.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: r.score, correct_answers: 2, wrong_answers: 1 });
  });
});

test.describe('the event closes while a game is running', () => {
  test('the player still gets the result (grace period), and the score is on the final scoreboard', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev = await events.create({ tag: 'flow-closing', questions: 6, perGame: 3, timer: 20 });
    await openEvent(page, ev.slug);
    await registerUpToRules(page, { first: 'Last', last: 'Minute' });
    await startGame(page);
    await playByKeyboard(page, ['g'], null, { total: 3 });
    await setStatus(ev, 'closed'); // the booth closes the event mid-game
    await playByKeyboard(page, ['g', 'g'], null, { total: 3, first: 2 });
    const r = await readResults(page);
    expect([r.correct, r.wrong, r.unanswered]).toEqual([3, 0, 0]);
    const rows = await scoreboard(ev.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0].player_name).toBe('Last M.');
  });
});
