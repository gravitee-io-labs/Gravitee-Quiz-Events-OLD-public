/**
 * api.js - fetch wrapper for the Quiz REST API + resilient SSE helper.
 *
 *   import { api, ApiError, openEventSource, apiUrl } from '../shared/js/api.js';
 *   const events = await api.get('/events');
 *   const player = await api.post(`/events/${slug}/players`, { first_name: 'Ada', ... });
 *
 * - base URL from config.apiBase ("/api" by default), JSON in/out, 15 s timeout
 * - GET requests are retried with exponential backoff on network errors / 502 / 503 / 504 (never POST/PUT/PATCH/DELETE)
 * - attaches `Authorization: Bearer <token>` when localStorage "quiz.admin.token" is set (pass auth:false to skip)
 * - errors are ApiError { status, detail, fieldErrors }
 */
import { config } from './config.js';

export const TOKEN_KEY = 'quiz.admin.token';
const unauthorizedListeners = new Set();

let memToken = null;   // used only when localStorage is unavailable (private window, blocked storage): the session still works, until reload
/** @returns {string|null} stored admin JWT */
export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return memToken; } }
/** Store (or with null remove) the admin JWT. */
export function setToken(token) { memToken = token || null; try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: memory only */ } }
export function clearToken() { setToken(null); }
/** Called (once per failed request) when the API answers 401 to a request that carried a token. The token is cleared first. */
export function onUnauthorized(cb) { unauthorizedListeners.add(cb); return () => unauthorizedListeners.delete(cb); }

/**
 * Error thrown for every failed request.
 *  status        HTTP status, 0 = network error, -1 = timeout / aborted
 *  detail        human readable message from the API ({"detail": "..."}), or a generic one
 *  code          the raw detail when it is a machine code (e.g. "event_closed", "not_enough_questions")
 *  fieldErrors   {field: message} for FastAPI 422 validation errors
 */
export class ApiError extends Error {
  constructor(status, detail, { body = null, method = 'GET', url = '', code = null, fieldErrors = {}, cause } = {}) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.body = body;
    this.method = method;
    this.url = url;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
  get isNetwork() { return this.status === 0; }
  get isTimeout() { return this.status === -1; }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isConflict() { return this.status === 409; }
  get isValidation() { return this.status === 422 || this.status === 400; }
  get isServer() { return this.status >= 500; }
}

function parseDetail(status, body) {
  const d = body && typeof body === 'object' ? body.detail : undefined;
  if (typeof d === 'string') return { detail: d, code: /^[a-z0-9_]+$/.test(d) ? d : null, fieldErrors: {} };
  if (Array.isArray(d)) { // FastAPI validation errors
    const fieldErrors = {};
    for (const item of d) {
      const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body' && p !== 'query' && p !== 'path') : [];
      fieldErrors[loc.join('.') || '_'] = item.msg || 'Invalid value';
    }
    const detail = d.map((i) => `${(i.loc || []).filter((p) => p !== 'body').join('.')}: ${i.msg}`).join('; ');
    return { detail, code: null, fieldErrors };
  }
  return { detail: status === 0 ? 'Network error' : status === -1 ? 'Request timed out' : `Request failed (${status})`, code: null, fieldErrors: {} };
}

