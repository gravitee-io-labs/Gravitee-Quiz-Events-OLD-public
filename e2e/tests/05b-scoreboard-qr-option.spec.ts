/**
 * Scoreboard "Scan to play" QR code is an event option (branding.show_join_qr, Admin > Appearance): on by default, and
 * switched off for an event that is only played at the booth: no QR code, no join address, no "scan" wording.
 */
import { test, expect } from '../support/fixtures';
import { admin, call } from '../support/api';

test.describe('scoreboard QR option', () => {
  test('on by default: QR code, join address and "scan" wording', async ({ page, events }) => {
    const ev = await events.create({ tag: 'qr-on', questions: 6, perGame: 3, timer: 10 });
    const pub = await call('GET', `/events/${ev.slug}`);
    expect(pub.branding.show_join_qr).toBe(true);

    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-qr', 'on');
    await expect(page.locator('#sb-empty-text')).toContainText('Scan the code');
    await expect(page.locator('#sb-empty-qr > *')).not.toHaveCount(0);
    await expect(page.locator('#sb-empty-url')).toBeVisible();
    await expect(page.locator('#sb-empty-url')).toContainText(ev.slug);
  });

  test('switched off: no QR code, no join address, no "scan" wording; the URL parameter still works', async ({ page, events }) => {
    const ev = await events.create({ tag: 'qr-off', questions: 6, perGame: 3, timer: 10 });
    const updated = await admin.put(`/admin/events/${ev.id}`, { branding: { show_join_qr: false } });
    expect(updated.branding.show_join_qr).toBe(false);
    expect(updated.branding.primary_color).toBeTruthy(); // the other branding keys are untouched (merged key by key)
    expect((await call('GET', `/events/${ev.slug}`)).branding.show_join_qr).toBe(false);

    await page.goto(`/${ev.slug}/scoreboard`);
    await expect(page.locator('#sb')).toHaveAttribute('data-qr', 'off');
    await expect(page.locator('#sb-empty-text')).toContainText('Answer 3 quick questions');
    await expect(page.locator('#sb-empty-text')).not.toContainText(/scan/i);
    await expect(page.locator('#sb-empty-qr > *')).toHaveCount(0);
    await expect(page.locator('#sb-empty-url')).toBeHidden();
    await expect(page.locator('#sb-join-slot > *')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(ev.slug);

    // French wording follows
    await page.goto(`/${ev.slug}/scoreboard?lang=fr`);
    await expect(page.locator('#sb-empty-text')).toContainText('Répondez à 3 questions');
    await expect(page.locator('#sb-empty-text')).not.toContainText(/scann/i);
  });

  test('?qr=0 hides it even when the event shows it', async ({ page, events }) => {
    const ev = await events.create({ tag: 'qr-param', questions: 6, perGame: 3, timer: 10 });
    await page.goto(`/${ev.slug}/scoreboard?qr=0`);
    await expect(page.locator('#sb')).toHaveAttribute('data-qr', 'off');
    await expect(page.locator('#sb-empty-qr > *')).toHaveCount(0);
  });
});
