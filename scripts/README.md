# scripts/

## quizctl.py - admin CLI

One dependency-light tool (Python 3.9+, `requests`) to manage events from a terminal. It talks to the
**admin REST API** (`docs/ARCHITECTURE.md` section 5.3), exactly like the admin console, so it behaves the
same against the local stack and production.

```bash
pip install -r scripts/requirements.txt        # once (a virtualenv is a good idea)
python3 scripts/quizctl.py --help
```

### Connection

| Variable | Default | Notes |
|---|---|---|
| `QUIZ_API_URL` | `http://localhost:8080/api` | Must end with `/api`. Production: `https://quiz.events.gravitee.io/api` |
| `QUIZ_ADMIN_USER` | `admin` | The `admin` default is applied **only for localhost** |
| `QUIZ_ADMIN_PASSWORD` | `admin` | Same: for a remote API it is read from the variable, or prompted (hidden) in a terminal |

Each of them also has a flag (`--api-url`, `--user`, `--password`), but prefer the variables: command-line
arguments are visible in `ps`. Plain `http://` to a non-local host works but prints a warning.

```bash
# production, password prompted
export QUIZ_API_URL=https://quiz.events.gravitee.io/api
export QUIZ_ADMIN_USER=admin
python3 scripts/quizctl.py events
```

### Commands

| Command | What it does |
|---|---|
| `events [--json]` | List events: id, slug, status, game title, active/total questions, categories, players, completed games |
| `export <slug\|id> [-o FILE]` | Export an event as a JSON bundle (`format: gravitee-quiz-event`). Prints to stdout without `-o` |
| `import <bundle.json> [--slug S] [--name N] [--status draft\|live\|closed]` | Create an event from a bundle. `409` if the slug exists (use `--slug`). Imported as the bundle says (usually `draft`); `--status live` lists it on the hub |
| `duplicate <slug\|id> --slug S --name N [--game-title T] [--no-branding] [--no-settings] [--no-questions]` | Copy an event (branding, rules, categories, questions; never players or results). The copy is a `draft` |
| `import-csv <slug\|id> <file.csv> [--dry-run]` | Add questions from a CSV (same columns as `questions/API Masters Quiz Questions - quiz_questions.csv`; `question_format` optional). Duplicates are skipped. Exit code 1 if some rows have errors. `--dry-run` validates only |
| `stats <slug\|id> [--json]` | Players, games, scores, hardest / easiest questions |
| `results-csv <slug\|id> [-o FILE]` | Leads export: names, e-mails, phones, consent, scores. **Personal data**: the file is created mode 600 |
| `purge-results <slug\|id> --yes [--confirm SLUG]` | Delete every game result of the event (irreversible). Needs `--yes` **and** the slug typed at the prompt (or `--confirm <slug>` when not in a terminal) |

`<slug|id>` is the event slug (`api-masters`) or its numeric id (shown by `events`).

Exit codes: `0` ok, `1` the API refused / unreachable / row errors, `2` usage error.

### Typical flows

```bash
# 1. publish the World AI Summit event on production (the bundle is already `live`; add --status draft to review it first)
python3 scripts/quizctl.py import events/world-ai-summit-2026.json

# 2. a new API Days event based on API Masters (new name, same questions, branding and rules), edit it, then publish in the admin console
python3 scripts/quizctl.py duplicate api-masters --slug api-days-paris-2027 --name "API Days Paris 2027"

# 3. back up an event definition before editing it live
python3 scripts/quizctl.py export world-ai-summit-2026 -o backups/world-ai-summit-2026.json

# 4. check a CSV of new questions without writing anything, then really import it
python3 scripts/quizctl.py import-csv api-masters new-questions.csv --dry-run
python3 scripts/quizctl.py import-csv api-masters new-questions.csv

# 5. after the event: leads, then clean the scoreboard
python3 scripts/quizctl.py results-csv world-ai-summit-2026 -o leads-wais26.csv
python3 scripts/quizctl.py purge-results world-ai-summit-2026 --yes
```

> `purge-results` deletes the game results one by one through `DELETE /api/admin/results/{id}`. Delete the
> whole event in the admin console (cascade) to also remove its players.

### Tests

`test_quizctl.py` runs the real HTTP layer against an in-process fake of the admin API: argument parsing,
credential rules, token refresh, every command's exact paths, query strings and bodies.

```bash
python3 -m unittest scripts/test_quizctl.py -v        # from the repository root, no backend needed
```

Against a real backend, `python3 scripts/quizctl.py events` is the smoke test (login + list).

## What replaced the old scripts

| Old | Now |
|---|---|
| `import_questions.py --mode add` | `quizctl.py import-csv <slug> <file.csv>` (server side, per event) |
| `import_questions.py --mode replace` | create a fresh event (`import` / `duplicate`) instead of wiping one |
| `db_manage.py stats` | `quizctl.py stats <slug>` / `quizctl.py events` |
| `db_manage.py purge/reset` (local) | `docker compose down -v` then `docker compose up -d` |
| `db_manage.py purge/reset` (k8s) | removed on purpose (it deleted the production volume). Backup: `k8s/backup-db.sh`; restore: `k8s/restore-db.md` |
