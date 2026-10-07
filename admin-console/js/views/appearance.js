/**
 * Appearance tab: identity (game title, event name, slug), brand colours + look, public texts (EN/FR), place and dates,
 * with a LIVE PREVIEW of the hub card and of the landing page exactly as players see them.
 *
 * The preview is an iframe-less scoped copy: the draft branding goes through applyBranding(draft, { root: stage }) and the few tokens
 * that the design system only defines on <html> (neutral surfaces, status colours, fluid type) are re-declared on the stage in
 * appearance.css, so the admin's own theme and colours are never touched.
 * Contract: docs/ARCHITECTURE.md sections 3.1, 5.3 and the admin view contract.
 */
import { api as sharedApi } from '../../shared/js/api.js';
import { config, eventUrl } from '../../shared/js/config.js';
import { el, icon, hydrateIcons, uid, debounce, formatNumber, setBusy } from '../../shared/js/dom.js';
import { openModal, announce, initColorInputs } from '../../shared/js/ui.js';
import { applyBranding, computeBrandTokens, deriveAccent, DEFAULT_BRANDING, SURFACE_L } from '../../shared/js/branding.js';
import { contrast, hexToOklch, oklchToHex } from '../../shared/js/color.js';
import { getResolvedTheme, onThemeChange } from '../../shared/js/theme.js';

