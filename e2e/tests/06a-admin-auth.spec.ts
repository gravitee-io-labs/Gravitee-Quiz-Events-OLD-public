/**
 * (6) Admin: login failure and success, session handling.
 * The failure test uses a throw-away username: the backend throttles per (IP, username) and the real "admin" is shared.
 */
import { test, expect } from '../support/fixtures';
import { gotoAdmin, signOut, toast } from '../support/admin';
import { ADMIN_PASSWORD, ADMIN_USER } from '../support/api';

const tokenOf = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.getItem('quiz.admin.token'));

test.describe('login', () => {
  test('an unauthenticated visit lands on the login form', async ({ page }) => {
    await gotoAdmin(page, '#/events');
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByRole('heading', { name: 'Quiz Admin' })).toBeVisible();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/Sign in/);
  });

  test('empty fields are explained before any request is sent', async ({ page }) => {
    await gotoAdmin(page);
    let loginCalls = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/auth/login')) loginCalls += 1; });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Enter your username.');
    await page.getByLabel('Username', { exact: true }).fill('someone');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Enter your password.');
    expect(loginCalls).toBe(0);
  });

  test.describe('wrong credentials', () => {
    // the 401 of the refused login is logged by the browser: that is the point of this test
    test.use({ expectedConsole: /Failed to load resource|401/ });
    test('are refused with a clear message and no session is created', async ({ page }) => {
      await gotoAdmin(page);
      await page.getByLabel('Username', { exact: true }).fill(`qa-nobody-${Date.now().toString(36)}`);
      await page.getByLabel('Password', { exact: true }).fill('definitely-wrong');
      await page.getByRole('button', { name: 'Sign in' }).click();
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('Sign-in failed');
      await expect(alert).toContainText('Incorrect username or password.');
      await expect(page).toHaveURL(/#\/login$/);
      expect(await tokenOf(page)).toBeNull();
      // the password field was cleared and refocused
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    });
  });

  test('the password can be revealed and hidden', async ({ page }) => {
    await gotoAdmin(page);
    const input = page.getByLabel('Password', { exact: true });
    await input.fill('secret');
    await expect(input).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(input).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('valid credentials open the events list; the session survives a reload; Sign out ends it', async ({ page }) => {
    await gotoAdmin(page);
    await page.getByLabel('Username', { exact: true }).fill(ADMIN_USER);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/#\/events$/);
    await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
    expect(await tokenOf(page)).toBeTruthy();
    // the password is not kept anywhere
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(ADMIN_PASSWORD + '"');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();

    await signOut(page);
    await expect(page).toHaveURL(/#\/login$/);
    await expect(toast(page, 'You have been signed out.')).toBeVisible();
    expect(await tokenOf(page)).toBeNull();
    // and the back button cannot reopen a protected page
    await gotoAdmin(page, '#/events');
    await expect(page).toHaveURL(/#\/login$/);
  });

  test('a deep link survives the login: you land where you were going', async ({ page, events }) => {
    const ev = await events.create({ tag: 'auth-deep', perGame: 3, questions: 4 });
    await gotoAdmin(page, `#/events/${ev.id}/questions`);
    await expect(page).toHaveURL(/#\/login$/);
    await page.getByLabel('Username', { exact: true }).fill(ADMIN_USER);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`#/events/${ev.id}/questions$`));
    await expect(page.getByRole('heading', { name: 'Questions', level: 1 })).toBeVisible();
  });
});

test.describe('session', () => {
  test.describe('a rejected token', () => {
    test.use({ expectedConsole: /Failed to load resource|401/ });
    test('sends you back to the login screen and clears it', async ({ page }) => {
      await page.addInitScript(() => { try { localStorage.setItem('quiz.admin.token', 'not-a-real-token'); } catch { /* ignore */ } });
      await gotoAdmin(page, '#/events');
      await expect(page).toHaveURL(/#\/login$/);
      await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
      expect(await tokenOf(page)).toBeNull();
    });
  });

  test.describe('the session ends while the console is open', () => {
    test.use({ asAdmin: true, expectedConsole: /Failed to load resource|401/ });
    test('the next request sends you to the login screen with an explanation', async ({ page, events }) => {
      const ev = await events.create({ tag: 'auth-expire', questions: 4, perGame: 3 });
      await gotoAdmin(page, `#/events/${ev.id}/results`);
      await expect(page.getByRole('heading', { name: 'Results', level: 1 })).toBeVisible();
      await page.evaluate(() => localStorage.setItem('quiz.admin.token', 'expired-or-revoked'));
      await page.getByRole('button', { name: 'Refresh now' }).dispatchEvent('click');
      await expect(toast(page, 'Your session has expired')).toBeVisible();
      await expect(page).toHaveURL(/#\/login$/);
      expect(await tokenOf(page)).toBeNull();
    });
  });

  test.describe('signed in', () => {
    test.use({ asAdmin: true });
    test('an unknown route goes to the events list; an unknown event shows a not-found card', async ({ page }) => {
      await gotoAdmin(page, '#/nonsense/route');
      await expect(page).toHaveURL(/#\/events$/);
      await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
    });
  });

  test.describe('signed in, missing event', () => {
    test.use({ asAdmin: true, expectedConsole: /Failed to load resource|404/ });
    test('an event id that does not exist is explained', async ({ page }) => {
      await gotoAdmin(page, '#/events/999999999/overview');
      await expect(page.getByRole('heading', { name: 'Event not found' })).toBeVisible();
      await page.getByRole('link', { name: 'All events' }).first().click();
      await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
    });
  });
});
