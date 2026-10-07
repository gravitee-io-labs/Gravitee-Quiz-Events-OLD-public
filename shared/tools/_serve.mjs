// Tiny static server for the browser test tools (no Python, no fixed port: picks a free one).
//   - serves the repo root (so /shared/... works) with the PRODUCTION CSP header of ARCHITECTURE section 7
//   - mounts shared/ a second time at /admin/shared/ (what the admin container does) with a probe page at /admin/index.html
//   - serves a blank probe page at /probe/blank.html (theme-boot + the four stylesheets, nothing else)
// Used by test-api.mjs and test-layout.mjs:  const srv = await startServer(); ... srv.base ... await srv.close();
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

const page = (prefix, extraHead = '') => `<!doctype html>
<html lang="en" data-theme="dark" data-bg="aurora"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>probe</title>
<script src="${prefix}shared/js/theme-boot.js"></script>${extraHead}
<link rel="stylesheet" href="${prefix}shared/css/fonts.css"><link rel="stylesheet" href="${prefix}shared/css/tokens.css"><link rel="stylesheet" href="${prefix}shared/css/base.css"><link rel="stylesheet" href="${prefix}shared/css/components.css">
</head><body><main id="root"></main></body></html>`;
const PROBES = {
  '/probe/blank.html': page('/', '<script src="/probe/record.js"></script>'),
  '/probe/record.js': 'window.__bootTheme = document.documentElement.getAttribute("data-theme"); window.__bootBg = document.documentElement.getAttribute("data-bg");',
  '/admin/index.html': page('./'),
};

export async function startServer({ port = 0, csp = true } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      const headers = { 'Cache-Control': 'no-cache' };
      if (csp) headers['Content-Security-Policy'] = CSP;
      if (p === '/admin/') p = '/admin/index.html';
      if (PROBES[p] !== undefined) { res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(p)] }); return res.end(PROBES[p]); }
      if (p.startsWith('/admin/shared/')) p = '/shared/' + p.slice('/admin/shared/'.length);
      const file = normalize(join(REPO, p));
      if (!file.startsWith(REPO + sep)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
      res.end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}
