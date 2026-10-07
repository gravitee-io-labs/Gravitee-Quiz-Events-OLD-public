# Gravitee Quiz Events: end-to-end tests

Playwright suite for the whole product: hub, event game, live scoreboard, admin console and the API behind them.
It drives real browsers (desktop Chromium, iPhone 14 WebKit, desktop Firefox) against a running stack.

* 243 tests in Chromium, 170 in each of WebKit and Firefox (the browser-independent HTTP-level checks run once, in Chromium: 583 passed + 146 skipped
  per full run), about 5.5 minutes for all three projects with 2 workers (about 2 minutes for Chromium alone).
* Every test creates its own events (`qa-e2e-<run>-...`) through the admin API and deletes them afterwards. Nothing depends on seeded data
  except one read-only smoke test (`tests/01a-smoke-seeded.spec.ts`), which skips itself when the seeded events are absent.
* No arbitrary sleeps: everything waits on state (`expect` polling, `waitForResponse`, `data-*` attributes).

## What is covered

| # | Area | Spec |
|---|------|------|
| - | The safety nets themselves (the detectors must fail on bad input) | `tests/00-selfcheck.spec.ts` |
| - | Read-only smoke of the seeded events | `tests/01a-smoke-seeded.spec.ts` |
| 1 | Hub lists live events as branded cards; draft / closed never listed; empty and error states | `tests/01-hub.spec.ts` |
| 2 | Event landing: live, draft (404 for the public, preview banner for an admin), closed (ended, no play), unknown slug, 404 page, languages | `tests/02-event-landing.spec.ts` |
| 3 | Registration: required fields, phone hidden / optional / required, consent, email-in-name, markup in names, server 422 mapping, the same rules at the API | `tests/03-registration.spec.ts` |
| 4 | Complete 15-question game on the keyboard (G / R) with a timeout, results (score, rank), review with explanations, FR / EN switch mid-flow; resume after reload; flaky network at the end of a game (retry, lost response); event closed mid-game | `tests/04-game-flow.spec.ts` |
| 5 | Scoreboard live update through SSE (no reload), polling fallback, privacy (no email / phone in DOM, REST or stream), closed / draft behaviour, big boards | `tests/05-scoreboard-live.spec.ts` |
| 6 | Admin: login failure / success / session (`06a`), events list, create, duplicate, export + import bundle, status draft -> live -> closed, delete with slug confirmation (`06b`), appearance and its effect on the public pages (`06c`), settings (`06d`), categories, questions, CSV import with dry run (`06e`), results, score edit, leads CSV (CSV-injection safe) (`06f`) | `tests/06*.spec.ts` |
| 7 | XSS regression: hostile text stored in events / categories / questions (`07a`), hostile player names fed to the scoreboard and the admin results (`07b`), the real production probes rendered from a copy of the production data (`07c`) | `tests/07*.spec.ts` |
| 8 | Accessibility smoke with axe-core (no serious / critical violation), dark and light themes | `tests/08-a11y.spec.ts` |
| 9 | CSP: strict headers, no inline script / handler in the served HTML, the policy is enforced by the browser, a page sweep with no console error and no request leaving the origin | `tests/09-csp-console.spec.ts` |
| 10 | Mobile sanity: no horizontal scroll with very long texts, touch targets | `tests/10-mobile.spec.ts` |

On top of that, an automatic fixture (`guard`, see below) makes **every** test fail on a console error, a CSP violation, an uncaught exception
or a native `alert / confirm / prompt` dialog, on any page the test opens.

## Run it locally

