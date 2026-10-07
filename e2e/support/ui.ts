/**
 * Page helpers for the player web app (hub, event game, scoreboard). Selectors favour roles / labels and fall back to the
 * stable class or data-* hooks of the markup (documented in web/js/event/views/*).
 */
import { expect, type Page, type Locator } from '@playwright/test';

export interface PlayerForm {
  first: string;
  last: string;
  email?: string;
  phone?: string;
  consent?: boolean;
}

let n = 0;
export const emailFor = (tag = 'ui') => `${tag}.${Date.now().toString(36)}${(n++).toString(36)}@e2e.example.com`;

/** Open the event page (landing view) and wait for the app to be booted. */
export async function openEvent(page: Page, slug: string, query = '') {
  await page.goto(`/${slug}${query}`);
  await expect(page.locator('main[data-view]')).toBeVisible();
}

export const playButton = (page: Page) => page.locator('[data-action="play"]');

/** Fill the registration form. Labels are matched in English unless `lang: 'fr'`. */
export async function fillRegistration(page: Page, p: PlayerForm, lang: 'en' | 'fr' = 'en') {
  const L = lang === 'fr'
    ? { first: 'Prénom', last: 'Nom', email: 'Email', phone: 'Numéro de téléphone' }
    : { first: 'First name', last: 'Last name', email: 'Email', phone: 'Phone number' };
  await page.getByLabel(L.first, { exact: true }).fill(p.first);
  await page.getByLabel(L.last, { exact: true }).fill(p.last);
  await page.getByLabel(L.email, { exact: true }).fill(p.email ?? emailFor());
  if (p.phone !== undefined) await page.getByLabel(new RegExp(`^${L.phone}`)).fill(p.phone);
  const consent = page.locator('input[name="consent"]');
  if (p.consent !== undefined && (await consent.count())) await consent.setChecked(p.consent);
}

export const submitRegistration = (page: Page) => page.locator('.ev-submit').click();

/** landing -> register -> rules (does NOT start the game). */
export async function registerUpToRules(page: Page, p: PlayerForm, lang: 'en' | 'fr' = 'en') {
  await playButton(page).click();
  await expect(page.locator('main[data-view="register"]')).toBeVisible();
  await fillRegistration(page, p, lang);
  await submitRegistration(page);
  await expect(page.locator('main[data-view="rules"]')).toBeVisible();
}

/** Click "Start the game" and wait for the first question. */
export async function startGame(page: Page) {
  await page.locator('[data-action="start"]').click();
  await expect(page.locator('main[data-view="game"]')).toBeVisible();
  await expect(page.locator('.answer--green')).toBeEnabled();
}

export type Step = 'g' | 'r' | 'timeout';

/** Number of questions announced by the game header ("Question 3 / 15"). */
export async function questionTotal(page: Page): Promise<number> {
  const text = (await page.locator('.game-counter').textContent()) || '';
  const m = text.match(/\/\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Play from the keyboard: for question i press G / R, or let the timer run out ('timeout').
 * Waits for each question to be on screen and unlocked before acting: no sleeps.
 * `total` is the number of questions of the game (default: steps.length), `first` the 1-based question to start at.
 * `onQuestion(i, page)` runs while question i is on screen, before the answer.
 */
export async function playByKeyboard(
  page: Page, steps: Step[],
  onQuestion?: ((i: number, page: Page) => Promise<void>) | null,
  opts: { total?: number; first?: number } = {},
) {
  const total = opts.total ?? steps.length;
  const first = opts.first ?? 1;
  const counter = page.locator('.game-counter');
  for (let k = 0; k < steps.length; k += 1) {
    const i = first + k;
    await expect(counter).toContainText(new RegExp(`\\b${i}\\s*/\\s*${total}`));
    // buttons are disabled while the question is "locked" (previous answer pause, image wait): the clock starts when they are enabled
    await expect(page.locator('.answer--green')).toBeEnabled();
    if (onQuestion) await onQuestion(i, page);
    const step = steps[k];
    if (step === 'timeout') {
      await expect(page.locator('.ev-lock--timeout')).toBeVisible({ timeout: 30_000 });
    } else {
      await page.keyboard.press(step === 'g' ? 'g' : 'r');
      await expect(page.locator('.ev-lock')).toBeVisible();
    }
  }
}

/** Wait for the results screen and read the numbers from it. */
export async function readResults(page: Page) {
  await expect(page.locator('main[data-view="results"]')).toBeVisible({ timeout: 20_000 });
  const text = (loc: Locator) => loc.first().innerText();
  const score = Number(((await text(page.locator('.score-hero .u-sr-only'))).match(/[\d\s.,  ]+/)?.[0] || '0').replace(/\D/g, ''));
  const rank = (await text(page.locator('.ev-rank'))).trim();
  const tiles = await page.locator('.ev-tiles .stat__value').allInnerTexts();
  return { score, rank, correct: Number(tiles[0]), wrong: Number(tiles[1]), unanswered: Number(tiles[2]) };
}

/** Whole flow in one go: landing -> register -> rules -> game (keyboard) -> results. */
export async function playFullGame(page: Page, slug: string, p: PlayerForm, steps: Step[], query = '') {
  await openEvent(page, slug, query);
  await registerUpToRules(page, p);
  await startGame(page);
  await playByKeyboard(page, steps);
  return readResults(page);
}

export const langRadio = (page: Page, code: 'en' | 'fr') => page.locator(`.lang-switch input[value="${code}"]`);
export async function switchLang(page: Page, code: 'en' | 'fr') {
  // the radio itself is visually hidden inside a segmented control: click its label (the visible text)
  await page.locator('.lang-switch label').filter({ has: page.locator(`input[value="${code}"]`) }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', code);
}

/** No horizontal scrolling on the page (1px tolerance for sub-pixel rounding). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** Text of the whole page (visible text, not source). */
export const bodyText = (page: Page) => page.locator('body').innerText();

/** Switch the theme through the app bar button (it cycles system -> light -> dark), without reloading the page. */
export async function setThemeViaUi(page: Page, theme: 'light' | 'dark') {
  const button = page.locator('.appbar button[aria-label^="Theme"], #sb-theme-slot button').first();
  const wanted = new RegExp(`Theme: ${theme}`, 'i');
  for (let i = 0; i < 4 && !wanted.test((await button.getAttribute('aria-label')) || ''); i += 1) await button.click();
  await expect(button).toHaveAttribute('aria-label', wanted);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
