/**
 * styleguide.js - drives shared/styleguide.html (docs mode) and its ?screen=… reference compositions.
 * It is also the living example of how an app boots on the design system: read it top to bottom.
 */
import { el, icon, hydrateIcons, qs, qsa, avatar, copyToClipboard, formatNumber, SPRITE_URL, sleep } from './dom.js';
import { createI18n } from './i18n.js';
import { initTheme, createThemeToggle, onThemeChange, setTheme } from './theme.js';
import { applyBranding, computeBrandTokens, DEFAULT_BRANDING } from './branding.js';
import { toast, confirmDialog, openModal, announce, initTabs, initDropdowns, initColorInputs, initRanges, initShell, withBusy } from './ui.js';
import { countUp, celebrate } from './effects.js';
import { qrCode } from './qr.js';

// ------------------------------------------------------------------------------------------------
// data
// ------------------------------------------------------------------------------------------------
const PRESETS = [
  { key: 'gravitee', name: 'Gravitee orange', primary: '#FC5607', accent: '#FF9A52', title: 'API Masters' },
  { key: 'ai', name: 'AI violet', primary: '#7C5CFF', accent: '#22D3EE', title: 'AI Masters' },
  { key: 'yellow', name: 'Stress: yellow + pink', primary: '#FFD60A', accent: '#FF006E', title: 'Sun Masters' },
  { key: 'navy', name: 'Stress: navy', primary: '#0B2447', accent: '#19376D', title: 'Navy Masters' },
  { key: 'mint', name: 'Stress: mint', primary: '#2EC4B6', accent: '#CBF3F0', title: 'Mint Masters' },
];
const PLAYERS = [['Ada L.', 1340, 14], ['Grace H.', 1285, 14], ['Alan T.', 1240, 13], ['Linus T.', 1190, 13], ['Margaret H.', 1150, 12], ['Tim B.', 1105, 12], ['Katherine J.', 1060, 12], ['Dennis R.', 990, 11], ['Barbara L.', 940, 10], ['Ken T.', 905, 10]];
const CATEGORIES = [['LLMs & GenAI', '#7C5CFF'], ['MCP & Agents', '#22D3EE'], ['Gravitee AI', '#FC5607'], ['Guardrails', '#FFD60A'], ['Governance', '#2EC4B6'], ['Security', '#FF006E'], ['Black', '#000000'], ['White', '#FFFFFF']];
const EVENTS = [
  { slug: 'api-masters', icon: 'plugs-connected', game_title: 'API Masters', name: 'API Days Paris 2026', location: 'Paris', starts_on: '2026-12-02', ends_on: '2026-12-03', desc: 'Events, REST, GraphQL, AI and Gravitee: how well do you know the API world?', languages: ['en', 'fr'], branding: { primary_color: '#FC5607', accent_color: '#FF9A52' } },
  { slug: 'world-ai-summit-2026', icon: 'robot', game_title: 'AI Masters', name: 'World AI Summit – Amsterdam 2026', location: 'Amsterdam', starts_on: '2026-10-07', ends_on: '2026-10-08', desc: 'LLMs, MCP, agents, guardrails and AI governance. Easy, medium and a few tricky ones.', languages: ['en', 'fr'], branding: { primary_color: '#7C5CFF', accent_color: '#22D3EE' } },
  { slug: 'sun-masters', icon: 'lightning', game_title: 'Sun Masters', name: 'Stress test: yellow and pink', location: 'Everywhere', starts_on: '2026-11-03', ends_on: '2026-11-03', desc: 'A loud brand colour to prove that buttons, chips and text stay readable.', languages: ['en'], branding: { primary_color: '#FFD60A', accent_color: '#FF006E' } },
  { slug: 'navy-masters', icon: 'shield-check', game_title: 'Navy Masters', name: 'Stress test: deep navy', location: 'Lyon', starts_on: '2026-11-18', ends_on: '2026-11-19', desc: 'A very dark brand colour that has to be lifted in dark mode and stay crisp in light mode.', languages: ['en', 'fr'], branding: { primary_color: '#0B2447', accent_color: '#19376D' } },
  { slug: 'mint-masters', icon: 'sparkle', game_title: 'Mint Masters', name: 'Stress test: mint', location: 'Online', starts_on: '2026-12-10', ends_on: '2026-12-10', desc: 'A pale accent colour: great aurora, tricky for text.', languages: ['fr', 'en'], branding: { primary_color: '#2EC4B6', accent_color: '#CBF3F0' } },
];
const QUESTIONS = [
  ['An LLM predicts the next token from the tokens before it.', 'LLMs & GenAI', '#7C5CFF', 'true_false', 1, true],
  ['What does the “temperature” setting control?', 'LLMs & GenAI', '#7C5CFF', 'two_choices', 2, true],
  ['MCP stands for Model Context Protocol.', 'MCP & Agents', '#22D3EE', 'true_false', 1, true],
  ['Which document describes an agent’s capabilities in A2A?', 'MCP & Agents', '#22D3EE', 'two_choices', 2, true],
  ['Gravitee’s LLM Proxy can enforce token-based rate limits.', 'Gravitee AI', '#FC5607', 'true_false', 2, true],
  ['Which policy shrinks prompts before they reach the model?', 'Gravitee AI', '#FC5607', 'two_choices', 3, false],
  ['A guardrail can block a prompt injection attempt.', 'Guardrails', '#FFD60A', 'true_false', 1, true],
  ['Semantic caching matches prompts by exact string only.', 'Gravitee AI', '#FC5607', 'true_false', 3, true],
];

