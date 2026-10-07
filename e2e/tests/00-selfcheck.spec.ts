/**
 * The safety nets themselves: a test suite that cannot fail proves nothing. These tests feed the detectors something
 * that IS wrong and expect them to notice (no app page involved).
 */
import { test, expect } from '../support/fixtures';
import { xssState, assertNothingExecuted } from '../support/xss';
import { expectNoSeriousA11yViolations } from '../support/a11y';

test.describe('detectors', () => {
  test('the XSS detector sees markup that was parsed as HTML', async ({ page }) => {
    await page.setContent('<main id="m"></main>');
    await page.evaluate(() => { document.getElementById('m')!.innerHTML = '<img src=x onerror=window.__xss=1><x-probe-aa></x-probe-aa>'; });
    const state = await xssState(page);
    expect(state.injected).toBeGreaterThanOrEqual(2);
    expect(state.handlers.length).toBeGreaterThanOrEqual(1);
    await expect(assertNothingExecuted(page, 'canary')).rejects.toThrow();
  });

  test('the XSS detector sees a rewritten title and a global flag', async ({ page }) => {
    await page.setContent('<title>ok</title><p>hello</p>');
    await page.evaluate(() => { (window as any).__xss = 3; document.title = 'XSS-EXECUTED-localhost'; });
    const state = await xssState(page);
    expect(state.flag).toBe(3);
    await expect(assertNothingExecuted(page, 'canary')).rejects.toThrow();
  });

  test('a clean page passes', async ({ page }) => {
    await page.setContent('<main><p>just text &lt;img src=x&gt;</p></main>');
    await assertNothingExecuted(page, 'canary');
  });

  test('axe notices a missing alt text and unreadable text', async ({ page }, testInfo) => {
    await page.setContent('<!doctype html><html lang="en"><title>t</title><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><p style="color:#bbb;background:#fff">faint grey text</p><button></button></main></html>');
    await expect(expectNoSeriousA11yViolations(page, testInfo, 'canary')).rejects.toThrow(/serious|critical|image-alt|button-name|color-contrast/);
  });

  test.describe('console guard', () => {
    test.use({ expectedConsole: /intentional canary error/ });
    test('an expected console error is tolerated, anything else would fail the test', async ({ page }) => {
      await page.setContent('<p>x</p>');
      await page.evaluate(() => console.error('intentional canary error'));
    });
  });
});
