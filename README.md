# Gravitee Quiz Events

A multi-event buzzer quiz game. One deployment hosts **many events** — *API Masters* at API Days, *AI Masters* at the World Summit AI, whatever comes next — each with its own branding, questions, categories, rules, players and live scoreboard.

Players answer **green or red**: either true/false statements or two-choice questions, from their phone, a booth laptop, or with the physical Bluetooth buzzers (keys `G` / `R` also work).

| URL | What |
|---|---|
| `https://quiz.events.gravitee.io/` | Hub — all live events |
| `https://quiz.events.gravitee.io/{slug}` | Play an event (e.g. `/world-ai-summit-2026`) |
| `https://quiz.events.gravitee.io/{slug}/scoreboard` | Live scoreboard for a big screen (SSE, QR code to join) |
| `https://quiz.events.gravitee.io/admin/` | Admin console |
| `https://quiz.events.gravitee.io/api` | Backend API (Swagger UI at `/api/docs` in local dev only; disabled in production) |

## Features

- **Events as first-class objects** — create from scratch, **duplicate** an existing one, import/export as JSON bundles. Everything is configurable from the admin console:
  - branding: game title, colours, background style, logo, default theme, hero/tagline/description (EN/FR)
  - categories (EN/FR names, colours) and questions (true/false or two-choice, difficulty, bilingual text + explanations)
  - rules: questions per game, timer, scoring and time bonus, category weights, question order (random / easy → hard)
  - registration: phone hidden/optional/required, optional consent checkbox
  - lifecycle: `draft` (preview for admins) → `live` → `closed` (scoreboard stays readable)
- **Modern UI** — dark-first, brand-driven design system (`shared/`), mobile-first, EN/FR, light/dark, accessible, self-hosted fonts and icons (no CDN: conference Wi-Fi is hostile).
- **Live scoreboard** — podium, animated updates over SSE with polling fallback, QR code, TV-friendly. No PII is exposed publicly.
- **Buzzers** — Web Bluetooth integration with the nRF52840 buzzer firmware in `buzzer-firmware/`.
- **Operations** — results and leads CSV export, per-event stats (hardest/easiest questions), CSV question import, `quizctl` CLI.

## Quick start (local)

```bash
docker compose up -d --build
open http://localhost:8080          # hub (a demo "API Masters" event is seeded on first start)
open http://localhost:8080/admin/   # admin / admin
```

Everything is served through one gateway on `:8080` (same origin, same paths as production). The backend is also on `:8000`, API docs at `http://localhost:8080/api/docs`.

For live reload of the backend and the static apps use the dev override (bind mounts): `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d` (see `docs/DEPLOYMENT.md`).

## Repository layout

```
backend/         FastAPI + SQLAlchemy + Alembic (PostgreSQL), pytest suite
shared/          Design system (CSS tokens/components, JS modules, icons, fonts) — see shared/README.md
web/             Player app: hub, event game, scoreboard (static, no build step)
admin-console/   Admin SPA (static, no build step)
gateway/         nginx gateway used by docker-compose (mirrors the production ingress)
events/          Event bundles (JSON): api-masters, world-ai-summit-2026
questions/       Legacy CSV question sets
scripts/         quizctl (CLI), bundle validator/converter
k8s/             Kubernetes manifests + deploy script
e2e/             Playwright end-to-end tests
buzzer-firmware/ nRF52840 Bluetooth buzzer firmware (Zephyr)
docs/            ARCHITECTURE.md (contract), DEPLOYMENT.md
```

## Creating an event

1. **Admin console → New event** → *Blank*, *Duplicate existing* (copies branding, rules, categories and questions — never players or results) or *Import bundle*.
2. Edit **Appearance** (title, colours, texts), **Questions**/**Categories**, **Settings** (rules). The overview tab shows a readiness checklist.
3. Set the status to **live**; share `/{slug}` (the Overview tab has a QR code) and put `/{slug}/scoreboard` on the big screen.

From the command line: `python3 scripts/quizctl.py --help` (import/export bundles, CSV import, results export).
Bundle format: `docs/ARCHITECTURE.md` §6. Examples in `events/`.

## Development

```bash
# backend
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt && pytest

# end-to-end (needs the compose stack on :8080)
cd e2e && npm install && npx playwright install chromium && npx playwright test
```

Architecture, data model and API contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Deployment (AKS), backups, rollback: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Security notes

- Admin credentials and the JWT secret come from the environment; in production (`APP_ENV=production`) the backend refuses to start with default values.
- The public scoreboard exposes display names only (`First L.`); emails/phones are reachable through the admin API only.
- HTML is served with a strict CSP (no inline scripts, no external hosts).

---

Made with ❤️ by **Dorian BLANC**
