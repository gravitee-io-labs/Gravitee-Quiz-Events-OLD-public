#!/usr/bin/env node
// Layout / robustness regression test of the design system, in a real Chromium (needs Playwright from e2e/; starts its own server):
//   1. no horizontal page scroll: 320 -> 1920 px x 5 brand presets x dark/light x docs + 7 reference screens
//   2. no layout shift when the web fonts arrive late (CLS <= 0.02 on every screen) and none when they never arrive
//   3. prefers-reduced-motion: every decorative infinite animation stops (only the loading spinner may keep turning)
//   4. structure: accessible names, labels, unique ids, one h1 per screen, heading order
//   5. touch: with a coarse pointer every control of the player screens is >= 44 px (the query is forced on, headless Chromium cannot emulate it)
//   node shared/tools/test-layout.mjs [--quick]
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './_serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(join(here, '..', '..', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs')).href);
const QUICK = process.argv.includes('--quick');
const srv = await startServer();
const BASE = srv.base;
const browser = await chromium.launch();
const PRESETS = ['gravitee', 'ai', 'yellow', 'navy', 'mint'];
const SCREENS = ['landing', 'game', 'results', 'scoreboard', 'hub', 'admin', 'branding'];
const SG = `${BASE}/shared/styleguide.html`;
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

// ------------------------------------------------------------------------------------------------ 1. overflow
console.log('1. no horizontal overflow');
{
  const sizes = QUICK ? [[320, 640], [390, 844], [1440, 900]] : [[320, 640], [360, 740], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
  let n = 0;
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      for (const preset of PRESETS) for (const screen of ['', ...SCREENS]) {
        if (preset !== 'gravitee' && ![390, 1440].includes(w)) continue;
        await page.goto(`${SG}?preset=${preset}&theme=${theme}${screen ? `&screen=${screen}` : ''}`, { waitUntil: 'load' });
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        n++;
        if (r[0] > r[1]) fail(`${theme} ${w}x${h} ${preset} ${screen || 'docs'}: scrollWidth ${r[0]} > ${r[1]}`);
      }
    }
    await ctx.close();
  }
  console.log(`   ${n} pages checked`);
}

// ------------------------------------------------------------------------------------------------ 2. font swap CLS
console.log('2. layout shift when fonts arrive late / never');
for (const mode of ['delayed', 'blocked']) {
  const worst = [];
  for (const screen of SCREENS) for (const [w, h] of [[390, 844], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.route('**/*.woff2', async (route) => { if (mode === 'blocked') return route.abort(); await new Promise((r) => setTimeout(r, 900)); return route.continue(); });
    await page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
    await page.goto(`${SG}?screen=${screen}`, { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    const cls = await page.evaluate(() => window.__cls);
    worst.push(cls);
    if (cls > 0.02) fail(`fonts ${mode}: ${screen}@${w} CLS ${cls.toFixed(3)} > 0.02`);
    await ctx.close();
  }
  console.log(`   fonts ${mode}: worst CLS ${Math.max(...worst).toFixed(3)}`);
}

// ------------------------------------------------------------------------------------------------ 3. reduced motion
console.log('3. prefers-reduced-motion');
{
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const url of [SG, ...SCREENS.map((s) => `${SG}?screen=${s}`)]) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity && !/^spin$/.test(a.animationName || '')).map((a) => a.animationName || 'animation'));
    if (running.length) fail(`${url.replace(SG, 'docs')}: infinite animations still running: ${[...new Set(running)].join(', ')}`);
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 4. structure
console.log('4. accessible structure');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const screen of SCREENS) {
    await page.goto(`${SG}?screen=${screen}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const issues = await page.evaluate(() => {
      const out = [];
      const name = (n) => (n.getAttribute('aria-label') || (n.getAttribute('aria-labelledby') || '').split(' ').map((i) => document.getElementById(i)?.textContent).join(' ') || n.textContent || n.getAttribute('title') || '').trim();
      for (const n of document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem]')) if (!n.closest('template, [hidden]') && !name(n)) out.push('no accessible name: ' + n.outerHTML.slice(0, 80));
      for (const n of document.querySelectorAll('input:not([type=hidden]), select, textarea')) { if (n.closest('template, [hidden]')) continue; if (!n.closest('label') && !(n.id && document.querySelector(`label[for="${n.id}"]`)) && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')) out.push('input without label: ' + n.outerHTML.slice(0, 80)); }
      for (const n of document.querySelectorAll('img:not([alt])')) out.push('img without alt: ' + n.src);
      const ids = {}; for (const n of document.querySelectorAll('[id]')) ids[n.id] = (ids[n.id] || 0) + 1;
      for (const [k, v] of Object.entries(ids)) if (v > 1) out.push(`duplicate id "${k}"`);
      const main = document.querySelector('.screen__main, main, [role=main]'); if (!main) out.push('no main landmark');
      const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.getClientRects().length).map((h) => +h.tagName[1]);
      let prev = 0; for (const h of hs) { if (prev && h > prev + 1) out.push(`heading jump h${prev} -> h${h}`); prev = h; }
      return [...new Set(out)];
    });
    issues.forEach((i) => fail(`${screen}: ${i}`));
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ 5. touch targets
console.log('5. touch targets >= 44 px (coarse pointer forced on)');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  for (const screen of ['landing', 'game', 'results', 'hub']) {
    await page.goto(`${SG}?screen=${screen}`, { waitUntil: 'networkidle' });
    for (const f of ['tokens', 'base', 'components', 'styleguide']) {
      const css = await page.evaluate(async (u) => (await fetch(u)).text(), `/shared/css/${f}.css`);
      await page.addStyleTag({ content: css.replace(/\(pointer:\s*coarse\)/g, '(min-width: 0px)') });
    }
    await page.waitForTimeout(300);
    const small = await page.evaluate(() => {
      const out = [];
      for (const n of document.querySelectorAll('button, a[href], select, textarea, input:not([type=hidden])')) {
        if (n.closest('template, [hidden]') || n.matches('.skip-link')) continue;
        let r = (n.matches('input[type=radio],input[type=checkbox]') ? n.closest('label') || n : n).getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const inside = n.matches('.segmented input');   // segmented controls extend their tap area 0.3rem above and below the pill
        const h = inside ? r.height + 9 : r.height;
        if ((h < 43.5 || r.width < 43.5) && !(n.matches('a') && getComputedStyle(n).display === 'inline')) out.push(`${n.tagName.toLowerCase()} "${(n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 18)}" ${Math.round(r.width)}x${Math.round(h)}`);
      }
      return [...new Set(out)];
    });
    small.forEach((s) => fail(`${screen}: ${s}`));
  }
  await ctx.close();
}

await browser.close();
await srv.close();
console.log(failures ? `\n${failures} failure(s)` : '\nALL LAYOUT CHECKS PASSED');
process.exit(failures ? 1 : 0);