const dictionaries = {
  en: {
    sg: { eyebrow: 'Design system · any brand colour', hero_a: 'Become THE', tagline: 'One look for every event: pick a brand colour and the whole UI follows, readable in light and dark.', play: 'Play now', scoreboard: 'Scoreboard' },
    common: { powered: 'Powered by' },
    game: { question: 'Question' },
    landing: { questions: 'Questions', seconds: 'Seconds each', buzzers: 'Buzzers or keys' },
    results: { score: 'Your score', rank: 'Rank {rank} of {total}', correct: 'Correct', wrong: 'Wrong', unanswered: 'Unanswered', celebrate: 'Celebrate', top: 'Top players', review: 'Your answers' },
    board: { players: 'players', games: 'games', live: 'Live', scan: 'Scan to play', scan_sub: 'Open the camera, point at the code, beat the leaderboard.', ranks: 'Ranks 4 to 10' },
    hub: { eyebrow: 'Live events', title_a: 'Pick your', title_b: 'arena', tagline: 'Quick quizzes, big bragging rights. Choose the event you are attending and play.' },
  },
  fr: {
    sg: { eyebrow: 'Design system · toutes les couleurs', hero_a: 'Devenez LE', tagline: 'Un style pour chaque évènement : choisissez une couleur de marque et toute l’interface suit, lisible en clair comme en sombre.', play: 'Jouer', scoreboard: 'Classement' },
    common: { powered: 'Propulsé par' },
    game: { question: 'Question' },
    landing: { questions: 'Questions', seconds: 'Secondes chacune', buzzers: 'Buzzers ou touches' },
    results: { score: 'Votre score', rank: 'Rang {rank} sur {total}', correct: 'Bonnes', wrong: 'Fausses', unanswered: 'Sans réponse', celebrate: 'Fêter ça', top: 'Meilleurs joueurs', review: 'Vos réponses' },
    board: { players: 'joueurs', games: 'parties', live: 'En direct', scan: 'Scannez pour jouer', scan_sub: 'Ouvrez l’appareil photo, visez le code, battez le classement.', ranks: 'Rangs 4 à 10' },
    hub: { eyebrow: 'Évènements en direct', title_a: 'Choisissez votre', title_b: 'arène', tagline: 'Des quiz rapides et de grands droits de vantardise. Choisissez l’évènement auquel vous assistez.' },
  },
};

// ------------------------------------------------------------------------------------------------
// boot
// ------------------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const screenName = params.get('screen');
const i18n = createI18n({ dictionaries, fallback: 'en' });
initTheme();
if (['dark', 'light', 'system'].includes(params.get('theme'))) setTheme(params.get('theme'), { persist: false });

const STATE_KEY = 'sg.state';
const readState = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || null; } catch { return null; } };
const writeState = (s) => { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ } };

const preset0 = PRESETS.find((p) => p.key === params.get('preset')) || (screenName === 'admin' || screenName === 'branding' ? PRESETS[0] : null);
let state = preset0 ? { primary: preset0.primary, accent: preset0.accent, bg: params.get('bg') || 'aurora', title: preset0.title } : (readState() || { primary: PRESETS[0].primary, accent: PRESETS[0].accent, bg: 'aurora', title: PRESETS[0].title });
if (params.get('bg')) state.bg = params.get('bg');
// screens use the preset passed in the URL; the docs page shares its state with the iframes through localStorage
const syncAcrossFrames = !preset0;

function applyState({ persist = true } = {}) {
  applyBranding({ game_title: state.title, name: 'Design System', branding: { primary_color: state.primary, accent_color: state.accent, background_style: state.bg, default_theme: 'dark' } }, { title: false });
  document.title = screenName ? `${screenName} · Quiz Design System` : 'Quiz Design System';
  qsa('[data-bind="game_title"]').forEach((n) => { n.textContent = state.title; });
  const t = qs('#sg-game-title'); if (t) t.textContent = state.title;
  if (persist && syncAcrossFrames) writeState(state);
  requestAnimationFrame(() => { document.dispatchEvent(new CustomEvent('sg:brand')); });
}