Prerequisites: Node 18+, the stack up (`docker compose up -d`, gateway on <http://localhost:8080>), admin login `admin` / `admin`.

```bash
cd e2e
npm ci
npx playwright install chromium firefox webkit      # once

npm test                       # all three projects
npm run test:chromium          # desktop Chrome 1440x900 only (fastest, ~2 min)
npm run test:mobile            # WebKit with the iPhone 14 profile
npm run test:firefox
npm run test:smoke             # the quick "is it alive" selection

npx playwright test tests/04-game-flow.spec.ts --project=chromium         # one file
npx playwright test -g "lost response"                                    # by title
npx playwright test --project=chromium --headed --workers=1 tests/05*     # watch it
npx playwright test --ui                                                  # Playwright UI mode
npx playwright test --debug tests/03-registration.spec.ts                 # step through
```

Projects (`playwright.config.ts`): `chromium` (Desktop Chrome, 1440x900), `webkit-mobile` (iPhone 14, WebKit, touch), `firefox` (1440x900).
Retries: 1. Workers: 2. Reporters: list + HTML. Traces are recorded on the first retry, screenshots on failure.
The browsers run with `reducedMotion: reduce`, `en-GB` and the Amsterdam time zone so that assertions never depend on the machine.

### WebKit on macOS 26

The WebKit build bundled with Playwright 1.63 crashes at launch on macOS 26 (`Segmentation fault: 11`). A one-line shim works around it:

```bash
export WEBKIT_EXECUTABLE="$(e2e/tools/webkit-macos26/build.sh)"   # compiles tools/webkit-macos26/shim.m, prints the launcher path
npm run test:mobile
```

On other systems nothing is needed and `WEBKIT_EXECUTABLE` stays unset.

## Run it against a deployed URL

```bash
BASE_URL=https://quiz.example.org ADMIN_USER=... ADMIN_PASSWORD=... npx playwright test --project=chromium --project=webkit-mobile
```

Mind that the suite **writes**: it creates (and deletes) events named `qa-e2e-*`, registers players in them and signs in as the admin. Do not point
it at a production host during a live event: the throw-away events are public (listed on the hub) while a test runs. A failed run that was killed
half way can leave `qa-e2e-*` events behind; `npm run clean` removes them (and only them), and the next run removes the ones older than 30 minutes by itself.

The admin login limiter is respected: the only failed login of the suite uses a throw-away user name.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `BASE_URL` | `http://localhost:8080` | Gateway of the stack under test (hub, `/{slug}`, `/admin/`, `/api` are same origin) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin` | Admin login used by the fixtures |
| `E2E_WORKERS` | `2` | Parallel workers |
| `E2E_SWEEP_ALL` | (on) | `0` keeps leftovers of earlier runs instead of removing the old ones at start |
| `SEEDED_SLUGS` | `api-masters,world-ai-summit-2026` | Seeded events checked (read only) by the smoke test; skipped when absent |
| `PROD_COPY_API` | `http://localhost:8190/api` | Backend holding a copy of the production data, used by `07c` (skipped when it does not answer) |
| `PROD_COPY_USER` / `PROD_COPY_PASSWORD` | `admin` / `admin` | Admin login of that copy |
| `WEBKIT_EXECUTABLE` | (unset) | WebKit launcher, see "WebKit on macOS 26" |
| `CI` | (unset) | Forbids `test.only` |

`E2E_RUN_ID` and `E2E_ADMIN_TOKEN` are set by the global setup for the workers; do not set them yourself.

## How the suite is built

```
playwright.config.ts          projects, retries, reporters, global setup / teardown
support/
  api.ts                      REST client (admin + public), playViaApi() = register + start + submit, SSE snapshot reader, sweeper
  events.ts                   deterministic event factory (bundle import): createEvent(), createMinimalEvent(), uniqueSlug()
  fixtures.ts                 test = base.extend: `events` factory, `guard`, `expectedConsole`, `asAdmin`
  ui.ts                       player app page helpers (register, play by keyboard, read results, language / theme switch)
  admin.ts                    admin console helpers (routes, dialogs, toasts, downloads)
  xss.ts                      hostile strings, "nothing executed" check, API interception (hostile names, production proxy)
  a11y.ts  mobile.ts          axe wrapper, overflow / touch-target measurement
  global-setup.ts / global-teardown.ts
tests/                        the specs (see the table above)
tools/clean-events.mjs        `npm run clean`
tools/webkit-macos26/         WebKit launch workaround for macOS 26
```

### The event factory

`createEvent({ tag, questions, perGame, timer, twoChoices, status, collectPhone, consentEn, primary, ... })` imports a bundle with two categories
(`QA Alpha`, `QA Beta`) and N questions that all read "QA statement N: water is wet." in English and "Affirmation QA N : l'eau est mouillée." in
French. **The correct answer is always green**, so a plan such as `['g','g','r','timeout']` gives exactly 2 correct / 1 wrong / 1 unanswered whatever
order the server draws the questions in. Each question has an English and a French explanation; the first `twoChoices` ones are two-choices
questions ("Alpha N" / "Omega N"). Use the worker-scoped `events` fixture so the event is deleted at the end of the worker:

```ts
test.beforeAll(async ({ events }) => { ev = await events.create({ tag: 'my-feature', questions: 6, perGame: 3 }); });
```

Slugs look like `qa-e2e-<run id>-<tag>-<random>`: unique per run, per worker and per call, so tests are parallel safe.
An event created through the admin UI must be registered with `events.track(slug)` so it is deleted too.

### Admin pages

`test.use({ asAdmin: true })` stores the admin JWT in `localStorage` before the first page loads (it is the same origin as the player app,
which is also what makes the draft preview work). Only `06a-admin-auth.spec.ts` uses the login form.

### The `guard` fixture and `expectedConsole`

`guard` is an automatic fixture: any `console.error`, CSP violation (also reported through a `securitypolicyviolation` listener), uncaught
exception or native dialog on any page of the test fails it. Some tests provoke errors on purpose (a 404 for an unknown event, a refused
registration, a blocked stream). They declare it, narrowly:

```ts
test.describe('hub when the API is down', () => {
  test.use({ expectedConsole: /Failed to load resource|503/ });   // ONE regular expression (use alternation)
  ...
});
```

Failed loads of images from a foreign host (a broken logo URL typed into somebody else's event, which the hub lists) are ignored on purpose:
`img-src` allows `https:` and the app removes the broken `<img>`.

### XSS tests

The hardened backend rejects `<` and `>` in player names, so the probes left in production (`PoC<img src=x onerror=alert(document.domain)>`,
`PoC2<img ... document.title ...>`, `ZtestZ<x-probe-aa>`) cannot be registered any more; the suite checks that they are refused (API and form).
Because those rows still exist in the production database and the public scoreboard prints the first name in full, the front ends must be safe
on their own. They are exercised three ways:

1. `07a`: hostile text is really stored (event, categories, questions, labels, explanations, consent text) and read back by every screen.
2. `07b`: the scoreboard (REST and SSE) and the admin results are served the real probe names through request interception.
3. `07c`: the apps are served from the normal stack but every `/api` call is answered by a copy of the production data (`PROD_COPY_API`).

After each page, `assertNothingExecuted()` checks that `window.__xss` is unset, `document.title` was not rewritten, no element was injected
(`img[src=x]`, `x-probe-aa`, `iframe[srcdoc]`, `[onerror]`...), no inline `on*` attribute exists, and the payload is displayed as literal text.
`00-selfcheck.spec.ts` proves the detector fires on markup that was parsed as HTML.

## Reading the results

```bash
npx playwright show-report                                   # HTML report of the last run (playwright-report/)
npx playwright show-trace test-results/<test-folder>/trace.zip
```

* **Trace** (`trace.zip`): recorded on the first retry of a failing test, so a test that passes on retry (flaky) still leaves one. The viewer shows
  every action with before / after DOM snapshots, the network (including the `/api` calls and the SSE stream), the console and the source line.
  Open the failing action, look at the "Before" snapshot (what the page really showed), then at Console and Network for errors.
* **Screenshots** of the failure and `error-context.md` (an accessibility snapshot of the page at the failure) are in `test-results/<test-folder>/`.
* **Attachments**: the axe results of every scan (`axe-<page>.json`, all violations with their nodes) and the touch-target measurements
  (`targets-<page>.json`) are attached to the test in the HTML report even when it passes.
* A message starting with `console errors / CSP violations / uncaught exceptions / native dialogs` comes from the `guard` fixture and lists
  every offending message with the page URL.
* `npx playwright test --last-failed` re-runs only what failed.

## Troubleshooting

* `The quiz stack does not answer at ...`: start the stack or set `BASE_URL`.
* Many tests fail on the first request with 401 / 429: the admin login is throttled (10 failures per 5 minutes per IP + user name). Wait or check the credentials.
* `Segmentation fault: 11` when launching WebKit: see "WebKit on macOS 26".
* Leftover `qa-e2e-*` events after a crash: `npm run clean`.
* Flaky timing assertions on a very loaded machine: lower `E2E_WORKERS` to 1.
