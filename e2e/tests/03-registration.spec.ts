/**
 * (3) Registration: required fields, phone hidden / optional / required, consent required, email-in-name rejection,
 * server-side 422 mapped to the fields, and the same rules enforced by the API itself.
 */
import { test, expect, onlyInFirstProject, type TestEvent } from '../support/fixtures';
import { call, registerPlayer } from '../support/api';
import { openEvent, playButton, fillRegistration, submitRegistration, emailFor, switchLang } from '../support/ui';
import type { Page } from '@playwright/test';

let optional: TestEvent;
let hidden: TestEvent;
let required: TestEvent;
let consent: TestEvent;

test.beforeAll(async ({ events }) => {
  const base = { perGame: 5, questions: 6 };
  optional = await events.create({ tag: 'reg-opt', collectPhone: 'optional', ...base });
  hidden = await events.create({ tag: 'reg-hid', collectPhone: 'hidden', ...base });
  required = await events.create({ tag: 'reg-req', collectPhone: 'required', ...base });
  consent = await events.create({
    tag: 'reg-consent', collectPhone: 'optional', ...base,
    consentEn: 'I agree to be contacted about the QA event.', consentFr: 'J’accepte d’être contacté au sujet de l’évènement QA.',
  });
});

async function toRegister(page: Page, slug: string, query = '') {
  await openEvent(page, slug, query);
  await playButton(page).click();
  await expect(page.locator('main[data-view="register"]')).toBeVisible();
}
/** the error paragraph that belongs to a labelled input */
const errorOf = (page: Page, label: string | RegExp) =>
  page.locator('.field').filter({ has: page.getByLabel(label, { exact: typeof label === 'string' }) }).locator('.field__error');

test.describe('required fields', () => {
  test('an empty form shows an error on every required field and stays on the page', async ({ page }) => {
    await toRegister(page, optional.slug);
    await submitRegistration(page);
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await expect(errorOf(page, 'First name')).toHaveText('Enter your first name.');
    await expect(errorOf(page, 'Last name')).toHaveText('Enter your last name.');
    await expect(errorOf(page, 'Email')).toContainText('Enter a valid email address');
    // the first invalid field gets the focus, and is flagged for assistive tech
    await expect(page.getByLabel('First name')).toBeFocused();
    await expect(page.getByLabel('First name')).toHaveAttribute('aria-invalid', 'true');
    // the optional phone number is NOT an error
    await expect(errorOf(page, /^Phone number/)).toBeHidden();
  });

  test('whitespace only counts as empty', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: '   ', last: '  ', email: emailFor() });
    await submitRegistration(page);
    await expect(errorOf(page, 'First name')).toHaveText('Enter your first name.');
    await expect(errorOf(page, 'Last name')).toHaveText('Enter your last name.');
  });

  test('an invalid email is rejected, a fixed one is accepted', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'Ada', last: 'Lovelace', email: 'not-an-email' });
    await submitRegistration(page);
    await expect(errorOf(page, 'Email')).toContainText('Enter a valid email address');
    await page.getByLabel('Email', { exact: true }).fill('ada@e2e.example.com');
    await expect(errorOf(page, 'Email')).toBeHidden(); // validates live once the field was touched
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How to play' })).toBeVisible();
    await expect(page.locator('.ev-sub')).toContainText('Ada');
  });

  test('the Back button returns to the landing page', async ({ page }) => {
    await toRegister(page, optional.slug);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('main[data-view="landing"]')).toBeVisible();
  });
});

test.describe('names', () => {
  test('an email address in the first or last name is rejected', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'ada@lovelace.com', last: 'Lovelace' });
    await submitRegistration(page);
    await expect(errorOf(page, 'First name')).toHaveText('Please enter your name, not your email address.');
    await page.getByLabel('First name').fill('Ada');
    await page.getByLabel('Last name').fill('me@x.io');
    await submitRegistration(page);
    await expect(errorOf(page, 'Last name')).toHaveText('Please enter your name, not your email address.');
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
  });

  test('markup characters and letter-less names are rejected', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'PoC<img src=x onerror=alert(1)>', last: '12345' });
    await submitRegistration(page);
    await expect(errorOf(page, 'First name')).toContainText('characters we cannot accept');
    await expect(errorOf(page, 'Last name')).toContainText('at least one letter');
  });

  test('accented, apostrophe and hyphenated names are fine', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'Jean-François', last: "D'Éloïse-Ñandú" });
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
  });
});

