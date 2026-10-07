/**
 * Smoke test of the SEEDED events (api-masters and world-ai-summit-2026): read-only, nothing is registered or changed,
 * and the test is skipped when a stack does not have them (every other test of the suite creates its own data).
 * Override the slugs with SEEDED_SLUGS="a,b".
 */
import { test, expect } from '../support/fixtures';
import { call } from '../support/api';

const SLUGS = (process.env.SEEDED_SLUGS || 'api-masters,world-ai-summit-2026').split(',').map((s) => s.trim()).filter(Boolean);

test.describe('seeded events', () => {
  let present: any[] = [];
  test.beforeAll(async () => {
    const live = await call('GET', '/events');
    present = SLUGS.map((slug) => live.find((e: any) => e.slug === slug)).filter(Boolean);
  });
  test.beforeEach(() => { test.skip(present.length === 0, 'the seeded events are not live on this stack'); });

  test('are listed on the hub with their own branding', async ({ page }) => {
    await page.goto('/');
    for (const ev of present) {
      const card = page.locator('article.hub-card').filter({ has: page.locator(`a.hub-card__link[href="/${ev.slug}"]`) });
      await expect(card, ev.slug).toBeVisible();
      await expect(card.locator('.hub-card__wordmark')).toHaveText(ev.game_title);
    }
  });

  test('landing pages and scoreboards open (read only)', async ({ page }) => {
    for (const ev of present) {
      await page.goto(`/${ev.slug}`);
      await expect(page.locator('main[data-view="landing"]')).toBeVisible();
      await expect(page.locator('h1.hero__title')).not.toBeEmpty();
      await expect(page.locator('[data-action="play"]')).toBeVisible();
      await page.goto(`/${ev.slug}/scoreboard`);
      await expect(page.locator('#sb')).toHaveAttribute('data-state', /ready|empty/);
      await expect(page.locator('#sb')).toHaveAttribute('data-transport', 'sse', { timeout: 15_000 });
    }
  });

  test('have enough questions to start a game', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'HTTP-level check, identical in every browser');
    for (const ev of present) {
      const full = await call('GET', `/events/${ev.slug}`);
      expect(full.categories.length, ev.slug).toBeGreaterThan(0);
      const total = full.categories.reduce((n: number, c: any) => n + c.question_count, 0);
      expect(total, ev.slug).toBeGreaterThanOrEqual(full.settings.questions_per_game);
    }
  });
});
