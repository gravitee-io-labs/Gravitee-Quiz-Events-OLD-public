#!/usr/bin/env node
// Regenerates the static Gravitee-orange defaults block in css/tokens.css (between the @generated markers)
// from js/branding.js, so the UI is complete before/without JavaScript and always matches the JS maths.
//   node shared/tools/gen-default-tokens.mjs --write      (omit --write to print the block)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeBrandTokens, DEFAULT_BRANDING } from '../js/branding.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', 'css', 'tokens.css');
const t = computeBrandTokens(DEFAULT_BRANDING.primary_color, DEFAULT_BRANDING.accent_color);
const block = Object.entries(t.vars).map(([k, v]) => `    ${k}: ${v};`).join('\n');
if (!process.argv.includes('--write')) { console.log(block); process.exit(0); }
const css = readFileSync(file, 'utf8');
const re = /(\/\* @generated:brand-defaults:start \*\/\n)[\s\S]*?(\n\s*\/\* @generated:brand-defaults:end \*\/)/;
if (!re.test(css)) throw new Error('markers not found in tokens.css');
writeFileSync(file, css.replace(re, `$1${block}$2`));
console.log(`updated ${file} (${Object.keys(t.vars).length} variables, hue ${t.hue.toFixed(1)}, tint ${t.tintC.toFixed(3)})`);