/** Build an absolute-path URL: apiUrl('/events/x/scoreboard', {limit: 10}) -> '/api/events/x/scoreboard?limit=10'. */
export function apiUrl(path = '', query) {
  const isAbsolute = /^https?:\/\//i.test(path);
  let url = isAbsolute ? path : `${config.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  return url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([502, 503, 504]);

/**
 * Low-level request.
 * @param {string} method
 * @param {string} path
 * @param {object} [opts]
 * @param {object} [opts.query] query string params (undefined/null/'' skipped)
 * @param {*}      [opts.body] object -> JSON; FormData/Blob/string sent as is
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeout=15000] ms
 * @param {number} [opts.retries] extra attempts (default 2 for GET, 0 otherwise)
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.auth=true] attach the admin Bearer token when present
 * @param {boolean} [opts.raw=false] resolve with the Response instead of parsed JSON
 * @returns {Promise<any>}
 */
export async function request(method, path, { query, body, headers = {}, timeout = 15000, retries, signal, auth = true, raw = false } = {}) {
  method = method.toUpperCase();
  const url = apiUrl(path, query);
  const maxRetries = retries ?? (method === 'GET' ? 2 : 0);
  const init = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
  const token = auth ? getToken() : null;
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) {
    if (body instanceof FormData || body instanceof Blob || typeof body === 'string' || body instanceof ArrayBuffer) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
    if (signal?.aborted) throw new ApiError(-1, 'Request aborted', { method, url });
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (raw && res.ok) return res;
      const ct = res.headers.get('content-type') || '';
      const parsed = res.status === 204 ? null : ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
      if (!res.ok) {
        const { detail, code, fieldErrors } = parseDetail(res.status, parsed);
        const err = new ApiError(res.status, detail, { body: parsed, method, url, code, fieldErrors });
        if (RETRY_STATUS.has(res.status) && attempt < maxRetries) { lastError = err; continue; }
        if (res.status === 401 && token) { clearToken(); unauthorizedListeners.forEach((cb) => { try { cb(err); } catch (e) { console.error(e); } }); }
        throw err;
      }
      return parsed;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const err = timedOut ? new ApiError(-1, 'Request timed out', { method, url, cause: e })
        : signal?.aborted ? new ApiError(-1, 'Request aborted', { method, url, cause: e })
          : new ApiError(0, 'Network error', { method, url, cause: e });
      if (attempt < maxRetries && !signal?.aborted) { lastError = err; continue; }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

/**
 * Download a protected file (CSV / JSON export) with the Bearer token and save it.
 * @returns {Promise<string>} the filename used
 */
async function download(path, { query, filename, signal } = {}) {
  const res = await request('GET', path, { query, raw: true, signal, timeout: 60000 });
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = filename || (m && decodeURIComponent(m[1])) || 'download';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  return name;
}

/** The API client. Every method returns parsed JSON (or null for 204) and throws ApiError. */
export const api = {
  request,
  url: apiUrl,
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, opts),
  /** multipart upload: api.upload('/admin/events/1/questions/import-csv', file, {query:{dry_run:true}}) */
  upload: (path, file, { field = 'file', query, ...opts } = {}) => {
    const fd = new FormData();
    fd.append(field, file);
    return request('POST', path, { ...opts, query, body: fd, timeout: 60000 });
  },
  download,
};

// -------------------------------------------------------------------------------------------------
// Server-Sent Events with automatic reconnect (exponential backoff + jitter)
// -------------------------------------------------------------------------------------------------
/**
 * Open an SSE stream that survives network drops, proxy timeouts and server restarts.
 *
 * @param {string} url full URL (use apiUrl('/events/ai-masters/scoreboard/stream', {limit: 10}))
 * @param {object} handlers
 * @param {(data:any, event:MessageEvent)=>void} handlers.onMessage called per message (JSON parsed unless json:false)
 * @param {(status:'connecting'|'open'|'reconnecting'|'closed', info?:{attempt:number, delay:number})=>void} [handlers.onStatus]
 * @param {(err:Error)=>void} [handlers.onError] JSON parse errors etc.
 * @param {boolean} [handlers.json=true]
 * @param {number} [handlers.minDelay=1000] first reconnect delay (ms)
 * @param {number} [handlers.maxDelay=30000]
 * @param {number} [handlers.staleAfter=0] ms without any message after which the stream is silently re-opened (0 = off).
 *        A half-open connection (Wi-Fi roaming, laptop sleep) never raises `error`: set e.g. 45000 on a TV scoreboard.
 *        The server sends a full snapshot on every connect, so a refresh is harmless and invisible (status stays 'open').
 * @returns {{close():void, reconnect():void, readonly status:string, readonly attempts:number}}
 */
export function openEventSource(url, { onMessage, onStatus, onError, json = true, minDelay = 1000, maxDelay = 30000, staleAfter = 0 } = {}) {
  let source = null, timer = null, attempts = 0, closed = false, status = 'connecting', lastSeen = Date.now(), watchdog = null;
  const setStatus = (s, info) => { status = s; try { onStatus?.(s, info); } catch (e) { console.error(e); } };

  function connect(quiet = false) {
    clearTimeout(timer); timer = null;
    if (closed) return;
    lastSeen = Date.now();
    if (!quiet) setStatus(attempts ? 'reconnecting' : 'connecting', attempts ? { attempt: attempts, delay: 0 } : undefined);
    try { source = new EventSource(url); } catch (e) { onError?.(e); schedule(); return; }
    source.onopen = () => { attempts = 0; setStatus('open'); };
    source.onmessage = (event) => {
      lastSeen = Date.now();
      let data = event.data;
      if (json) { try { data = JSON.parse(event.data); } catch (e) { onError?.(e); return; } }
      try { onMessage?.(data, event); } catch (e) { console.error(e); }
    };
    source.onerror = () => { source?.close(); source = null; schedule(); };
  }
  function schedule() {
    if (closed) return;
    attempts += 1;
    const delay = Math.round(Math.min(maxDelay, minDelay * 2 ** (attempts - 1)) * (0.8 + Math.random() * 0.4));
    setStatus('reconnecting', { attempt: attempts, delay });
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
  }
  const wake = () => { if (!closed && status !== 'open') { source?.close(); source = null; attempts = 0; connect(); } };
  if (staleAfter > 0) {
    watchdog = setInterval(() => {
      if (closed || status !== 'open' || Date.now() - lastSeen < staleAfter) return;
      source?.close(); source = null; connect(true);   // quiet: the UI keeps showing 'open'; a failure goes through the normal reconnect path
    }, Math.max(20, Math.round(staleAfter / 3)));
  }
  const onVisible = () => { if (document.visibilityState === 'visible') wake(); };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', onVisible);
  connect();

  return {
    close() {
      closed = true; clearTimeout(timer); clearInterval(watchdog); source?.close(); source = null;
      window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', onVisible);
      setStatus('closed');
    },
    reconnect() { source?.close(); source = null; attempts = 0; connect(); },
    get status() { return status; },
    get attempts() { return attempts; },
  };
}
