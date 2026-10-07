import { API, BASE_URL, login, sweepEvents, SLUG_PREFIX } from './api';

/**
 * Runs once before the workers start:
 *  - checks the stack answers (clear message instead of 100 timeouts when docker compose is down),
 *  - signs in once and shares the admin token with the workers (a login per test would trip the login throttle),
 *  - picks a run id: every event of this run is called qa-e2e-<runId>-..., which is what the teardown sweeps,
 *  - removes leftovers of a crashed earlier run (events older than 30 minutes; E2E_SWEEP_ALL=0 to keep them).
 */
export default async function globalSetup() {
  let health: any = null;
  try {
    const res = await fetch(`${API}/health`);
    health = await res.json();
  } catch (e: any) {
    throw new Error(`The quiz stack does not answer at ${BASE_URL} (${e?.message || e}). Start it with "docker compose up -d" or set BASE_URL.`);
  }
  if (health?.status !== 'ok') throw new Error(`GET ${API}/health returned ${JSON.stringify(health)}`);

  for (const path of ['/', '/admin/']) {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) throw new Error(`GET ${BASE_URL}${path} returned ${res.status}`);
  }

  process.env.E2E_RUN_ID = Math.random().toString(36).slice(2, 6);
  process.env.E2E_ADMIN_TOKEN = await login();

  if (process.env.E2E_SWEEP_ALL !== '0') {
    const removed = await sweepEvents(SLUG_PREFIX, { olderThanMs: 30 * 60_000 }).catch(() => []);
    if (removed.length) console.log(`[e2e] removed ${removed.length} leftover qa-e2e-* event(s) from an earlier run`);
  }
  console.log(`[e2e] ${BASE_URL}  run=${process.env.E2E_RUN_ID}`);
}
