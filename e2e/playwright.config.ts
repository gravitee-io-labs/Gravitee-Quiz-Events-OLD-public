import { defineConfig, devices } from '@playwright/test';

/**
 * Gravitee Quiz Events: end-to-end suite.
 *
 *   BASE_URL         where the gateway listens (default http://localhost:8080). Everything is same-origin:
 *                    /, /{slug}, /{slug}/scoreboard, /admin/, /api
 *   ADMIN_USER       admin login used by the fixtures (default admin)
 *   ADMIN_PASSWORD   admin password (default admin)
 *   E2E_WORKERS      parallel workers (default 2)
 *   WEBKIT_EXECUTABLE launcher for WebKit on macOS 26 (see tools/webkit-macos26/build.sh)
 *
 * Three projects: desktop Chromium (1440x900), WebKit with the iPhone 14 profile, desktop Firefox.
 * See README.md for the full list of variables and how to read a trace.
 */
const baseURL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',

  fullyParallel: true,
  forbidOnly: isCI,
  retries: 1,
  workers: Number(process.env.E2E_WORKERS || 2),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 12_000,
    navigationTimeout: 20_000,
    // the app is bilingual: pin the browser language so the English assertions never depend on the machine
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    // no animation dependent flakiness: the suite asserts on state, not on motion
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: 'webkit-mobile',
      use: {
        ...devices['iPhone 14'],
        browserName: 'webkit',
        // macOS 26: the bundled WebKit segfaults at launch. tools/webkit-macos26/build.sh prints a launcher that works.
        launchOptions: process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {},
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
