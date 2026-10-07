// Visual QA helper: node shot.mjs <url> <out.png> [--w 390] [--h 844] [--dark|--light] [--full] [--wait 800] [--lang fr]
// Example: node shot.mjs http://localhost:8080/ .shots/hub-mobile.png --w 390 --h 844 --dark
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node shot.mjs <url> <out.png> [--w N] [--h N] [--dark|--light] [--full] [--wait ms]'); process.exit(2); }
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const flag = (n) => rest.includes(`--${n}`);
const width = +opt('w', 1280), height = +opt('h', 800), wait = +opt('wait', 800);
const colorScheme = flag('light') ? 'light' : 'dark';
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1, locale: opt('lang', 'en') });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(wait);
await page.screenshot({ path: out, fullPage: flag('full') });
await browser.close();
console.log(`saved ${out} (${width}x${height}, ${colorScheme})`);
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
