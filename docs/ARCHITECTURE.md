# Gravitee Quiz Events — Architecture & Contract (v2)

This document is the **single source of truth** for the multi-event rework. Backend, frontends,
infra and content all code against it. If you must deviate, record the deviation in your final
report (and fix this document if the deviation is an improvement).

## 1. Product concept

One deployment hosts **many events**. An *event* is a self-contained quiz instance:

* its own **branding** (game title such as "API Masters" or "AI Masters", colors, logo, texts, languages)
* its own **categories** and **question pool**
* its own **game rules** (questions per game, timer, scoring, category weights, ordering, registration fields)
* its own **players, game sessions and scoreboard**

Admins create events from scratch, **duplicate** an existing one (copy branding + rules + categories +
questions, never players/results), import/export them as JSON bundles, and edit everything live.

Players use one public host: **`https://quiz.events.gravitee.io`** (the only host exposed in production).

| URL | What |
|---|---|
| `/` | **Hub**: lists the `live` events as branded cards |
| `/{slug}` | **Event game** (landing → register → rules → game → results → review) |
| `/{slug}/scoreboard` | **Scoreboard** (big-screen / TV friendly, live via SSE, QR code to join) |
| `/admin/` | **Admin console** (SPA, hash routes) |
| `/api/...` | **Backend API** (FastAPI) |

Local dev / docker-compose mirrors this exactly through a `gateway` nginx container on
`http://localhost:8080` (same paths, same origin → no CORS, no per-app ports).

Reserved slugs (cannot be used for events): `api admin assets shared css js vendor fonts static
health docs openapi favicon robots scoreboard game events new login config index manifest sw`
(the backend enforces this list; slug regex `^[a-z0-9]+(-[a-z0-9]+)*$`, length 2–48).

## 2. Repository layout (ownership)

