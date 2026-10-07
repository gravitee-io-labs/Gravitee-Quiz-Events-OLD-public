/**
 * Settings tab: game rules, scoring, category mix, registration fields, languages and event status.
 *
 * Everything is one draft (see fromEvent) compared with the saved event: Save sends only what changed (PUT is a partial update),
 * Reset restores the saved values, ctx.setDirty() arms the shell's "unsaved changes" guard.
 * Contract: docs/ARCHITECTURE.md sections 3, 4 (selection + scoring), 5.3 and the admin view contract.
 */
import { api as sharedApi } from '../../shared/js/api.js';
import { el, icon, hydrateIcons, uid, clamp, formatNumber, setBusy } from '../../shared/js/dom.js';
import { announce } from '../../shared/js/ui.js';

const LANG = 'en';
const fmtN = (n) => formatNumber(n, { lang: LANG });
const LANGS = [['en', 'English'], ['fr', 'Français']];
const STATUS = {
  draft: { label: 'Draft', icon: 'eye-slash', text: 'Hidden from the hub. Players cannot open it; you can preview it while signed in as admin.' },
  live: { label: 'Live', icon: 'play', text: 'Listed on the hub. Players can register, play and appear on the scoreboard.' },
  closed: { label: 'Closed', icon: 'lock', text: 'Not listed and not playable: registration and new games are refused. The scoreboard stays visible.' },
};
const NUM_FIELDS = {
  questions_per_game: { label: 'Questions per game', min: 1, max: 50 },
  timer_seconds: { label: 'Seconds per question', min: 5, max: 120 },
  points_correct: { label: 'Points for a correct answer', min: 0, max: 100000 },
  points_wrong: { label: 'Points for a wrong answer', min: 0, max: 100000 },
  time_bonus_max: { label: 'Maximum time bonus', min: 0, max: 100000 },
};
const SETTING_KEYS = ['questions_per_game', 'timer_seconds', 'points_correct', 'points_wrong', 'time_bonus_max', 'question_order', 'collect_phone'];
const CONSENT_MAX = 2000;

// ---------------------------------------------------------------------------------------------
// pure helpers (selection preview mirrors backend/app/services/selection.py)
// ---------------------------------------------------------------------------------------------
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const num = (raw) => { if (raw === '' || raw === null || raw === undefined) return null; const n = Number(raw); return Number.isFinite(n) ? n : null; };

