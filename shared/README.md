# Quiz Design System (`shared/`)

One modern look for every Gravitee Quiz app (player web app, scoreboard, admin console), driven by **two brand colours per event**.
Vanilla CSS + ES modules, **no build step, no framework, no runtime CDN**. CSP-friendly (`script-src 'self'`): no inline script, no inline handlers, no `eval`.

- Live reference: `cd <repo> && python3 -m http.server 8300` then open <http://localhost:8300/shared/styleguide.html> (every token, every component, theme / brand / language switchers, a live contrast report).
- Reference **screen compositions** (real responsive pages built only from this system, copy their markup): `styleguide.html?screen=landing|game|results|scoreboard|hub|admin|branding` (add `&preset=gravitee|ai|yellow|navy|mint`, `&theme=dark|light`, `&lang=fr`).
- Served at `/shared/…` by the `web/` container and at `/admin/shared/…` by the admin container. Every path inside the system is relative, so both work.

```
shared/
  css/        fonts.css  tokens.css  base.css  components.css      (+ styleguide.css: styleguide page only)
  js/         config api theme theme-boot branding color i18n dom ui effects qr   (+ styleguide.js: styleguide page only)
  icons/      sprite.svg                  186 Phosphor symbols
  img/        gravitee logos (horizontal on dark / on light, mark)
  fonts/      Bricolage Grotesque + Inter, variable woff2, latin + latin-ext
  vendor/     qrcode.js                   (qrcode-generator, MIT)
  tools/      build-sprite.mjs  gen-default-tokens.mjs  fetch-assets.sh  icons.json  test-color.mjs  test-js.mjs  test-api.mjs  test-layout.mjs  test-csp.mjs  check-static.mjs  verify-contrast.mjs  (_serve.mjs: test server)
  styleguide.html   LICENSES.md   README.md
```

---

## 1. Quick start

### 1.1 Page skeleton (copy this)

```html
<!doctype html>
<html lang="en" data-theme="dark" data-bg="aurora">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>Gravitee Quiz</title>
  <!-- 1. sets data-theme before first paint (external classic script: CSP safe) -->
  <script src="/shared/js/theme-boot.js"></script>
  <!-- 2. optional font preload -->
  <link rel="preload" href="/shared/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/shared/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>
  <!-- 3. the four stylesheets, in this order -->
  <link rel="stylesheet" href="/shared/css/fonts.css">
  <link rel="stylesheet" href="/shared/css/tokens.css">
  <link rel="stylesheet" href="/shared/css/base.css">
  <link rel="stylesheet" href="/shared/css/components.css">
  <!-- 4. your app CSS (unlayered, so it always wins over the system) -->
  <link rel="stylesheet" href="/app.css">
  <!-- 5. runtime config written by the nginx entrypoint: window.QUIZ_CONFIG = { apiBase: "/api" } -->
  <script src="/config.js"></script>
  <script type="module" src="/main.js"></script>
</head>
<body>
  <a class="skip-link" href="#main" data-i18n="a11y.skip">Skip to content</a>
  <div id="app" class="screen"> … </div>
  <noscript><p class="container">This quiz needs JavaScript.</p></noscript>
</body>
</html>
```

For the admin container use `/admin/shared/…` (or relative `./shared/…`) in the `<link>`/`<script>` tags; module code uses relative imports and works unchanged.
Meta `theme-color`, the favicon and `document.title` are created/updated by `applyBranding()`: do not hard-code them.

### 1.2 Boot sequence (`main.js`)

```js
import { api } from '/shared/js/api.js';
import { createI18n } from '/shared/js/i18n.js';
import { initTheme } from '/shared/js/theme.js';
import { applyBranding } from '/shared/js/branding.js';
import { hydrateIcons } from '/shared/js/dom.js';
import { initDropdowns, toast } from '/shared/js/ui.js';

const i18n = createI18n({ dictionaries: { en: {/* … */}, fr: {/* … */} }, fallback: 'en' });
initTheme();                                        // dark / light / system, per-event default handled below

const slug = location.pathname.split('/')[1];
try {
  const event = await api.get(`/events/${slug}`);
  i18n.setSupported(event.languages);               // ["en","fr"]
  i18n.setEventDefault(event.default_language);     // used only when no ?lang= and no saved choice
  applyBranding(event);                             // colours, background, favicon, title, theme-color, default theme
  render(event);                                    // build your DOM with el() / templates
  hydrateIcons(); i18n.apply(document); initDropdowns();
} catch (e) {
  toast(e.detail, { type: 'error' });
}
```

---

## 2. Concepts

### 2.1 Theme and background

| attribute | values | set by |
|---|---|---|
| `html[data-theme]` | `dark` (default) · `light` | `theme-boot.js` then `theme.js` (always the **resolved** value, never `system`) |
| `html[data-bg]` | `aurora` (default) · `grid` · `plain` | `applyBranding()` from `branding.background_style` |
| `html[data-display]` | `tv` | you, on the scoreboard: scales every `rem` up to 2x for big screens (`font-size: clamp(16px, 0.85vw + 5px, 40px)`) |