```
backend/            FastAPI app, Alembic migrations, tests            (backend agents)
                      Docker build context is the REPO ROOT: `docker build -f backend/Dockerfile .`
                      (image copies `backend/` → /app and `events/*.json` → /app/seed/events/)
shared/             Design system + shared JS modules, no build step  (design-system agent)
web/                Player-facing static app: hub, event game, scoreboard   (web / scoreboard agents)
                      Dockerfile, nginx.conf, docker-entrypoint.sh    (infra agent)
admin-console/      Admin SPA                                         (admin agent)
                      Dockerfile, nginx.conf, docker-entrypoint.sh    (infra agent)
gateway/            nginx reverse proxy for docker-compose            (infra agent)
events/             Event bundles (JSON) — api-masters.json, world-ai-summit-2026.json (content)
questions/          Legacy CSV question sets (kept for reference)
scripts/            quizctl & helpers                                  (infra agent)
k8s/                Kubernetes manifests + deploy.sh                  (infra agent)
e2e/                Playwright end-to-end tests                       (verification phase)
docs/               This file + deployment docs
game-client/ scoreboard/   LEGACY — deleted once `web/` replaces them
```

`game-client/` and `scoreboard/` are the old apps. They are the **reference for buzzer behaviour and
feature parity**, and are deleted at the end of the rework (the `web/` app replaces both).

## 3. Data model (PostgreSQL, SQLAlchemy 2.0)

Existing tables stay (non-destructive migration). New/changed:

### `events` (new)
| column | type | notes |
|---|---|---|
| id | int PK | |
| slug | varchar(48) unique, indexed | public identifier |
| name | varchar(200) | e.g. "World Summit AI – Amsterdam 2026" |
| game_title | varchar(100) | brand shown in UI: "API Masters", "AI Masters" |
| status | varchar(10) | `draft` (hidden, admin preview only) · `live` (listed, playable) · `closed` (not listed, not playable, scoreboard still viewable) |
| hero_title_en / hero_title_fr | varchar(200) null | landing headline; null → UI default "Become THE {game_title}!" |
| tagline_en / tagline_fr | varchar(300) null | landing sub-headline |
| description_en / description_fr | text null | hub card + landing paragraph |
| location | varchar(200) null | |
| starts_on / ends_on | date null | |
| languages | JSON list | subset of `["en","fr"]`, at least one |
| default_language | varchar(2) | must be in `languages` |
| branding | JSON | see §3.1 |
| questions_per_game | int | 1–50, default 15 |
| timer_seconds | int | 5–120, default 20 |
| points_correct | int ≥0 | default 100 |
| points_wrong | int ≥0 | default 0 |
| time_bonus_max | int ≥0 | default 50 |
| category_distribution | JSON null | `{ "<category_id>": weight }`; null/empty → equal split |
| question_order | varchar(12) | `random` (default) · `easy_to_hard` |
| collect_phone | varchar(10) | `hidden` · `optional` (default) · `required` |
| consent_text_en / consent_text_fr | text null | if set, registration shows a **required** consent checkbox |
| created_at / updated_at | datetime | |

### 3.1 `branding` JSON
```json
{
  "primary_color": "#FC5607",
  "accent_color": "#FF9A52",
  "background_style": "aurora",
  "logo_url": null,
  "default_theme": "dark"
}
```
`background_style` ∈ `aurora | grid | plain`. `default_theme` ∈ `dark | light | system`.
`logo_url` null → default Gravitee logo; when set it is shown next to the Gravitee mark.
Colors are `#RRGGBB`. The UI derives *every* tint/shade from these two colors with CSS
`color-mix()` / `oklch`, so any admin-chosen color must produce a readable, good-looking UI.

### Changed existing tables
* `categories`: + `event_id` (FK events, **ON DELETE CASCADE**, NOT NULL after backfill), + `name_fr`, + `description_fr` (nullable). Unique `(event_id, name)` replaces unique `name`.
* `questions`: + `event_id` (FK, CASCADE, NOT NULL after backfill), + `question_format` (`true_false` | `two_choices`; backfill: `true_false` when `upper(green_label_en)='TRUE'` and `upper(red_label_en)='FALSE'`, else `two_choices`). `question_text_fr` becomes **nullable** (falls back to EN). `difficulty` 1–5 (we use 1 easy · 2 medium · 3 hard).
* `players`: + `event_id` (FK, CASCADE, NOT NULL after backfill), + `consent_at` (datetime null).
* `game_sessions`: + `event_id` (FK, CASCADE, NOT NULL after backfill); index `(event_id, status, total_score DESC)`.
* `game_settings`: **legacy**, left untouched but unused after migration.

### Migration (Alembic, run at startup under a Postgres advisory lock)
* `0001_baseline` — idempotent: creates the legacy tables if absent (so fresh DBs and legacy DBs converge).
* `0002_events` — creates `events`; inserts **one event** `slug=api-masters`, `name="API Masters"`, `game_title="API Masters"`, status `live`, languages `["en","fr"]`, branding = Gravitee orange, settings copied from the legacy `game_settings` row (defaults if none); adds the new columns, **backfills every existing category/question/player/session with that event's id**, then applies NOT NULL / FK / unique constraints.
* Must be **idempotent and transactional**, safe to run twice, and verified against a real PostgreSQL 15 loaded with a legacy dataset (see backend task).
* Fresh DB (no events after migrations) → seed `events/api-masters.json` (bundled in the image at `/app/seed/events/`).

## 4. Behavioural rules

* **Question selection** (`POST .../games`): active questions of the event only. If `category_distribution` is set → allocate by normalized weights (largest-remainder); else equal split across categories that have active questions (largest-remainder, remainder spread randomly). If a category lacks questions, redistribute the shortfall to other categories; finally fill randomly. Fewer active questions than `questions_per_game` → 400 `not_enough_questions`. `question_order=easy_to_hard`: sort by difficulty ascending, random within a difficulty; `random`: shuffle.
* **Answers**: `green`/`red`. `true_false` ⇒ green = TRUE, red = FALSE. `two_choices` ⇒ labels name the two options.
* **Scoring** (computed server-side at submit): correct → `points_correct + int(time_bonus_max * (1 - t/timer))` with `t` clamped to `[0, timer_seconds]`; wrong → `points_wrong`; unanswered (null **or missing from the submission**) → 0 and counted as unanswered.
* **Status gating**: `draft` → 404 for the public (visible with a valid admin Bearer token, so admins can preview); `closed` → event + scoreboard readable, register/start → 403 `{"detail":"event_closed"}`.
* **Privacy**: the public scoreboard never exposes email or phone; names are shortened to `First L.` (backend does it). Full details only via admin endpoints.
* **Admin auth**: `POST /api/auth/login`; credentials from env; constant-time comparison; in-memory login throttling per IP+username over a 5 min sliding window with **two thresholds**: from `LOGIN_MAX_FAILURES` (10) failures a *wrong* password gets 429 + `Retry-After` while a *correct* one still logs in (so an attendee or scanner behind a shared proxy IP cannot lock the real admin out); from `LOGIN_HARD_MAX_FAILURES` (50) every attempt gets 429 without the password being checked, until failures slide out of the window (per replica); production refuses to start with default `SECRET_KEY`/`admin:admin` when `APP_ENV=production`.
* Sync DB code is served from threadpool (`def` endpoints, not `async def`); the SSE endpoint must not hold a DB session for its lifetime.

## 5. REST API

Base: `/api`. JSON in/out. Errors: `{"detail": "..."}` (422 validation: FastAPI default list).
Timestamps ISO-8601 UTC. `{slug}` public routes, `{id}` numeric admin routes.

### 5.1 Public
| method | path | |
|---|---|---|
| GET | `/api/health` (also `/health`) | `{"status":"ok","db":"ok"}` |
| GET | `/api/livez` (also `/livez`) | liveness, no database: always `{"status":"ok"}` while the process answers (use it for the Kubernetes liveness probe; `/api/health` is the readiness check, 503 when the DB is down) |
| GET | `/api/events` | live events → `[EventSummary]` |
| GET | `/api/events/{slug}` | `EventPublic` (404 if draft & not admin) |
| POST | `/api/events/{slug}/players` | register → `Player` (201). Body `{first_name,last_name,email,phone_number?,consent?}`; phone required if `collect_phone=required`, ignored if `hidden`; `consent` must be true if consent text set |
| POST | `/api/events/{slug}/games` | body `{player_id}` (player must belong to event) → `{game_session_id, timer_seconds, points_correct, time_bonus_max, questions:[QuestionForGame], submit_token}` (`submit_token`: random secret of this game, shown once; only its SHA-256 is stored) |
| POST | `/api/events/{slug}/games/{game_id}/submit` | body `{answers:[{question_id, player_answer: "green"\|"red"\|null, time_taken}], submit_token?}` (the token may instead be sent as the `X-Game-Token` header) → `GameComplete` (403 `invalid_game_token`, 403 `event_closed`, 409 `game_already_completed`) |
| GET | `/api/events/{slug}/games/{game_id}/result` | the same `GameComplete` for an **already completed** game, for a player whose submit response was lost (the retry gets 409): header `X-Game-Token` only (a GET has no body), checked exactly like submit; 403 `invalid_game_token`, 409 `{"detail":"game_not_completed"}` while the game is in progress (or abandoned), 404 unknown game / game of another event; read-only so it also works for `closed` events; `rank`/`total_players` computed as for submit, at the time of the call; `Cache-Control: no-store` |
| GET | `/api/events/{slug}/scoreboard?limit=10` | `[ScoreboardEntry]` (limit ≤ 100) |
| GET | `/api/events/{slug}/scoreboard/stream?limit=10` | SSE, see below |

`EventSummary`: `{slug,name,game_title,status,tagline_en,tagline_fr,description_en,description_fr,location,starts_on,ends_on,languages,default_language,branding}`.
`EventPublic` = EventSummary + `{hero_title_en,hero_title_fr,settings:{questions_per_game,timer_seconds,points_correct,points_wrong,time_bonus_max,collect_phone,consent_text_en,consent_text_fr,question_order}, categories:[{id,name,name_fr,color,question_count}], stats:{players,games_completed}}` (only active categories with ≥1 active question).
`QuestionForGame`: `{id,question_format,question_text_en,question_text_fr,question_type,media_url,green_label_en,green_label_fr,red_label_en,red_label_fr,difficulty,category:{id,name,name_fr,color}|null}` — **never** the answer/explanation.
`GameComplete`: `{game_session:{id,player_id,status,total_score,correct_answers,wrong_answers,unanswered,started_at,completed_at}, rank, total_players, review:[{question_id,question_format,question_text_en,question_text_fr,correct_answer,player_answer,is_correct,explanation_en,explanation_fr,time_taken,points_earned,green_label_*,red_label_*,category}]}`.
`ScoreboardEntry`: `{id (game session id), rank, player_name, score, correct_answers, wrong_answers, completed_at}`.
**SSE**: each message `data: {"entries":[ScoreboardEntry…],"total_players":N,"total_games":M}\n\n`; sent immediately on connect, then whenever the content changes (in-process notify on submit **plus** a ≤5 s DB re-check so it works across replicas/restarts), `: keepalive` comment every 15 s; headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

**Game integrity** (`submit_token`): `POST .../games` returns the secret; `submit` and `result` check it in constant time against the stored hash. A wrong token is always refused (403 `{"detail":"invalid_game_token"}`); a missing one only when `REQUIRE_SUBMIT_TOKEN=true` (default `false` during the staged rollout; enabled in docker-compose / k8s). **Closed events**: once an admin closes an event, registrations and new games are refused at once (403 `event_closed`), but a game that is still `in_progress` can be submitted for a **15-minute grace** counted from the start of that game, so closing never robs a player mid-game.

### 5.2 Auth
`POST /api/auth/login {username,password}` → `{access_token,token_type}` · `POST /api/auth/logout` · `GET /api/auth/me` → `{username}`.

### 5.3 Admin (Bearer admin JWT)
**Events**
* `GET /api/admin/events` → `[EventAdmin + counts{questions,active_questions,categories,players,games_completed}]`
* `POST /api/admin/events` (EventCreate: slug,name,game_title required; the rest defaulted; status default `draft`) → 201 EventAdmin
* `GET|PUT /api/admin/events/{id}` (PUT is a partial update; `branding` merged key-by-key)
* `DELETE /api/admin/events/{id}?confirm={slug}` → 204, cascade (400 if confirm mismatch)
* `POST /api/admin/events/{id}/duplicate` `{slug,name,game_title?,copy_branding=true,copy_settings=true,copy_questions=true}` → 201 EventAdmin (status `draft`; category ids in `category_distribution` remapped)
* `GET /api/admin/events/{id}/export` → bundle (§6) with `Content-Disposition: attachment`
* `POST /api/admin/events/import` `{bundle, slug?, name?, status?}` → 201 EventAdmin (409 on slug conflict)
* `GET /api/admin/events/{id}/stats` → `{players,games_completed,games_in_progress,games_abandoned,avg_score,top_score,avg_correct,questions_active,hardest_questions:[{id,question_text_en,correct_rate,answered}],easiest_questions:[…]}` (top 5 each, min 3 answers; `games_in_progress` = started less than 3 h ago, `games_abandoned` = `abandoned` status or still `in_progress` after 3 h)

`EventAdmin` = every `events` column (nested: `branding`, `settings{…}` for the rules columns; flat text/meta fields).

**Categories** — `GET|POST /api/admin/events/{id}/categories` · `PUT|DELETE /api/admin/categories/{cid}` (delete sets questions' category to null). Category: `{id,event_id,name,name_fr,description,description_fr,color,is_active,question_count}`.

**Questions** — `GET /api/admin/events/{id}/questions?skip&limit&include_inactive&category_id&difficulty&question_format&search` → `{items:[Question],total}` · `POST /api/admin/events/{id}/questions` · `PUT|DELETE /api/admin/questions/{qid}` · `POST /api/admin/events/{id}/questions/bulk {ids,action:"activate"|"deactivate"|"delete"|"set_category"|"set_difficulty",category_id?,difficulty?}` → `{affected}` · `POST /api/admin/events/{id}/questions/import-csv` (multipart `file`, `?dry_run=true`) → `{created,skipped_duplicates,categories_created,errors:[{row,message}]}` (CSV columns as `questions/API Masters Quiz Questions - quiz_questions.csv`; `question_format` column optional, inferred like the migration) · `GET /api/admin/events/{id}/questions/export.csv`.
`Question` (admin) = all columns incl. `correct_answer`, `explanation_*`, `category`, `question_format`, `is_active`, `difficulty`, `media_url`.

**Results** — `GET /api/admin/events/{id}/results?skip&limit&search&order=recent|score` → `{items:[{id,player{id,first_name,last_name,email,phone_number,consent_at},status,total_score,correct_answers,wrong_answers,unanswered,started_at,completed_at}],total}` · `GET /api/admin/results/{sid}` (adds `answers:[{question_id,question_text_en,question_text_fr,green_label_en,red_label_en,correct_answer,player_answer,is_correct,time_taken,points_earned,question_order}]`) · `DELETE /api/admin/results/{sid}[?purge_player=true]` · `DELETE /api/admin/events/{id}/results?confirm={slug}[&include_players=true]` → `{deleted_results,deleted_players}` (purge every game of the event; 400 if `confirm` is not the slug; registered players are only deleted with `include_players=true`) · `PATCH /api/admin/results/{sid}/score {total_score}` · `GET /api/admin/events/{id}/results.csv` (leads export: rank, first/last name, email, phone, consent_at, score, correct, wrong, completed_at; CSV-injection-safe cells).
Result mutations notify the SSE broadcaster.

## 6. Event bundle (export / import / seed) — `format: gravitee-quiz-event`, `version: 1`
```jsonc
{
  "format": "gravitee-quiz-event", "version": 1,
  "event": {
    "slug": "world-ai-summit-2026", "name": "...", "game_title": "AI Masters", "status": "live",
    "hero_title_en": "...", "hero_title_fr": "...", "tagline_en": "...", "tagline_fr": "...",
    "description_en": "...", "description_fr": "...", "location": "Amsterdam", "starts_on": "2026-10-07", "ends_on": "2026-10-08",
    "languages": ["en","fr"], "default_language": "en",
    "branding": { "primary_color": "#…", "accent_color": "#…", "background_style": "aurora", "logo_url": null, "default_theme": "dark" },
    "settings": { "questions_per_game": 15, "timer_seconds": 20, "points_correct": 100, "points_wrong": 0, "time_bonus_max": 50,
                  "category_distribution": { "<category name>": 20, "...": 20 },   // keyed by category NAME in bundles
                  "question_order": "easy_to_hard", "collect_phone": "optional", "consent_text_en": null, "consent_text_fr": null }
  },
  "categories": [ { "name": "LLMs & GenAI", "name_fr": "LLM & IA générative", "description": "...", "description_fr": "...", "color": "#7C5CFF", "is_active": true } ],
  "questions": [ { "category": "LLMs & GenAI", "question_format": "true_false", "difficulty": 1,
                   "question_text_en": "...", "question_text_fr": "...", "correct_answer": "green",
                   "green_label_en": "TRUE", "green_label_fr": "Vrai", "red_label_en": "FALSE", "red_label_fr": "Faux",
                   "explanation_en": "...", "explanation_fr": "...", "is_active": true } ]
}
```
`true_false` questions always use labels TRUE/FALSE (Vrai/Faux). `two_choices` labels are short (≤ 40 chars, ideally ≤ 25) so they fit on a big button.

## 7. Frontend conventions (no build step)

* Vanilla **ES modules**, no framework, no bundler, no runtime CDN dependency (events have flaky Wi-Fi):
  fonts and icons are **self-hosted** under `shared/` (woff2 variable fonts, inline SVG icon sprite), QR lib vendored.
* `shared/css/{tokens,base,components}.css`, `shared/js/{api,theme,branding,i18n,dom,config}.js`, `shared/icons/sprite.svg`,
  `shared/fonts/*`, `shared/vendor/*`, `shared/README.md` documenting the public API. The design-system agent owns it; app agents consume it and may **not** modify it (ask via report).
* Served at `/shared/…` by `web/` nginx; the admin container serves a copy at `/admin/shared/…` (each Dockerfile `COPY shared/`).
* Runtime config: `window.QUIZ_CONFIG = { apiBase: "/api" }` from a generated `config.js` (nginx entrypoint writes it from `API_BASE_URL`, default `/api`). Same-origin by default.
* **i18n**: `en`/`fr`; language = `?lang=` → localStorage → event default → browser → `en`. Content fields use `pick(obj,'name')` (→ `name_fr` when lang=fr and non-empty, else EN). UI strings in per-app dictionaries.
* **Branding**: `applyBranding(event.branding)` sets `--brand`, `--brand-accent`, derived tokens, `data-bg` style, document title (`{game_title} · {event.name}`), `theme-color`, SVG favicon tinted with the brand.
* **Theme**: dark / light / system, per-event default, user override persisted.
* **CSP-compatible**: nginx sends `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`. So: **no inline `<script>`, no inline event-handler attributes, no `eval`, no external hosts**. Dynamic styling goes through CSS custom properties set from JS (`el.style.setProperty`) which CSP allows. Web Bluetooth/SSE/fetch are same-origin or browser APIs.
* **Untrusted data (XSS rules, audited)**: player names, emails, event / category / question texts, bundle and CSV files, API error messages and SSE payloads are all attacker-controlled. The apps never build HTML from them: text goes through `el()` / `textContent` (no `innerHTML`, `insertAdjacentHTML`, `document.write`, string timers, `eval`; `check-static.mjs` fails the build on them). Values that reach an *attribute* are validated first: image URLs only `https://…` or `/path` (`isSafeImageUrl` in `web/js/lib/format.js`, `isSafeAssetUrl` in the admin `core/util.js`; never `javascript:`, `data:`, `//host`, `\`), colours only hex before they are put in a CSS custom property (`safeColor`), `mailto:` addresses are percent-encoded, route ids are plain decimals, slugs go through `encodeURIComponent`. Every external link has `rel="noopener"`. Regression scripts: the e2e `07*-xss-*` specs.
* **Caching**: HTML/JS/CSS are served `Cache-Control: no-cache` (ETag revalidation — there are no hashed filenames); fonts/icons/images `public, max-age=2592000, immutable`.
* **Quality bar**: mobile-first (players are on phones, portrait), WCAG AA contrast with arbitrary brand colors, keyboard operable, visible focus, `prefers-reduced-motion` respected, `aria-live` for timer/feedback, no layout shift, < 150 KB JS per page (excluding vendor QR), works offline-ish when fonts fail.
* **Look & feel — "modern"**: dark-first, luminous brand-colored aurora/mesh backgrounds, subtle glass surfaces with hairline borders, big expressive display type, generous spacing, pill buttons with glow, giant tactile answer buttons, circular countdown ring, animated score count-up + confetti on results, podium for the top 3 on the scoreboard, smooth view transitions. Gravitee logo present on every screen footer/header ("Powered by Gravitee").
* **Buzzer** (Web Bluetooth + keyboard `G`/`R`) behaviour of the legacy `game-client` **must be preserved** (green = `G`, red = `R`; `buzzer.js`/`buzzer-ui.js` are ported, not rewritten from scratch, and still work with the buzzer firmware GATT service).

## 8. Deployment topology (AKS, namespace `quiz-game`)

Ingress `quiz-ingress` (nginx ingress, cert-manager `google-ca-http01`), **host `quiz.events.gravitee.io` only** (TLS secret `quiz-events-tls`):
`/api` → `quiz-backend:8000` · `/admin` → `quiz-admin-console:80` · `/` → `quiz-web:80`.
Deployments: `quiz-backend`, `quiz-web`, `quiz-admin-console`, `quiz-db` (+PVC). The old `quiz-game-client` and `quiz-scoreboard` deployments are removed. Images `dobl1/quiz-{backend,web,admin-console}:2.0.0` (linux/amd64).
Secrets (never committed): `quiz-backend-secret` has `SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`; `APP_ENV=production`.

## 9. Local development ports (shared by all agents — do not change)

| service | host port |
|---|---|
| gateway (everything, same origin) | **8080** |
| backend direct | 8000 |
| postgres (compose) | 127.0.0.1:5432 |

Backend-agent private test resources (do not collide): Postgres container `quiz-test-pg` on **55432**, uvicorn on **8100**.
Admin credentials in local dev: `admin` / `admin`.
