#!/usr/bin/env node
// Deletes every event whose slug starts with "qa-e2e-" (what the suite creates; a crashed run can leave some behind).
//   node tools/clean-events.mjs            -> all of them
//   node tools/clean-events.mjs --older 30 -> only those created more than 30 minutes ago
// Never touches any other slug. Uses BASE_URL / ADMIN_USER / ADMIN_PASSWORD like the suite.
const base = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const api = `${base}/api`;
const args = process.argv.slice(2);
const olderMin = args.includes('--older') ? Number(args[args.indexOf('--older') + 1]) : 0;

const login = await fetch(`${api}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD || 'admin' }),
});
if (!login.ok) { console.error(`login failed (${login.status})`); process.exit(1); }
const { access_token: token } = await login.json();
const auth = { Authorization: `Bearer ${token}` };

const events = await (await fetch(`${api}/admin/events`, { headers: auth })).json();
let removed = 0;
for (const e of events) {
  if (!String(e.slug).startsWith('qa-e2e-')) continue;
  if (olderMin && Date.now() - Date.parse(e.created_at) < olderMin * 60_000) continue;
  const res = await fetch(`${api}/admin/events/${e.id}?confirm=${encodeURIComponent(e.slug)}`, { method: 'DELETE', headers: auth });
  console.log(`${res.status === 204 ? 'deleted' : `FAILED ${res.status}`}  ${e.slug}`);
  if (res.status === 204) removed += 1;
}
console.log(`${removed} event(s) removed`);
