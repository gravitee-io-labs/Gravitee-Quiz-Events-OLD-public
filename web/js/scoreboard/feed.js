/**
 * feed.js - live data source of the scoreboard.
 *
 * Primary transport: Server-Sent Events (shared/js/api.js openEventSource: reconnects forever with backoff).
 * Fallback: polling GET /events/{slug}/scoreboard (+ GET /events/{slug} for the counters) every 5 s, started as soon
 * as the stream cannot be opened (blocked by a proxy, server restarting, flaky Wi-Fi) and stopped when it comes back.
 * While the stream is healthy a slow "safety" poll (30 s) still runs: it costs nothing and heals a half-open
 * connection that stops delivering without ever raising an error.
 *
 * transport: 'connecting' | 'sse' | 'poll' | 'offline'
 * onData({ entries, totalPlayers, totalGames, source:'sse'|'poll' })   (totals are null when the source cannot tell)
 *
 * Totals: the stream sends "distinct players with a completed game" and "completed games". GET /events/{slug} only
 * knows "registered players" (it includes people still answering), so a poll must NOT overwrite the stream's totals:
 * the safety poll that runs next to a healthy stream only refreshes the rows (totals null), and the fallback poll
 * (stream down) uses min(registered players, completed games), which is exactly the stream's number as long as
 * every player plays once.
 */
import { api, apiUrl, openEventSource } from '/shared/js/api.js';

export const POLL_MS = 5000;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;   // LRE RLE PDF LRO RLO, LRI RLI FSI PDI (LRM / RLM / ALM stay: real RTL names use them)
const SAFETY_POLL_MS = 30000;
const STALE_GRACE_MS = 4000;     // a poll that differs from the stream's last snapshot only proves the stream is stale after this long
/** id / rank / score of every row: the part of a snapshot that decides what the board shows (timestamps may be formatted differently by the two endpoints). */
const keyOf = (entries) => entries.map((e) => `${e.id}:${e.rank}:${e.score}`).join(',');
const SSE_OPEN_TIMEOUT_MS = 7000;

/**
 * @param {{slug:string, limit:number, onData:Function, onTransport:Function, stream?:boolean}} cfg
 *   stream: false = polling only (an admin previewing a draft: EventSource cannot send the Authorization header, the
 *   stream would answer 404 forever)
 */
export function createFeed({ slug, limit, onData, onTransport, stream = true }) {
  let sse = null;
  let transport = 'connecting';
  let closed = false;
  let pollTimer = null;
  let safetyTimer = null;
  let openTimer = null;
  let inFlight = false;
  let lastSseAt = 0;
  let lastSseKey = '';
  let sseOpen = false;

  const setTransport = (next) => {
    if (next === transport) return;
    transport = next;
    try { onTransport?.(next); } catch (e) { console.error(e); }
  };

  const emit = (entries, totalPlayers, totalGames, source) => {
    if (!Array.isArray(entries)) return;
    const num = (v) => (v === null || v === undefined ? null : Number(v) || 0);
    // names come from the public registration form: drop the bidi override / embedding / isolate characters (a name that starts with
    // U+202E would display its own letters reversed and could reorder the text around it on the big screen)
    const clean = (e) => (e && typeof e.player_name === 'string' ? { ...e, player_name: e.player_name.replace(BIDI_CONTROLS, '') } : e);
    try { onData?.({ entries: entries.map(clean), totalPlayers: num(totalPlayers), totalGames: num(totalGames), source }); } catch (e) { console.error(e); }
  };

  async function pollOnce({ safety = false } = {}) {
    if (closed || inFlight) return;
    inFlight = true;
    const startedAt = Date.now();
    try {
      const opts = { retries: 0, timeout: 8000 };
      const withStats = !sseOpen;                 // beside a healthy stream the rows are enough (the stream owns the totals)
      const [entries, event] = await Promise.all([
        api.get(`/events/${encodeURIComponent(slug)}/scoreboard`, { ...opts, query: { limit } }),
        withStats ? api.get(`/events/${encodeURIComponent(slug)}`, opts) : Promise.resolve(null),
      ]);
      if (closed) return;
      // a stream message newer than this request wins: never roll the board back with an older snapshot
      if (lastSseAt > startedAt) return;
      // half-open stream (Wi-Fi roaming, laptop sleep, proxy that swallowed the connection): the board is healed from
      // this poll AND the stream is reopened (a stream message later than STALE_GRACE_MS would already have shown it)
      if (sseOpen && Date.now() - lastSseAt > STALE_GRACE_MS && keyOf(entries) !== lastSseKey) sse?.reconnect();
      if (event) {
        const games = Number(event.stats?.games_completed) || 0;
        const players = Math.min(Number(event.stats?.players) || 0, games);
        emit(entries, players, games, 'poll');
      } else emit(entries, null, null, 'poll');
      if (!sseOpen) setTransport('poll');
    } catch (e) {
      if (!safety && !sseOpen && !closed) setTransport('offline');
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer || closed) return;
    pollOnce();
    pollTimer = setInterval(() => pollOnce(), POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function start() {
    if (!stream) { startPolling(); return; }
    // the stream never opened within a few seconds: do not stay blank, poll meanwhile
    openTimer = setTimeout(() => { if (!sseOpen) startPolling(); }, SSE_OPEN_TIMEOUT_MS);
    sse = openEventSource(apiUrl(`/events/${encodeURIComponent(slug)}/scoreboard/stream`, { limit }), {
      onMessage(data) {
        lastSseAt = Date.now();
        if (Array.isArray(data?.entries)) lastSseKey = keyOf(data.entries);
        emit(data?.entries, data?.total_players, data?.total_games, 'sse');
      },
      onStatus(status) {
        if (status === 'open') {
          sseOpen = true;
          clearTimeout(openTimer);
          stopPolling();
          setTransport('sse');
        } else if (status === 'reconnecting') {
          sseOpen = false;
          startPolling();
        }
      },
    });
    safetyTimer = setInterval(() => { if (sseOpen) pollOnce({ safety: true }); }, SAFETY_POLL_MS);
  }

  const onVisible = () => { if (document.visibilityState === 'visible' && !sseOpen) pollOnce(); };
  document.addEventListener('visibilitychange', onVisible);
  start();

  return {
    get transport() { return transport; },
    refresh() { return pollOnce({ safety: true }); },
    close() {
      closed = true;
      clearTimeout(openTimer); clearInterval(safetyTimer); stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
      sse?.close();
    },
  };
}
