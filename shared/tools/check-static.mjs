#!/usr/bin/env node
// CSP / hygiene audit of static files (HTML, CSS, JS, SVG). Default: the whole shared/ folder (minus vendor, fonts, tools).
// App agents can run it on their own folder: node shared/tools/check-static.mjs web admin-console
//   node shared/tools/check-static.mjs [dir-or-file ...]
// Fails on: inline <script>, inline event-handler attributes, javascript: URLs, eval / new Function / string timers,
//           external http(s) URLs (anything not same-origin) that the page would LOAD or LINK TO, @import of remote CSS, document.write, remote fonts/scripts.
// What is NOT an external URL: placeholder / aria-* / title / alt / value text, i18n sentences ("e.g. https://example.com/logo.png"), prose in HTML text,
// comments. In HTML / SVG only src, href, srcset, poster, action, formaction, data, xlink:href (and friends) count; in JS only a string literal that IS
// a URL (no spaces around it) counts, unless it is the value of a text-ish key (placeholder, aria-*, title, alt, label, hint, example, ...); in CSS only
// url(...) and @import count.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = process.argv.slice(2).length ? process.argv.slice(2).map((p) => resolve(p)) : [resolve(here, '..')];
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'fonts', 'tools']);   // tools/ are Node dev scripts, never served
const EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg']);
const problems = [];
// the project's own domain and the XML namespaces are not external
const ALLOWED = /^https?:\/\/(?:www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml)|quiz\.events\.gravitee\.io|localhost)(?:[:/?#]|$)/i;
// attributes whose value the browser loads or navigates to
const LOAD_ATTRS = new Set(['src', 'href', 'xlink:href', 'srcset', 'imagesrcset', 'poster', 'action', 'formaction', 'data', 'background', 'manifest', 'ping', 'cite']);
// a JS key / call that introduces TEXT: the URL after it is an example, not a resource
const TEXT_KEY = /(?:placeholder|aria-[\w-]+|ariaLabel|ariaDescription|title|alt|label|caption|tooltip|hint|help|description|text|message|msg|example|sample|eg)['"]?\s*(?:[:=]|,)\s*$/i;

function* walk(p) {
  const st = statSync(p);
  if (st.isFile()) { if (EXT.has(extname(p))) yield p; return; }
  for (const name of readdirSync(p)) { if (SKIP_DIRS.has(name)) continue; yield* walk(join(p, name)); }
}

// strip comments so URLs in docs/licence headers are not flagged; keep line numbers
const stripComments = (src, ext) => {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  if (ext === '.css') return src.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (ext === '.html' || ext === '.svg') return src.replace(/<!--[\s\S]*?-->/g, blank);
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
};

for (const root of roots) for (const file of walk(root)) {
  const ext = extname(file);
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw, ext);
  const rel = relative(process.cwd(), file);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const flag = (re, msg, text = src) => { for (const m of text.matchAll(re)) problems.push(`${rel}:${lineOf(m.index)}  ${msg}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`); };

  if (ext === '.html') {
    flag(/<script\b(?![^>]*\bsrc=)[^>]*>/gi, 'inline <script>');
    flag(/\son[a-z]+\s*=\s*["']/gi, 'inline event handler attribute');
    flag(/(?:href|src|action)\s*=\s*["']\s*javascript:/gi, 'javascript: URL');
    flag(/<link\b[^>]*rel=["']?(?:preconnect|dns-prefetch)/gi, 'third-party preconnect');
  }
  if (ext === '.js' || ext === '.mjs') {
    flag(/\beval\s*\(/g, 'eval');
    flag(/\bnew\s+Function\s*\(/g, 'new Function');
    flag(/\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, 'string timer');
    flag(/\bdocument\.write\s*\(/g, 'document.write');
    flag(/\.innerHTML\s*=(?!=)/g, 'innerHTML assignment (use el()/textContent unless the HTML is a static literal)');
    flag(/\bimport\s*\(\s*["'`]https?:/g, 'remote dynamic import');
    flag(/\bfrom\s+["']https?:/g, 'remote import');
  }
  if (ext === '.css') flag(/@import\s+(?:url\()?["']?https?:/gi, 'remote @import');
  // absolute http(s) URLs that the page loads or links to (not text): everything except the xmlns declaration and the project's own domain
  const external = (url) => /^https?:\/\/[^\s]/i.test(url) && !ALLOWED.test(url);
  if (ext === '.html' || ext === '.svg') {
    for (const tag of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
      for (const a of tag[0].matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const [, name, v1, v2] = a, value = (v1 ?? v2 ?? '').trim();
        if (!LOAD_ATTRS.has(name.toLowerCase())) continue;   // placeholder, aria-*, title, alt, value, data-*, content ... are text
        const urls = name.toLowerCase().endsWith('srcset') ? value.split(',').map((c) => c.trim().split(/\s+/)[0]) : [value];
        for (const u of urls) if (external(u)) problems.push(`${rel}:${lineOf(tag.index)}  external URL: ${name}="${u.slice(0, 70)}"`);
      }
    }
  }
  if (ext === '.js' || ext === '.mjs') {
    // a string literal that IS a URL ("https://x/y", no spaces); sentences that merely contain one are text
    for (const m of src.matchAll(/(["'`])(https?:\/\/(?:[^\s"'`$]|\$\{[^}]*\})+)\1/g)) {
      if (!external(m[2])) continue;
      if (TEXT_KEY.test(src.slice(Math.max(0, m.index - 80), m.index))) continue;   // placeholder: '…', 'aria-label': '…', title: '…', setAttribute('alt', '…')
      problems.push(`${rel}:${lineOf(m.index)}  external URL: ${m[2].slice(0, 70)}`);
    }
  }
  if (ext === '.css' || ext === '.js' || ext === '.mjs' || ext === '.html') flag(/url\(\s*["']?https?:\/\/(?!www\.w3\.org\/(?:2000\/svg|1999\/xlink)|quiz\.events\.gravitee\.io|localhost)[^\s"')]+/gi, 'external URL in url()');
}
if (problems.length) { console.log(problems.join('\n')); console.log(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(`static audit OK (${roots.map((r) => relative(process.cwd(), r) || '.').join(', ')}): no inline script/handler, no eval, no external URL`);
