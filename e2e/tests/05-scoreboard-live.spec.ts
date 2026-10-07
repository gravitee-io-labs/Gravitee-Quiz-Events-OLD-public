/**
 * (5) Scoreboard: live update through SSE (a game finished in another page shows up without a reload), the polling
 * fallback, closed / draft behaviour, and privacy: no email / phone in the DOM, the REST responses or the stream.
 */
import { test, expect, type TestEvent } from '../support/fixtures';
import { playViaApi, readSseSnapshot, scoreboard, registerPlayer, call } from '../support/api';
import { setStatus } from '../support/events';
import { openEvent, registerUpToRules, startGame, playByKeyboard, readResults, horizontalOverflow, emailFor } from '../support/ui';
import type { Page, BrowserContext } from '@playwright/test';

const SECRET_PHONE = '0612345678';
const board = (page: Page) => page.locator('#sb');
const liveReady = async (page: Page) => {
  await expect(board(page)).toHaveAttribute('data-transport', 'sse', { timeout: 15_000 });
};

/** Play a complete game with the keyboard in another page of the same browser. */
async function playInAnotherPage(context: BrowserContext, slug: string, first: string, last: string, steps: Array<'g' | 'r'>, phone?: string) {
  const other = await context.newPage();
  try {
    await openEvent(other, slug);
    await registerUpToRules(other, { first, last, email: emailFor('sb'), phone });
    await startGame(other);
    await playByKeyboard(other, steps);
    return await readResults(other);
  } finally {
    await other.close();
  }
}

