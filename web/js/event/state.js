/**
 * In-memory state of one play-through, plus the resume snapshot kept in sessionStorage.
 *
 * Privacy: the registration form values live in memory ONLY (shared booth devices). The snapshot in
 * sessionStorage holds the game session id, its submit token (the secret that lets only this player submit it),
 * the questions (no answers) and the player's answers: no name, no email, no phone.
 */

const SNAPSHOT_VERSION = 1;
const MAX_AGE_MS = 3 * 60 * 60 * 1000; // a snapshot older than 3 h is stale

export function emptyForm() {
  return { first_name: '', last_name: '', email: '', phone_number: '', consent: false };
}

/** @returns the play-through state (reset() empties it for the next player). */
export function createState(slug) {
  const state = {
    slug,
    form: emptyForm(),   // memory only
    player: null,        // { id } once registered
    game: null,          // { id, timerSeconds, pointsCorrect, timeBonusMax, questions, answers, shown }
    results: null,       // GameComplete from the server
    resume: null,        // snapshot offered on the landing page
    reset() {
      state.form = emptyForm();
      state.player = null;
      state.game = null;
      state.results = null;
      state.resume = null;
    },
  };
  return state;
}

const key = (slug) => `quiz.session.${slug}`;

function storage() {
  try { return window.sessionStorage; } catch { return null; }
}

/** Persist the running game (never personal data). */
export function saveSnapshot(slug, game, phase = 'playing') {
  const s = storage();
  if (!s || !game) return;
  try {
    s.setItem(key(slug), JSON.stringify({
      v: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      phase,
      id: game.id,
      timerSeconds: game.timerSeconds,
      pointsCorrect: game.pointsCorrect,
      timeBonusMax: game.timeBonusMax,
      submitToken: game.submitToken || null,
      questions: game.questions,
      answers: game.answers,
      shown: game.shown ?? -1,
    }));
  } catch { /* quota or blocked: resuming is a nicety, never a requirement */ }
}

export function clearSnapshot(slug) {
  try { storage()?.removeItem(key(slug)); } catch { /* ignore */ }
}

/** @returns the stored snapshot if it is valid and fresh, else null (and it is removed). */
export function loadSnapshot(slug) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key(slug));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    const ok = snap && snap.v === SNAPSHOT_VERSION && Number.isInteger(snap.id)
      && Array.isArray(snap.questions) && snap.questions.length > 0 && Array.isArray(snap.answers)
      && Number.isFinite(snap.timerSeconds) && snap.timerSeconds > 0
      && Date.now() - (snap.savedAt || 0) < MAX_AGE_MS;
    if (!ok) { s.removeItem(key(slug)); return null; }
    return snap;
  } catch {
    try { s.removeItem(key(slug)); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Turn a snapshot into a game ready to continue. The question that was on screen when the page went away
 * counts as UNANSWERED (otherwise reloading would be a free second look at a question).
 */
export function gameFromSnapshot(snap) {
  const answers = snap.answers.filter((a) => a && Number.isInteger(a.question_id)).slice(0, snap.questions.length);
  const shown = Number.isInteger(snap.shown) ? snap.shown : -1;
  for (let i = answers.length; i <= shown && i < snap.questions.length; i++) {
    answers.push({ question_id: snap.questions[i].id, player_answer: null, time_taken: snap.timerSeconds });
  }
  return {
    id: snap.id,
    timerSeconds: snap.timerSeconds,
    pointsCorrect: snap.pointsCorrect,
    timeBonusMax: snap.timeBonusMax,
    submitToken: typeof snap.submitToken === 'string' ? snap.submitToken : null,
    questions: snap.questions,
    answers,
    shown: Math.max(shown, answers.length - 1),
    resumed: true,
  };
}

/** Number of questions already settled in a snapshot (for "question N of M" on the resume card). */
export function snapshotProgress(snap) {
  const shown = Number.isInteger(snap.shown) ? snap.shown + 1 : 0;
  return Math.min(snap.questions.length, Math.max(snap.answers.length, shown));
}