const LANGS = [['en', 'English'], ['fr', 'Français']];
const RESERVED = new Set('api admin assets shared css js vendor fonts static health docs openapi favicon robots scoreboard game events new login config index manifest sw'.split(' '));
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const URL_FORBIDDEN = /[\s<>"'`\\\u0000-\u001f\u007f]/;
const HEX6 = /^#[0-9a-f]{6}$/i;
const PRESETS = [
  { name: 'Gravitee orange', primary: '#FC5607', accent: '#FF9A52' },
  { name: 'AI violet', primary: '#7C5CFF', accent: '#22D3EE' },
  { name: 'Ocean blue', primary: '#2563EB', accent: '#38BDF8' },
  { name: 'Emerald', primary: '#0E9F6E', accent: '#A3E635' },
  { name: 'Magenta', primary: '#DB2777', accent: '#FB923C' },
  { name: 'Sunshine', primary: '#FFD60A', accent: '#FF006E' },
  { name: 'Deep navy', primary: '#0B2447', accent: '#19376D' },
  { name: 'Mint', primary: '#2EC4B6', accent: '#CBF3F0' },
];
const LIMITS = { game_title: 100, name: 200, hero_title: 200, tagline: 300, description: 4000, location: 200, logo_url: 500 };
const fmtN = (n) => formatNumber(n, { lang: 'en' });

function errorText(e) {
  if (!e) return 'Something went wrong';
  if (e.isNetwork) return 'Cannot reach the server. Check your connection and try again.';
  if (e.isTimeout) return 'The server took too long to answer.';
  return typeof e.detail === 'string' && e.detail ? e.detail : e.message || 'Something went wrong';
}

// ---------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------
/** Same rule as the backend (_validate_asset_url): https:// or a root-relative path. Returns an error message or ''. */
function logoError(v) {
  if (!v) return '';
  if (v.length > LIMITS.logo_url) return 'The URL is too long (500 characters at most).';
  if (URL_FORBIDDEN.test(v)) return 'The URL cannot contain spaces, quotes or angle brackets.';
  if (/^https:\/\/\S+/i.test(v) || (v.startsWith('/') && !v.startsWith('//'))) return '';
  return 'Use an https:// URL or a path starting with / (for example /assets/logo.svg).';
}
const isSafeImageUrl = (u) => typeof u === 'string' && !!u.trim() && !logoError(u.trim());

/** Local copies of web/js/lib/format.js helpers, so the preview titles are cut exactly like the landing page. */
const NBSP = '  ';
function splitHero(title) {
  const s = String(title || '').trim();
  if (!s) return ['', '', ''];
  const tail = `[${NBSP}\\s]*[!?.…]*`;
  let m = s.match(new RegExp(`^(.*?\\b(?:THE|LE|LA|LES|L['’]|UN|UNE)[${NBSP}\\s]+)(.+?)(${tail})$`, 'u'));
  if (m && m[2].trim()) return [m[1], m[2], m[3]];
  m = s.match(new RegExp(`^(.*[${NBSP}\\s])(\\S+?)(${tail})$`, 'u'));
  if (m && m[2]) return [m[1], m[2], m[3]];
  return [s, '', ''];
}
const singularTitle = (t) => String(t || '').replace(/(\w{2,}(?:er|or|ard|ist|ion))s$/iu, '$1');
function formatDates(lang, a, b) {
  const day = (v) => { if (!v) return null; const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? null : d; };
  const x = day(a), y = day(b);
  if (!x && !y) return '';
  const f = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (!x || !y || x.getTime() === y.getTime()) return f.format(x || y);
  return typeof f.formatRange === 'function' ? f.formatRange(x, y) : `${f.format(x)} - ${f.format(y)}`;
}

const PV = {
  en: { heroDefault: 'Become THE {title}!', play: 'Play now', playShort: 'Play', scoreboard: 'Scoreboard', live: 'Live', questions: 'Questions', seconds: 'Seconds each', players: 'Players so far', playersLive: 'Live', topics: 'Topics', keys: 'Playing on a keyboard? Press G for green and R for red.', powered: 'Powered by', language: 'Language', theme: 'Theme' },
  fr: { heroDefault: 'Devenez LE {title} !', play: 'Jouer maintenant', playShort: 'Jouer', scoreboard: 'Classement', live: 'En direct', questions: 'Questions', seconds: 'Secondes chacune', players: 'Joueurs jusqu’ici', playersLive: 'En direct', topics: 'Thèmes', keys: 'Sur un clavier ? Appuyez sur G pour le vert et sur R pour le rouge.', powered: 'Propulsé par', language: 'Langue', theme: 'Thème' },
};
const pick = (obj, key, lang) => (lang === 'fr' && obj[`${key}_fr`] && String(obj[`${key}_fr`]).trim() ? String(obj[`${key}_fr`]).trim() : String(obj[`${key}_en`] || '').trim());

/** Readability report of a brand colour pair, computed with the design system's own solver. */
function analyse(primary, accent) {
  const t = computeBrandTokens(primary, accent);
  const raw = hexToOklch(t.brand);
  const acc = hexToOklch(t.accent);
  const themes = ['dark', 'light'].map((theme) => {
    const k = theme === 'dark' ? 'd' : 'l';
    const S = SURFACE_L[theme];
    const tint = theme === 'dark' ? t.tintC : t.tintC * 0.5;
    const raised = oklchToHex({ l: S.raised, c: tint, h: t.hue });
    const solid = t.vars[`--brand-solid-${k}`], on = t.vars[`--on-brand-${k}`], text = t.vars[`--brand-text-${k}`];
    return {
      theme, solid, on, text,
      label: contrast(solid, on), link: contrast(text, raised), shape: contrast(solid, raised),
      shift: Math.abs(hexToOklch(solid).l - raw.l),
      aurora: parseFloat(t.vars[`--aurora-strength-${k}`]),
    };
  });
  const ab = (o) => [o.c * Math.cos((o.h * Math.PI) / 180), o.c * Math.sin((o.h * Math.PI) / 180)];
  const [pa, pb] = ab(raw), [qa, qb] = ab(acc);
  const distance = Math.hypot(raw.l - acc.l, pa - qa, pb - qb);
  return { tokens: t, themes, chroma: raw.c, lightness: raw.l, distance };
}
const grade = (ratio) => (ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : 'Fail');

// ---------------------------------------------------------------------------------------------
// live preview (hub card + landing page)
// ---------------------------------------------------------------------------------------------
const FRAMES = { phone: { w: 390, h: 780, vw: 3.9, vh: 7.8, vmax: 8.44 }, desktop: { w: 1280, h: 720, vw: 12.8, vh: 7.2, vmax: 12.8 } };

function createPreview({ getDraft, getEvent, getCats, getLanguages, initial = {} }) {
  const state = { view: 'landing', frame: 'phone', lang: 'en', theme: null, ...initial };
  const name = uid('ap-pv');
  // purely visual: hidden from assistive technology and not focusable (the controls above describe what it shows)
  const stage = el('div', { class: 'ap-stage', 'data-brand-scope': '', 'aria-hidden': 'true', inert: '' });
  const scroll = el('div', { class: 'ap-scroll' });
  const fit = el('div', { class: 'ap-fit' }, stage);
  stage.append(scroll);
  const chromeBar = el('div', { class: 'ap-device__chrome', 'aria-hidden': 'true' }, el('span', { class: 'ap-dots' }, el('i'), el('i'), el('i')), el('span', { class: 'ap-url' }, icon('lock', { size: 'sm' }), el('span', { class: 'ap-url__text' })));
  const device = el('div', { class: 'ap-device' }, chromeBar, fit);

  const radio = (group, label, options, current, onPick, { sm = true, iconOnly = false } = {}) => {
    const n = `${name}-${group}`;
    const inputs = options.map(([value]) => el('input', { type: 'radio', name: n, value, checked: value === current }));
    const box = el('div', { class: ['segmented', sm && 'segmented--sm'], role: 'radiogroup', 'aria-label': label },
      ...options.map(([value, text, ic], i) => el('label', { title: text }, inputs[i], el('span', null, ic ? icon(ic) : null, el('span', { class: iconOnly ? 'u-sr-only' : null }, text)))));
    box.addEventListener('change', (e) => { if (e.target.name === n) onPick(e.target.value); });
    return { box, set(v) { inputs.forEach((i) => { i.checked = i.value === v; }); } };
  };

  const viewSeg = radio('view', 'Page to preview', [['landing', 'Landing', 'rocket-launch'], ['hub', 'Hub card', 'squares-four']], state.view, (v) => { state.view = v; render(); });
  const frameSeg = radio('frame', 'Device', [['phone', 'Phone', 'device-mobile'], ['desktop', 'Desktop', 'desktop']], state.frame, (v) => { state.frame = v; layout(); render(); }, { iconOnly: true });
  let langSeg = null;
  const langHost = el('span', { class: 'ap-lang' });
  const themeSeg = radio('theme', 'Preview theme', [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun']], 'dark', (v) => { state.theme = v; paintBrand(); render(); }, { iconOnly: true });
  const bar = el('div', { class: 'ap-preview__bar' }, viewSeg.box, frameSeg.box, langHost, themeSeg.box);
  const note = el('p', { class: 'ap-preview__note' });
  const node = el('div', { class: 'ap-preview' }, bar, device, note);

  // -- scaling: the stage always lays out at the real viewport width (390 / 1280 px) and is scaled to fit the pane
  let ro = null;
  function layout() {
    const f = FRAMES[state.frame];
    device.dataset.frame = state.frame;
    stage.dataset.frame = state.frame;
    const avail = device.clientWidth - (state.frame === 'phone' ? 20 : 2);
    const k = avail > 0 ? Math.min(1, avail / f.w) : 1;
    stage.style.setProperty('--pv-scale', String(k));
    stage.style.setProperty('--pv-w', `${f.w}px`);
    stage.style.setProperty('--pv-h', `${f.h}px`);
    stage.style.setProperty('--pv-vw', String(f.vw));
    stage.style.setProperty('--pv-vh', String(f.vh));
    stage.style.setProperty('--pv-vmax', String(f.vmax));
    fit.style.inlineSize = `${f.w * k}px`;
    fit.style.blockSize = `${f.h * k}px`;
  }
  ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(device);

  const themeNow = () => {
    if (state.theme) return state.theme;
    const d = getDraft().branding.default_theme;
    return d === 'light' || d === 'dark' ? d : getResolvedTheme();
  };

  /** brand variables + theme + background of the stage */
  function paintBrand() {
    const b = getDraft().branding;
    const primary = HEX6.test(b.primary_color) ? b.primary_color : DEFAULT_BRANDING.primary_color;
    const accent = HEX6.test(b.accent_color) ? b.accent_color : DEFAULT_BRANDING.accent_color;
    const out = applyBranding({ branding: { primary_color: primary, accent_color: accent, background_style: b.background_style, default_theme: 'dark' } }, { root: stage });
    for (const [k, v] of Object.entries(out.vars)) stage.style.setProperty(k, v);
    stage.style.setProperty('--brand-h', String(Math.round(out.hue * 10) / 10));
    stage.style.setProperty('--tint-c', String(Math.round(out.tintC * 1000) / 1000));
    stage.dataset.bg = ['aurora', 'grid', 'plain'].includes(b.background_style) ? b.background_style : 'aurora';
    const th = themeNow();
    stage.dataset.pvTheme = th;
    themeSeg.set(th);
  }

  // -- content ----------------------------------------------------------------------------------
  const L = () => PV[state.lang] || PV.en;
  function appbar(d) {
    const logo = isSafeImageUrl(d.branding.logo_url) ? d.branding.logo_url.trim() : null;
    const langs = getLanguages();
    const sw = langs.length > 1 ? el('div', { class: 'segmented segmented--sm lang-switch', role: 'group', 'aria-label': L().language },
      ...langs.map((c) => el('label', null, el('input', { type: 'radio', tabindex: '-1', checked: c === state.lang, disabled: true }), el('span', { 'aria-hidden': 'true' }, c.toUpperCase())))) : null;
    return el('header', { class: 'appbar' },
      el('div', { class: 'appbar__brand' }, el('span', { class: 'brand' },
        el('img', { class: 'brand__mark', src: new URL('../../shared/img/gravitee-mark.svg', import.meta.url).href, alt: '', width: 30, height: 30 }),
        el('span', { class: 'brand__name' }, d.game_title || 'Game title'),
        logo ? el('span', { class: 'brand__sep', 'aria-hidden': 'true' }) : null,
        logo ? el('img', { class: 'brand__event-logo', src: logo, alt: '', on: { error: (e) => { e.currentTarget.previousElementSibling?.remove(); e.currentTarget.remove(); } } }) : null)),
      el('span', { class: 'appbar__spacer' }),
      el('div', { class: 'appbar__actions' }, sw, el('span', { class: 'btn btn--ghost btn--icon', 'aria-hidden': 'true' }, icon(themeNow() === 'light' ? 'sun' : 'moon'))));
  }

  function footer() {
    const th = themeNow();
    const logo = new URL(`../../shared/img/gravitee-horizontal-on-${th === 'light' ? 'light' : 'dark'}.svg`, import.meta.url).href;
    return el('footer', { class: 'footer' }, el('span', null, L().powered), el('span', { class: 'footer__logo' }, el('img', { class: 'logo', src: logo, alt: '' })));
  }

  function emblem(d) {
    const logo = isSafeImageUrl(d.branding.logo_url) ? d.branding.logo_url.trim() : null;
    return el('div', { class: 'ev-emblem' },
      logo ? el('img', { class: 'ev-emblem__logo', src: logo, alt: '', on: { error: (e) => { e.currentTarget.nextElementSibling?.remove(); e.currentTarget.remove(); } } }) : null,
      logo ? el('span', { class: 'ev-emblem__x', 'aria-hidden': 'true' }, icon('x', { size: 'sm' })) : null,
      el('span', { class: 'ev-emblem__mark' }, el('img', { src: new URL('../../shared/img/gravitee-mark.svg', import.meta.url).href, alt: '', width: 40, height: 40 })));
  }

  function statTile(label, value, ic, tone, live) {
    return el('div', { class: ['stat', tone && `stat--${tone}`] },
      el('div', { class: 'stat__head' }, el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__icon' }, icon(ic))),
      el('div', { class: 'stat__value u-tabular' }, value),
      live ? el('div', { class: 'stat__sub ev-live' }, el('span', { class: 'status-dot', 'data-state': 'on', 'aria-hidden': 'true' }), live) : null);
  }

  function landing(d) {
    const ev = getEvent();
    const where = [d.location.trim(), formatDates(state.lang, d.starts_on, d.ends_on)].filter(Boolean).join(' · ');
    const custom = pick(d, 'hero_title', state.lang);
    const [pre, em, post] = splitHero(custom || L().heroDefault.replace('{title}', singularTitle(d.game_title || 'Game')));
    const tagline = pick(d, 'tagline', state.lang);
    const description = pick(d, 'description', state.lang);
    const cats = getCats().filter((c) => c.is_active && c.question_count > 0);
    const s = ev.settings || {};
    return el('div', { class: 'screen' },
      appbar(d),
      el('main', { class: 'screen__main container' },
        el('div', { class: 'ev-landing' },
          el('section', { class: 'hero ev-hero' },
            emblem(d),
            where ? el('span', { class: 'hero__eyebrow' }, icon('map-pin'), el('span', null, where)) : null,
            el('h1', { class: 'hero__title' }, pre, em ? el('em', null, em) : null, post),
            tagline ? el('p', { class: 'hero__tagline' }, tagline) : null,
            el('div', { class: 'hero__actions' },
              el('span', { class: 'btn btn--primary btn--xl ev-play' }, L().play, icon('arrow-right')),
              el('span', { class: 'btn btn--secondary btn--lg' }, icon('trophy'), L().scoreboard)),
            description && description !== tagline ? el('p', { class: 'ev-description' }, description) : null,
            cats.length ? el('div', { class: 'ev-topics' }, el('h2', { class: 'u-eyebrow' }, L().topics),
              el('ul', { class: 'chips ev-chips', role: 'list' }, cats.map((c) => el('li', null, el('span', { class: 'chip', style: { '--chip': /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : 'var(--fg-muted)' } }, state.lang === 'fr' && c.name_fr ? c.name_fr : c.name, el('span', { class: 'ev-chip__n' }, fmtN(c.question_count))))))) : null),
          el('div', { class: 'stats ev-stats' },
            statTile(L().questions, fmtN(s.questions_per_game ?? 15), 'list-checks'),
            statTile(L().seconds, fmtN(s.timer_seconds ?? 20), 'timer', 'accent'),
            statTile(L().players, fmtN(ev.counts?.players ?? 0), 'users-three', 'success', L().playersLive)),
          el('p', { class: 'ev-keys-hint u-hide-touch' }, icon('keyboard'), el('span', null, L().keys)))),
      footer());
  }

  function hubCard(d) {
    const tagline = pick(d, 'tagline', state.lang);
    const dates = formatDates(state.lang, d.starts_on, d.ends_on);
    const showName = d.name.trim() && d.name.trim().toLowerCase() !== d.game_title.trim().toLowerCase();
    const logo = isSafeImageUrl(d.branding.logo_url) ? d.branding.logo_url.trim() : null;
    const meta = [
      d.location.trim() ? el('span', null, icon('map-pin', { size: 'sm' }), d.location.trim()) : null,
      dates ? el('span', null, icon('calendar-blank', { size: 'sm' }), dates) : null,
    ].filter(Boolean);
    return el('div', { class: 'ap-hub' },
      el('article', { class: 'hub-card' },
        el('div', { class: 'hub-card__banner' },
          el('span', { class: 'badge badge--dot hub-card__status' }, L().live),
          logo ? el('img', { class: 'hub-card__logo', src: logo, alt: '', on: { error: (e) => e.currentTarget.remove() } }) : null,
          el('h2', { class: 'hub-card__wordmark' }, el('span', { class: 'hub-card__link' }, d.game_title || 'Game title'))),
        el('div', { class: 'hub-card__main' },
          el('div', { class: 'hub-card__body' },
            showName ? el('p', { class: 'hub-card__event' }, d.name) : null,
            meta.length ? el('div', { class: 'hub-card__meta' }, ...meta) : null,
            tagline ? el('p', { class: 'hub-card__tagline' }, tagline) : null),
          el('div', { class: 'hub-card__actions' },
            el('span', { class: 'btn btn--primary' }, L().playShort, icon('arrow-right')),
            el('span', { class: 'btn btn--secondary' }, icon('trophy'), L().scoreboard)))));
  }

  let langSig = '';
  let lastView = '';
  function render() {
    const d = getDraft();
    const ev = getEvent();
    const langs = getLanguages();
    if (!langs.includes(state.lang)) state.lang = langs.includes(ev.default_language) ? ev.default_language : langs[0] || 'en';
    // language switch (only when the event has 2 languages); rebuilt only when the list changes so focus survives a click
    if (langSig !== langs.join()) {
      langSig = langs.join();
      langHost.replaceChildren();
      langSeg = null;
      if (langs.length > 1) {
        langSeg = radio('lang', 'Preview language', LANGS.filter(([c]) => langs.includes(c)).map(([c]) => [c, c.toUpperCase()]), state.lang, (v) => { setLang(v, true); });
        langHost.append(langSeg.box);
      }
    }
    langSeg?.set(state.lang);
    themeSeg.set(themeNow());
    const top = lastView === state.view ? scroll.scrollTop : 0;
    lastView = state.view;
    chromeBar.querySelector('.ap-url__text').textContent = `${new URL(config.publicBaseUrl || location.origin).host}/${state.view === 'hub' ? '' : d.slug || ev.slug}`;
    scroll.replaceChildren(state.view === 'hub' ? hubCard(d) : landing(d));
    scroll.scrollTop = top;
    hydrateIcons(scroll);
    note.textContent = state.view === 'hub'
      ? 'The card as listed on the hub when the event is live.'
      : 'The landing page as players see it when the event is live. Counters use the real data of this event.';
  }

  function setLang(code, fromPreview = false) {
    state.lang = code;
    render();
    if (fromPreview) node.dispatchEvent(new CustomEvent('ap:lang', { detail: code, bubbles: false }));
  }

  const offTheme = onThemeChange(() => { if (!state.theme) { paintBrand(); render(); } });

  return {
    node,
    state,
    setLang(code) { if (code !== state.lang) setLang(code); },
    /** colours only: no DOM rebuild */
    updateBrand() { paintBrand(); },
    update() { layout(); paintBrand(); render(); },
    destroy() { ro?.disconnect(); offTheme?.(); },
  };
}

// ---------------------------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------------------------
export default {
  id: 'appearance',
  title: 'Appearance',
  icon: 'palette',

  async mount(root, ctx) {
    const api = ctx.api || sharedApi;
    const eventId = ctx.eventId;
    let alive = true;
    let cats = [];
    let baseline = null;
    let draft = null;
    let dirty = false;
    let saving = false;
    let submitted = false;
    let rafId = 0;
    const touched = new Set();
    const serverErrors = {};
    const hexText = {};       // what is typed in the two hex boxes (valid or not)
    const fields = {};
    const disposers = [];
    const previews = new Set();

    try { cats = await api.get(`/admin/events/${eventId}/categories`); } catch { cats = []; }
    if (!alive) return { unmount() {} };

    // ------------------------------------------------------------------------------------------
    // draft model
    // ------------------------------------------------------------------------------------------
    const TEXT_KEYS = ['game_title', 'name', 'slug', 'hero_title_en', 'hero_title_fr', 'tagline_en', 'tagline_fr', 'description_en', 'description_fr', 'location', 'starts_on', 'ends_on'];
    const NULLABLE = new Set(['hero_title_en', 'hero_title_fr', 'tagline_en', 'tagline_fr', 'description_en', 'description_fr', 'location', 'starts_on', 'ends_on']);
    const BRANDING_KEYS = ['primary_color', 'accent_color', 'background_style', 'default_theme', 'logo_url', 'show_join_qr'];

    function fromEvent(ev) {
      const d = {};
      for (const k of TEXT_KEYS) d[k] = ev[k] === null || ev[k] === undefined ? '' : String(ev[k]);
      const b = { ...DEFAULT_BRANDING, ...(ev.branding || {}) };
      d.branding = {
        primary_color: String(b.primary_color).toUpperCase(), accent_color: String(b.accent_color).toUpperCase(),
        background_style: b.background_style, default_theme: b.default_theme, logo_url: b.logo_url || '',
        show_join_qr: b.show_join_qr !== false,
      };
      return d;
    }
    const languages = () => (ctx.getEvent().languages || ['en']);

    function buildPatch(d, b) {
      const patch = {};
      for (const k of TEXT_KEYS) {
        const a = d[k].trim(), c = b[k].trim();
        if (a !== c) patch[k] = NULLABLE.has(k) ? (a || null) : a;
      }
      const br = {};
      for (const k of BRANDING_KEYS) {
        const a = String(d.branding[k] ?? '').trim(), c = String(b.branding[k] ?? '').trim();
        if (a !== c) br[k] = k === 'logo_url' ? (a || null) : k === 'show_join_qr' ? a === 'true' : a;
      }
      if (Object.keys(br).length) patch.branding = br;
      return patch;
    }

    function validate(d) {
      const e = {};
      const req = (k, label, max) => { const v = d[k].trim(); if (!v) e[k] = `${label} is required.`; else if (v.length > max) e[k] = `At most ${fmtN(max)} characters (currently ${fmtN(v.length)}).`; };
      req('game_title', 'The game title', LIMITS.game_title);
      req('name', 'The event name', LIMITS.name);
      const slug = d.slug.trim();
      if (!slug) e.slug = 'The slug is required.';
      else if (slug.length < 2 || slug.length > 48) e.slug = 'The slug must be 2 to 48 characters long.';
      else if (!SLUG_RE.test(slug)) e.slug = 'Use lowercase letters, digits and single hyphens (no hyphen at the start, at the end or doubled).';
      else if (RESERVED.has(slug)) e.slug = `"${slug}" is reserved by the platform, pick another slug.`;
      for (const [k, max] of [['hero_title_en', LIMITS.hero_title], ['hero_title_fr', LIMITS.hero_title], ['tagline_en', LIMITS.tagline], ['tagline_fr', LIMITS.tagline], ['description_en', LIMITS.description], ['description_fr', LIMITS.description], ['location', LIMITS.location]]) {
        if (d[k].trim().length > max) e[k] = `At most ${fmtN(max)} characters (currently ${fmtN(d[k].trim().length)}).`;
      }
      if (d.starts_on && d.ends_on && d.ends_on < d.starts_on) e.ends_on = 'The end date cannot be before the start date.';
      for (const k of ['primary_color', 'accent_color']) { const raw = hexText[k] ?? d.branding[k]; if (!HEX6.test(raw)) e[k] = raw ? 'Use a 6-digit hex colour such as #FC5607.' : 'The colour is required.'; }
      const le = logoError(d.branding.logo_url.trim());
      if (le) e.logo_url = le;
      return e;
    }

    // ------------------------------------------------------------------------------------------
    // builders
    // ------------------------------------------------------------------------------------------
    function shell(key, { label, help, optional }) {
      const id = uid(`ap-${key}`);
      const err = el('p', { class: 'field__error', id: `${id}-err`, hidden: true }, icon('warning-circle', { size: 'sm' }), el('span', { class: 'ap-err-text' }));
      const helpEl = help ? el('p', { class: 'field__help', id: `${id}-help` }, help) : null;
      const node = el('div', { class: 'field' }, label ? el('label', { class: 'field__label', for: id }, label, optional ? ' ' : null, optional ? el('span', { class: 'field__optional' }, optional) : null) : null);
      return { id, err, helpEl, node, describedBy: [help ? `${id}-help` : null, `${id}-err`].filter(Boolean).join(' ') };
    }
    function register(key, s, control) {
      fields[key] = {
        node: s.node,
        setError(msg) { s.err.hidden = !msg; s.err.querySelector('.ap-err-text').textContent = msg || ''; s.node.classList.toggle('field--invalid', !!msg); control.setAttribute('aria-invalid', String(!!msg)); },
        focus() { control.focus(); },
      };
    }

    /** text-like control bound to draft[key] (or draft.branding[key] when path = 'branding') */
    function textField(key, { label, help, optional, textarea, rows = 3, type = 'text', mono, maxlength, placeholder, autocomplete, path, lang, counter, inputMode }) {
      const s = shell(key, { label, help, optional });
      const target = () => (path ? draft[path] : draft);
      const control = textarea
        ? el('textarea', { class: 'textarea', id: s.id, rows, placeholder, lang, 'aria-describedby': s.describedBy })
        : el('input', { class: ['input', mono && 'input--mono'], id: s.id, type, placeholder, autocomplete: autocomplete || 'off', spellcheck: 'false', lang, inputmode: inputMode, 'aria-describedby': s.describedBy });
      const count = counter ? el('span', { class: 'ap-count', 'aria-hidden': 'true' }) : null;
      const updateCount = () => { if (count) { const n = control.value.length; count.textContent = `${fmtN(n)} / ${fmtN(counter)}`; count.classList.toggle('is-over', n > counter); } };
      control.addEventListener('input', () => { target()[key] = control.value; updateCount(); changed(key); });
      control.addEventListener('blur', () => { touched.add(key); refreshErrors(); });
      s.node.append(...[control, count, s.helpEl, s.err].filter(Boolean));
      register(key, s, control);
      return { node: s.node, control, sync() { control.value = target()[key] ?? ''; updateCount(); } };
    }

    function segmented(key, { label, options, path = 'branding', help }) {
      const name = uid(`ap-${key}`);
      const labelId = `${name}-l`;
      const inputs = options.map(([value]) => el('input', { type: 'radio', name, value }));
      const group = el('div', { class: 'segmented segmented--block', role: 'radiogroup', 'aria-labelledby': labelId },
        ...options.map(([value, text, ic], i) => el('label', null, inputs[i], el('span', null, ic ? icon(ic) : null, text))));
      const helpEl = help ? el('p', { class: 'field__help' }, help) : null;
      const node = el('div', { class: 'field' }, el('span', { class: 'field__label', id: labelId }, label), group, helpEl);
      group.addEventListener('change', (e) => { if (e.target.name === name) { draft[path][key] = e.target.value; changed(key, { color: key === 'background_style' }); } });
      return { node, helpEl, sync() { inputs.forEach((i) => { i.checked = i.value === draft[path][key]; }); } };
    }

    /** on/off switch bound to draft.branding[key] (a boolean) */
    function switchField(key, { label, help, path = 'branding' }) {
      const id = uid(`ap-${key}`);
      const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch', id });
      const helpEl = help ? el('p', { class: 'field__help', id: `${id}-h` }, help) : null;
      if (helpEl) input.setAttribute('aria-describedby', helpEl.id);
      const node = el('div', { class: 'field ap-switch' },
        el('label', { class: 'ap-switch__row', for: id }, input, el('span', { class: 'field__label' }, label)),
        helpEl);
      input.addEventListener('change', () => { draft[path][key] = input.checked; changed(key); });
      return { node, sync() { input.checked = draft[path][key] !== false; } };
    }

    function card(titleText, sub, ic, ...children) {
      const id = uid('ap-card');
      return el('section', { class: 'card ap-card stack', 'aria-labelledby': id },
        el('header', { class: 'ap-card__head' }, el('span', { class: 'ap-card__icon' }, icon(ic)), el('div', null, el('h2', { class: 'card__title', id }, titleText), sub ? el('p', { class: 'card__sub' }, sub) : null)),
        ...children);
    }

    // ------------------------------------------------------------------------------------------
    // 1. identity
    // ------------------------------------------------------------------------------------------
    const fTitle = textField('game_title', { label: 'Game title', help: 'The brand players see: "API Masters", "AI Masters"…', maxlength: LIMITS.game_title });
    const fName = textField('name', { label: 'Event name', help: 'For example the conference: "World Summit AI, Amsterdam 2026".' });
    const fSlug = textField('slug', { label: 'Slug', mono: true, help: 'Used in the public address of the event.' });
    const slugUrl = el('p', { class: 'ap-url-line' });
    const slugWarn = el('div', { class: 'alert alert--warning', role: 'status', hidden: true }, el('span', { class: 'alert__icon' }, icon('warning-fill')),
      el('div', null, el('p', { class: 'alert__title' }, 'Renaming the slug changes the public address'),
        el('p', { class: 'alert__text ap-slugwarn-text' })));
    fSlug.node.insertBefore(slugUrl, fSlug.node.querySelector('.field__error'));
    const identityCard = card('Identity', 'Names and public address of the event.', 'identification-badge',
      el('div', { class: 'form-grid' }, fTitle.node, fName.node, el('div', { class: 'field--full field' }, fSlug.node, slugWarn)));

    // ------------------------------------------------------------------------------------------
    // 2. colours & look
    // ------------------------------------------------------------------------------------------
    const presetBox = el('div', { class: 'ap-presets', role: 'group', 'aria-label': 'Colour presets' });
    const presetBtns = PRESETS.map((p) => {
      const b = el('button', { type: 'button', class: 'ap-preset', 'aria-pressed': 'false', title: `${p.name}: ${p.primary} + ${p.accent}`, dataset: { primary: p.primary, accent: p.accent } },
        el('span', { class: 'swatch', style: { '--swatch': p.primary, '--swatch-2': p.accent }, 'aria-hidden': 'true' }), el('span', { class: 'ap-preset__name' }, p.name));
      b.addEventListener('click', () => { draft.branding.primary_color = p.primary; draft.branding.accent_color = p.accent; syncColors(); changed('primary_color', { color: true, touch: true }); announce(`${p.name} colours applied`); });
      return b;
    });
    presetBox.append(...presetBtns);

    function colorField(key, { label, help }) {
      const s = shell(key, { label, help });
      const swatch = el('input', { type: 'color', class: 'color-input__swatch', 'aria-label': `${label} picker` });
      const hex = el('input', { class: 'input color-input__hex', id: s.id, maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': s.describedBy });
      const wrap = el('div', { class: 'color-input' }, swatch, hex);
      swatch.addEventListener('input', () => {
        draft.branding[key] = swatch.value.toUpperCase(); hexText[key] = draft.branding[key]; hex.value = draft.branding[key];
        changed(key, { color: true });
      });
      hex.addEventListener('input', () => {
        if (/^[0-9a-f]{6}$/i.test(hex.value.trim())) hex.value = `#${hex.value.trim()}`;
        const v = hex.value.trim();
        hexText[key] = v;
        if (HEX6.test(v)) { draft.branding[key] = v.toUpperCase(); swatch.value = v.toLowerCase(); }
        changed(key, { color: true });
      });
      hex.addEventListener('blur', () => { touched.add(key); if (HEX6.test(hex.value.trim())) hex.value = hex.value.trim().toUpperCase(); refreshErrors(); });
      s.node.append(...[wrap, s.helpEl, s.err].filter(Boolean));
      register(key, s, hex);
      return { node: s.node, hex, swatch, sync() { hexText[key] = draft.branding[key]; hex.value = draft.branding[key]; swatch.value = HEX6.test(draft.branding[key]) ? draft.branding[key].toLowerCase() : '#000000'; } };
    }
    const fPrimary = colorField('primary_color', { label: 'Primary colour', help: 'Buttons, highlights and the hub card banner.' });
    const fAccent = colorField('accent_color', { label: 'Accent colour', help: 'Gradients and secondary highlights.' });
    const suggestBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--sm ap-suggest' }, icon('magic-wand'), 'Suggest an accent');
    suggestBtn.addEventListener('click', () => { draft.branding.accent_color = deriveAccent(draft.branding.primary_color).toUpperCase(); syncColors(); changed('accent_color', { color: true, touch: true }); });
    fAccent.node.append(suggestBtn);

    const contrastBox = el('div', { class: 'ap-contrast stack stack--sm', 'aria-live': 'polite' });
    const fBg = segmented('background_style', { label: 'Background', options: [['aurora', 'Aurora', 'sparkle'], ['grid', 'Grid', 'table'], ['plain', 'Plain', 'circle']] });
    const fQr = switchField('show_join_qr', { label: 'Show the “Scan to play” QR code on the scoreboard', help: 'Turn this off for an event that is only played at the booth: the scoreboard then shows no QR code and no join address.' });
    const fTheme = segmented('default_theme', { label: 'Default theme', options: [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], help: 'What players see first. They can switch themes themselves.' });

    // logo
    const fLogo = textField('logo_url', { label: 'Logo URL', optional: 'optional', path: 'branding', type: 'url', placeholder: 'Address of your logo image', help: 'Shown next to the Gravitee mark. https:// or a path starting with /. SVG or PNG with a transparent background works best.' });
    const logoPreview = el('div', { class: 'ap-logo', hidden: true }, el('span', { class: 'ap-logo__tile' }), el('span', { class: 'ap-logo__status' }));
    fLogo.node.insertBefore(logoPreview, fLogo.node.querySelector('.field__help'));
    let logoSeq = 0;
    const checkLogo = debounce(() => {
      const url = draft.branding.logo_url.trim();
      const seq = ++logoSeq;
      if (!url || logoError(url)) { logoPreview.hidden = true; return; }
      logoPreview.hidden = false;
      const status = logoPreview.querySelector('.ap-logo__status');
      const tile = logoPreview.querySelector('.ap-logo__tile');
      status.textContent = 'Loading…'; status.dataset.state = 'loading'; tile.replaceChildren();
      const img = new Image();
      img.alt = '';
      img.onload = () => { if (seq !== logoSeq || !alive) return; tile.replaceChildren(img); status.textContent = `Image loaded (${img.naturalWidth} × ${img.naturalHeight})`; status.dataset.state = 'ok'; };
      img.onerror = () => { if (seq !== logoSeq || !alive) return; tile.replaceChildren(icon('image')); status.textContent = 'This URL does not load an image. Players will see the default Gravitee mark.'; status.dataset.state = 'error'; };
      img.src = url;
    }, 450);

    const lookCard = card('Colours & look', 'Pick two colours: every shade, glow and contrast is derived automatically for light and dark.', 'palette',
      el('div', { class: 'field' }, el('span', { class: 'field__label', id: 'ap-presets-l' }, 'Presets'), presetBox),
      el('div', { class: 'form-grid' }, fPrimary.node, fAccent.node),
      contrastBox,
      el('div', { class: 'form-grid' }, fBg.node, fTheme.node),
      fQr.node,
      fLogo.node);

    // ------------------------------------------------------------------------------------------
    // 3. public texts (EN / FR tabs)
    // ------------------------------------------------------------------------------------------
    const textTabs = el('div', { class: 'tabs tabs--pill ap-tabs', role: 'tablist', 'aria-label': 'Language of the texts' });
    const langFields = {};
    const langPanels = {};
    let textLang = 'en';
    for (const [code, name] of LANGS) {
      langFields[code] = {
        hero: textField(`hero_title_${code}`, { label: 'Headline', optional: 'optional', lang: code, counter: LIMITS.hero_title, placeholder: code === 'en' ? 'Become THE Ultimate AI Master!' : 'Devenez LE Maître de l’IA !', help: 'Leave empty for the default "Become THE {game title}!". The part after "THE" is highlighted.' }),
        tagline: textField(`tagline_${code}`, { label: 'Tagline', optional: 'optional', textarea: true, rows: 2, lang: code, counter: LIMITS.tagline, help: 'One sentence under the headline and on the hub card.' }),
        description: textField(`description_${code}`, { label: 'Description', optional: 'optional', textarea: true, rows: 4, lang: code, counter: LIMITS.description, help: 'A short paragraph on the landing page.' }),
      };
      const tabId = uid('ap-tab'), panelId = uid('ap-panel');
      const tab = el('button', { type: 'button', class: 'tabs__tab', role: 'tab', id: tabId, 'aria-controls': panelId, 'aria-selected': 'false', tabindex: '-1', dataset: { lang: code } }, name);
      textTabs.append(tab);
      langPanels[code] = { tab, panel: el('div', { class: 'tabpanel stack', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, hidden: true }, langFields[code].hero.node, langFields[code].tagline.node, langFields[code].description.node) };
    }
    function selectTextLang(code, { fromPreview = false, focus = false } = {}) {
      const langs = languages();
      if (!langs.includes(code)) code = langs[0];
      textLang = code;
      for (const [c, p] of Object.entries(langPanels)) {
        const on = c === code;
        p.tab.setAttribute('aria-selected', String(on)); p.tab.tabIndex = on ? 0 : -1; p.panel.hidden = !on;
        p.tab.hidden = !langs.includes(c);
      }
      textTabs.hidden = langs.length < 2;
      if (!fromPreview) for (const pv of previews) pv.setLang(code);
      if (focus) langPanels[code].tab.focus();
    }
    textTabs.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) selectTextLang(t.dataset.lang); });
    textTabs.addEventListener('keydown', (e) => {
      const tabs = Object.values(langPanels).map((p) => p.tab).filter((t) => !t.hidden); const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key]; if (n === undefined) return;
      e.preventDefault(); selectTextLang(tabs[(n + tabs.length) % tabs.length].dataset.lang, { focus: true });
    });
    const textsCard = card('Public texts', 'What players read on the hub and on the landing page. Missing translations fall back to English.', 'text-aa',
      textTabs, ...Object.values(langPanels).map((p) => p.panel));

    // ------------------------------------------------------------------------------------------
    // 4. place and dates
    // ------------------------------------------------------------------------------------------
    const fLocation = textField('location', { label: 'Location', optional: 'optional', placeholder: 'Amsterdam', autocomplete: 'off' });
    const fStart = textField('starts_on', { label: 'Starts on', optional: 'optional', type: 'date' });
    const fEnd = textField('ends_on', { label: 'Ends on', optional: 'optional', type: 'date' });
    const whenCard = card('Place & dates', 'Shown on the hub card and above the headline of the landing page.', 'map-pin',
      el('div', { class: 'form-grid' }, el('div', { class: 'field field--full' }, fLocation.node), fStart.node, fEnd.node));

    // ------------------------------------------------------------------------------------------
    // preview + action bar
    // ------------------------------------------------------------------------------------------
    const makePreview = (initial) => {
      const pv = createPreview({ getDraft: () => draft, getEvent: () => ctx.getEvent(), getCats: () => cats, getLanguages: languages, initial });
      pv.node.addEventListener('ap:lang', (e) => selectTextLang(e.detail, { fromPreview: true }));
      previews.add(pv);
      return pv;
    };
    const preview = makePreview({ lang: ctx.getEvent().default_language });
    const publicLink = el('a', { class: 'btn btn--secondary btn--sm', target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Public page');
    const expandBtn = el('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Open the preview full size', title: 'Full size' }, icon('projector-screen'));
    expandBtn.addEventListener('click', openExpanded);
    const previewHead = el('div', { class: 'ap-aside__head' }, el('h2', { class: 'ap-aside__title' }, icon('eye'), 'Live preview'), el('div', { class: 'cluster ap-aside__actions' }, expandBtn, publicLink));
    const aside = el('aside', { class: 'ap-aside stack', 'aria-label': 'Live preview' }, previewHead, preview.node);

    function openExpanded() {
      const pv = makePreview({ ...preview.state, frame: window.innerWidth < 700 ? 'phone' : 'desktop' });
      const body = el('div', { class: 'ap-expanded' }, pv.node);
      const ctl = openModal({ title: 'Live preview', description: 'Exactly what players see, with your unsaved changes.', icon: 'eye', size: 'xl', content: body, actions: [{ label: 'Close', variant: 'primary', value: 'close', autofocus: true }] });
      requestAnimationFrame(() => pv.update());
      ctl.closed.then(() => { pv.destroy(); previews.delete(pv); });
    }

    const formError = el('div', { class: 'alert alert--danger', role: 'alert', hidden: true }, el('span', { class: 'alert__icon' }, icon('warning-fill')), el('div', null, el('p', { class: 'alert__title' }, 'Could not save the changes'), el('p', { class: 'alert__text ap-form-error' })));
    const stateText = el('span', { class: 'ap-bar__state' });
    const previewBtn = el('button', { type: 'button', class: 'btn btn--secondary ap-bar__preview', 'aria-label': 'Open the full-size preview' }, icon('eye'), el('span', { class: 'bar-lbl' }, 'Preview'));
    previewBtn.addEventListener('click', openExpanded);
    const resetBtn = el('button', { type: 'button', class: 'btn btn--ghost', 'aria-label': 'Reset changes' }, icon('arrow-counter-clockwise'), el('span', { class: 'bar-lbl' }, 'Reset'));
    const saveBtn = el('button', { type: 'button', class: 'btn btn--primary' }, icon('floppy-disk'), 'Save changes');
    const bar = el('div', { class: 'ap-bar', role: 'region', 'aria-label': 'Save changes' }, stateText, el('span', { class: 'ap-bar__spacer' }), previewBtn, resetBtn, saveBtn);

    const editor = el('div', { class: 'ap-editor stack stack--lg' }, formError, identityCard, lookCard, textsCard, whenCard, bar);
    const view = el('form', { class: 'ap ap-split', novalidate: '', 'aria-label': 'Event appearance' }, editor, aside);
    const head = el('header', { class: 'page-header' }, el('div', { class: 'page-header__main' },
      el('h1', { class: 'page-header__title', tabindex: '-1' }, 'Appearance'),
      el('p', { class: 'page-header__sub' }, 'Name, colours, texts and dates of the event, with a live preview of what players see.')));
    root.replaceChildren(head, view);
    hydrateIcons(view);
    disposers.push(initColorInputs(view));

    // ------------------------------------------------------------------------------------------
    // refresh pipeline
    // ------------------------------------------------------------------------------------------
    function syncColors() {
      fPrimary.sync(); fAccent.sync();
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.primary === draft.branding.primary_color && b.dataset.accent === draft.branding.accent_color)));
    }

    function renderContrast() {
      const b = draft.branding;
      if (!HEX6.test(b.primary_color) || !HEX6.test(b.accent_color)) { contrastBox.replaceChildren(); return; }
      const a = analyse(b.primary_color, b.accent_color);
      const notes = [];
      const adjusted = a.themes.filter((t) => t.shift > 0.04);
      for (const t of adjusted) notes.push(`In the ${t.theme} theme your primary colour is ${t.solid === b.primary_color ? '' : t.theme === 'dark' ? 'lifted' : 'deepened'} to ${t.solid} for buttons and ${t.text} for links, so they stay readable.`.replace('  ', ' '));
      const warns = [];
      if (a.chroma < 0.03) warns.push('The primary colour is almost grey, so the interface will look monochrome. A more saturated colour gives the event a stronger identity.');
      if (a.distance < 0.09) warns.push('Primary and accent are almost identical: gradients and highlights will look flat. Try "Suggest an accent".');
      if (a.themes[0].aurora < 18) warns.push('This colour is so bright that the background glow is dimmed to keep text readable. The banner and buttons keep your colour.');
      const tone = warns.length ? 'warning' : adjusted.length ? 'brand' : 'success';
      const title = warns.length ? 'Worth a second look' : adjusted.length ? 'Readable in both themes, shades adjusted automatically' : 'Accessible in both themes';
      const rows = a.themes.map((t) => el('div', { class: 'ap-ct__row' },
        el('span', { class: 'ap-ct__theme' }, icon(t.theme === 'dark' ? 'moon' : 'sun'), t.theme === 'dark' ? 'Dark' : 'Light'),
        el('span', { class: 'ap-ct__btn', style: { '--ct-bg': t.solid, '--ct-fg': t.on } }, 'Button'),
        el('span', { class: ['badge', t.label >= 4.5 ? 'badge--success' : 'badge--danger'], title: 'Label on the button' }, `Label ${t.label.toFixed(1)}:1 ${grade(t.label)}`),
        el('span', { class: ['badge', t.link >= 4.5 ? 'badge--success' : 'badge--danger'], title: 'Brand-coloured text on cards' }, `Text ${t.link.toFixed(1)}:1 ${grade(t.link)}`),
        el('span', { class: ['badge', t.shape >= 3 ? 'badge--success' : 'badge--danger'], title: 'Button against the page' }, `Shape ${t.shape.toFixed(1)}:1`)));
      contrastBox.replaceChildren(
        el('div', { class: `alert alert--${tone}`, role: 'status' }, el('span', { class: 'alert__icon' }, icon(warns.length ? 'warning-fill' : adjusted.length ? 'info-fill' : 'check-circle-fill')),
          el('div', null, el('p', { class: 'alert__title' }, title),
            el('p', { class: 'alert__text' }, warns.length ? warns.join(' ') : adjusted.length ? notes.join(' ') : 'Buttons, links and text keep at least 4.7:1 contrast on cards and 3:1 for shapes, whatever you pick.'))),
        el('div', { class: 'ap-ct' }, ...rows));
      hydrateIcons(contrastBox);
    }

    function renderIdentity() {
      const saved = baseline.slug;
      const slug = draft.slug.trim();
      const url = eventUrl(slug || saved);
      slugUrl.replaceChildren(icon('link-simple', { size: 'sm' }), el('span', { class: 'ap-url-line__text' }, url));
      hydrateIcons(slugUrl);
      const renamed = slug && slug !== saved && !fields.slug?.node.classList.contains('field--invalid');
      slugWarn.hidden = !renamed;
      if (renamed) {
        const live = ctx.getEvent().status !== 'draft';
        slugWarn.querySelector('.ap-slugwarn-text').textContent = `${eventUrl(saved)} will stop working${live ? ' right away, even for players who already have it open' : ''}. Printed QR codes, shared links and bookmarks pointing to it will lead nowhere. The scoreboard address changes too.`;
      }
      publicLink.href = `/${saved}`;
    }

    let errors = {};
    function refreshErrors() {
      errors = validate(draft);
      for (const [key, f] of Object.entries(fields)) f.setError(serverErrors[key] || ((submitted || touched.has(key)) ? errors[key] : '') || '');
    }

    function renderBar() {
      const patch = buildPatch(draft, baseline);
      dirty = Object.keys(patch).length > 0;
      ctx.setDirty?.(dirty);
      view.classList.toggle('is-dirty', dirty);
      stateText.replaceChildren(el('span', { class: ['ap-bar__dot', dirty && 'is-on'], 'aria-hidden': 'true' }), el('span', { class: 'bar-long' }, dirty ? 'Unsaved changes' : 'All changes saved'), el('span', { class: 'bar-short', 'aria-hidden': 'true' }, dirty ? 'Unsaved' : 'Saved'));
      resetBtn.disabled = !dirty || saving;
      saveBtn.disabled = !dirty || saving;
    }

    /** everything, synchronously (initial render, reset) */
    function refresh() {
      renderIdentity(); renderBar(); refreshErrors(); renderContrast();
      previews.forEach((p) => p.update());
    }
    let pending = 0; // 1: colours only, 2: everything
    function schedule(full) {
      pending |= full ? 2 : 1;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const p = pending; pending = 0;
        if (!alive) return;
        renderContrast();
        previews.forEach((pv) => (p & 2 ? pv.update() : pv.updateBrand()));
      });
    }
    /** a control changed: the cheap parts now, the preview on the next frame */
    function changed(key, { color = false, touch = false } = {}) {
      formError.hidden = true;
      if (key) delete serverErrors[key];
      if (touch && key) touched.add(key);
      if (color) syncPresetState();
      if (key === 'logo_url') checkLogo();
      renderBar(); refreshErrors(); renderIdentity();
      schedule(!color);
    }
    function syncPresetState() {
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.primary === draft.branding.primary_color && b.dataset.accent === draft.branding.accent_color)));
    }

    function pushDraft() {
      for (const f of [fTitle, fName, fSlug, fLocation, fStart, fEnd, fLogo]) f.sync();
      for (const c of ['en', 'fr']) Object.values(langFields[c]).forEach((f) => f.sync());
      syncColors(); fBg.sync(); fTheme.sync(); fQr.sync();
      checkLogo();
    }

    function resetFromEvent(ev = ctx.getEvent()) {
      baseline = fromEvent(ev);
      draft = structuredClone(baseline);
      touched.clear(); submitted = false; formError.hidden = true;
      Object.keys(serverErrors).forEach((k) => delete serverErrors[k]);
      pushDraft();
      selectTextLang(languages().includes(textLang) ? textLang : ev.default_language, { fromPreview: true });
      refresh();
    }

    // ------------------------------------------------------------------------------------------
    // save / reset
    // ------------------------------------------------------------------------------------------
    const FIELD_MAP = { 'branding.primary_color': 'primary_color', 'branding.accent_color': 'accent_color', 'branding.logo_url': 'logo_url', 'branding.background_style': null, 'branding.default_theme': null, 'branding.show_join_qr': null };
    async function save() {
      if (saving) return;
      submitted = true;
      refreshErrors();
      const firstKey = Object.keys(errors)[0];
      if (firstKey) {
        if (['hero_title_en', 'tagline_en', 'description_en'].includes(firstKey)) selectTextLang('en');
        if (['hero_title_fr', 'tagline_fr', 'description_fr'].includes(firstKey)) selectTextLang('fr');
        fields[firstKey]?.focus();
        announce(`${Object.keys(errors).length} field${Object.keys(errors).length === 1 ? '' : 's'} need attention`, { politeness: 'assertive' });
        return;
      }
      const patch = buildPatch(draft, baseline);
      if (!Object.keys(patch).length) return;
      if (patch.slug) {
        const ok = await ctx.confirm({
          title: 'Change the public address?',
          message: `${eventUrl(baseline.slug)} will stop working and the event moves to ${eventUrl(patch.slug)}. Printed QR codes and shared links to the old address will no longer work.`,
          confirmLabel: 'Rename the slug', danger: ctx.getEvent().status !== 'draft',
        });
        if (!ok || !alive) return;
      }
      saving = true; setBusy(saveBtn, true); resetBtn.disabled = true; formError.hidden = true;
      try {
        await api.put(`/admin/events/${eventId}`, patch);
        ctx.toast('Appearance saved', { type: 'success' });
        await ctx.reloadEvent();
        if (!alive) return;
        resetFromEvent();
      } catch (e) {
        if (!alive || e?.isUnauthorized) return;
        const mapped = [];
        const generic = [];
        if (e?.isConflict) { serverErrors.slug = 'This slug is already used by another event. Pick another one.'; mapped.push('slug'); }
        for (const [loc, msg] of Object.entries(e?.fieldErrors || {})) {
          const clean = String(msg).replace(/^Value error, /, '');
          const key = loc in FIELD_MAP ? FIELD_MAP[loc] : loc;
          if (key && fields[key]) { serverErrors[key] = clean; mapped.push(key); }
          else if (/ends_on/.test(clean)) { serverErrors.ends_on = clean; mapped.push('ends_on'); }
          else generic.push(clean);
        }
        if (!mapped.length && !generic.length && !e?.isConflict) generic.push(errorText(e));
        if (generic.length) { formError.querySelector('.ap-form-error').textContent = generic.join(' '); formError.hidden = false; formError.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }
        else { refreshErrors(); fields[mapped[0]]?.focus(); }
        ctx.toast('The changes were not saved', { type: 'error' });
      } finally {
        saving = false;
        if (saveBtn.isConnected) { setBusy(saveBtn, false); refresh(); }
      }
    }
    saveBtn.addEventListener('click', save);
    view.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    resetBtn.addEventListener('click', () => { resetFromEvent(); announce('Changes discarded'); });

    disposers.push(ctx.onEventChanged?.((ev) => {
      if (!alive || saving) return;
      if (!dirty) { resetFromEvent(ev); return; }
      baseline = fromEvent(ev);
      selectTextLang(textLang, { fromPreview: true });
      refresh();
    }) || (() => {}));

    resetFromEvent();
    selectTextLang(ctx.getEvent().default_language, { fromPreview: false });

    return {
      unmount() {
        alive = false;
        cancelAnimationFrame(rafId);
        checkLogo.cancel?.();
        previews.forEach((p) => p.destroy());
        previews.clear();
        disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
        document.querySelectorAll('.ap-expanded').forEach((n) => n.closest('dialog')?.close());
        ctx.setDirty?.(false);
        root.replaceChildren();
      },
    };
  },
};
