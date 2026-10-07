/**
 * Thin REST client for the quiz backend (through the gateway, same origin as the apps).
 * Used by the fixtures to create / delete events and by tests that need a finished game without clicking through it.
 * Pure Node (global fetch): no Playwright dependency, so it also runs in global setup / teardown.
 */
export const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
export const API = `${BASE_URL}/api`;
export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

/** Every event the suite creates starts with this prefix, then the run id: the sweeper only ever touches these. */
export const SLUG_PREFIX = 'qa-e2e-';

export class HttpError extends Error {
  constructor(public status: number, public body: any, message: string) {
    super(message);
  }
}

export interface CallOpts {
  token?: string | null;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** return {status, body} instead of throwing on non-2xx */
  raw?: boolean;
}

export async function call(method: string, path: string, body?: unknown, opts: CallOpts = {}): Promise<any> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text (csv) */ }
  if (opts.raw) return { status: res.status, body: data, headers: res.headers };
  if (!res.ok) throw new HttpError(res.status, data, `${method} ${path} -> ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

export async function login(username = ADMIN_USER, password = ADMIN_PASSWORD): Promise<string> {
  const res = await call('POST', '/auth/login', { username, password });
  return res.access_token as string;
}

let cachedToken: string | null = null;
/** One admin token per process (global setup exports it to the workers through E2E_ADMIN_TOKEN). */
export async function adminToken(): Promise<string> {
  if (process.env.E2E_ADMIN_TOKEN) return process.env.E2E_ADMIN_TOKEN;
  if (!cachedToken) cachedToken = await login();
  return cachedToken;
}

/** Authenticated admin calls. */
export const admin = {
  get: async (path: string, opts: CallOpts = {}) => call('GET', path, undefined, { ...opts, token: await adminToken() }),
  post: async (path: string, body?: unknown, opts: CallOpts = {}) => call('POST', path, body ?? {}, { ...opts, token: await adminToken() }),
  put: async (path: string, body?: unknown, opts: CallOpts = {}) => call('PUT', path, body ?? {}, { ...opts, token: await adminToken() }),
  patch: async (path: string, body?: unknown, opts: CallOpts = {}) => call('PATCH', path, body ?? {}, { ...opts, token: await adminToken() }),
  del: async (path: string, opts: CallOpts = {}) => call('DELETE', path, undefined, { ...opts, token: await adminToken() }),
};

// ---------------------------------------------------------------------------------------------
// players / games (the public API, exactly what the web app calls)
// ---------------------------------------------------------------------------------------------
export interface PlayerInput {
  first_name: string;
  last_name: string;
  email?: string;
  phone_number?: string;
  consent?: boolean;
}

let seq = 0;
export const uniqueEmail = (tag = 'p') => `${tag}.${Date.now().toString(36)}${(seq++).toString(36)}@e2e.example.com`;

export async function registerPlayer(slug: string, p: PlayerInput, opts: CallOpts = {}) {
  return call('POST', `/events/${slug}/players`, { email: uniqueEmail(), ...p }, opts);
}

export async function startGame(slug: string, playerId: number, opts: CallOpts = {}) {
  return call('POST', `/events/${slug}/games`, { player_id: playerId }, opts);
}

export interface PlayOpts extends PlayerInput {
  /** how many of the questions are answered "green" (the fixtures make green the right answer); the rest are answered red */
  green?: number;
  /** questions left unanswered (null) after the green and red ones */
  skip?: number;
  /** seconds taken per answer (default 1) */
  seconds?: number;
}

/** Register + start + submit a whole game through the API. Returns the GameComplete payload plus the player. */
export async function playViaApi(slug: string, p: PlayOpts) {
  const player = await registerPlayer(slug, p);
  const game = await startGame(slug, player.id);
  const n = game.questions.length;
  const green = Math.min(p.green ?? n, n);
  const skip = Math.min(p.skip ?? 0, n - green);
  const answers = game.questions.map((q: any, i: number) => ({
    question_id: q.id,
    player_answer: i < green ? 'green' : i < n - skip ? 'red' : null,
    time_taken: p.seconds ?? 1,
  }));
  const result = await call('POST', `/events/${slug}/games/${game.game_session_id}/submit`, { answers, submit_token: game.submit_token });
  return { player, game, result };
}

/** Public scoreboard rows. */
export const scoreboard = (slug: string, limit = 10) => call('GET', `/events/${slug}/scoreboard`, undefined, { query: { limit } });

/** Delete one event (cascade). Never throws: cleanup must not mask the test result. */
export async function deleteEventBySlug(slug: string): Promise<boolean> {
  try {
    const list = await admin.get('/admin/events');
    const found = list.find((e: any) => e.slug === slug);
    if (!found) return false;
    await admin.del(`/admin/events/${found.id}`, { query: { confirm: slug } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete every event of this suite whose slug starts with `prefix` (default: all runs).
 * `olderThanMs` keeps the events of a run that is still in progress (two runs may share one stack).
 */
export async function sweepEvents(prefix = SLUG_PREFIX, opts: { olderThanMs?: number } = {}): Promise<string[]> {
  const removed: string[] = [];
  const list: any[] = await admin.get('/admin/events');
  const now = Date.now();
  for (const e of list) {
    if (typeof e.slug !== 'string' || !e.slug.startsWith(prefix)) continue;
    if (opts.olderThanMs && now - Date.parse(e.created_at) < opts.olderThanMs) continue;
    try {
      await admin.del(`/admin/events/${e.id}`, { query: { confirm: e.slug } });
      removed.push(e.slug);
    } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Read the first message of the scoreboard SSE stream (what a TV receives on connect) and hang up.
 * Returns the raw event text and the parsed JSON payload.
 */
export async function readSseSnapshot(slug: string, limit = 10, token?: string | null): Promise<{ raw: string; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${API}/events/${slug}/scoreboard/stream?limit=${limit}`, {
      headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new HttpError(res.status, await res.text(), `SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const m = raw.match(/(?:^|\n)data: (.*)\n\n/);
      if (m) return { raw, data: JSON.parse(m[1]) };
    }
    throw new Error(`SSE ended without a data message: ${raw}`);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}