// ------------------------------------------------------------------------------------------------
// shared builders
// ------------------------------------------------------------------------------------------------
const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);
const fill = (root, name) => root.querySelector(`[data-fill="${name}"]`);
const clone = (id) => document.getElementById(id).content.cloneNode(true);
const bindText = (root, map) => Object.entries(map).forEach(([k, v]) => root.querySelectorAll(`[data-bind="${k}"]`).forEach((n) => { n.textContent = v; }));

function appbar({ lang = true } = {}) {
  const bar = clone('tpl-appbar');
  const actions = slot(bar, 'actions');
  if (lang) actions.append(langSwitch());
  actions.append(createThemeToggle());
  return bar;
}
function langSwitch() {
  const name = `l${Math.random().toString(36).slice(2, 6)}`;
  const wrap = el('div', { class: 'segmented segmented--sm', role: 'radiogroup', 'aria-label': 'Language' }, ['en', 'fr'].map((l) => el('label', null, el('input', { type: 'radio', name, value: l, checked: i18n.lang === l, on: { change: () => i18n.setLang(l) } }), el('span', null, l.toUpperCase()))));
  i18n.onChange((l) => wrap.querySelectorAll('input').forEach((i) => { i.checked = i.value === l; }));
  return wrap;
}
function footer() { return clone('tpl-footer'); }

function buildPodium(container, entries) {
  container.replaceChildren(...[1, 2, 3].map((rank) => {
    const [name, score, correct] = entries[rank - 1];
    return el('div', { class: 'podium__place', dataset: { rank } },
      rank === 1 ? icon('crown-fill', { class: 'podium__crown' }) : null,
      avatar(name, { size: 'xl', class: 'podium__avatar' }),
      el('div', { class: 'podium__name' }, name),
      el('div', { class: 'podium__score' }, formatNumber(score)),
      el('div', { class: 'podium__meta' }, `${correct}/15`),
      el('div', { class: 'podium__block' }, el('span', { class: 'podium__rank' }, rank)));
  }));
}
function buildRows(container, entries, { from = 1, you = -1, flash = -1 } = {}) {
  container.replaceChildren(...entries.map(([name, score, correct], i) => el('li', { class: ['lb__row', i === you && 'is-you', i === flash && 'is-new'], dataset: { rank: from + i } },
    el('span', { class: 'lb__rank' }, from + i), avatar(name, { size: 'sm' }), el('span', { class: 'lb__name' }, name), el('span', { class: 'lb__meta' }, `${correct}/15`), el('span', { class: 'lb__score' }, formatNumber(score)))));
}
function eventCard(ev, i, level = 3) {
  const card = el('a', { class: 'event-card u-rise', href: '#hub', style: { '--i': i } },
    el('div', { class: 'event-card__banner' }, el('span', { class: 'badge badge--dot event-card__status' }, 'Live'), el('span', { class: 'event-card__medallion' }, icon(ev.icon, { size: 'lg' }))),
    el('div', { class: 'event-card__body' },
      el('span', { class: 'event-card__kicker' }, ev.game_title),
      el(`h${level}`, { class: 'event-card__title' }, ev.name),   // h2 under the hub's h1, h3 under a section h2
      el('div', { class: 'event-card__meta' }, el('span', null, icon('map-pin', { size: 'sm' }), ev.location), el('span', null, icon('calendar-blank', { size: 'sm' }), i18n.dateRange(ev.starts_on, ev.ends_on))),
      el('p', { class: 'event-card__desc' }, ev.desc)),
    el('div', { class: 'event-card__footer' }, el('span', { class: 'badge badge--brand' }, icon('globe'), ev.languages.join(' · ').toUpperCase()), el('span', { class: 'btn btn--primary btn--sm' }, i18n.lang === 'fr' ? 'Jouer' : 'Play', icon('arrow-right'))));
  applyBranding(ev, { root: card });
  return card;
}
const chip = (label, color) => el('span', { class: 'chip', style: { '--chip': color } }, label);

