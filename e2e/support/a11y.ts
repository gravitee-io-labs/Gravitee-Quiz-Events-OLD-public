/**
 * Accessibility helper: axe-core (WCAG 2.0 / 2.1 A + AA rules) on the page as it is now.
 * Serious and critical violations fail the test; the full result is attached to the report either way.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export interface AxeOptions {
  /** CSS selectors to leave out (third-party widgets, a known false positive...) */
  exclude?: string[];
  /** rule ids to disable for this scan, with the reason in the call site */
  disableRules?: string[];
}

export async function expectNoSeriousA11yViolations(page: Page, testInfo: TestInfo, name: string, opts: AxeOptions = {}) {
  // scan a settled page: loading skeletons and busy lists are dimmed on purpose (opacity), which axe would measure
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('.skeleton')).toHaveCount(0);
  // ... and one where colour transitions (a theme switch just happened) are over, otherwise axe measures a half-faded colour
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']);
  for (const sel of opts.exclude || []) builder = builder.exclude(sel);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const results = await builder.analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify({ url: page.url(), violations: results.violations, incomplete: results.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length })) }, null, 2), contentType: 'application/json' });
  const bad = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}  ::  ${(n.failureSummary || '').split('\n').slice(0, 2).join(' | ')}`) }));
  expect(bad, `axe: serious / critical violations on ${name} (${page.url()})`).toEqual([]);
}
