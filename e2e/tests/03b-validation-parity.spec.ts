/**
 * (3) The registration form validates in the browser (web/js/event/validate.js) AND the API validates again. When the two
 * disagree the player pays for it: a value the form accepts but the API refuses only fails at "Start the game" (after the
 * rules screen), and a value the form refuses but the API would take blocks a legitimate player for nothing.
 *
 * The browser rules are loaded from the deployed web app itself (GET /js/event/validate.js, a pure ES module), so the test
 * works against any BASE_URL, then every case is sent to the real API.
 */
import { test, expect, onlyInFirstProject } from '../support/fixtures';
import { BASE_URL, call, uniqueEmail } from '../support/api';
import type { TestEvent } from '../support/fixtures';

let ev: TestEvent;
let v: any;

test.beforeAll(async ({ events }) => {
  ev = await events.create({ tag: 'parity', questions: 6, perGame: 3, collectPhone: 'optional' });
  const source = await (await fetch(`${BASE_URL}/js/event/validate.js`)).text();
  v = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
});

const accepts = async (body: Record<string, unknown>) => {
  const res = await call('POST', `/events/${ev.slug}/players`, { first_name: 'Par', last_name: 'Ity', email: uniqueEmail('par'), ...body }, { raw: true });
  return res.status === 201;
};

const NAMES: Array<[string, string]> = [
  ['plain', 'Ada'], ['hyphen', 'Jean-Pierre'], ['apostrophe', "O'Brien"], ['typographic apostrophe', 'D’Éloïse'], ['accents', 'Zoë Åsa Ñandú'],
  ['cjk', '李雷'], ['arabic', 'محمد'], ['initials', 'J. R. R.'], ['inner double space', 'Mary  Ann'], ['one letter', 'A'],
  ['letters and digits', 'R2D2'], ['digits only', '12345'], ['symbols only', '---'], ['emoji only', '😀'], ['emoji and letter', '😀Ann'],
  ['at sign', 'ann@home'], ['angle bracket', 'Ann<'], ['markup', '<b>Ann</b>'], ['tab', 'Ann\tLee'], ['newline', 'Ann\nLee'],
  ['zero width space', 'Ann​Lee'], ['right-to-left override', '‮Ann'], ['private use', 'Ann'], ['nul', 'Ann\u0000'],
  ['ampersand and quotes', 'A&B "C"'], ['100 letters', 'a'.repeat(100)], ['101 letters', 'a'.repeat(101)], ['entity text', '&lt;img&gt;'],
];

const PHONES: Array<[string, string]> = [
  ['national', '0612345678'], ['spaced', '06 12 34 56 78'], ['international', '+31 6 12345678'], ['brackets', '+33 (0)6 12 34 56 78'], ['dots', '06.12.34.56.78'],
  ['slashes', '030/1234567'], ['five digits', '12345'], ['six digits', '123456'], ['fifteen digits', '123456789012345'], ['sixteen digits', '1234567890123456'],
  ['letters', 'call me'], ['extension', '0612345678 ext 12'], ['plus in the middle', '06+1234567'], ['arabic digits', '٠٦١٢٣٤٥٦٧٨'], ['21 chars', '0'.repeat(21)],
];

const EMAILS: Array<[string, string]> = [
  ['plain', 'ada@example.com'], ['plus tag', 'ada+quiz@example.com'], ['subdomain', 'ada@mail.example.co.uk'], ['upper case', 'Ada@Example.COM'],
  ['no tld', 'ada@localhost'], ['one letter tld', 'ada@example.c'], ['double dot domain', 'ada@example..com'], ['leading dot local', '.ada@example.com'],
  ['trailing dot local', 'ada.@example.com'], ['space inside', 'ada lovelace@example.com'], ['two at signs', 'ada@@example.com'], ['unicode local', 'adä@example.com'],
  ['unicode domain', 'ada@exämple.com'], ['quoted local', '"ada lovelace"@example.com'], ['ip domain', 'ada@[127.0.0.1]'], ['reserved test tld', 'ada@example.test'],
  ['dash domain', 'ada@my-company.io'], ['underscore local', 'ada_l@example.com'], ['long local (64)', `${'a'.repeat(64)}@example.com`], ['too long local (65)', `${'a'.repeat(65)}@example.com`],
];

/**
 * Known, harmless differences (documented here so that any NEW difference fails the test):
 *  - the form is stricter where the API is lenient and a person cannot type the value anyway or it is not a real address;
 *  - the form is more lenient for the special-use ".test" domain, which the API refuses (nobody registers with it).
 */
const FORM_STRICTER = new Set(['phone: arabic digits', 'first name: tab', 'first name: newline', 'email: one letter tld']);
const FORM_MORE_LENIENT = new Set(['email: reserved test tld']);

function expectParity(title: string, browser: boolean, api: boolean) {
  if (FORM_STRICTER.has(title)) expect({ title, browser, api }, 'known difference: the form is stricter than the API').toEqual({ title, browser: false, api: true });
  else if (FORM_MORE_LENIENT.has(title)) expect({ title, browser, api }, 'known difference: the form is more lenient than the API').toEqual({ title, browser: true, api: false });
  else expect({ title, browser }, `the form and the API must agree (API ${api ? 'accepts' : 'refuses'})`).toEqual({ title, browser: api });
}

test.describe('browser rules and API rules agree', () => {
  onlyInFirstProject();

  for (const [label, name] of NAMES) {
    test(`first name: ${label}`, async () => {
      expectParity(`first name: ${label}`, v.validateFirstName(name) === null, await accepts({ first_name: name }));
    });
  }

  for (const [label, phone] of PHONES) {
    test(`phone: ${label}`, async () => {
      expectParity(`phone: ${label}`, v.validatePhone(phone, 'optional') === null, await accepts({ phone_number: phone }));
    });
  }

  for (const [label, email] of EMAILS) {
    test(`email: ${label}`, async () => {
      expectParity(`email: ${label}`, v.validateEmail(email) === null, await accepts({ email }));
    });
  }
});
