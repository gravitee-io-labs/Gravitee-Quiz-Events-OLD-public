/**
 * config.js - runtime configuration.
 * Reads window.QUIZ_CONFIG (written by the container entrypoint into /config.js) and applies defaults.
 *
 *   window.QUIZ_CONFIG = { apiBase: "/api", publicBaseUrl: "https://quiz.events.gravitee.io" }
 */
const raw = (typeof window !== 'undefined' && window.QUIZ_CONFIG) || {};
const trimSlash = (s) => String(s).replace(/\/+$/, '');

/**
 * @typedef {Object} QuizConfig
 * @property {string} apiBase   Base URL of the REST API, no trailing slash. Default "/api" (same origin).
 * @property {string} publicBaseUrl Public origin used for links/QR codes. Default: location.origin.
 */
/** @type {QuizConfig & Record<string, any>} */
export const config = {
  ...raw,
  apiBase: trimSlash(raw.apiBase || '/api'),
  publicBaseUrl: trimSlash(raw.publicBaseUrl || (typeof location !== 'undefined' ? location.origin : '')),
};

/** Public URL of an event game page, e.g. eventUrl('ai-masters') -> https://quiz.events.gravitee.io/ai-masters */
export function eventUrl(slug, { lang } = {}) {
  const u = `${config.publicBaseUrl}/${encodeURIComponent(slug)}`;
  return lang ? `${u}?lang=${encodeURIComponent(lang)}` : u;
}

/** Public URL of an event scoreboard. */
export function scoreboardUrl(slug) {
  return `${config.publicBaseUrl}/${encodeURIComponent(slug)}/scoreboard`;
}

export default config;
