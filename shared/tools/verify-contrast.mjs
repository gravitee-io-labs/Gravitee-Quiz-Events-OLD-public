#!/usr/bin/env node
// Browser-level WCAG verification of the design system (needs Playwright from e2e/ and the styleguide being served):
//
//   cd <repo> && python3 -m http.server 8300 &
//   node shared/tools/verify-contrast.mjs [--base http://localhost:8300/shared/styleguide.html] [--quick] [--out <dir for failing screenshots>]
//
// Pass 1 ("token report"): reads the live Contrast report section of the styleguide for every brand preset x theme and
//   fails on any pair below its WCAG minimum (text 4.5:1, UI 3:1).
// Pass 2 ("pixels"): renders every docs section and reference screen with text made transparent, measures the real
//   composited background behind every text node (aurora, glass, gradients included) and checks the text colour against it
//   (4.5:1, or 3:1 for large text). This is what a user's eye actually gets. `--extremes` repeats it for black / white / grey / pure-RGB / random brands.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright lives in e2e/ (the only place it is installed)
const { chromium } = await import(pathToFileURL(join(here, '..', '..', 'e2e', 'node_modules', '@playwright', 'test', 'index.mjs')).href);

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8300/shared/styleguide.html');
const QUICK = args.includes('--quick');
const MATCH = opt('match', ''); // only run targets whose label contains this text, e.g. --match "docs gravitee dark"
const SKIP1 = args.includes('--skip-tokens');
const EXTREME_PIXELS = args.includes('--extremes');   // also run the pixel pass for the extreme colour pairs (black, white, grey, pure RGB) on the main screens

const PRESET_KEYS = ['gravitee', 'ai', 'yellow', 'navy', 'mint'];
const EXTREMES = [
  ['#000000', '#FFFFFF'], ['#FFFFFF', '#000000'], ['#808080', '#C0C0C0'], ['#FF0000', '#00FF00'], ['#00FF00', '#0000FF'], ['#FFFF00', '#FFFF00'], ['#0000FF', '#FF00FF'], ['#7F7F7F', '#7F7F7F'],
];
const SCREENS = ['landing', 'game', 'results', 'scoreboard', 'hub', 'admin', 'branding'];
const THEMES = ['dark', 'light'];

const browser = await chromium.launch();
let failures = 0;
const report = (label, items) => { if (items.length) { failures += items.length; console.log(`\n  FAIL ${label}`); items.slice(0, 12).forEach((i) => console.log('    - ' + i)); if (items.length > 12) console.log(`    ... ${items.length - 12} more`); } };

