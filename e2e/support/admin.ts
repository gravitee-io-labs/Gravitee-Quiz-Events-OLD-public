/**
 * Page helpers for the admin console (hash router: /admin/#/events, /admin/#/events/{id}/{tab}).
 */
import { expect, type Page, type Locator } from '@playwright/test';
import type { TestEvent } from './events';

export type Tab = 'overview' | 'questions' | 'categories' | 'results' | 'settings' | 'appearance';

/** Open an admin route and wait for the view of that route to be rendered (page title is set when a view is mounted). */
export async function gotoAdmin(page: Page, hash = '#/events') {
  await page.goto(`/admin/${hash}`);
  await expect(page.locator('main#main, main').first()).toBeVisible();
}

export async function gotoTab(page: Page, ev: TestEvent | number, tab: Tab) {
  const id = typeof ev === 'number' ? ev : ev.id;
  await gotoAdmin(page, `#/events/${id}/${tab}`);
  await expect(page.locator(`[data-view="${tab}"]`)).toBeVisible();
}

export const eventCard = (page: Page, ev: TestEvent | number) =>
  page.locator(`article.admin-event[data-id="${typeof ev === 'number' ? ev : ev.id}"]`);

/** The modal currently open. */
export const dialog = (page: Page) => page.locator('dialog[open]');

/** The latest toast containing text (toasts live in a region created by the design system; an earlier identical one may still be fading out). */
export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text }).last();

/** Fill a design-system colour input: the hex textbox next to the swatch. */
export async function setColour(box: Locator, hex: string) {
  await box.fill(hex);
  await box.blur();
}

/** Open the status dropdown of an event card and pick an entry ("Set live", "Back to draft", "Close event"). */
export async function setStatusFromCard(page: Page, ev: TestEvent, action: 'Set live' | 'Back to draft' | 'Close event') {
  const card = eventCard(page, ev);
  await card.getByRole('button', { name: /^Status:/ }).click();
  await card.getByRole('menuitemradio', { name: new RegExp(action) }).click();
}

/** Account menu -> Sign out. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

/** Read the file Playwright caught from a download as text. */
export async function downloadText(download: import('@playwright/test').Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
