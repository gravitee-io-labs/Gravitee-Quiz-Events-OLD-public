#!/usr/bin/env node
// Property test: for ANY brand colours, computeBrandTokens() must give AA-compliant roles in both themes.
//   node shared/tools/test-color.mjs [--n 4000]
import { computeBrandTokens, SURFACE_L } from '../js/branding.js';
import { contrast, oklchToHex, hexToOklch } from '../js/color.js';

const ni = process.argv.indexOf('--n');
const n = ni >= 0 ? +process.argv[ni + 1] : 4000;
const rnd = (() => { let s = 0x9e3779b9; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
const randHex = () => '#' + Array.from({ length: 3 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('');
const presets = [
  ['#FC5607', '#FF9A52'], ['#7C5CFF', '#22D3EE'], ['#FFD60A', '#FF006E'], ['#0B2447', '#19376D'], ['#2EC4B6', '#CBF3F0'],
  ['#000000', '#FFFFFF'], ['#FFFFFF', '#000000'], ['#808080', '#808080'], ['#FF0000', '#00FF00'], ['#00FF00', '#0000FF'], ['#0000FF', '#FFFF00'], ['#FFFF00', '#FFFF00'], ['#7F7F7F', null],
];
const pairs = [...presets];
for (let i = 0; i < n; i++) pairs.push([randHex(), rnd() < 0.15 ? null : randHex()]);

const fails = [];
const worst = {};
const track = (k, v) => { if (!(k in worst) || v < worst[k]) worst[k] = v; };

for (const [p, a] of pairs) {
  const t = computeBrandTokens(p, a);
  const { hue, tintC } = t;
  for (const theme of ['dark', 'light']) {
    const k = theme === 'dark' ? 'd' : 'l';
    const S = SURFACE_L[theme];
    const tint = theme === 'dark' ? tintC : tintC * 0.5;
    const surfaces = {
      bg: oklchToHex({ l: S.bg, c: tint, h: hue }),
      raised: oklchToHex({ l: S.raised, c: S.raised === 1 ? 0 : tint, h: hue }),
      textRef: oklchToHex({ l: S.textRef, c: tint, h: hue }),
    };
    const v = (name) => t.vars[`--${name}-${k}`];
    const check = (label, ratio, min) => { track(`${theme}:${label}`, ratio); if (ratio < min) fails.push(`${p}/${a} ${theme} ${label} ${ratio.toFixed(2)} < ${min}`); };
    for (const role of ['brand', 'accent', 'green', 'red', 'amber', 'blue']) {
      const solid = role === 'brand' || role === 'accent' ? `${role}-solid` : role;
      const on = role === 'brand' ? 'on-brand' : role === 'accent' ? 'on-accent' : `on-${role}`;
      const hover = role === 'brand' || role === 'accent' ? `${role}-solid-hover` : `${role}-hover`;
      const text = `${role}-text`;
      check(`${role} label/solid`, contrast(v(on), v(solid)), 4.5);
      check(`${role} label/hover`, contrast(v(on), v(hover)), 4.5);
      check(`${role} solid/bg`, contrast(v(solid), surfaces.bg), 3);
      check(`${role} solid/raised`, contrast(v(solid), surfaces.raised), 3);
      check(`${role} text/bg`, contrast(v(text), surfaces.bg), 4.5);
      check(`${role} text/raised`, contrast(v(text), surfaces.raised), 4.5);
      check(`${role} text/hoverSurface`, contrast(v(text), surfaces.textRef), 4.5);
    }
    const gh = hexToOklch(v('green')).h, rh = hexToOklch(v('red')).h;
    if (gh < 130 || gh > 170) fails.push(`${p}/${a} ${theme} green hue ${gh.toFixed(0)}`);
    if (rh > 42 && rh < 350 || (rh < 12)) fails.push(`${p}/${a} ${theme} red hue ${rh.toFixed(0)}`);
  }
}
console.log(`${pairs.length} brand pairs x 2 themes x 6 roles checked`);
for (const [k, v] of Object.entries(worst).sort()) console.log(`  worst ${k.padEnd(30)} ${v.toFixed(2)}`);
if (fails.length) { console.log(`\nFAILURES: ${fails.length}`); console.log(fails.slice(0, 25).join('\n')); process.exit(1); }
console.log('\nALL OK');