// ------------------------------------------------------------------------------------------------
// screen mode
// ------------------------------------------------------------------------------------------------
let remountHooked = false;
function mountScreen(name) {
  document.body.dataset.mode = 'screen';
  const host = document.getElementById('screen');
  host.hidden = false;
  const tpl = { landing: 'tpl-landing', game: 'tpl-game', results: 'tpl-results', scoreboard: 'tpl-scoreboard', hub: 'tpl-hub', admin: 'tpl-admin-shell', branding: 'tpl-admin-shell' }[name];
  if (!tpl) { host.append(el('p', { class: 'container' }, `Unknown screen "${name}"`)); return; }
  const root = clone(tpl);
  applyState({ persist: false });
  const ev = EVENTS.find((e) => e.branding.primary_color === state.primary) || EVENTS[1];

  slot(root, 'appbar')?.replaceWith(appbar());
  slot(root, 'footer')?.replaceWith(footer());
  bindText(root, { game_title: state.title, game_title_caps: state.title.toUpperCase(), event_name: ev.name, players: '128', games: '341', eyebrow: `${ev.location} · ${i18n.dateRange(ev.starts_on, ev.ends_on)}`, hero_em: ev.game_title.replace(/s$/, ''), url: `quiz.events.gravitee.io/${ev.slug}` });

  if (name === 'landing') fill(root, 'chips').replaceChildren(...CATEGORIES.slice(0, 5).map(([n, c]) => chip(n, c)));
  if (name === 'game') {
    if (params.get('format') === 'tf') {
      bindText(root, { question: 'An LLM generates text one token at a time.', green: 'TRUE', red: 'FALSE' });
    }
    if (params.get('live') === '1') runRing(root.querySelector('.ring'), 20);
  }
  if (name === 'results') {
    buildRows(fill(root, 'lb'), PLAYERS.slice(0, 5).map((p, i) => (i === 3 ? ['You', 1190, 13] : p)), { you: 3 });
    root.querySelector('[data-action="celebrate"]').addEventListener('click', () => celebrate());
  }
  if (name === 'scoreboard') {
    document.documentElement.dataset.display = 'tv';
    buildPodium(fill(root, 'podium'), PLAYERS);
    buildRows(fill(root, 'lb'), PLAYERS.slice(3), { from: 4, flash: 1 });
    slot(root, 'qr').replaceWith(qrCode(`https://quiz.events.gravitee.io/${ev.slug}`, { size: '9.5rem', ecc: 'M' }));
  }
  if (name === 'hub') fill(root, 'events').replaceChildren(...EVENTS.map((ev, i) => eventCard(ev, i, 2)));
  if (name === 'admin' || name === 'branding') {
    slot(root, 'theme').replaceWith(createThemeToggle());
    const main = slot(root, 'main');
    main.append(clone(name === 'admin' ? 'tpl-admin-questions' : 'tpl-admin-branding'));
    root.querySelector(`[data-nav="${name === 'admin' ? 'questions' : 'branding'}"]`)?.setAttribute('aria-current', 'page');
    if (name === 'admin') fillQuestions(main);
    if (name === 'branding') wireBranding(main);
  }

  host.append(root);
  hydrateIcons(host);
  i18n.apply(host);
  initDropdowns(host);
  initTabs(host);
  initColorInputs(host);
  initShell(host.querySelector('.shell'));
  if (!remountHooked) { remountHooked = true; i18n.onChange(() => { host.replaceChildren(); mountScreen(name); }); }
}

function fillQuestions(main) {
  const body = main.querySelector('[data-fill="questions"]');
  body.replaceChildren(...QUESTIONS.map(([text, cat, color, fmt, diff, active]) => el('tr', null,
    el('td', { dataset: { label: 'Question' } }, el('div', { class: 'cell-title' }, text), el('div', { class: 'cell-sub' }, 'FR: ' + (active ? 'translated' : 'missing'))),
    el('td', { dataset: { label: 'Category' } }, chip(cat, color)),
    el('td', { dataset: { label: 'Format' } }, el('span', { class: 'badge' }, fmt === 'true_false' ? 'True / False' : 'Two choices')),
    el('td', { dataset: { label: 'Level' } }, el('span', { class: 'difficulty', dataset: { level: diff }, 'aria-label': ['', 'Easy', 'Medium', 'Hard'][diff] })),
    el('td', { dataset: { label: 'Active' } }, el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: active, 'aria-label': 'Active' })),
    el('td', { class: 'actions' }, el('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', 'aria-label': 'Edit', onclick: () => questionEditor() }, icon('pencil-simple')), el('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', 'aria-label': 'Delete' }, icon('trash'))))));
  main.querySelector('[data-action="add-question"]').addEventListener('click', () => questionEditor());
}