test.describe('phone number', () => {
  test('hidden: the field is not shown and nothing is sent', async ({ page }) => {
    await toRegister(page, hidden.slug);
    await expect(page.getByLabel(/^Phone number/)).toHaveCount(0);
    let sent: any = null;
    await page.route('**/api/events/*/players', async (route) => { sent = route.request().postDataJSON(); await route.continue(); });
    await fillRegistration(page, { first: 'Hidden', last: 'Phone' });
    await submitRegistration(page);
    await page.locator('[data-action="start"]').click();
    await expect(page.locator('main[data-view="game"]')).toBeVisible();
    expect(sent).not.toBeNull();
    expect(sent).not.toHaveProperty('phone_number');
  });

  test('optional: marked optional, can stay empty, a bad value is rejected', async ({ page }) => {
    await toRegister(page, optional.slug);
    await expect(page.locator('label[for]').filter({ hasText: 'Phone number' }).locator('.field__optional')).toHaveText('optional');
    await fillRegistration(page, { first: 'Opt', last: 'Phone', phone: 'abc' });
    await submitRegistration(page);
    await expect(errorOf(page, /^Phone number/)).toContainText('valid phone number');
    await page.getByLabel(/^Phone number/).fill('');
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible(); // empty is fine
  });

  test('optional: a well formed international number is accepted', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'Opt', last: 'Phone', phone: '+31 6 12 34 56 78' });
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
  });

  test('required: not marked optional, empty is an error, a number passes', async ({ page }) => {
    await toRegister(page, required.slug);
    await expect(page.locator('label[for]').filter({ hasText: 'Phone number' }).locator('.field__optional')).toHaveCount(0);
    await fillRegistration(page, { first: 'Req', last: 'Phone' });
    await submitRegistration(page);
    await expect(errorOf(page, /^Phone number/)).toHaveText('Enter your phone number.');
    await expect(page.getByLabel(/^Phone number/)).toBeFocused();
    await page.getByLabel(/^Phone number/).fill('0612345678');
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
  });
});

test.describe('consent', () => {
  test('an event with a consent text shows a required checkbox', async ({ page }) => {
    await toRegister(page, consent.slug);
    const box = page.locator('input[name="consent"]');
    await expect(box).toBeVisible();
    await expect(page.locator('.ev-consent')).toContainText('I agree to be contacted about the QA event.');
    await fillRegistration(page, { first: 'No', last: 'Consent' });
    await submitRegistration(page);
    await expect(page.locator('.ev-consent .field__error')).toHaveText('Please accept to continue.');
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await box.check();
    await expect(page.locator('.ev-consent .field__error')).toBeHidden();
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
  });

  test('the consent text follows the language', async ({ page }) => {
    await toRegister(page, consent.slug, '?lang=fr');
    await expect(page.locator('.ev-consent')).toContainText('J’accepte d’être contacté');
    await switchLang(page, 'en');
    await expect(page.locator('.ev-consent')).toContainText('I agree to be contacted');
  });

  test('an event without a consent text has no checkbox', async ({ page }) => {
    await toRegister(page, optional.slug);
    await expect(page.locator('input[name="consent"]')).toHaveCount(0);
  });

  test('the consent is sent to the server and recorded', async ({ page }) => {
    await toRegister(page, consent.slug);
    let sent: any = null;
    await page.route('**/api/events/*/players', async (route) => { sent = route.request().postDataJSON(); await route.continue(); });
    await fillRegistration(page, { first: 'Yes', last: 'Consent', consent: true });
    await submitRegistration(page);
    await page.locator('[data-action="start"]').click();
    await expect(page.locator('main[data-view="game"]')).toBeVisible();
    expect(sent.consent).toBe(true);
  });
});