Theme preference is `system | light | dark`: `localStorage "quiz.theme"` (the user's explicit choice) wins; the event's `default_theme` only applies while the user has not chosen. `?theme=light|dark|system` on a page load is a non-persisted override (handled by `theme-boot.js` before first paint and by `initTheme()`; same as `setTheme('light', {persist:false})`). When `localStorage` is blocked (private windows, strict settings) the choice is kept in memory for the session instead of being silently dropped (same for `quiz.lang` and the admin token).

Backgrounds: **aurora** = blurred brand-coloured glows (pure CSS gradients on a fixed layer, one composited layer, slow drift, static under `prefers-reduced-motion`); **grid** = hairline grid fading from a brand glow; **plain** = flat `--bg`. Keep the number of `.glass` / `backdrop-filter` surfaces low (appbar, a few panels, toasts, dialogs): stacking a dozen of them over the animated aurora halved the frame rate of a 1080p scoreboard on a throttled CPU, which is why leaderboard rows are plain translucent cards without blur. Glow strength is **solved per brand colour** (`--aurora-strength`, `--bloom-strength`) so `--fg`, `--fg-muted` and the brand / accent text colours stay AA wherever the glow peaks.

### 2.2 Brand model: any two colours in, a readable UI out

`applyBranding()` receives two hex colours (`primary_color`, `accent_color`). All contrast decisions are computed with real WCAG maths in OKLCH (`js/branding.js` + `js/color.js`), separately for dark and light:

- **`--brand-solid`** is your brand colour as a fill (buttons, switches, progress): the *nearest* lightness that has >= 3:1 against the surfaces and a readable label. A navy brand is lifted in dark mode, a yellow brand is deepened in light mode; hue and chroma are kept.
- **`--on-brand`** is the label colour for that fill (white or tinted near-black, whichever has more contrast, always >= 4.7:1). For Gravitee orange that is dark ink, not white.
- **`--brand-text`** is the brand as text/links/icons on surfaces (>= 4.7:1 on the most demanding surface). Same trio for the accent: `--accent-solid`, `--on-accent`, `--accent-text`.
- **`--green` / `--red`** (the answer buttons, mirroring the physical buzzers) stay recognisably green / red: only a few degrees of hue drift toward the brand for harmony. `--on-green` is ink, `--on-red` is white. Also `--amber` (warning), `--blue` (info), each with `--on-*` and `--*-text`.
- Neutral surfaces (`--bg`, `--bg-raised`, …) are tinted with the brand hue at tiny chroma.

`tools/test-color.mjs` runs this over 4000 random colour pairs x both themes x 6 roles and fails on any text < 4.5:1 or UI < 3:1; `tools/verify-contrast.mjs` re-checks it in a real browser (see section 8).

The raw admin colours stay available for **decoration only**: `--brand`, `--brand-accent` (glows, gradients, big shapes). Never put text on them.

### 2.3 Which token for what (the cheat sheet)

| need | token |
|---|---|
| page / card / dialog / input background | `--bg` / `--bg-raised` / `--bg-overlay` / `--input-bg` |
| text | `--fg` (primary), `--fg-muted` (secondary, OK on the page and over the aurora), `--fg-soft` (over the hero bloom) |
| tertiary text, placeholders | `--fg-subtle` (**cards and inputs only**, not directly on the aurora) |
| filled brand control + its label | `background: var(--brand-solid); color: var(--on-brand)` |
| brand-coloured text / link / icon | `--brand-text` |
| tinted brand panel | `--brand-soft`, `--brand-soft-strong` (opaque tints of the card surface) + text in `--fg` or `--brand-text` |
| green / red answer | `--green` + `--on-green`, `--red` + `--on-red` |
| success / danger / warning / info | `--success-text`, `--danger-text`, … and `--success-soft`, … for fills |
| hairlines | `--border`, `--border-strong`; form control borders `--input-border` (3:1) |
| focus ring | `--focus` (already applied globally to `:focus-visible`) |
| gold / silver / bronze (ranks) | `--gold`/`--on-gold`, `--silver`/`--on-silver`, `--bronze`/`--on-bronze` |

### 2.4 Cascade layers: how to override

`@layer reset, tokens, base, components, utilities;` is declared first in every file. **Any unlayered CSS beats all layers**, so your app stylesheet overrides the system without specificity fights. Utilities (`.u-*`, `.stack`, `.cluster`, …) beat components. To restyle a token, redefine it in unlayered CSS (`:root { --radius-lg: 1rem }`) or set it from JS (`el.style.setProperty('--x', v)`, allowed by the CSP).

### 2.5 Scoped brand: cards that show another event's colours

`applyBranding(event, { root: element })` sets the brand variables on `element` only and marks it `data-brand-scope`; everything inside (buttons, chips, badges, gradients) resolves against that event's colours in the current theme. The hub uses this for the event cards. Theme (`data-theme`) is always page-wide.

---

## 3. CSS custom properties

All defined in `css/tokens.css`.

| group | tokens |
|---|---|
| fonts | `--font-display` (Bricolage Grotesque), `--font-text` (Inter), `--font-mono` |
| type scale (fluid) | `--text-xs` `-sm` `-base` `-md` `-lg` `-xl` `-2xl` `-3xl` `-4xl` `-display`; `--lh-tight/-snug/-normal/-relaxed`; `--tracking-display/-tight/-wide` |
| spacing (4pt) | `--space-0 … 1 2 3 4 5 6 8 10 12 16 20 24` (0.25rem steps), `--gutter` (fluid page gutter), `--container` (72rem), `--container-narrow` (40rem) |
| controls | `--control-h` (44px touch target), `--control-h-sm`, `--control-h-lg` |
| radii | `--radius-xs sm md lg xl 2xl pill` |
| shadows | `--shadow-xs sm md lg xl`, `--shadow-glow` (brand), `--highlight` (top inner edge) |
| z-index | `--z-base 0`, `-raised 10`, `-sticky 100`, `-dropdown 200`, `-overlay 300`, `-modal 400`, `-toast 500`, `-max 9999` |
| motion | `--dur-instant 80ms`, `--dur-fast 140ms`, `--dur 220ms`, `--dur-slow 400ms`, `--dur-slower 700ms`; `--ease-out`, `--ease-in`, `--ease-in-out`, `--ease-spring` (all durations collapse under reduced motion) |
| surfaces | `--bg --bg-raised --bg-overlay --bg-sunken --input-bg --glass-bg --glass-bg-strong --glass-border --scrim --hover --active --border --border-strong --input-border` |
| text | `--fg --fg-soft --fg-muted --fg-subtle` |
| brand roles | `--brand --brand-accent --brand-solid --brand-solid-hover --on-brand --brand-text --accent-solid --accent-solid-hover --on-accent --accent-text --brand-soft --brand-soft-strong --brand-border --brand-glow --accent-soft --accent-glow --focus --grad-brand --grad-brand-soft --grad-text` |
| status | `--green --red --amber --blue` (+ `-hover`, `--on-*`, `*-text`), aliases `--success --danger --warning --info` (+ `-text`, `-soft`) |
| ranks | `--gold --silver --bronze` (+ `--on-*`) |
| internals set by JS | `--brand-h --tint-c --aurora-strength --bloom-strength` and the `*-d` / `*-l` pairs (dark / light) |

---

## 4. Components

BEM-ish naming: `.block`, `.block__element`, `.block--modifier`, state classes `.is-*`. Icons are `<svg class="icon">`; in static markup write `<span data-icon="plus"></span>` and call `hydrateIcons()`.
Everything below is demonstrated live in the styleguide.

### Buttons
```html
<button class="btn btn--primary">Play</button>      <!-- --primary --secondary --ghost --danger --success --link -->
<button class="btn btn--primary btn--lg">…</button> <!-- sizes: --sm  (default 44px)  --lg  --xl -->
<button class="btn btn--primary btn--icon" aria-label="Play"><span data-icon="play-fill"></span></button>
<button class="btn btn--primary btn--block">Full width</button>
<button class="btn btn--primary is-loading" aria-busy="true">Saving</button>   <!-- or setBusy(btn, true) / withBusy(btn, task) -->
```
Disabled: the `disabled` attribute. Hover lifts + glows (primary), press scales.

### Forms
```html
<div class="field field--invalid">
  <label class="field__label" for="email">Email <span class="field__optional">optional</span></label>
  <input class="input" id="email" type="email" aria-describedby="email-err" aria-invalid="true">
  <p class="field__help">Helper text</p>
  <p class="field__error" id="email-err">Error text</p>
</div>
<select class="select">…</select>   <textarea class="textarea"></textarea>
<input class="input input--lg">     <!-- --sm --lg --mono -->
<div class="input-wrap"><span data-icon="magnifying-glass"></span><input class="input"></div>   <!-- leading icon -->
<label class="check"><input type="checkbox" class="checkbox"><span class="check__text">Label</span></label>   <!-- radio: .radio; indeterminate supported -->
<label class="check"><input type="checkbox" class="switch" role="switch"><span class="check__text">Live</span></label>
<div class="segmented" role="radiogroup"><label><input type="radio" name="x" checked><span>One</span></label><label><input type="radio" name="x"><span>Two</span></label></div>
        <!-- --brand (filled), --sm, --block -->
<div class="color-input"><input type="color" class="color-input__swatch"><input class="input color-input__hex" maxlength="7"></div>   <!-- initColorInputs() syncs them -->
<button class="swatch" style="--swatch:#7C5CFF; --swatch-2:#22D3EE" aria-pressed="false" aria-label="AI violet"></button>
<input type="range" class="range">  <!-- initRanges() paints the fill -->
<div class="dropzone">Drop files</div>   <!-- + .is-over while dragging -->
<div class="form-grid"> <div class="field field--full">…</div> </div>   <div class="form-actions">…buttons…</div>
<fieldset class="fieldset"><legend>…</legend>…</fieldset>
```
Inputs are >= 16px (no iOS zoom), 44px tall, borders have 3:1 contrast.

### Cards and glass
`.card` (solid raised surface; `--flush`, `--lg`, `--interactive` for linkable cards; parts `.card__header .card__title .card__sub .card__footer`), `.glass` (translucent blurred panel; `--strong`, `--brand`), `.panel` (padding), `.divider`.

### Badges, chips, difficulty, kbd, avatar
```html
<span class="badge badge--success badge--dot">Live</span>   <!-- --brand --accent --success --danger --warning --info --solid --lg --dot -->
<span class="chip" style="--chip:#7C5CFF">LLMs &amp; GenAI</span>   <!-- any colour stays readable; .chip--plain (no dot), --lg, button.chip.is-selected -->
<span class="difficulty" data-level="2" aria-label="Medium"></span>  <!-- 1 easy, 2 medium, 3 hard -->
<span class="kbd">G</span>  <span class="kbd kbd--green">G</span>  <span class="kbd kbd--red">R</span>
<span class="avatar avatar--lg" style="--hue: 210">AL</span>  <!-- JS: avatar(name, {size}) -->   <span class="avatar-stack">…</span>
```

### Tabs, menus, pagination, breadcrumbs, toolbar
```html
<div class="tabs" role="tablist"><button class="tabs__tab" role="tab" id="t1" aria-controls="p1" aria-selected="true">General <span class="tabs__count">3</span></button>…</div>
<div class="tabpanel" id="p1" role="tabpanel" aria-labelledby="t1">…</div>     <!-- .tabs--pill variant; initTabs(root) wires keys + panels -->

<div class="dropdown dropdown--end">             <!-- --end aligns right, --up opens upward; initDropdowns() wires it -->
  <button class="btn" aria-haspopup="menu" aria-expanded="false" data-dropdown-trigger>Actions</button>
  <div class="menu" role="menu" hidden>
    <div class="menu__label">Event</div>
    <button class="menu__item" role="menuitem"><span data-icon="copy"></span>Duplicate</button>
    <hr class="menu__sep">
    <button class="menu__item menu__item--danger" role="menuitem">Delete…</button>
  </div>
</div>

<nav class="breadcrumbs"><a href="#">Events</a><span aria-current="page">Questions</span></nav>
<div class="pagination"><span class="pagination__info">1–20 of 48</span><div class="pagination__pages"><button class="pagination__btn" aria-current="page">1</button>…</div></div>
<div class="toolbar"><div class="input-wrap">…</div><select class="select select--sm">…</select><span class="toolbar__spacer"></span><button class="btn btn--primary btn--sm">Add</button></div>
```

### Table (responsive)
```html
<div class="table-wrap"><table class="table table--cards">   <!-- --cards: stacked label/value cards below 40rem (needs data-label on <td>; a cell may hold several blocks, e.g. .cell-title + .cell-sub, they stack in the value column); --compact -->
  <thead><tr><th scope="col">Player</th><th scope="col" class="num">Score</th><th aria-sort="descending">…</th></tr></thead>
  <tbody><tr><td data-label="Player"><div class="cell-title">Ada</div><div class="cell-sub">14:32</div></td><td data-label="Score" class="num">1 340</td><td class="actions">…</td></tr></tbody>
</table></div>
```
`tr.is-selected` highlights; `th[aria-sort]` shows the arrow; the header is sticky inside a scrolling wrapper.

### Stats, empty state, skeleton, progress, ring
```html
<div class="stats">           <!-- --compact: always 3 across -->
  <div class="stat stat--glow"><div class="stat__head"><span class="stat__label">Players</span><span class="stat__icon"><span data-icon="users-three"></span></span></div>
    <div class="stat__value">1,284</div><div class="stat__sub">+12%</div></div>   <!-- stat--accent / --success / --danger tint the icon -->
</div>
<div class="empty"><div class="empty__icon"><span data-icon="trophy"></span></div><h3 class="empty__title">No scores yet</h3><p class="empty__text">…</p><div class="empty__actions">…</div></div>
<span class="skeleton skeleton--text"></span> <span class="skeleton skeleton--title"></span> <span class="skeleton skeleton--circle" style="inline-size:3rem"></span> <span class="skeleton skeleton--card"></span>
<span class="spinner" role="status" aria-label="Loading"></span>

<div class="progress" role="progressbar" aria-valuenow="62" aria-valuemin="0" aria-valuemax="100" style="--value:62"><div class="progress__bar"></div></div>   <!-- --lg --thin --success --danger --warning; set --value from JS -->
<div class="steps" style="--total:15"><i class="is-correct"></i><i class="is-wrong"></i><i class="is-current"></i><i></i>…</div>             <!-- question progress -->

<div class="ring ring--lg" data-state="ok" style="--value:75" role="timer" aria-label="Time left">     <!-- --sm --lg --xl; data-state: ok | warn | danger | done -->
  <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring__track" cx="50" cy="50" r="44" pathLength="100"/><circle class="ring__bar" cx="50" cy="50" r="44" pathLength="100"/></svg>
  <span class="ring__label">15</span>
</div>
```
Drive the ring either by setting `--value` (0 to 100) each second (it transitions linearly) or CSS-only: `ring.style.setProperty('--duration','20s'); ring.classList.add('ring--run')` (remove and re-add the class to restart; `.ring--paused` pauses). Switch `data-state` to `warn` / `danger` in the last seconds; announce milestones with `announce()`.

### Alert, banner
```html
<div class="alert alert--warning" role="alert"><span class="alert__icon" data-icon="warning-fill"></span><div><p class="alert__title">Title</p><p class="alert__text">Text</p></div><button class="btn btn--ghost btn--sm">Retry</button></div>
```
`--success --danger --warning --brand` (info is default); `.alert--banner` makes it full width (offline notice).

### Dialog (native `<dialog>`), toast
Use `openModal()` / `confirmDialog()` from `ui.js` (they build the markup below, handle focus, Escape, backdrop click, scroll lock). On phones dialogs become bottom sheets.
```html
<dialog class="dialog dialog--lg"><div class="dialog__header">…<h2 class="dialog__title">…</h2></div><div class="dialog__body">…</div><div class="dialog__footer">…</div></dialog>
```
Toasts: `toast('Saved', { type: 'success' })` (container `.toast-region` is created for you).

### Game: question, answer buttons, feedback
```html
<section class="question glass"><p class="question__text">Which protocol…?</p></section>
<div class="answers">      <!-- 2 columns, 1 column below 31rem; .answers--stack forces one column -->
  <button class="answer answer--green"><span class="answer__icon" data-icon="check-circle-fill"></span><span class="answer__label">TRUE</span><span class="answer__key">G</span></button>
  <button class="answer answer--red"><span class="answer__icon" data-icon="x-circle-fill"></span><span class="answer__label">FALSE</span><span class="answer__key">R</span></button>
</div>
```
States: `.is-pressed` (also on real `:active`: simulate presses coming from the BLE buzzers / G / R keys), `.is-selected`, `.is-correct` (check badge), `.is-wrong` (cross badge + shake), `.is-dimmed`, `disabled`. `.answer--sm` is a compact variant for previews. Key hints are hidden on touch devices. Buttons never rely on colour alone (icon + label + key). Also: `.game-head`, `.game-counter`, `.feedback.feedback--correct|wrong|timeout` (+ `.feedback__points`), `.score-hero` (`__label __value __sub`, gradient number: use `countUp()`), `.review-item[data-state=correct|wrong|missed]` (`__icon __q __points __answers __explain`).

### Podium and leaderboard
```html
<div class="podium">
  <div class="podium__place" data-rank="1">           <!-- order is handled by CSS: 2 · 1 · 3 -->
    <span class="icon podium__crown">…</span><span class="avatar avatar--xl podium__avatar">AL</span>
    <div class="podium__name">Ada L.</div><div class="podium__score">1,340</div><div class="podium__meta">14/15</div>
    <div class="podium__block"><span class="podium__rank">1</span></div></div> …
</div>
<ol class="lb">     <!-- .lb--lg for TV -->
  <li class="lb__row is-you" data-rank="4"><span class="lb__rank">4</span><span class="avatar avatar--sm">LT</span><span class="lb__name">Linus T.</span><span class="lb__meta">13/15</span><span class="lb__score">1,190</span></li>
</ol>
```
`.is-you` highlights the player's row; `.is-new` flashes a new entry. Ranks 1-3 get medal discs.

### Hub: hero, event cards, QR
`.hero` (`__eyebrow __title __tagline __actions`; wrap one word of the title in `<em>` for the brand gradient; `--xl` for the biggest title) · `.event-grid > .event-card` (`__banner __status __medallion __body __kicker __title __meta __desc __footer`; call `applyBranding(event, {root: card})`) · `.qr` / `.qr-card` (from `qr.js`).

### Layout: appbar, screen, container, shell, page header, split
- Player / scoreboard: `.screen > .appbar + .screen__main.container + .footer`; `.screen__bottom` pins the answers to the thumb zone; `.brand` (`__mark __name __sep`), `.logo.logo--on-dark` / `.logo--on-light` (two `<img>`, the right one shows per theme), `.footer`.
- Admin: `.shell > .shell__topbar + .shell__sidebar (.nav > .nav__section/.nav__item[aria-current=page]/.nav__badge) + .shell__scrim + .shell__main > .container`; `data-shell-toggle` button on small screens, `initShell()` wires it.
- `.page-header (__main __eyebrow __title __sub __actions)`, `.split > .split__aside` (editor + sticky live preview), `.preview-frame`, `.kv` (definition rows), `.live` (LIVE pill), `.status-dot[data-state=on|connecting|off|error]`, `.pill-status`.
- Page-level status text should be `--fg` / `--fg-muted` (guaranteed over the aurora), never `--fg-subtle`.

### Utilities
`.stack` (`--gap`, `--lg`, `--sm`) · `.cluster` (`--between --center --end`) · `.grid-auto` (`--min`) · `.grid-2/.grid-3` · `.container(--narrow --wide)` · `.u-muted .u-subtle .u-brand .u-success .u-danger .u-warning` · `.u-display .u-mono .u-tabular .u-eyebrow .u-text-xs…2xl .u-center-text .u-truncate .u-balance .u-gradient-text` · `.u-hidden .u-sr-only .u-hide-sm .u-show-sm .u-hide-touch .skip-link` · `.u-mt-* .u-mb-* .u-ml-auto .u-mx-auto` · `.u-fade-in .u-rise .u-pop` (stagger with `style.setProperty('--i', index)`).

---

## 5. JavaScript API

All modules are dependency-free ES modules; import by path (`'/shared/js/dom.js'` or relative). Types are JSDoc in the source.

### `config.js`
```js
import { config, eventUrl, scoreboardUrl } from './config.js';
config.apiBase            // "/api" (window.QUIZ_CONFIG.apiBase, no trailing slash)
config.publicBaseUrl      // window.QUIZ_CONFIG.publicBaseUrl or location.origin
eventUrl('ai-masters', { lang: 'fr' })   // "https://quiz.events.gravitee.io/ai-masters?lang=fr"   (use for QR codes / share links)
scoreboardUrl('ai-masters')              // ".../ai-masters/scoreboard"
```

### `api.js`
```js
import { api, ApiError, openEventSource, apiUrl, getToken, setToken, clearToken, onUnauthorized } from './api.js';

const events = await api.get('/events');                                   // GET  /api/events (2 retries with backoff on network/502/503/504)
const player = await api.post(`/events/${slug}/players`, { first_name, last_name, email });
await api.put(`/admin/events/${id}`, patch);   await api.patch(...);   await api.delete(`/admin/events/${id}`, { query: { confirm: slug } });
await api.upload(`/admin/events/${id}/questions/import-csv`, file, { query: { dry_run: true } });   // multipart
await api.download(`/admin/events/${id}/results.csv`);                     // fetches with the Bearer token, saves the file (filename from Content-Disposition)
apiUrl('/events/x/scoreboard', { limit: 10 })                              // "/api/events/x/scoreboard?limit=10"

try { await api.post(...) } catch (e) {
  if (e instanceof ApiError) {
    e.status; e.detail; e.code; e.fieldErrors;   // 0 network, -1 timeout; code = machine code ("event_closed"); fieldErrors = {email: "…"} for 422
    e.isNetwork; e.isTimeout; e.isUnauthorized; e.isForbidden; e.isNotFound; e.isConflict; e.isValidation; e.isServer;
  }
}
```
Options on every call: `{ query, headers, timeout = 15000, retries, signal, auth = true, raw }`. Only `GET` is retried automatically (network errors, timeouts, 502/503/504). The admin JWT is read from `localStorage["quiz.admin.token"]` (memory fallback when storage is blocked) and sent as `Authorization: Bearer …` unless `auth:false` (use that for `POST /auth/login`). A 401 to a request that carried a token clears it and fires `onUnauthorized(cb)` listeners (show the login screen). `setToken(jwt)` after login.

```js
const live = openEventSource(apiUrl(`/events/${slug}/scoreboard/stream`, { limit: 10 }), {
  onMessage: (data) => renderBoard(data.entries, data.total_players),     // JSON parsed (json:false for raw text)
  onStatus: (status, info) => setLive(status === 'open'),                 // 'connecting' | 'open' | 'reconnecting' (info.attempt, info.delay) | 'closed'
});
live.close();  live.reconnect();  live.status;
```
Reconnects forever with exponential backoff + jitter (1 s to 30 s), instantly on `online` / tab visible. A half-open connection (Wi-Fi roaming, laptop sleep) never raises `error`, so on a screen that stays open for hours (the TV scoreboard) pass `staleAfter: 45000`: when no message arrives for that long the stream is silently re-opened (the server sends a full snapshot on every connect; `status` stays `open`, no flicker). Default `0` = off.

### `theme.js`
`initTheme({ defaultTheme })`, `setTheme('dark'|'light'|'system'|null, { persist = true })` (null forgets the user's choice), `getTheme()` (preference), `getResolvedTheme()` (`dark|light`), `hasUserChoice()`, `setEventDefaultTheme(mode)` (called by `applyBranding`), `cycleTheme()`, `onThemeChange(cb) → off`, `createThemeToggle({ variant: 'button'|'segmented', labels })` (returns a ready control; pass translated `labels`).
`theme-boot.js` is a classic script for `<head>` (see 1.1): it applies `?theme=`, the stored choice or the OS before first paint (a first-time visitor of a `default_theme: "light"` event sees one dark -> light switch when `applyBranding()` runs, since the event is only known after the API answers).

### `branding.js`
```js
applyBranding(eventOrBranding, { root = documentElement, title = true, page })
```
Accepts an event (`{ branding, game_title, name }`), a bare branding object or `null` (defaults). On the document it sets the brand variables, `data-bg`, `<meta name=theme-color>` (follows light/dark), the SVG favicon (brand square + Gravitee mark), `document.title` (`{game_title} · {name}`; `page: 'Scoreboard'` prefixes it) and the event's default theme. With `root: someElement` it only sets the scoped brand variables. Returns the computed tokens.
Also: `resetBranding()`, `setDocumentTitle(eventOrString, page?)`, `computeBrandTokens(primary, accent?)` (pure; Node-testable), `deriveAccent(primary)`, `faviconDataUrl(hex)`, `getBrandTokens()`, `DEFAULT_BRANDING`. `color.js` exports the maths (`contrast`, `readableOn`, `hexToOklch`, `oklchToHex`, `normalizeHex`, …).
Live branding editor: call `applyBranding({ branding: {primary_color, accent_color, background_style} }, { root: previewElement })` on every `input` event.

### `i18n.js`
```js
const i18n = createI18n({ dictionaries: { en: { game: { question: 'Question {n}' } }, fr: {…} }, fallback: 'en' });
i18n.lang                          // 'en' | 'fr'   (?lang= → localStorage "quiz.lang" → event default → browser → fallback; only supported languages)
i18n.t('game.question', { n: 3 }) // nested or flat keys; falls back to 'en' then to the key; {placeholders}
i18n.t('results.players', { count: 5 })   // plural: keys results.players_one / results.players_other (Intl.PluralRules)
i18n.pick(category, 'name')        // name_fr when lang=fr and non-empty, else name / name_en;  pick(event, 'tagline') → tagline_fr / tagline_en
i18n.setLang('fr')                 // persists; updates <html lang>, re-applies data-i18n, fires onChange
i18n.setSupported(['en','fr']); i18n.setEventDefault('fr');
i18n.onChange(lang => …);  i18n.apply(root);   // data-i18n="key", data-i18n-attr="placeholder:key; aria-label:key2", data-i18n-params='{"n":3}'
// data-i18n REPLACES the element's content with text: put it on a <span> next to an icon, never on the button itself
i18n.number(1234.5)  i18n.percent(0.68)  i18n.date(d)  i18n.dateTime(d)  i18n.relative(d)  i18n.list(['a','b'])  i18n.dateRange('2026-10-07','2026-10-08')
// English dates are day-first ("7 Oct 2026", 24 h clock) because the events are European; French follows fr. A date-only string
// (event starts_on / ends_on) is a calendar day, never shifted by the viewer's time zone: 2026-10-07 reads "7 Oct" in Los Angeles too.
```

### `dom.js`
```js
el('button', { class: 'btn btn--primary', on: { click: save }, dataset: { id: 3 }, aria: { label: 'Save' }, style: { '--i': 2 } }, icon('check'), 'Save')
//  strings/numbers become TEXT nodes: no HTML injection possible. attrs: class | style | dataset | aria | on | onclick | text | any attribute
icon('trophy-fill', { size: 'lg' | 24 | '2rem', label: 'Winner', spin: true })     // SVG from the sprite (resolved from import.meta.url)
hydrateIcons(root)                // <span data-icon="trophy" data-icon-size="lg"> → svg
qs  qsa  clear  on  delegate  uid  sleep  clamp  debounce(fn, ms)  throttle(fn, ms)
initials('Jean-Pierre Dupont') // "JD"      avatar(name, {size:'lg'})   avatarHue(name)   slugify('World AI Summit – Amsterdam 2026')
formatNumber  formatPercent  formatDate  formatDateTime  formatDateRange(a, b)  formatDuration(75) // "1:15"  formatBytes  relativeTime(date, lang)
copyToClipboard(text) → Promise<boolean>   downloadBlob(data, 'x.csv', 'text/csv')   setBusy(btn, true)   formToObject(form)   escapeHtml
prefersReducedMotion()  isTouch()  SPRITE_URL
```

### `ui.js`
```js
toast('Saved', { type: 'success'|'error'|'warning'|'info', title, duration, action: { label, onClick } })
await confirmDialog({ title, message, confirmLabel, cancelLabel, tone: 'danger' })      // → boolean (danger: focus starts on Cancel)
const m = openModal({ title, description, content: node, size: 'sm'|'md'|'lg'|'xl', icon: 'copy', dismissible: true,
                      actions: [{ label: 'Cancel', variant: 'ghost' }, { label: 'Save', variant: 'primary', value: 'save', onClick: async (e, ctl) => {…; e.preventDefault() /* keep open */} }] });
await m.closed   // → action value or undefined; m.close(value); m.dialog
announce('Correct! 148 points', { politeness: 'polite'|'assertive' })    // aria-live
withBusy(button, asyncFn)   focusFirst(root)
initTabs(root, { onChange })   initDropdowns(root)   initShell(shellEl)   initColorInputs(root)   initRanges(root)   // each returns a dispose function (initTabs returns {select})
```

### `effects.js`
`countUp(el, 1340, { from, duration, format })` · `confetti({ count, origin: {x,y}, spread, angle, power, colors })` · `celebrate()` (3 bursts) · `transition(fn)` (View Transition when available) · `shake(el)` · `pulse(el)`. All are no-ops or instant under `prefers-reduced-motion`; confetti uses the brand colours.

### `qr.js`
`qrCode(url, { size: '12rem', ecc: 'M', large })` → the styled white `.qr` tile with an inline SVG (dark on white so scanners work in both themes); `qrSvg(text, { margin, fg, bg, ecc, label })` → bare SVG; `renderQr(container, text)`. UTF-8 safe.

---

## 6. Icons

186 Phosphor symbols in `icons/sprite.svg` (regular weight; `-fill` and `-bold` variants where listed). Use `icon('name')`, `<span data-icon="name">` or raw `<svg class="icon"><use href="/shared/icons/sprite.svg#name"/></svg>`. Add or remove icons in `tools/icons.json`, then `node shared/tools/build-sprite.mjs` (downloads `@phosphor-icons/core` via `npm pack`).

Regular: `arrow-clockwise`, `arrow-counter-clockwise`, `arrow-down`, `arrow-left`, `arrow-right`, `arrow-square-out`, `arrow-up`, `arrows-clockwise`, `arrows-in`, `arrows-out`, `arrows-down-up`, `arrows-in-line-horizontal`, `battery-charging`, `battery-empty`, `battery-full`, `battery-high`, `battery-low`, `battery-medium`, `bell`, `bluetooth`, `bluetooth-connected`, `bluetooth-slash`, `bookmark-simple`, `brain`, `calendar`, `calendar-blank`, `calendar-check`, `caret-double-left`, `caret-double-right`, `caret-down`, `caret-left`, `caret-right`, `caret-up`, `caret-up-down`, `chart-bar`, `chart-line-up`, `chat-circle-dots`, `check`, `check-circle`, `check-square`, `circle`, `circle-notch`, `clipboard-text`, `clock`, `code`, `confetti`, `copy`, `copy-simple`, `corners-in`, `corners-out`, `cpu`, `crown`, `database`, `desktop`, `device-mobile`, `dots-six-vertical`, `dots-three`, `dots-three-vertical`, `download`, `download-simple`, `export`, `eye`, `eye-slash`, `eyedropper`, `file-arrow-down`, `file-arrow-up`, `file-csv`, `fingerprint`, `fire`, `flag`, `flag-checkered`, `floppy-disk`, `funnel`, `gauge`, `gear`, `gear-six`, `globe`, `graduation-cap`, `graph`, `hand-pointing`, `hourglass-medium`, `house`, `identification-badge`, `image`, `info`, `key`, `keyboard`, `lightbulb`, `lightning`, `link`, `link-simple`, `list`, `list-checks`, `lock`, `lock-key`, `lock-open`, `magic-wand`, `magnifying-glass`, `map-pin`, `medal`, `megaphone`, `minus`, `monitor`, `moon`, `paint-brush`, `palette`, `pause`, `pencil`, `pencil-simple`, `play`, `plug`, `plugs-connected`, `plus`, `projector-screen`, `push-pin`, `puzzle-piece`, `qr-code`, `question`, `robot`, `rocket-launch`, `rows`, `scales`, `share-network`, `shield-check`, `shield-warning`, `sidebar-simple`, `sign-in`, `sign-out`, `skip-forward`, `sliders-horizontal`, `smiley`, `smiley-sad`, `sparkle`, `speaker-high`, `speaker-slash`, `squares-four`, `stack`, `star`, `stop`, `sun`, `table`, `tag`, `target`, `television`, `terminal-window`, `text-aa`, `thumbs-up`, `timer`, `translate`, `trash`, `tree-structure`, `trophy`, `upload`, `upload-simple`, `user`, `user-circle`, `user-plus`, `users`, `users-three`, `warning`, `warning-circle`, `wifi-high`, `wifi-slash`, `x`, `x-circle`

Fill: `check-circle-fill`, `circle-fill`, `crown-fill`, `crown-simple-fill`, `fire-fill`, `heart-fill`, `info-fill`, `lightning-fill`, `medal-fill`, `moon-fill`, `pause-fill`, `play-fill`, `sparkle-fill`, `star-fill`, `sun-fill`, `trophy-fill`, `warning-fill`, `x-circle-fill`

Bold: `check-bold`, `plus-bold`, `x-bold`

---

## 7. Accessibility and quality rules the system gives you (keep them)

- Contrast: text >= 4.5:1 (large 3:1), UI >= 3:1 for every brand colour in both themes; the styleguide shows a live report.
- Touch targets 44px (`--control-h`; the `-sm` controls, pagination, pill tabs and checkboxes grow to 44px on `(pointer: coarse)` screens, dense 36px toolbars stay for mouse users); inputs 16px; visible `:focus-visible` rings everywhere; native `<dialog>`, `<button>`, `<input>` semantics; keyboard support in tabs, menus, dialogs, segmented controls.
- `prefers-reduced-motion`: durations collapse, aurora/ring/confetti/skeleton animations stop. Timer and feedback: put results in an `aria-live` region (`announce()`), never rely on colour alone (answer buttons carry an icon, label and key).
- Fonts are `font-display: swap` with metric-matched fallbacks (measured: CLS <= 0.003 when the fonts arrive late, 0 when they never arrive); only the latin subset is downloaded unless an accent outside latin-1 appears. Do not size layouts in `ch` (the width of "0" differs between a webfont and its fallback and flips wrapping at font swap): use `rem` / `em` for measures.
- No external hosts, no inline `<script>`, no inline handlers. Inline `style="--x: …"` and `el.style.setProperty` are allowed by the CSP (`style-src 'unsafe-inline'`), but prefer JS-set custom properties over `style` strings.
- Dark is the default; light is a first-class theme (test both).

---

## 8. Tooling

```bash
node shared/tools/test-color.mjs                 # property test: 4000 random brand pairs x 2 themes x 6 roles must be AA (no browser needed)
node shared/tools/test-js.mjs                    # 67 behaviour checks of the JS modules in Chromium, against the styleguide (mock API, SSE, dialogs, tabs…); needs the static server
node shared/tools/test-api.mjs [section]         # 276 checks that every export documented in this README exists and behaves as documented (i18n order, pick(), colour maths, theme persistence + ?theme=, api errors with a stubbed fetch, SSE backoff + watchdog, icons at /shared and /admin/shared, dom/ui/effects/qr); starts its own server
node shared/tools/test-layout.mjs [--quick]      # no horizontal scroll 320-1920 px x 5 presets x 2 themes x 8 pages, CLS with late/blocked fonts, reduced motion, a11y structure, 44px touch targets; starts its own server
node shared/tools/test-csp.mjs                   # loads the styleguide + every screen under the production CSP header: zero violations, fonts + icons render, same-origin only
node shared/tools/check-static.mjs [dirs…]       # CSP audit: no inline script / handler, eval, external URL that is LOADED or LINKED (src/href/srcset/action/url()/fetch...; placeholder, aria-*, title, alt and sentences that merely mention https://... are not flagged) (app agents: run it on web/ or admin-console/)
node shared/tools/verify-contrast.mjs            # needs: python3 -m http.server 8300 (repo root) + e2e/node_modules (Playwright); works under the production CSP too.
                                                 #  pass 1: styleguide contrast report for 5 presets + 8 extreme colour pairs x both themes
                                                 #  pass 2: real composited pixels behind every text node on every docs section + every ?screen=… (390/1440/1920 px)
                                                 #  options: --quick  --match "docs ai dark"  --skip-tokens  --extremes (pass 2 again for black / white / grey / pure-RGB / random brands on the main screens)
node shared/tools/gen-default-tokens.mjs --write # regenerates the static Gravitee-orange defaults block in tokens.css from branding.js
node shared/tools/build-sprite.mjs               # regenerates icons/sprite.svg from tools/icons.json
bash shared/tools/fetch-assets.sh                # re-fetches fonts, qrcode.js and copies logos (documented, reproducible)
```
After changing contrast constants in `js/branding.js` always run `gen-default-tokens.mjs --write` and both test scripts.

## 9. Serving notes (for the nginx / infra agents)

- Everything is static. MIME types that matter: `.js` as `text/javascript` (ES modules refuse other types), `.svg` as `image/svg+xml` (the sprite is referenced with `<use href="…/sprite.svg#id">`, same-origin), `.woff2` as `font/woff2`.
- Caching per ARCHITECTURE section 7: `css/ js/ *.html` `no-cache` (ETag); `fonts/ icons/ img/ vendor/` `public, max-age=2592000, immutable`.
- Serve the folder unchanged at `/shared/` (web) and `/admin/shared/` (admin): no path is absolute inside the system.
- The pages pass the production CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'` (`tools/test-csp.mjs`). `data:` images are used for the favicon, checkbox ticks and answer badges (`img-src data:`).

## 10. Browser support

Baseline is spring 2023: Chrome / Edge 111+, Safari 16.4+, Firefox 113+ (needs `oklch()`, `color-mix()`, `@layer`, container queries, `dvh`). Nice-to-have features degrade silently: view transitions, `:has()` scroll lock behind dialogs (Firefox < 121), `linear()` spring easing, `text-wrap: balance`, backdrop blur (opaque glass fallback). Web Bluetooth (buzzers) remains Chromium-only, as before.

## 11. Credits

Fonts: Bricolage Grotesque (display) and Inter (text), SIL OFL 1.1. Icons: Phosphor Icons, MIT. QR: qrcode-generator by Kazuhiko Arase, MIT. Gravitee logos from `assets/gravitee-logo/`. Details and licence texts in [`LICENSES.md`](LICENSES.md).