function questionEditor() {
  const form = el('form', { class: 'stack', novalidate: '' },
    el('div', { class: 'tabs tabs--pill', role: 'tablist', 'aria-label': 'Language' }, el('button', { class: 'tabs__tab', role: 'tab', type: 'button', 'aria-selected': 'true' }, 'English'), el('button', { class: 'tabs__tab', role: 'tab', type: 'button', 'aria-selected': 'false' }, 'Français')),
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'qe-text' }, 'Question'), el('textarea', { class: 'textarea', id: 'qe-text', placeholder: 'Which protocol…?' })),
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Format'), el('div', { class: 'segmented segmented--block', role: 'radiogroup' }, el('label', null, el('input', { type: 'radio', name: 'qe-fmt', checked: true }), el('span', null, 'True / False')), el('label', null, el('input', { type: 'radio', name: 'qe-fmt' }), el('span', null, 'Two choices')))),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'qe-cat' }, 'Category'), el('select', { class: 'select', id: 'qe-cat' }, CATEGORIES.slice(0, 4).map(([n]) => el('option', null, n)))),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Correct answer'), el('div', { class: 'cluster' }, el('label', { class: 'check' }, el('input', { type: 'radio', class: 'radio', name: 'qe-ans', checked: true }), el('span', { class: 'kbd kbd--green' }, 'G'), 'Green'), el('label', { class: 'check' }, el('input', { type: 'radio', class: 'radio', name: 'qe-ans' }), el('span', { class: 'kbd kbd--red' }, 'R'), 'Red'))),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Difficulty'), el('div', { class: 'segmented segmented--block', role: 'radiogroup' }, ['Easy', 'Medium', 'Hard'].map((d, i) => el('label', null, el('input', { type: 'radio', name: 'qe-diff', checked: i === 1 }), el('span', null, d)))))),
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'qe-exp' }, 'Explanation ', el('span', { class: 'field__optional' }, 'shown in the review')), el('textarea', { class: 'textarea', id: 'qe-exp' })));
  const ctl = openModal({ title: 'New question', description: 'Questions can be true / false or two choices.', icon: 'question', size: 'lg', content: form, actions: [{ label: 'Cancel', variant: 'ghost' }, { label: 'Save question', variant: 'primary', value: 'save', onClick: () => toast('Question saved', { type: 'success' }) }] });
  initTabs(ctl.dialog);
}