test.describe('form behaviour', () => {
  test('typed values survive a language switch (and errors are translated)', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'Ada', last: '', email: 'ada@e2e.example.com' });
    await submitRegistration(page);
    await expect(errorOf(page, 'Last name')).toHaveText('Enter your last name.');
    await switchLang(page, 'fr');
    await expect(page.getByLabel('Prénom', { exact: true })).toHaveValue('Ada');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('ada@e2e.example.com');
    await expect(errorOf(page, 'Nom')).toHaveText('Saisissez votre nom.');
    await expect(page.getByRole('heading', { name: 'Qui joue ?' })).toBeVisible();
  });

  test('personal data stays in memory: nothing is written to web storage', async ({ page }) => {
    await toRegister(page, optional.slug);
    const email = emailFor('privacy');
    await fillRegistration(page, { first: 'Priva', last: 'Cy', email, phone: '0612345678' });
    await submitRegistration(page);
    await page.locator('[data-action="start"]').click();
    await expect(page.locator('main[data-view="game"]')).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(stored).not.toContain(email);
    expect(stored).not.toContain('0612345678');
    expect(stored).not.toContain('Priva');
  });

});

test.describe('server-side validation', () => {
  test.use({ expectedConsole: /Failed to load resource|422/ }); // the browser logs the 422 we provoke

  test('a server-side 422 is shown on the field that the API names', async ({ page }) => {
    await toRegister(page, optional.slug);
    await fillRegistration(page, { first: 'Srv', last: 'Err' });
    await submitRegistration(page);
    await expect(page.locator('main[data-view="rules"]')).toBeVisible();
    await page.route('**/api/events/*/players', (route) => route.fulfill({
      status: 422, contentType: 'application/json',
      body: JSON.stringify({ detail: [{ type: 'value_error', loc: ['body', 'email'], msg: 'value is not a valid email address' }] }),
    }));
    await page.locator('[data-action="start"]').click();
    await expect(page.locator('main[data-view="register"]')).toBeVisible();
    await expect(errorOf(page, 'Email')).toContainText('Enter a valid email address');
    await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
    // what was typed is still there
    await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Srv');
  });
});

test.describe('the API enforces the same rules (defence in depth)', () => {
  onlyInFirstProject();

  const player = (extra: Record<string, unknown> = {}) => ({ first_name: 'Api', last_name: 'Player', email: emailFor('api'), ...extra });
  const post = (slug: string, body: unknown) => call('POST', `/events/${slug}/players`, body, { raw: true });
  const fieldOf = (r: any) => (r.body.detail || []).map((d: any) => d.loc[d.loc.length - 1]);

  test('phone: required / hidden / optional', async () => {
    const miss = await post(required.slug, player());
    expect(miss.status).toBe(422);
    expect(fieldOf(miss)).toContain('phone_number');
    const ok = await post(required.slug, player({ phone_number: '+33 6 12 34 56 78' }));
    expect(ok.status).toBe(201);
    const dropped = await post(hidden.slug, player({ phone_number: '0612345678' }));
    expect(dropped.status).toBe(201);
    expect(dropped.body.phone_number).toBeNull();
    const bad = await post(optional.slug, player({ phone_number: 'call me maybe' }));
    expect(bad.status).toBe(422);
  });

  test('consent must be true when the event has a consent text', async () => {
    for (const consentValue of [undefined, false, null]) {
      const r = await post(consent.slug, player(consentValue === undefined ? {} : { consent: consentValue }));
      expect(r.status).toBe(422);
      expect(fieldOf(r)).toContain('consent');
    }
    const ok = await post(consent.slug, player({ consent: true }));
    expect(ok.status).toBe(201);
    expect(ok.body.consent_at).toBeTruthy();
    // an event WITHOUT a consent text records none
    const none = await post(optional.slug, player({ consent: true }));
    expect(none.status).toBe(201);
    expect(none.body.consent_at).toBeNull();
  });

  test('names: email-looking, markup and letter-less names are 422', async () => {
    for (const [first, last] of [['a@b.co', 'X'], ['Ada', 'a@b.co'], ['<b>Ada</b>', 'X'], ['Ada', 'X<script>alert(1)</script>'], ['1234', 'X'], ['Ada\u0000', 'X']]) {
      const r = await post(optional.slug, player({ first_name: first, last_name: last }));
      expect(r.status, `${first} / ${last}`).toBe(422);
    }
    const ok = await registerPlayer(optional.slug, { first_name: 'Zoë', last_name: "O'Neil-Smith" });
    expect(ok.first_name).toBe('Zoë');
  });

  test('email: malformed addresses are 422, the address is stored lower-cased', async () => {
    const bad = await post(optional.slug, player({ email: 'nope' }));
    expect(bad.status).toBe(422);
    const ok = await post(optional.slug, player({ email: 'Mixed.Case@E2E.Example.com' }));
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe('mixed.case@e2e.example.com');
  });
});
