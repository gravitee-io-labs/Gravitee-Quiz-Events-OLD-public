import { SLUG_PREFIX, sweepEvents } from './api';

/** Safety net: workers delete their own events, this removes whatever a crashed worker left behind. */
export default async function globalTeardown() {
  const run = process.env.E2E_RUN_ID;
  if (!run) return;
  try {
    const removed = await sweepEvents(`${SLUG_PREFIX}${run}-`);
    if (removed.length) console.log(`[e2e] teardown removed ${removed.length} leftover event(s): ${removed.join(', ')}`);
  } catch (e: any) {
    console.warn(`[e2e] teardown sweep failed: ${e?.message || e}`);
  }
}