function wireBranding(main) {
  const preview = main.querySelector('#bp-preview');
  const presetBox = main.querySelector('#bp-presets');
  const [pIn, aIn] = [main.querySelector('#bp-primary'), main.querySelector('#bp-accent')];
  const update = (primary, accent, bg) => {
    const branding = { primary_color: primary, accent_color: accent, background_style: bg || 'aurora' };
    applyBranding({ branding }, { root: preview });
    const hexOk = (h) => /^#[0-9a-f]{6}$/i.test(h);
    preview.dataset.bg = branding.background_style;
    presetBox.querySelectorAll('.sg-preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.primary === primary.toUpperCase())));
    void hexOk;
  };
  presetBox.replaceChildren(...PRESETS.map((p) => el('button', { class: 'sg-preset', type: 'button', dataset: { primary: p.primary }, 'aria-pressed': 'false', on: { click: () => { pIn.value = p.primary; aIn.value = p.accent; pIn.dispatchEvent(new Event('input', { bubbles: true })); aIn.dispatchEvent(new Event('input', { bubbles: true })); } } }, el('span', { class: 'swatch', style: { '--swatch': p.primary, '--swatch-2': p.accent } }), p.name.replace('Stress: ', ''))));
  const go = () => { if (/^#[0-9a-f]{6}$/i.test(pIn.value) && /^#[0-9a-f]{6}$/i.test(aIn.value)) update(pIn.value.toUpperCase(), aIn.value.toUpperCase(), main.querySelector('#bp-bg input:checked')?.value); };
  main.addEventListener('input', go);
  main.addEventListener('change', go);
  go();
}

function runRing(ring, seconds) {
  const label = ring.querySelector('.ring__label');
  let left = seconds;
  const paint = () => {
    ring.style.setProperty('--value', String((left / seconds) * 100));
    ring.dataset.state = left <= 3 ? 'danger' : left <= 7 ? 'warn' : left === 0 ? 'done' : 'ok';
    label.textContent = String(left);
  };
  paint();
  const timer = setInterval(() => { left -= 1; if (left < 0) { clearInterval(timer); ring.dataset.state = 'done'; return; } paint(); }, 1000);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------------------------------------
// docs mode
// ------------------------------------------------------------------------------------------------
const cvs = document.createElement('canvas');
cvs.width = cvs.height = 1;
const ctx2d = cvs.getContext('2d', { willReadFrequently: true });
const probe = el('span', { 'aria-hidden': 'true', style: { position: 'fixed', inset: '0 auto auto -9999px', visibility: 'hidden' } });

/** Resolve CSS colour layers (bottom to top, CSS strings / var()s) to an opaque sRGB triple by painting them. */
function composite(layers) {
  if (!probe.isConnected) document.body.append(probe);
  ctx2d.clearRect(0, 0, 1, 1);
  for (const layer of layers) {
    probe.style.color = layer;
    ctx2d.fillStyle = '#000';
    ctx2d.fillStyle = getComputedStyle(probe).color;
    ctx2d.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx2d.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const v = (n) => `var(${n})`;
const PAIRS = [
  // [label, foreground, [background layers], minimum ratio]
  ['Body text / page', v('--fg'), [v('--bg')], 4.5], ['Body text / card', v('--fg'), [v('--bg-raised')], 4.5], ['Body text / menu, dialog', v('--fg'), [v('--bg-overlay')], 4.5],
  ['Muted text / page', v('--fg-muted'), [v('--bg')], 4.5], ['Muted text / card', v('--fg-muted'), [v('--bg-raised')], 4.5], ['Muted text / hovered row', v('--fg-muted'), [v('--bg-raised'), v('--hover')], 4.5],
  ['Subtle text / page', v('--fg-subtle'), [v('--bg')], 4.5], ['Subtle text / card', v('--fg-subtle'), [v('--bg-raised')], 4.5], ['Placeholder / input', v('--fg-subtle'), [v('--input-bg')], 4.5],
  ['Brand text (links) / page', v('--brand-text'), [v('--bg')], 4.5], ['Brand text / card', v('--brand-text'), [v('--bg-raised')], 4.5], ['Brand text / brand tint', v('--brand-text'), [v('--bg-raised'), v('--brand-soft')], 4.5], ['Brand text / hovered', v('--brand-text'), [v('--bg-overlay'), v('--active')], 4.5],
  ['Accent text / page', v('--accent-text'), [v('--bg')], 4.5], ['Accent text / card', v('--accent-text'), [v('--bg-raised')], 4.5], ['Accent text / accent tint', v('--accent-text'), [v('--bg-raised'), v('--accent-soft')], 4.5],
  ['Primary button label', v('--on-brand'), [v('--brand-solid')], 4.5], ['Primary button label (hover)', v('--on-brand'), [v('--brand-solid-hover')], 4.5], ['Accent fill label', v('--on-accent'), [v('--accent-solid')], 4.5],
  ['GREEN answer label', v('--on-green'), [v('--green')], 4.5], ['GREEN answer label (hover)', v('--on-green'), [v('--green-hover')], 4.5], ['RED answer label', v('--on-red'), [v('--red')], 4.5], ['RED answer label (hover)', v('--on-red'), [v('--red-hover')], 4.5],
  ['Amber / blue fill labels', v('--on-amber'), [v('--amber')], 4.5], ['Info fill label', v('--on-blue'), [v('--blue')], 4.5],
  ['Success text / card', v('--success-text'), [v('--bg-raised')], 4.5], ['Danger text / card', v('--danger-text'), [v('--bg-raised')], 4.5], ['Warning text / card', v('--warning-text'), [v('--bg-raised')], 4.5], ['Info text / card', v('--info-text'), [v('--bg-raised')], 4.5],
  ['Success text / tint', v('--success-text'), [v('--bg-raised'), v('--success-soft')], 4.5], ['Danger text / tint', v('--danger-text'), [v('--bg-raised'), v('--danger-soft')], 4.5], ['Warning text / tint', v('--warning-text'), [v('--bg-raised'), v('--warning-soft')], 4.5], ['Info text / tint', v('--info-text'), [v('--bg-raised'), v('--info-soft')], 4.5],
  ['Gold rank label', v('--on-gold'), [v('--gold')], 4.5], ['Silver rank label', v('--on-silver'), [v('--silver')], 4.5], ['Bronze rank label', v('--on-bronze'), [v('--bronze')], 4.5],
  ['UI: focus ring / page', v('--focus'), [v('--bg')], 3], ['UI: focus ring / card', v('--focus'), [v('--bg-raised')], 3],
  ['UI: primary fill / page', v('--brand-solid'), [v('--bg')], 3], ['UI: primary fill / card', v('--brand-solid'), [v('--bg-raised')], 3],
  ['UI: green answer / page', v('--green'), [v('--bg')], 3], ['UI: red answer / page', v('--red'), [v('--bg')], 3],
  ['UI: input border / input', v('--input-border'), [v('--input-bg')], 3], ['UI: input border / card', v('--input-border'), [v('--bg-raised')], 3],
];

/** swatch dot + hex; on phones the hex is hidden so that the ratio and the verdict stay visible without sideways scrolling */
const colourCell = (rgb) => el('span', { class: 'sg-colour', title: hex(rgb) }, el('i', { class: 'sg-dot', style: { background: hex(rgb) } }), el('span', { class: 'sg-hex' }, hex(rgb)));

function contrastReport() {
  const body = qs('#cr-table tbody');
  if (!body) return;
  let pass = 0, fail = 0;
  const rows = PAIRS.map(([label, fg, bgs, min]) => {
    const bg = composite(bgs.length ? bgs : [v('--bg')]);
    const f = composite([bgs[0], fg]);
    const r = ratio(f, bg);
    const ok = r >= min;
    ok ? pass++ : fail++;
    return el('tr', { dataset: { pass: ok, ratio: r.toFixed(2), min } },
      el('td', null, label), el('td', null, colourCell(f)), el('td', null, colourCell(bg)),
      el('td', { class: 'num' }, `${r.toFixed(2)}:1`), el('td', { class: 'num' }, `${min}:1`), el('td', null, el('span', { class: ok ? 'badge badge--success' : 'badge badge--danger' }, icon(ok ? 'check' : 'x', { size: 'sm' }), ok ? 'AA' : 'Fail')));
  });
  body.replaceChildren(...rows);
  qs('#cr-pass').textContent = `${pass} pass`;
  qs('#cr-fail').textContent = `${fail} fail`;
  document.documentElement.dataset.contrastFail = String(fail);
}

function initDocs() {
  // header + theme
  qs('#sg-theme-slot').append(createThemeToggle());
  qs('#sg-theme-seg').append(createThemeToggle({ variant: 'segmented' }));
  const langRadios = qsa('#sg-lang input');
  langRadios.forEach((r) => r.addEventListener('change', () => i18n.setLang(r.value)));
  i18n.onChange((l) => langRadios.forEach((r) => { r.checked = r.value === l; }));

  // presets + colour inputs
  const presetBox = qs('#sg-presets');
  const refreshPresets = () => presetBox.querySelectorAll('.sg-preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.primary === state.primary.toUpperCase())));
  presetBox.replaceChildren(...PRESETS.map((p) => el('button', { class: 'sg-preset', type: 'button', dataset: { primary: p.primary, key: p.key }, 'aria-pressed': 'false', on: { click: () => setBrand(p.primary, p.accent, p.title) } },
    el('span', { class: 'swatch', style: { '--swatch': p.primary, '--swatch-2': p.accent } }), p.name)));
  const pHex = qs('#sg-primary'), aHex = qs('#sg-accent'), pSw = qs('#sg-primary-sw'), aSw = qs('#sg-accent-sw');
  function setBrand(primary, accent, title) {
    state = { ...state, primary, accent, title: title || state.title };
    pHex.value = primary; aHex.value = accent; pSw.value = primary.toLowerCase(); aSw.value = accent.toLowerCase();
    applyState();
    refreshPresets();
  }
  initColorInputs(document);
  initRanges(document);
  const fromInputs = () => { if (/^#[0-9a-f]{6}$/i.test(pHex.value) && /^#[0-9a-f]{6}$/i.test(aHex.value)) { state = { ...state, primary: pHex.value.toUpperCase(), accent: aHex.value.toUpperCase() }; applyState(); refreshPresets(); } };
  [pHex, aHex, pSw, aSw].forEach((n) => n.addEventListener('input', fromInputs));
  qsa('#sg-bg input').forEach((r) => r.addEventListener('change', () => { state.bg = r.value; applyState(); }));
  qs(`#sg-bg input[value="${state.bg}"]`)?.click();
  pHex.value = state.primary; aHex.value = state.accent; pSw.value = state.primary.toLowerCase(); aSw.value = state.accent.toLowerCase();
  refreshPresets();

  // tokens
  qs('#sg-space').append(...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => el('div', null, el('i', { style: { inlineSize: `var(--space-${n})` } }), `--space-${n}`)));
  qs('#sg-radii').append(...['xs', 'sm', 'md', 'lg', 'xl', 'pill'].map((n) => el('div', { style: { borderRadius: `var(--radius-${n})` } }, n)));
  qs('#sg-shadows').append(...['xs', 'sm', 'md', 'lg', 'xl'].map((n) => el('div', { style: { boxShadow: `var(--shadow-${n})` } }, n)));
  const track = qs('.sg-track'), ball = qs('#sg-ball');
  qsa('.sg-motion').forEach((b) => b.addEventListener('click', () => {
    ball.style.transitionTimingFunction = `var(${b.dataset.ease})`;
    track.style.setProperty('--track-w', `${track.clientWidth}px`);
    track.classList.toggle('is-on');
  }));

  // chips
  qs('#sg-chips').append(...CATEGORIES.map(([n, c]) => chip(n, c)));

  // podium + leaderboard
  buildPodium(qs('#sg-podium'), PLAYERS);
  buildRows(qs('#sg-lb'), PLAYERS.slice(3, 8), { from: 4, you: 1 });

  // hub cards
  qs('#sg-events').append(...EVENTS.map((ev, i) => eventCard(ev, i)));

  // icons
  fetch(SPRITE_URL).then((r) => r.text()).then((svg) => {
    const ids = [...svg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
    qs('#sg-icon-count').textContent = `${ids.length} in the sprite`;
    const grid = qs('#sg-icons');
    const render = (q = '') => grid.replaceChildren(...ids.filter((id) => id.includes(q)).map((id) => el('button', { class: 'sg-icon', type: 'button', title: `Copy "${id}"`, on: { click: async () => { await copyToClipboard(id); toast(`Copied "${id}"`, { type: 'success', duration: 1500 }); } } }, icon(id), id)));
    render();
    qs('#sg-icon-filter').addEventListener('input', (e) => render(e.target.value.trim().toLowerCase()));
  }).catch(() => {});

  // components wiring
  initTabs(qs('#sg-tabs-demo'));
  initDropdowns(document);
  qsa('[data-toast]').forEach((b) => b.addEventListener('click', () => toast({ success: 'Event saved.', error: 'Could not reach the server.', warning: 'Bluetooth is unavailable.', info: 'Scoreboard is live at /ai-masters/scoreboard.' }[b.dataset.toast], { type: b.dataset.toast, title: { success: 'Saved', error: 'Error', warning: 'Heads up', info: 'Good to know' }[b.dataset.toast] })));
  qs('#sg-confirm').addEventListener('click', async () => toast((await confirmDialog({ title: 'Publish this event?', message: 'It will appear on the hub for everyone.', confirmLabel: 'Publish' })) ? 'Published' : 'Cancelled', { type: 'info' }));
  qs('#sg-danger').addEventListener('click', async () => { if (await confirmDialog({ title: 'Delete “AI Masters”?', message: 'All players, games and questions of this event will be permanently deleted.', confirmLabel: 'Delete event', tone: 'danger' })) toast('Event deleted', { type: 'error' }); });
  qs('#sg-modal').addEventListener('click', () => {
    openModal({ title: 'Duplicate event', description: 'Copies branding, rules, categories and questions. Never players or results.', icon: 'copy', content: el('div', { class: 'stack' },
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'dup-name' }, 'New event name'), el('input', { class: 'input', id: 'dup-name', value: 'AI Masters (copy)' })),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'dup-slug' }, 'Slug'), el('input', { class: 'input input--mono', id: 'dup-slug', value: 'ai-masters-copy' })),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'checkbox', checked: true }), el('span', { class: 'check__text' }, 'Copy questions')),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'checkbox', checked: true }), el('span', { class: 'check__text' }, 'Copy branding and rules'))),
    actions: [{ label: 'Cancel', variant: 'ghost' }, { label: 'Duplicate', variant: 'primary', onClick: () => toast('Event duplicated as a draft', { type: 'success' }) }] });
  });
  qs('#sg-announce').addEventListener('click', () => { announce('Correct! 148 points.'); toast('Announced to screen readers (aria-live).', { type: 'info' }); });
  qs('#sg-confetti').addEventListener('click', () => { celebrate(); countUp(qs('#sg-count'), 1284, { from: 0 }); });
  countUp(qs('#sg-count'), 1284, { duration: 1200 });
  qs('#sg-busy').addEventListener('click', (e) => withBusy(e.currentTarget, () => sleep(1600)));
  qs('#f-ind').indeterminate = true;
  qs('#f-range').addEventListener('input', (e) => { qs('#f-range-out').textContent = `${e.target.value} s`; });
  qs('#sg-form').addEventListener('submit', (e) => { e.preventDefault(); toast('Saved (demo)', { type: 'success' }); });
  const live = qs('#sg-ring-live');
  qs('#sg-ring-run').addEventListener('click', () => { live.dataset.state = 'ok'; runRing(live, 10); });

  // answer demo: click selects
  qsa('#sg-answers-demo .answers:first-child .answer').forEach((b) => b.addEventListener('click', () => {
    qsa('#sg-answers-demo .answers:first-child .answer').forEach((x) => { x.classList.toggle('is-selected', x === b); x.classList.toggle('is-dimmed', x !== b); });
    announce(b.querySelector('.answer__label').textContent);
  }));

  // iframes: lazy src + scale TV frames
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { const f = en.target; f.src = `${f.dataset.src}${f.dataset.src.includes('?') ? '&' : '?'}x=${Date.now() % 1000}`; io.unobserve(f); } }), { rootMargin: '400px' });
  qsa('iframe[data-src]').forEach((f) => io.observe(f));
  const fit = () => qsa('.sg-tv').forEach((box) => {
    const f = box.querySelector('iframe');
    const w = +f.dataset.w || 1920, h = +f.dataset.h || 1080;
    f.style.setProperty('--w', w); f.style.setProperty('--h', h);
    box.style.aspectRatio = `${w} / ${h}`;
    f.style.setProperty('--scale', String(box.clientWidth / w));
  });
  new ResizeObserver(fit).observe(document.body);
  fit();

  document.addEventListener('sg:brand', contrastReport);
  onThemeChange(() => requestAnimationFrame(contrastReport));
  i18n.onChange(() => requestAnimationFrame(contrastReport));
  applyState({ persist: false });
}

// frames follow the docs page when it changes brand/theme (same origin => storage events)
window.addEventListener('storage', (e) => { if (e.key === STATE_KEY && screenName && !preset0) { state = JSON.parse(e.newValue); applyState({ persist: false }); } });

if (screenName) mountScreen(screenName);
else { hydrateIcons(document); i18n.apply(document); initDocs(); hydrateIcons(document); }

// expose a tiny hook for the verification scripts (tools/verify-*.mjs)
window.__sg = { PRESETS, setBrand: (primary, accent, title) => { state = { ...state, primary, accent, title: title || state.title }; applyState({ persist: false }); }, computeBrandTokens, DEFAULT_BRANDING };