// ---------------------------------------------------------------------------------------------------- pass 1
console.log('Pass 1: token-level contrast report (presets x themes)');
if (!SKIP1) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const sets = [...PRESET_KEYS.map((k) => ({ label: k, key: k })), ...EXTREMES.map(([p, a]) => ({ label: `${p}/${a}`, primary: p, accent: a }))];
  for (const theme of THEMES) {
    for (const set of sets) {
      await page.goto(`${BASE}?theme=${theme}${set.key ? `&preset=${set.key}` : ''}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length > 10);
      if (set.primary) {
        await page.evaluate(([p, a]) => window.__sg.setBrand(p, a), [set.primary, set.accent]);
        await page.waitForTimeout(150);
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('sg:brand')));
        await page.waitForTimeout(150);
      }
      const rows = await page.$$eval('#cr-table tbody tr', (trs) => trs.map((tr) => ({ ok: tr.dataset.pass === 'true', ratio: tr.dataset.ratio, min: tr.dataset.min, label: tr.cells[0].textContent })));
      const bad = rows.filter((r) => !r.ok).map((r) => `${r.label}: ${r.ratio}:1 < ${r.min}:1`);
      console.log(`  ${theme.padEnd(5)} ${set.label.padEnd(18)} ${rows.length - bad.length}/${rows.length} pass`);
      report(`${theme} ${set.label}`, bad);
    }
  }
  report('page errors', [...new Set(errors)]);
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------- pass 2
console.log('\nPass 2: composited pixel contrast of every text node');
async function scan(page, label) {
  // text hidden screenshot at each scroll position
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = page.viewportSize().height;
  const fails = [];
  const seen = new Set();
  for (let y = 0; y < total; y += vh - 120) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(80);
    const handle = await page.addStyleTag({ content: '*,*::before,*::after{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important}' });
    const shot = await page.screenshot({ type: 'png' });
    await handle.evaluate((n) => n.remove());
    const b64 = shot.toString('base64');
    const found = await page.evaluate(measureInPage, b64);
    for (const f of found) { const k = `${f.text}|${f.tag}`; if (!seen.has(k)) { seen.add(k); fails.push(`${f.text}  [${f.tag} ${f.size}px] ${f.ratio}:1 < ${f.min}:1  fg ${f.color} on ${f.bg}`); } }
  }
  report(label, fails);
  return fails.length;
}
// the measuring routine runs in the page; pass it as a function so the screenshot is already text-less
const measureInPage = async (shotB64) => {
  // decoded through an <img> (img-src allows data:), not fetch(): connect-src 'self' of the production CSP blocks data: fetches
  const shotImg = new Image(); shotImg.src = `data:image/png;base64,${shotB64}`; await shotImg.decode();
  const bmp = await createImageBitmap(shotImg);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const probe = document.createElement('canvas'); probe.width = probe.height = 1;
  const pc = probe.getContext('2d', { willReadFrequently: true });
  const toRgba = (css) => { pc.clearRect(0, 0, 1, 1); pc.fillStyle = '#000'; pc.fillStyle = css; pc.fillRect(0, 0, 1, 1); const d = pc.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [x, y] = [lum(...a), lum(...b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const dpr = bmp.width / innerWidth;
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('template, script, style, [hidden], .u-sr-only, iframe, .sg-icon')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let skip = false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (parseFloat(s.opacity) < 1 || e.matches(':disabled, [aria-disabled="true"], .is-dimmed, .skeleton, .is-leaving, .is-empty')) { skip = true; break; }
    }
    if (skip) continue;
    if (el.__gradient) continue; // gradient text (background-clip): covered by the token report
    const range = document.createRange(); range.selectNodeContents(n);
    const rect = [...range.getClientRects()].find((r) => r.width > 2 && r.height > 2);
    if (!rect || rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    // line boxes poke out of their background by a few px (esp. big display numerals): sample the glyph band, not the box
    const insetY = rect.height * 0.15, insetX = Math.min(2, rect.width * 0.05);
    const x0 = Math.max(0, Math.floor((rect.left + insetX) * dpr)), y0 = Math.max(0, Math.floor((rect.top + insetY) * dpr));
    const x1 = Math.min(bmp.width, Math.ceil((rect.right - insetX) * dpr)), y1 = Math.min(bmp.height, Math.ceil((rect.bottom - insetY) * dpr));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const img = cx.getImageData(x0, y0, x1 - x0, y1 - y0);
    // the real text colour: our injected style forced transparent, so recompute from the stylesheet by cloning the node style
    const real = el.__realColor;
    const [fr, fg, fb, fa] = toRgba(real || cs.color);
    let worst = Infinity, worstBg = null;
    const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 80)));
    for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const bg = [img.data[i], img.data[i + 1], img.data[i + 2]];
      const fgc = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)];
      const r = ratio(fgc, bg);
      if (r < worst) { worst = r; worstBg = bg; }
    }
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const min = large ? 3 : 4.5;
    if (worst < min) out.push({ text: text.slice(0, 40), ratio: worst.toFixed(2), min, color: real || cs.color, bg: `rgb(${worstBg.join(',')})`, size: size.toFixed(1), tag: `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''}` });
  }
  return out;
};

// To know the REAL text colour while the override style forces transparency, we stash it on each element first.
const stashColors = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    const fill = cs.webkitTextFillColor;
    el.__realColor = fill && fill !== 'rgba(0, 0, 0, 0)' && fill !== cs.color ? fill : cs.color;
    if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)') el.__gradient = true;
  }
};

{
  const targets = [];
  for (const theme of THEMES) for (const key of (QUICK ? ['gravitee', 'yellow', 'navy'] : PRESET_KEYS)) {
    targets.push({ label: `docs ${key} ${theme}`, url: `${BASE}?preset=${key}&theme=${theme}`, w: 1280, h: 900 });
    for (const s of SCREENS) {
      const dims = s === 'scoreboard' ? [[1920, 1080]] : s === 'game' || s === 'results' || s === 'landing' ? [[390, 844]] : [[1440, 900], [390, 844]];
      for (const [w, h] of dims) targets.push({ label: `${s} ${key} ${theme} ${w}x${h}`, url: `${BASE}?screen=${s}&preset=${key}&theme=${theme}`, w, h });
    }
  }
  if (EXTREME_PIXELS) {
    const RANDOM = [['#1B998B', '#ED217C'], ['#6A0DAD', '#FFC300'], ['#2D3142', '#EF8354'], ['#E63946', '#F1FAEE'], ['#00A8E8', '#003459']];
    for (const theme of THEMES) for (const [p, a] of [...EXTREMES, ...RANDOM]) for (const [s, w, h] of [['landing', 390, 844], ['results', 390, 844], ['game', 390, 844], ['hub', 1440, 900], ['scoreboard', 1920, 1080], ['admin', 1440, 900]]) {
      targets.push({ label: `${s} ${p}/${a} ${theme} ${w}x${h}`, url: `${BASE}?screen=${s}&preset=gravitee&theme=${theme}`, w, h, brand: [p, a] });
    }
  }
  for (const t of targets.filter((x) => x.label.includes(MATCH))) {
    const ctx = await browser.newContext({ viewport: { width: t.w, height: t.h }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(t.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '.appbar,.sg-bar,.shell__topbar{position:static !important}' });
    if (t.brand) { await page.evaluate(([p, a]) => window.__sg.setBrand(p, a), t.brand); await page.waitForTimeout(250); }
    await page.waitForTimeout(400);
    // stash real colours (once, before any override), then scan
    await page.evaluate(stashColors);
    const n = await scan(page, `pixels ${t.label}`);
    if (!n) console.log(`  ok   ${t.label}`);
    await ctx.close();
  }
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nALL CONTRAST CHECKS PASSED');
process.exit(failures ? 1 : 0);