test.describe('live updates', () => {
  test('an empty board turns into a podium when a game finishes in another page (SSE, no reload)', async ({ page, context, events }) => {
    test.setTimeout(90_000);
    const ev = await events.create({ tag: 'sb-live', questions: 6, perGame: 3, timer: 10 });
    await page.goto(`/${ev.slug}/scoreboard`);
    await liveReady(page);
    await expect(board(page)).toHaveAttribute('data-state', 'empty');
    await expect(page.locator('#sb-empty-title')).toHaveText('Be the first to play!');
    await expect(page.locator('#sb-players')).toHaveText('0');
    await page.evaluate(() => { (window as any).__noReload = 'still here'; });

    const result = await playInAnotherPage(context, ev.slug, 'Grace', 'Hopper', ['g', 'g', 'g'], SECRET_PHONE);

    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    const first = page.locator('.podium__place[data-rank="1"]');
    await expect(first.locator('.podium__name')).toHaveText('Grace H.');
    await expect(first.locator('.sb-num')).toHaveText(new RegExp(String(result.score).replace(/(\d)(?=(\d{3})+$)/, '$1[,.\\u202f\\u00a0 ]?')));
    await expect(page.locator('#sb-players')).toHaveText('1');
    await expect(page.locator('#sb-games')).toHaveText('1');
    await expect(page.locator('#sb-live-label')).toHaveText('Live');
    // the same document: nothing reloaded
    expect(await page.evaluate(() => (window as any).__noReload)).toBe('still here');
  });

  test('a lower score lands in the ranking list and a new leader pushes everybody down', async ({ page, context, events }) => {
    test.setTimeout(90_000);
    const ev = await events.create({ tag: 'sb-rows', questions: 6, perGame: 3, timer: 10 });
    for (const [first, last, seconds] of [['Ada', 'Lovelace', 0.5], ['Alan', 'Turing', 1], ['Edsger', 'Dijkstra', 2]] as const) {
      await playViaApi(ev.slug, { first_name: first, last_name: last, seconds });
    }
    await page.goto(`/${ev.slug}/scoreboard`);
    await liveReady(page);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Ada L.');
    await expect(page.locator('.podium__place[data-rank="3"] .podium__name')).toHaveText('Edsger D.');
    await page.evaluate(() => { (window as any).__noReload = 1; });

    // 4th place: one correct answer out of three, so below the three perfect games
    await playInAnotherPage(context, ev.slug, 'Linus', 'Torvalds', ['g', 'r', 'r']);
    const row = page.locator('.lb__row.sb-row:not(.is-ghost)').filter({ hasText: 'Linus T.' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-rank', '4');

    // a new leader: everybody moves down one rank
    await playViaApi(ev.slug, { first_name: 'Zed', last_name: 'Zeta', seconds: 0.01 });
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Zed Z.');
    await expect(page.locator('.podium__place[data-rank="2"] .podium__name')).toHaveText('Ada L.');
    await expect(page.locator('.lb__row.sb-row[data-rank="5"]')).toContainText('Linus T.');
    await expect(page.locator('#sb-games')).toHaveText('5');
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(1);
  });
});

test.describe('live updates without the stream', () => {
  // the browser logs every blocked EventSource connection: that is what this test provokes
  test.use({ expectedConsole: /Failed to load resource|ERR_FAILED|NetworkError|establish a connection|stream/i });

  test('without the stream the board still follows by polling', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev = await events.create({ tag: 'sb-poll', questions: 6, perGame: 3, timer: 10 });
    await playViaApi(ev.slug, { first_name: 'Poll', last_name: 'First' });
    // block the stream
    await page.route('**/scoreboard/stream*', (route) => route.abort());
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(board(page)).toHaveAttribute('data-transport', 'poll', { timeout: 20_000 });
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Poll F.');
    await playViaApi(ev.slug, { first_name: 'Poll', last_name: 'Second', seconds: 0.01 });
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Poll S.', { timeout: 20_000 });
  });
});

test.describe('big boards', () => {
  test('only the top N are shown, in score order, and the counters count everybody', async ({ page, events }) => {
    test.setTimeout(60_000);
    const ev = await events.create({ tag: 'sb-many', questions: 6, perGame: 3, timer: 10 });
    await Promise.all(Array.from({ length: 14 }, (_, i) => playViaApi(ev.slug, { first_name: `Rank${String(i).padStart(2, '0')}`, last_name: 'Test', green: i % 4, seconds: 1 + i * 0.3 })));
    const top = await scoreboard(ev.slug, 6);
    expect(top).toHaveLength(6);
    await page.goto(`/${ev.slug}/scoreboard?limit=6`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#sb-games')).toHaveText('14');
    const shown = page.locator('.podium__name, .lb__row:not(.is-ghost) .lb__name');
    await expect(shown).toHaveCount(6);
    expect(await shown.allInnerTexts()).toEqual(top.map((e: any) => e.player_name));
  });
});

test.describe('privacy', () => {
  test('no email, phone or full last name anywhere: DOM, REST responses and the SSE stream', async ({ page, events }) => {
    const ev = await events.create({ tag: 'sb-priv', questions: 6, perGame: 3, timer: 10, collectPhone: 'optional' });
    const email = emailFor('private');
    const { result } = await (async () => {
      const player = await registerPlayer(ev.slug, { first_name: 'Hedy', last_name: 'Lamarrsecret', email, phone_number: '+31 6 5555 0100' });
      const game = await call('POST', `/events/${ev.slug}/games`, { player_id: player.id });
      const answers = game.questions.map((q: any) => ({ question_id: q.id, player_answer: 'green', time_taken: 1 }));
      const result = await call('POST', `/events/${ev.slug}/games/${game.game_session_id}/submit`, { answers, submit_token: game.submit_token });
      return { result };
    })();
    expect(result.rank).toBe(1);

    // every JSON response the page receives
    const bodies: string[] = [];
    page.on('response', async (res) => {
      const type = res.headers()['content-type'] || '';
      if (res.url().includes('/api/') && type.includes('json')) bodies.push(await res.text().catch(() => ''));
    });
    await page.goto(`/${ev.slug}/scoreboard`);
    await liveReady(page);
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Hedy L.');
    await page.waitForLoadState('networkidle').catch(() => {});

    const forbidden = [email, email.split('@')[0], '@e2e.example.com', 'Lamarrsecret', 'Lamarr', '5555 0100', '55550100', 'phone_number', 'first_name', 'last_name', '"email"'];
    const dom = await page.content();
    const text = await page.locator('body').innerText();
    for (const needle of forbidden) {
      expect(dom, `DOM must not contain ${needle}`).not.toContain(needle);
      expect(text, `visible text must not contain ${needle}`).not.toContain(needle);
      for (const b of bodies) expect(b, `REST response must not contain ${needle}`).not.toContain(needle);
    }
    expect(bodies.length).toBeGreaterThan(0);

    // the stream a TV receives
    const sse = await readSseSnapshot(ev.slug);
    expect(Object.keys(sse.data).sort()).toEqual(['entries', 'total_games', 'total_players']);
    expect(Object.keys(sse.data.entries[0]).sort()).toEqual(['completed_at', 'correct_answers', 'id', 'player_name', 'rank', 'score', 'wrong_answers']);
    for (const needle of forbidden) expect(sse.raw).not.toContain(needle);
    // and the plain REST scoreboard
    expect(JSON.stringify(await scoreboard(ev.slug))).not.toMatch(/@|Lamarr|5555/);
  });
});

test.describe('states and display options', () => {
  test('a closed event keeps its final results online, flagged as final', async ({ page, events }) => {
    const ev = await events.create({ tag: 'sb-closed', questions: 6, perGame: 3, timer: 10 });
    await playViaApi(ev.slug, { first_name: 'Final', last_name: 'Winner' });
    await setStatus(ev, 'closed');
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Final W.');
    await expect(page.locator('#sb-live-label')).toHaveText('Final results');
    // nobody can play any more: no "open spot, could be you" placeholders
    await expect(page.locator('.lb__row.is-ghost')).toHaveCount(0);
    await expect(page.locator('.sb-join')).toHaveCount(0);
  });

  test('an open event invites players: QR join card and open spots', async ({ page, events }) => {
    const ev = await events.create({ tag: 'sb-invite', questions: 6, perGame: 3, timer: 10 });
    await playViaApi(ev.slug, { first_name: 'Only', last_name: 'One' });
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    const join = page.locator('#view-board .sb-join');
    await expect(join).toBeVisible();
    await expect(join.locator('svg')).toBeVisible(); // the QR code
    await expect(join.locator('a.sb-join__cta')).toHaveAttribute('href', new RegExp(`/${ev.slug}$`));
    await expect(page.locator('.lb__row.is-ghost').first()).toBeAttached();
    // ?qr=0 hides it
    await page.goto(`/${ev.slug}/scoreboard?qr=0`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.sb-join')).toHaveCount(0);
  });

  test('French labels, limit and theme parameters', async ({ page, events }) => {
    const ev = await events.create({ tag: 'sb-fr', questions: 6, perGame: 3, timer: 10 });
    await playViaApi(ev.slug, { first_name: 'Zoé', last_name: 'Martin' });
    await page.goto(`/${ev.slug}/scoreboard?lang=fr&theme=light&limit=3`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(board(page)).toHaveAttribute('data-mode', 'podium'); // limit <= 3: podium only
    await expect(page.locator('#sb-players-label')).toHaveText('joueur');
    await expect(page.locator('.podium__place[data-rank="1"] .podium__name')).toHaveText('Zoé M.');
    await switchLangOnBoard(page, 'en');
    await expect(page.locator('#sb-players-label')).toHaveText('player');
  });

  test('no horizontal scroll', async ({ page, events }) => {
    const ev = await events.create({ tag: 'sb-fit', questions: 6, perGame: 3, timer: 10 });
    await playViaApi(ev.slug, { first_name: 'A'.repeat(40), last_name: 'Longname' });
    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(board(page)).toHaveAttribute('data-state', 'ready');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

async function switchLangOnBoard(page: Page, code: 'en' | 'fr') {
  await page.locator('.sb-lang label').filter({ has: page.locator(`input[value="${code}"]`) }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', code);
}

test.describe('draft event scoreboard', () => {
  test.describe('anonymous', () => {
    test.use({ expectedConsole: /Failed to load resource|404/ });
    test('is not public: 404 from the API and a "not found" screen', async ({ page, request, events }) => {
      const ev = await events.create({ tag: 'sb-draft', status: 'draft', questions: 6, perGame: 3 });
      expect((await request.get(`/api/events/${ev.slug}/scoreboard`)).status()).toBe(404);
      expect((await request.get(`/api/events/${ev.slug}/scoreboard/stream`)).status()).toBe(404);
      await page.goto(`/${ev.slug}/scoreboard`);
      await expect(page.locator('#sb-status-title')).toHaveText('Event not found');
      await expect(page.locator('#sb-status-action')).toBeVisible();
    });
  });

  test.describe('admin preview', () => {
    test.use({ asAdmin: true });
    test('is viewable by a signed-in admin (polling, flagged as a draft preview)', async ({ page, events }) => {
      const ev = await events.create({ tag: 'sb-draftadm', status: 'draft', questions: 6, perGame: 3 });
      await page.goto(`/${ev.slug}/scoreboard`);
      await expect(board(page)).toHaveAttribute('data-state', 'empty', { timeout: 20_000 });
      await expect(page.locator('#sb-live-label')).toHaveText('Draft preview');
    });
  });
});
