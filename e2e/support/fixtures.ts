/**
 * Shared test fixtures.
 *
 *  events         (worker)  creates throwaway events (qa-e2e-<run>-*) and deletes them when the worker ends
 *  guard          (auto)    fails the test on any console error, CSP violation, uncaught exception or native dialog
 *                           (alert / confirm / prompt = something executed that should not) on ANY page of the test
 *  expectedConsole (option) ONE regex (use alternation) of console errors that are expected for this test (e.g. the 404 of an unknown event)
 *
 * Admin pages: `test.use({ asAdmin: true })` puts the admin JWT in localStorage before the first page loads (same origin as
 * the public pages, which is also what makes the draft preview work), so only the login tests use the login form.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { adminToken, BASE_URL, deleteEventBySlug } from './api';
import { createEvent, createMinimalEvent, type EventSpec, type TestEvent } from './events';

export { expect };

/** For tests that only talk HTTP (no browser involved): run them in the first project only, the result cannot differ per browser. */
export const BROWSER_INDEPENDENT_PROJECT = 'chromium';
export function onlyInFirstProject() {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== BROWSER_INDEPENDENT_PROJECT, `HTTP-level check, identical in every browser: runs in the ${BROWSER_INDEPENDENT_PROJECT} project`);
  });
}
export type { TestEvent, EventSpec };

/** localStorage of an admin session (the JWT lives under "quiz.admin.token", same origin as the public pages). */
const adminStorage = (token: string) => ({
  cookies: [],
  origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: 'quiz.admin.token', value: token }] }],
});

export interface EventFactory {
  create(spec?: EventSpec): Promise<TestEvent>;
  createMinimal(spec?: Parameters<typeof createMinimalEvent>[0]): Promise<TestEvent>;
  /** register an event created some other way (through the admin UI) so it is deleted at the end */
  track(slug: string): void;
}

type Options = { expectedConsole: RegExp | null; ignoreDialogs: boolean; asAdmin: boolean };
type TestFixtures = Options & { guard: void };
type WorkerFixtures = { events: EventFactory; token: string };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  expectedConsole: [null, { option: true }],
  ignoreDialogs: [false, { option: true }],
  asAdmin: [false, { option: true }],
  storageState: async ({ asAdmin, token }, use) => { await use(asAdmin ? adminStorage(token) : undefined); },

  token: [async ({}, use) => { await use(await adminToken()); }, { scope: 'worker' }],

  events: [async ({}, use) => {
    const slugs = new Set<string>();
    await use({
      async create(spec) { const ev = await createEvent(spec); slugs.add(ev.slug); return ev; },
      async createMinimal(spec) { const ev = await createMinimalEvent(spec); slugs.add(ev.slug); return ev; },
      track(slug) { slugs.add(slug); },
    });
    await Promise.all([...slugs].map((s) => deleteEventBySlug(s)));
  }, { scope: 'worker' }],

  guard: [async ({ context, expectedConsole, ignoreDialogs }, use) => {
    const issues: string[] = [];
    const expected = (text: string) => !!expectedConsole && expectedConsole.test(text);
    const watch = (page: Page) => {
      page.on('console', (msg) => {
        const text = msg.text();
        // a broken logo URL typed by an admin in some OTHER event (the hub lists every live event) is that admin's data, not an app bug:
        // the app removes the <img> on error. Same-origin failures are always reported.
        if (/Failed to load resource/i.test(text)) {
          const url = msg.location().url;
          if (url && !url.startsWith(BASE_URL) && !url.startsWith('data:')) return;
        }
        const csp = /E2E_CSP_VIOLATION|content security policy|refused to (load|execute|apply|connect|frame)/i.test(text);
        if ((msg.type() === 'error' || csp) && !expected(text)) issues.push(`console.${msg.type()} on ${page.url()}: ${text}`);
      });
      page.on('pageerror', (err) => { if (!expected(err.message)) issues.push(`uncaught exception on ${page.url()}: ${err.message}`); });
      page.on('dialog', async (dialog) => {
        if (dialog.type() === 'beforeunload') { await dialog.accept().catch(() => {}); return; }
        if (!ignoreDialogs) issues.push(`native ${dialog.type()}() dialog on ${page.url()}: ${dialog.message()}`);
        await dialog.dismiss().catch(() => {});
      });
    };
    context.on('page', watch);
    // every CSP violation becomes a console error (readable above even after the page is gone)
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`E2E_CSP_VIOLATION ${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile || ''}:${e.lineNumber || 0}`);
      });
    });
    for (const page of context.pages()) watch(page);
    await use();
    expect(issues, 'console errors / CSP violations / uncaught exceptions / native dialogs').toEqual([]);
  }, { auto: true }],
});