function errorText(e) {
  if (!e) return 'Something went wrong';
  if (e.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
  if (e.isTimeout) return 'The server took too long to answer.';
  return typeof e.detail === 'string' && e.detail ? e.detail : e.message || 'Something went wrong';
}

/** Weights summing to exactly 100 (largest remainder), used to seed the editor. */
function equalWeights(ids) {
  if (!ids.length) return {};
  const base = Math.floor(100 / ids.length);
  let extra = 100 - base * ids.length;
  const out = {};
  ids.forEach((id) => { out[id] = base + (extra-- > 0 ? 1 : 0); });
  return out;
}

/** Small seeded generator: the preview shows stable numbers (no flicker between keystrokes). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Port of selection.largest_remainder (integer weights: exact remainders, random tie-break). */
function largestRemainder(total, weights, rng) {
  const keys = Object.keys(weights);
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  const counts = {}, rem = {};
  for (const k of keys) { counts[k] = Math.floor((total * weights[k]) / sum); rem[k] = (total * weights[k]) % sum; }
  let leftover = total - keys.reduce((a, k) => a + counts[k], 0);
  if (leftover > 0) {
    const order = keys.map((k) => [rng(), k]).sort((x, y) => x[0] - y[0]).map(([, k]) => k); // shuffle, then a stable sort on the remainder
    order.sort((x, y) => rem[y] - rem[x]);
    for (const k of order.slice(0, leftover)) counts[k] += 1;
  }
  return counts;
}

/** Port of selection.allocate_counts: weights, capacities and shortfall redistribution. */
function allocateCounts(total, weights, caps, rng) {
  const counts = {};
  Object.keys(weights).forEach((k) => { counts[k] = 0; });
  let remaining = total;
  let live = {};
  Object.keys(weights).forEach((k) => { if (weights[k] > 0 && (caps[k] || 0) > 0) live[k] = weights[k]; });
  while (remaining > 0 && Object.keys(live).length) {
    const quotas = largestRemainder(remaining, live, rng);
    let given = 0;
    for (const [k, q] of Object.entries(quotas)) { const take = Math.min(q, caps[k] - counts[k]); counts[k] += take; given += take; }
    remaining -= given;
    const next = {};
    Object.keys(live).forEach((k) => { if (counts[k] < caps[k]) next[k] = live[k]; });
    live = next;
    if (given === 0) break;
  }
  return { counts, remaining };
}

/**
 * What a player gets, per category: `lo..hi` questions (the remainders are spread at random from one game to the next, so the
 * range is measured over 80 simulated games with the same rules as the backend) and `short` when the category cannot supply its
 * proportional share. `filler` = questions taken from categories without weight / uncategorised questions.
 */
function previewMix(total, weights, caps) {
  const ids = Object.keys(weights).filter((id) => weights[id] > 0 && (caps[id] || 0) > 0);
  const per = {};
  ids.forEach((id) => { per[id] = { lo: Infinity, hi: 0, short: false }; });
  let missing = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const { counts, remaining } = allocateCounts(total, weights, caps, mulberry32(seed));
    missing = remaining;
    ids.forEach((id) => { per[id].lo = Math.min(per[id].lo, counts[id]); per[id].hi = Math.max(per[id].hi, counts[id]); });
  }
  const sum = ids.reduce((a, id) => a + weights[id], 0);
  ids.forEach((id) => { per[id].short = (total * weights[id]) / sum > caps[id] + 1e-9; });
  return { per, filler: missing };
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'sliders-horizontal',

  async mount(root, ctx) {
    const api = ctx.api || sharedApi;
    const eventId = ctx.eventId;
    let alive = true;
    let cats = null;          // [{id,name,color,is_active,question_count}] or null when it could not be loaded
    let caps = {};            // category id -> active questions
    let uncategorised = 0;    // active questions without category
    let poolError = null;
    let baseline = null;      // draft built from the saved event
    let draft = null;
    let dirty = false;
    let saving = false;
    let submitted = false;
    const touched = new Set();
    const serverErrors = {};  // key -> message from a 422, kept until the field is edited again
    const fields = {};        // key -> { setError(msg), focus() }
    const disposers = [];

    root.replaceChildren(el('div', { class: 'stack', 'aria-busy': 'true', 'aria-label': 'Loading settings' },
      el('span', { class: 'skeleton skeleton--card', style: { blockSize: '9rem' } }), el('span', { class: 'skeleton skeleton--card', style: { blockSize: '14rem' } }), el('span', { class: 'skeleton skeleton--card', style: { blockSize: '10rem' } })));

    // ------------------------------------------------------------------------------------------
    // data: categories + active question counts (to preview the category mix)
    // ------------------------------------------------------------------------------------------
    async function loadPool() {
      try {
        const list = await api.get(`/admin/events/${eventId}/categories`);
        const active = list.filter((c) => c.is_active);
        const totals = await Promise.all([
          ...active.map((c) => api.get(`/admin/events/${eventId}/questions`, { query: { category_id: c.id, limit: 1 } }).then((r) => r.total)),
          api.get(`/admin/events/${eventId}/questions`, { query: { category_id: 0, limit: 1 } }).then((r) => r.total),
        ]);
        cats = list;
        caps = {};
        active.forEach((c, i) => { caps[String(c.id)] = totals[i]; });
        uncategorised = totals[totals.length - 1];
        poolError = null;
      } catch (e) {
        poolError = e;
      }
    }
    await loadPool();
    if (!alive) return { unmount() {} };

    const activeCats = () => (cats || []).filter((c) => c.is_active);
    const poolSize = () => Object.values(caps).reduce((a, b) => a + b, 0) + uncategorised;

    // ------------------------------------------------------------------------------------------
    // draft model
    // ------------------------------------------------------------------------------------------
    function fromEvent(ev) {
      const s = ev.settings || {};
      const dist = s.category_distribution && Object.keys(s.category_distribution).length ? s.category_distribution : null;
      const weights = {};
      if (dist) activeCats().forEach((c) => { weights[String(c.id)] = Number(dist[String(c.id)] || 0); });
      return {
        status: ev.status,
        questions_per_game: s.questions_per_game, timer_seconds: s.timer_seconds,
        points_correct: s.points_correct, points_wrong: s.points_wrong, time_bonus_max: s.time_bonus_max,
        question_order: s.question_order, collect_phone: s.collect_phone,
        consent_text_en: s.consent_text_en || '', consent_text_fr: s.consent_text_fr || '',
        equal: !dist, weights, rawDist: dist,
        languages: [...ev.languages], default_language: ev.default_language,
      };
    }

    /** The category_distribution that would be saved: null (equal split) or {id: weight} of active categories with weight > 0. */
    function distOf(d) {
      if (d.equal) return null;
      if (!cats) return d.rawDist || null; // categories unknown: leave the saved value alone
      const out = {};
      activeCats().forEach((c) => { const w = Number(d.weights[String(c.id)] || 0); if (w > 0) out[String(c.id)] = w; });
      return Object.keys(out).length ? out : null;
    }
    const distSig = (d) => JSON.stringify(Object.entries(distOf(d) || {}).sort(([a], [b]) => Number(a) - Number(b)));
    const orderedLangs = (arr) => LANGS.map(([c]) => c).filter((c) => arr.includes(c));

    function buildPatch(d, b) {
      const patch = {};
      const settings = {};
      for (const k of SETTING_KEYS) if (d[k] !== b[k]) settings[k] = d[k];
      for (const k of ['consent_text_en', 'consent_text_fr']) if (d[k].trim() !== b[k].trim()) settings[k] = d[k].trim() || null;
      if (distSig(d) !== distSig(b)) settings.category_distribution = distOf(d);
      if (Object.keys(settings).length) patch.settings = settings;
      if (d.status !== b.status) patch.status = d.status;
      if (orderedLangs(d.languages).join() !== orderedLangs(b.languages).join() || d.default_language !== b.default_language) {
        patch.languages = orderedLangs(d.languages);
        patch.default_language = d.default_language;
      }
      return patch;
    }

    function validate(d) {
      const errors = {};
      for (const [k, spec] of Object.entries(NUM_FIELDS)) {
        const v = d[k];
        if (v === null || v === undefined) errors[k] = 'Enter a number.';
        else if (!isInt(v)) errors[k] = 'Enter a whole number.';
        else if (v < spec.min || v > spec.max) errors[k] = `Must be between ${fmtN(spec.min)} and ${fmtN(spec.max)}.`;
      }
      if (!d.languages.length) errors.languages = 'Keep at least one language enabled.';
      else if (!d.languages.includes(d.default_language)) errors.default_language = 'The default language must be one of the enabled languages.';
      for (const k of ['consent_text_en', 'consent_text_fr']) if (d[k].length > CONSENT_MAX) errors[k] = `At most ${fmtN(CONSENT_MAX)} characters (currently ${fmtN(d[k].length)}).`;
      if (!d.equal && cats) {
        const ac = activeCats();
        let any = false;
        for (const c of ac) {
          const w = d.weights[String(c.id)];
          if (w !== undefined && w !== null && (!isInt(w) || w < 0 || w > 1000)) errors[`w:${c.id}`] = 'Whole number from 0 to 1000.';
          else if (w > 0) any = true;
        }
        if (ac.length && !any) errors.distribution = 'Give at least one category a weight above 0, or switch back to an equal split.';
      }
      return errors;
    }

    // ------------------------------------------------------------------------------------------
    // small UI builders
    // ------------------------------------------------------------------------------------------
    function fieldShell(key, { label, help, optional, full }) {
      const id = uid(`st-${key}`);
      const errId = `${id}-err`;
      const helpId = `${id}-help`;
      const err = el('p', { class: 'field__error', id: errId, hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'st-err-text' }));
      const helpEl = help ? el('p', { class: 'field__help', id: helpId }, help) : null;
      const node = el('div', { class: ['field', full && 'field--full'] }, label ? el('label', { class: 'field__label', for: id }, label, optional ? el('span', { class: 'field__optional' }, optional) : null) : null);
      return { id, errId, helpId, err, helpEl, node, describedBy: [help ? helpId : null, errId].filter(Boolean).join(' ') };
    }
    function bindError(key, shell, controls) {
      fields[key] = {
        setError(msg) {
          shell.err.hidden = !msg;
          shell.err.querySelector('.st-err-text').textContent = msg || '';
          shell.node.classList.toggle('field--invalid', !!msg);
          controls.forEach((c) => c.setAttribute('aria-invalid', String(!!msg)));
        },
        focus() { controls[0]?.focus(); },
      };
    }

    const paint = (r) => { const min = +r.min || 0, max = +r.max || 100; r.style.setProperty('--p', String(((+r.value - min) / (max - min)) * 100)); };

    /** slider + number box for one integer setting */
    function rangeNumber(key, { help, unit, sliderMax }) {
      const spec = NUM_FIELDS[key];
      const shell = fieldShell(key, { label: spec.label, help, full: false });
      const numInput = el('input', { class: 'input u-tabular', id: shell.id, type: 'number', inputmode: 'numeric', min: spec.min, max: spec.max, step: 1, 'aria-describedby': shell.describedBy });
      const range = el('input', { class: 'range', type: 'range', min: spec.min, max: sliderMax || spec.max, step: 1, 'aria-label': `${spec.label}, slider`, tabindex: '-1' });
      shell.node.append(...[
        el('div', { class: 'st-rangerow' }, range, el('div', { class: 'st-numwrap' }, numInput, unit ? el('span', { class: 'st-unit', 'aria-hidden': 'true' }, unit) : null)),
        shell.helpEl, shell.err].filter(Boolean));
      numInput.addEventListener('input', () => { draft[key] = num(numInput.value); syncRange(); changed(key); });
      range.addEventListener('input', () => { draft[key] = Number(range.value); numInput.value = range.value; changed(key); });
      numInput.addEventListener('blur', () => { touched.add(key); refreshErrors(); });
      function syncRange() { const v = draft[key]; range.value = v === null ? spec.min : clamp(v, +range.min, +range.max); paint(range); }
      bindError(key, shell, [numInput]);
      return { node: shell.node, sync() { numInput.value = draft[key] === null ? '' : String(draft[key]); syncRange(); } };
    }

    function plainNumber(key, { help }) {
      const spec = NUM_FIELDS[key];
      const shell = fieldShell(key, { label: spec.label, help });
      const input = el('input', { class: 'input u-tabular', id: shell.id, type: 'number', inputmode: 'numeric', min: spec.min, max: spec.max, step: 1, 'aria-describedby': shell.describedBy });
      shell.node.append(...[input, shell.helpEl, shell.err].filter(Boolean));
      input.addEventListener('input', () => { draft[key] = num(input.value); changed(key); });
      input.addEventListener('blur', () => { touched.add(key); refreshErrors(); });
      bindError(key, shell, [input]);
      return { node: shell.node, sync() { input.value = draft[key] === null ? '' : String(draft[key]); } };
    }

    /** radio group rendered as a segmented control */
    function segmented(key, { label, options, block = true, help, brand = false }) {
      const name = uid(`st-${key}`);
      const labelId = `${name}-label`;
      const helpId = `${name}-help`;
      const err = el('p', { class: 'field__error', hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'st-err-text' }));
      const inputs = options.map(([value, text, ic]) => el('input', { type: 'radio', name, value }));
      const group = el('div', { class: ['segmented', block && 'segmented--block', brand && 'segmented--brand'], role: 'radiogroup', 'aria-labelledby': labelId, 'aria-describedby': help ? helpId : null },
        ...options.map(([value, text, ic], i) => el('label', null, inputs[i], el('span', null, ic ? icon(ic) : null, text))));
      const helpEl = el('p', { class: 'field__help', id: helpId });
      const node = el('div', { class: 'field' }, el('span', { class: 'field__label', id: labelId }, label), group, helpEl, err);
      group.addEventListener('change', (e) => { if (e.target.name === name) { draft[key] = e.target.value; changed(key); } });
      bindError(key, { err, node }, inputs);
      return { node, helpEl, sync() { inputs.forEach((i) => { i.checked = i.value === draft[key]; }); } };
    }

    function card(titleText, sub, ic, ...children) {
      const titleId = uid('st-card');
      return el('section', { class: 'card st-card stack', 'aria-labelledby': titleId },
        el('header', { class: 'st-card__head' }, el('span', { class: 'st-card__icon' }, icon(ic)), el('div', null, el('h2', { class: 'card__title', id: titleId }, titleText), sub ? el('p', { class: 'card__sub' }, sub) : null)),
        ...children);
    }

    // ------------------------------------------------------------------------------------------
    // 1. status
    // ------------------------------------------------------------------------------------------
    const statusSeg = segmented('status', { label: 'Status', brand: true, options: Object.entries(STATUS).map(([v, s]) => [v, s.label, s.icon]) });
    const statusLinks = el('div', { class: 'cluster st-links' });
    const statusAlert = el('div', { class: 'st-alerts stack stack--sm' });
    const statusCard = card('Event status', 'Controls whether players can find and play this event.', 'megaphone',
      statusSeg.node, statusAlert, statusLinks);

    // ------------------------------------------------------------------------------------------
    // 2. game rules
    // ------------------------------------------------------------------------------------------
    const fQuestions = rangeNumber('questions_per_game', { help: 'How many questions each player answers in one game (1 to 50).' });
    const fTimer = rangeNumber('timer_seconds', { unit: 's', help: 'Time to answer each question (5 to 120 seconds).' });
    const fOrder = segmented('question_order', {
      label: 'Question order', block: false,
      options: [['random', 'Random', 'sparkle'], ['easy_to_hard', 'Easy to hard', 'chart-line-up']],
    });
    const orderHelp = fOrder.helpEl;
    const durationHint = el('p', { class: 'st-hint' });
    const rulesCard = card('Game rules', 'The shape of one game.', 'gear-six',
      el('div', { class: 'form-grid st-grid-2' }, fQuestions.node, fTimer.node), fOrder.node, durationHint);

    // ------------------------------------------------------------------------------------------
    // 3. scoring + live example
    // ------------------------------------------------------------------------------------------
    const fCorrect = plainNumber('points_correct', { help: 'Base points for a right answer.' });
    const fWrong = plainNumber('points_wrong', { help: 'Points for a wrong answer (never negative).' });
    const fBonus = plainNumber('time_bonus_max', { help: 'Extra points for answering instantly, shrinking to 0 at the buzzer.' });
    const simId = uid('st-sim');
    const simRange = el('input', { class: 'range', type: 'range', min: 0, max: 20, step: 1, value: 5, id: simId, 'aria-describedby': `${simId}-out` });
    const simOut = el('div', { class: 'st-sim__out', id: `${simId}-out`, role: 'status', 'aria-live': 'polite' });
    const simTime = el('output', { class: 'st-sim__time', for: simId });
        const simGame = el('p', { class: 'st-hint st-sim__game' });
    const simulator = el('div', { class: 'st-sim' },
      el('h3', { class: 'st-sim__title' }, icon('lightning'), 'How a score is computed'),
      el('p', { class: 'st-sim__formula' }, el('strong', null, 'Correct'), ' = base points + time bonus. ', el('strong', null, 'Time bonus'), ' = max bonus × (1 − time taken ÷ seconds per question), rounded down. ',
        el('strong', null, 'Wrong'), ' = the points above, ', el('strong', null, 'no answer'), ' = 0.'),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: simId }, 'Try it: a player answers after ', simTime), simRange),
      simOut, simGame);
    simRange.addEventListener('input', () => { paint(simRange); renderSim(); });
    const scoringCard = card('Scoring', 'Points are computed on the server when a game is submitted.', 'target',
      el('div', { class: 'form-grid st-grid-3' }, fCorrect.node, fWrong.node, fBonus.node), simulator);

    // ------------------------------------------------------------------------------------------
    // 4. category mix
    // ------------------------------------------------------------------------------------------
    const equalSwitch = el('input', { type: 'checkbox', class: 'switch', role: 'switch', id: uid('st-equal') });
    const mixBody = el('div', { class: 'st-mix stack stack--sm' });
    const mixAlerts = el('div', { class: 'st-alerts stack stack--sm' });
    const mixSummary = el('p', { class: 'st-hint', role: 'status', 'aria-live': 'polite' });
    const mixTools = el('div', { class: 'cluster st-mix__tools' });
    const distErr = el('p', { class: 'field__error', hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'st-err-text' }));
    fields.distribution = {
      setError(msg) { distErr.hidden = !msg; distErr.querySelector('.st-err-text').textContent = msg || ''; },
      focus() { mixBody.querySelector('input:not(:disabled)')?.focus(); },
    };
    const mixRows = new Map(); // id -> { weight, range, num, pct, got, warn }
    const mixCard = card('Category mix', 'How the questions of one game are spread across categories.', 'chart-bar',
      el('label', { class: 'check st-equal' }, equalSwitch, el('span', { class: 'check__text' }, 'Equal split', el('span', { class: 'check__hint' }, 'Every category with active questions gets the same share.'))),
      mixBody, distErr, mixTools, mixSummary, mixAlerts);

    function buildMixRows() {
      mixRows.clear();
      const ac = activeCats();
      if (poolError) {
        mixBody.replaceChildren(el('div', { class: 'alert alert--warning', role: 'alert' }, el('span', { class: 'alert__icon' }, icon('warning-fill')),
          el('div', null, el('p', { class: 'alert__title' }, 'Categories could not be loaded'), el('p', { class: 'alert__text' }, errorText(poolError))),
          el('button', { type: 'button', class: 'btn btn--secondary btn--sm', on: { click: async () => { await loadPool(); buildMixRows(); draft = { ...draft, weights: fromEvent(ctx.getEvent()).weights }; refresh(); } } }, 'Try again')));
        equalSwitch.disabled = true;
        return;
      }
      equalSwitch.disabled = false;
      if (!ac.length) {
        mixBody.replaceChildren(el('div', { class: 'empty st-empty' }, el('div', { class: 'empty__icon' }, icon('tag')), el('h3', { class: 'empty__title' }, 'No active category yet'),
          el('p', { class: 'empty__text' }, 'Add categories and questions first. Until then every active question is drawn at random.'),
          el('div', { class: 'empty__actions' }, el('a', { class: 'btn btn--secondary', href: `#/events/${eventId}/categories` }, icon('tag'), 'Manage categories'))));
        equalSwitch.disabled = true;
        return;
      }
      mixBody.replaceChildren(...ac.map((c) => {
        const id = String(c.id);
        const nid = uid('st-w');
        const range = el('input', { class: 'range', type: 'range', min: 0, max: 100, step: 1, 'aria-label': `${c.name}, weight slider`, tabindex: '-1' });
        const numIn = el('input', { class: 'input input--sm u-tabular', id: nid, type: 'number', inputmode: 'numeric', min: 0, max: 1000, step: 1, 'aria-label': `Weight of ${c.name}` });
        const pct = el('span', { class: 'st-row__pct' });
        const got = el('span', { class: 'st-row__got' });
        const warn = el('span', { class: 'badge badge--warning st-row__warn', hidden: true });
        const rowErr = el('p', { class: 'field__error', hidden: true });
        const row = el('div', { class: 'st-row', dataset: { id } },
          el('div', { class: 'st-row__name' }, el('span', { class: 'st-dot', style: { '--c': /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : 'var(--fg-muted)' } }), el('div', null, el('label', { class: 'st-row__label', for: nid }, c.name), el('div', { class: 'cell-sub' }, `${fmtN(caps[id] || 0)} active question${caps[id] === 1 ? '' : 's'}`))),
          el('div', { class: 'st-row__ctl' }, range, numIn),
          el('div', { class: 'st-row__out' }, pct, got, warn), rowErr);
        const setW = (v) => { draft.weights[id] = v; touched.add('distribution'); changed(`w:${id}`); };
        numIn.addEventListener('input', () => { setW(num(numIn.value)); range.value = String(clamp(num(numIn.value) ?? 0, 0, 100)); paint(range); });
        range.addEventListener('input', () => { numIn.value = range.value; setW(Number(range.value)); paint(range); });
        numIn.addEventListener('blur', () => { touched.add(`w:${id}`); refreshErrors(); });
        fields[`w:${id}`] = {
          setError(msg) { rowErr.hidden = !msg; rowErr.textContent = msg || ''; numIn.setAttribute('aria-invalid', String(!!msg)); },
          focus() { numIn.focus(); },
        };
        mixRows.set(id, { range, numIn, pct, got, warn, row });
        return row;
      }));
      mixTools.replaceChildren(
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: normalise } }, icon('scales'), 'Normalise to 100'),
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', on: { click: resetToEqual } }, icon('arrow-counter-clockwise'), 'Same weight everywhere'),
        el('span', { class: 'st-total' }));
      hydrateIcons(mixBody); hydrateIcons(mixTools);
    }

    function normalise() {
      const ac = activeCats();
      const sum = ac.reduce((a, c) => a + (Number(draft.weights[String(c.id)]) || 0), 0);
      if (sum <= 0) { resetToEqual(); return; }
      const raw = ac.map((c) => ({ id: String(c.id), q: ((Number(draft.weights[String(c.id)]) || 0) * 100) / sum }));
      raw.forEach((r) => { r.f = Math.floor(r.q); });
      let left = 100 - raw.reduce((a, r) => a + r.f, 0);
      [...raw].sort((a, b) => (b.q - b.f) - (a.q - a.f)).forEach((r) => { if (left-- > 0) r.f += 1; });
      raw.forEach((r) => { draft.weights[r.id] = r.f; });
      syncMix(); changed('distribution', true);
      announce('Weights normalised to 100');
    }
    function resetToEqual() {
      draft.weights = equalWeights(activeCats().map((c) => String(c.id)));
      syncMix(); changed('distribution', true);
    }
    function syncMix() {
      for (const [id, r] of mixRows) {
        const w = draft.weights[id];
        r.numIn.value = w === null || w === undefined ? '' : String(w);
        r.range.value = String(clamp(w || 0, 0, 100)); paint(r.range);
      }
    }
    equalSwitch.addEventListener('change', () => {
      draft.equal = equalSwitch.checked;
      if (!draft.equal) {
        const has = activeCats().some((c) => draft.weights[String(c.id)] > 0);
        if (!has) draft.weights = baseline && !baseline.equal && activeCats().some((c) => baseline.weights[String(c.id)] > 0) ? { ...baseline.weights } : equalWeights(activeCats().map((c) => String(c.id)));
      }
      syncMix(); changed('distribution', true);
    });

    function renderMix() {
      const ac = activeCats();
      equalSwitch.checked = draft.equal;
      mixBody.classList.toggle('is-equal', draft.equal);
      mixTools.hidden = draft.equal || !ac.length;
      const total = isInt(draft.questions_per_game) ? draft.questions_per_game : null;
      mixAlerts.replaceChildren();
      if (!ac.length || poolError) { mixSummary.textContent = ''; return; }
      const weights = {};
      ac.forEach((c) => { const id = String(c.id); weights[id] = draft.equal ? ((caps[id] || 0) > 0 ? 1 : 0) : Number(draft.weights[id]) || 0; });
      const sumW = Object.values(weights).reduce((a, b) => a + b, 0);
      const { per, filler } = total ? previewMix(total, weights, caps) : { per: {}, filler: 0 };
      for (const c of ac) {
        const id = String(c.id);
        const r = mixRows.get(id);
        if (!r) continue;
        const w = weights[id];
        const share = sumW > 0 ? (w / sumW) * 100 : 0;
        const cap = caps[id] || 0;
        r.row.classList.toggle('is-zero', w <= 0 || cap === 0);
        r.numIn.disabled = draft.equal; r.range.disabled = draft.equal;
        r.pct.textContent = cap === 0 && draft.equal ? '0%' : `${share % 1 ? share.toFixed(1) : share}%`;
        const p = per[id];
        let gotText = '';
        if (!total) gotText = '';
        else if (cap === 0) gotText = 'skipped';
        else if (w <= 0) gotText = 'not drawn';
        else if (p) gotText = p.lo === p.hi ? `${p.lo} question${p.lo === 1 ? '' : 's'}` : `${p.lo} to ${p.hi} questions`;
        r.got.textContent = gotText;
        let warnText = '';
        if (total && w > 0 && cap === 0) warnText = 'No active question';
        else if (total && p?.short) warnText = `Only ${cap} active`;
        r.warn.hidden = !warnText;
        r.warn.replaceChildren(...(warnText ? [icon('warning'), warnText] : []));
      }
      const shortCats = ac.filter((c) => { const id = String(c.id); const p = per[id]; return total && weights[id] > 0 && (caps[id] || 0) > 0 && p?.short; });
      const emptyCats = ac.filter((c) => total && weights[String(c.id)] > 0 && !(caps[String(c.id)] || 0));
      if (shortCats.length) {
        mixAlerts.append(el('div', { class: 'alert alert--warning', role: 'status' }, el('span', { class: 'alert__icon' }, icon('warning-fill')), el('div', null,
          el('p', { class: 'alert__title' }, 'Some categories cannot supply their share'),
          el('p', { class: 'alert__text' }, `${shortCats.map((c) => `${c.name} (${caps[String(c.id)]} active)`).join(', ')} ${shortCats.length === 1 ? 'has' : 'have'} fewer active questions than the ${total} questions per game would ask for. The shortfall goes to the other categories; add questions to keep the mix as configured.`))));
      }
      if (emptyCats.length) {
        mixAlerts.append(el('div', { class: 'alert alert--warning', role: 'status' }, el('span', { class: 'alert__icon' }, icon('warning-fill')), el('div', null,
          el('p', { class: 'alert__title' }, 'Weighted categories without active questions'),
          el('p', { class: 'alert__text' }, `${emptyCats.map((c) => c.name).join(', ')}: no active question, so ${emptyCats.length === 1 ? 'it is' : 'they are'} skipped.`))));
      }
      if (total && total > poolSize()) {
        mixAlerts.append(el('div', { class: 'alert alert--danger', role: 'status' }, el('span', { class: 'alert__icon' }, icon('x-circle-fill')), el('div', null,
          el('p', { class: 'alert__title' }, 'Not enough active questions'),
          el('p', { class: 'alert__text' }, `A game needs ${total} questions but only ${poolSize()} are active in active categories. Players would get an error when they start a game.`))));
      }
      const totalEl = mixTools.querySelector('.st-total');
      if (totalEl) {
        const exact = Math.abs(sumW - 100) < 1e-9;
        totalEl.textContent = `Total weight ${fmtN(sumW)}${exact ? '' : ' (shares are computed from the total, so this is fine)'}`;
      }
      if (total) {
        mixSummary.textContent = `Each game has ${total} question${total === 1 ? '' : 's'}.${filler ? ` About ${filler} come from categories without a weight or from uncategorised questions.` : ''} Remainders are spread at random from one game to the next.`;
      }
    }

    // ------------------------------------------------------------------------------------------
    // 5. registration
    // ------------------------------------------------------------------------------------------
    const fPhone = segmented('collect_phone', {
      label: 'Phone number', options: [['hidden', 'Not asked', 'eye-slash'], ['optional', 'Optional', 'device-mobile'], ['required', 'Required', 'lock']],
    });
    const consentLang = { current: 'en' };
    const consentArea = {};
    const consentTabs = el('div', { class: 'tabs tabs--pill st-tabs', role: 'tablist', 'aria-label': 'Consent text language' });
    const consentPanels = LANGS.map(([code, name]) => {
      const taId = uid(`st-consent-${code}`);
      const errId = `${taId}-err`;
      const ta = el('textarea', { class: 'textarea', id: taId, rows: 3, maxlength: String(CONSENT_MAX + 200), lang: code, placeholder: code === 'en' ? 'I agree to be contacted by Gravitee about its products and events.' : 'J’accepte d’être contacté(e) par Gravitee au sujet de ses produits et événements.', 'aria-describedby': errId });
      const err = el('p', { class: 'field__error', id: errId, hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'st-err-text' }));
      const key = `consent_text_${code}`;
      ta.addEventListener('input', () => { draft[key] = ta.value; changed(key); });
      ta.addEventListener('blur', () => { touched.add(key); refreshErrors(); });
      consentArea[code] = ta;
      fields[key] = { setError(msg) { err.hidden = !msg; err.querySelector('.st-err-text').textContent = msg || ''; ta.setAttribute('aria-invalid', String(!!msg)); }, focus() { selectConsentTab(code); ta.focus(); } };
      const tabId = uid('st-ctab');
      const panelId = uid('st-cpanel');
      const tab = el('button', { type: 'button', class: 'tabs__tab', role: 'tab', id: tabId, 'aria-controls': panelId, 'aria-selected': String(code === 'en'), tabindex: code === 'en' ? '0' : '-1', dataset: { lang: code } }, name);
      consentTabs.append(tab);
      const panel = el('div', { class: 'tabpanel st-cpanel', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, hidden: code !== 'en' },
        el('label', { class: 'u-sr-only', for: taId }, `Consent text (${name})`), ta, err);
      return { code, tab, panel };
    });
    function selectConsentTab(code) {
      consentLang.current = code;
      consentPanels.forEach((p) => { const on = p.code === code; p.tab.setAttribute('aria-selected', String(on)); p.tab.tabIndex = on ? 0 : -1; p.panel.hidden = !on; });
      renderConsentPreview();
    }
    consentTabs.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) selectConsentTab(t.dataset.lang); });
    consentTabs.addEventListener('keydown', (e) => {
      const tabs = consentPanels.map((p) => p.tab); const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key]; if (n === undefined) return;
      e.preventDefault(); const t = tabs[(n + tabs.length) % tabs.length]; selectConsentTab(t.dataset.lang); t.focus();
    });
    const consentPreview = el('div', { class: 'st-consent-preview' });
    const consentWarn = el('div', { class: 'st-alerts stack stack--sm' });
    const consentBox = el('div', { class: 'field st-consent' },
      el('div', { class: 'field__label' }, 'Consent checkbox', ' ', el('span', { class: 'field__optional' }, 'optional')),
      el('p', { class: 'field__help' }, 'When a consent text is set, the registration form shows a checkbox that players must tick before they can play. Leave both texts empty to show no checkbox.'),
      consentTabs, ...consentPanels.map((p) => p.panel), consentWarn,
      el('div', { class: 'st-preview-label' }, icon('eye'), 'Preview in the registration form'), consentPreview);
    const regCard = card('Registration', 'What players are asked before they play. Name and email are always required.', 'identification-badge', fPhone.node, consentBox);

    function renderConsentPreview() {
      const code = consentLang.current;
      const text = draft[`consent_text_${code}`].trim();
      const other = draft[`consent_text_${code === 'en' ? 'fr' : 'en'}`].trim();
      const anyText = draft.consent_text_en.trim() || draft.consent_text_fr.trim();
      const shown = text || other;
      const checkId = uid('st-pv-check');
      consentPreview.replaceChildren(shown
        ? el('div', { class: 'st-pv' },
          el('div', { class: 'st-pv__row' }, el('span', { class: 'st-pv__ph' }, code === 'en' ? 'First name' : 'Prénom'), el('span', { class: 'st-pv__ph' }, code === 'en' ? 'Last name' : 'Nom')),
          el('div', { class: 'st-pv__row' }, el('span', { class: 'st-pv__ph' }, code === 'en' ? 'Email' : 'E-mail')),
          el('label', { class: 'check', for: checkId }, el('input', { class: 'checkbox', type: 'checkbox', id: checkId, tabindex: '-1' }), el('span', { class: 'check__text', lang: text ? code : (code === 'en' ? 'fr' : 'en') }, shown, el('span', { class: 'st-req', 'aria-hidden': 'true' }, ' *'))),
          el('p', { class: 'st-pv__note' }, code === 'en' ? 'Required: players cannot continue until it is ticked.' : 'Obligatoire : impossible de continuer sans la cocher.'))
        : el('p', { class: 'st-pv__none' }, icon('check-square'), 'No checkbox is shown: the form only asks for the player details.'));
      hydrateIcons(consentPreview);
      consentWarn.replaceChildren();
      if (anyText && !draft.consent_text_en.trim() !== !draft.consent_text_fr.trim()) {
        const missing = draft.consent_text_en.trim() ? 'French' : 'English';
        const have = draft.consent_text_en.trim() ? 'English' : 'French';
        consentWarn.append(el('div', { class: 'alert alert--brand', role: 'status' }, el('span', { class: 'alert__icon' }, icon('info-fill')), el('div', null,
          el('p', { class: 'alert__text' }, `Only the ${have} text is set: ${missing}-speaking players see the ${have} text. The checkbox is required either way.`))));
      }
    }

    // ------------------------------------------------------------------------------------------
    // 6. languages
    // ------------------------------------------------------------------------------------------
    const langBoxes = {};
    const langErr = el('p', { class: 'field__error', hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'st-err-text' }));
    const langGroup = el('div', { class: 'cluster st-langs', role: 'group', 'aria-labelledby': 'st-langs-label' },
      ...LANGS.map(([code, name]) => {
        const box = el('input', { type: 'checkbox', class: 'checkbox', value: code });
        langBoxes[code] = box;
        box.addEventListener('change', () => {
          draft.languages = orderedLangs(LANGS.map(([c]) => c).filter((c) => langBoxes[c].checked));
          if (draft.languages.length && !draft.languages.includes(draft.default_language)) draft.default_language = draft.languages[0];
          changed('languages', true);
        });
        return el('label', { class: 'check' }, box, el('span', { class: 'check__text' }, name));
      }));
    fields.languages = { setError(msg) { langErr.hidden = !msg; langErr.querySelector('.st-err-text').textContent = msg || ''; Object.values(langBoxes).forEach((b) => b.setAttribute('aria-invalid', String(!!msg))); }, focus() { Object.values(langBoxes)[0].focus(); } };
    const defLang = segmented('default_language', { label: 'Default language', options: LANGS.map(([c, n]) => [c, n]), block: false });
    defLang.helpEl.textContent = 'Shown first to players who have not picked a language. They can always switch between the enabled ones.';
    const langCard = card('Languages', 'Which languages players can use.', 'translate',
      el('div', { class: 'field' }, el('span', { class: 'field__label', id: 'st-langs-label' }, 'Enabled languages'), langGroup, langErr,
        el('p', { class: 'field__help' }, 'Texts missing in a language fall back to English.')),
      defLang.node);

    // ------------------------------------------------------------------------------------------
    // action bar
    // ------------------------------------------------------------------------------------------
    const formError = el('div', { class: 'alert alert--danger', role: 'alert', hidden: true }, el('span', { class: 'alert__icon' }, icon('warning-fill')), el('div', null, el('p', { class: 'alert__title' }, 'Could not save the settings'), el('p', { class: 'alert__text st-form-error' })));
    const stateText = el('span', { class: 'st-bar__state' });
    const resetBtn = el('button', { type: 'button', class: 'btn btn--ghost', 'aria-label': 'Reset changes' }, icon('arrow-counter-clockwise'), el('span', { class: 'bar-lbl' }, 'Reset'));
    const saveBtn = el('button', { type: 'button', class: 'btn btn--primary' }, icon('floppy-disk'), 'Save changes');
    const bar = el('div', { class: 'st-bar', role: 'region', 'aria-label': 'Save changes' }, stateText, el('span', { class: 'st-bar__spacer' }), resetBtn, saveBtn);

    const head = el('header', { class: 'page-header' }, el('div', { class: 'page-header__main' },
      el('h1', { class: 'page-header__title', tabindex: '-1' }, 'Settings'),
      el('p', { class: 'page-header__sub' }, 'Status, game rules, scoring, category mix, registration and languages.')));
    const view = el('form', { class: 'st stack stack--lg', novalidate: '', 'aria-label': 'Event settings' },
      head, formError, statusCard, rulesCard, scoringCard, mixCard, regCard, langCard, bar);
    root.replaceChildren(view);
    hydrateIcons(view);

    // ------------------------------------------------------------------------------------------
    // refresh pipeline
    // ------------------------------------------------------------------------------------------
    const ctrls = { questions_per_game: fQuestions, timer_seconds: fTimer, points_correct: fCorrect, points_wrong: fWrong, time_bonus_max: fBonus };

    function renderSim() {
      const timer = isInt(draft.timer_seconds) && draft.timer_seconds >= 1 ? draft.timer_seconds : 20;
      const pc = isInt(draft.points_correct) ? draft.points_correct : 0;
      const pw = isInt(draft.points_wrong) ? draft.points_wrong : 0;
      const bonusMax = isInt(draft.time_bonus_max) ? draft.time_bonus_max : 0;
      simRange.max = String(timer);
      if (+simRange.value > timer) simRange.value = String(timer);
      paint(simRange);
      const t = +simRange.value;
      simTime.textContent = `${t} second${t === 1 ? '' : 's'}`;
      const bonus = Math.floor(bonusMax * (1 - t / timer));
      simOut.replaceChildren(
        simCell('Correct answer', `${fmtN(pc + bonus)} pts`, `${fmtN(pc)} base + ${fmtN(bonus)} time bonus`, 'ok'),
        simCell('Wrong answer', `${fmtN(pw)} pts`, 'no bonus', 'ko'),
        simCell('No answer', '0 pts', 'time ran out', ''));
      const q = isInt(draft.questions_per_game) ? draft.questions_per_game : 0;
      simGame.textContent = q ? `Best possible game: ${q} × ${fmtN(pc + bonusMax)} = ${fmtN(q * (pc + bonusMax))} points. All correct at half time: ${fmtN(q * (pc + Math.floor(bonusMax / 2)))} points.` : '';
    }
    const simCell = (label, value, sub, tone) => el('div', { class: ['st-sim__cell', tone && `st-sim__cell--${tone}`] }, el('span', { class: 'st-sim__label' }, label), el('span', { class: 'st-sim__value' }, value), el('span', { class: 'st-sim__sub' }, sub));

    function renderStatus() {
      const s = STATUS[draft.status] || STATUS.draft;
      statusSeg.helpEl.textContent = s.text;
      const ev = ctx.getEvent();
      statusLinks.replaceChildren(
        el('a', { class: 'btn btn--secondary btn--sm', href: `/${ev.slug}`, target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Open the public page'),
        el('a', { class: 'btn btn--ghost btn--sm', href: `/${ev.slug}/scoreboard`, target: '_blank', rel: 'noopener' }, icon('television'), 'Open the scoreboard'));
      hydrateIcons(statusLinks);
      statusAlert.replaceChildren();
      const q = isInt(draft.questions_per_game) ? draft.questions_per_game : 0;
      if (!poolError && draft.status === 'live' && q > poolSize()) {
        statusAlert.append(el('div', { class: 'alert alert--danger' }, el('span', { class: 'alert__icon' }, icon('x-circle-fill')), el('div', null, el('p', { class: 'alert__title' }, 'Not ready for players'),
          el('p', { class: 'alert__text' }, `Games need ${q} questions but only ${poolSize()} are active. Add questions or lower the number of questions per game.`))));
      } else if (draft.status === 'live' && baseline.status !== 'live') {
        statusAlert.append(el('div', { class: 'alert alert--brand' }, el('span', { class: 'alert__icon' }, icon('info-fill')), el('div', null, el('p', { class: 'alert__text' }, 'The event will be listed on the hub as soon as you save.'))));
      }
      hydrateIcons(statusAlert);
    }

    function renderOrder() {
      orderHelp.textContent = draft.question_order === 'easy_to_hard'
        ? 'Easy questions first, hard ones last. Random inside one difficulty level.'
        : 'Every game gets its questions in a random order.';
      const q = isInt(draft.questions_per_game) ? draft.questions_per_game : null;
      const t = isInt(draft.timer_seconds) ? draft.timer_seconds : null;
      durationHint.textContent = q && t ? `At most ${fmtN(Math.round(q * t))} seconds of answering per game (${fmtN(Math.round((q * t) / 6) / 10)} min), plus the time players take to read the feedback.` : '';
    }

    function renderPhoneHelp() {
      fPhone.helpEl.textContent = { hidden: 'The registration form does not show a phone field.', optional: 'Players can leave the phone number empty.', required: 'Players must enter a phone number to register.' }[draft.collect_phone] || '';
    }

    function renderLangs() {
      LANGS.forEach(([c]) => { langBoxes[c].checked = draft.languages.includes(c); });
      defLang.sync();
      const inputs = defLang.node.querySelectorAll('input');
      inputs.forEach((i) => { i.disabled = !draft.languages.includes(i.value); });
    }

    let errors = {};
    function refreshErrors() {
      errors = validate(draft);
      for (const [key, f] of Object.entries(fields)) {
        const local = (submitted || touched.has(key)) ? errors[key] : '';
        f.setError(serverErrors[key] || local || '');
      }
    }

    function refresh() {
      renderSim(); renderOrder(); renderPhoneHelp(); renderStatus(); renderLangs(); renderMix(); renderConsentPreview();
      refreshErrors();
      const patch = buildPatch(draft, baseline);
      dirty = Object.keys(patch).length > 0;
      ctx.setDirty?.(dirty);
      view.classList.toggle('is-dirty', dirty);
      stateText.replaceChildren(el('span', { class: ['st-bar__dot', dirty && 'is-on'], 'aria-hidden': 'true' }), el('span', { class: 'bar-long' }, dirty ? 'Unsaved changes' : 'All changes saved'), el('span', { class: 'bar-short', 'aria-hidden': 'true' }, dirty ? 'Unsaved' : 'Saved'));
      resetBtn.disabled = !dirty || saving;
      saveBtn.disabled = !dirty || saving;
    }
    function changed(key, touch = false) { formError.hidden = true; if (key) delete serverErrors[key]; if (touch && key) touched.add(key); refresh(); }

    function pushDraftToControls() {
      Object.values(ctrls).forEach((c) => c.sync());
      statusSeg.sync(); fOrder.sync(); fPhone.sync();
      consentArea.en.value = draft.consent_text_en; consentArea.fr.value = draft.consent_text_fr;
      renderLangs();
      syncMix();
    }

    function resetFromEvent(ev = ctx.getEvent()) {
      baseline = fromEvent(ev);
      draft = structuredClone(baseline);
      touched.clear(); submitted = false; formError.hidden = true;
      Object.keys(serverErrors).forEach((k) => delete serverErrors[k]);
      buildMixRows();
      pushDraftToControls();
      refresh();
    }

    // ------------------------------------------------------------------------------------------
    // save / reset
    // ------------------------------------------------------------------------------------------
    const FIELD_ERROR_MAP = {
      'settings.questions_per_game': 'questions_per_game', 'settings.timer_seconds': 'timer_seconds', 'settings.points_correct': 'points_correct',
      'settings.points_wrong': 'points_wrong', 'settings.time_bonus_max': 'time_bonus_max', 'settings.consent_text_en': 'consent_text_en',
      'settings.consent_text_fr': 'consent_text_fr', 'settings.category_distribution': 'distribution', languages: 'languages', default_language: 'default_language',
      status: 'status', 'settings.question_order': 'question_order', 'settings.collect_phone': 'collect_phone',
    };

    async function save() {
      if (saving) return;
      submitted = true;
      refreshErrors();
      const firstKey = Object.keys(errors)[0];
      if (firstKey) {
        const f = fields[firstKey];
        f?.focus();
        announce(`${Object.keys(errors).length} field${Object.keys(errors).length === 1 ? '' : 's'} need attention`, { politeness: 'assertive' });
        return;
      }
      const patch = buildPatch(draft, baseline);
      if (!Object.keys(patch).length) return;
      if (patch.status) {
        const from = STATUS[baseline.status].label, to = STATUS[patch.status].label;
        const msg = patch.status === 'closed'
          ? 'Players can no longer register or start a game. The scoreboard stays visible and the event disappears from the hub.'
          : patch.status === 'draft' ? 'The event disappears from the hub and players get a "not found" page. You can still preview it as admin.'
            : 'The event is listed on the hub and players can register and play right away.';
        const ok = await ctx.confirm({ title: `Change the status from ${from} to ${to}?`, message: msg, confirmLabel: `Set to ${to}`, danger: patch.status !== 'live' });
        if (!ok || !alive) return;
      }
      saving = true; setBusy(saveBtn, true); resetBtn.disabled = true; formError.hidden = true;
      try {
        await api.put(`/admin/events/${eventId}`, patch);
        ctx.toast('Settings saved', { type: 'success' });
        await loadPool();
        await ctx.reloadEvent();
        if (!alive) return;
        resetFromEvent();
      } catch (e) {
        if (!alive) return;
        if (e?.isUnauthorized) return;
        const mapped = [];
        for (const [loc, msg] of Object.entries(e?.fieldErrors || {})) {
          const key = FIELD_ERROR_MAP[loc];
          if (key && fields[key]) { serverErrors[key] = msg.replace(/^Value error, /, ''); mapped.push(key); }
        }
        const generic = Object.entries(e?.fieldErrors || {}).filter(([loc]) => !FIELD_ERROR_MAP[loc]).map(([, m]) => m.replace(/^Value error, /, ''));
        if (!mapped.length) generic.push(errorText(e));
        if (generic.length) { formError.querySelector('.st-form-error').textContent = generic.join(' '); formError.hidden = false; formError.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }
        else { refreshErrors(); fields[mapped[0]]?.focus(); }
        ctx.toast('The settings were not saved', { type: 'error' });
      } finally {
        saving = false;
        if (saveBtn.isConnected) { setBusy(saveBtn, false); refresh(); }
      }
    }

    saveBtn.addEventListener('click', save);
    view.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    resetBtn.addEventListener('click', () => { resetFromEvent(); announce('Changes discarded'); });

    // the event changes elsewhere (header status, other tab, our own save): keep an unsaved draft, otherwise follow
    disposers.push(ctx.onEventChanged?.((ev) => {
      if (!alive || saving) return;
      if (!dirty) { resetFromEvent(ev); return; }
      baseline = fromEvent(ev); refresh();
    }) || (() => {}));

    resetFromEvent();

    return {
      unmount() {
        alive = false;
        disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        ctx.setDirty?.(false);
        root.replaceChildren();
      },
    };
  },
};
