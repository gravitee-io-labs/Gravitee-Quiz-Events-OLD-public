# Deployment guide

How Gravitee Quiz Events runs locally and in production, how to ship a new version, how to go back,
and how to create an event. The product contract (URLs, API, data model) is `docs/ARCHITECTURE.md`.

- [1. Architecture](#1-architecture)
- [2. Local stack (docker compose)](#2-local-stack-docker-compose)
- [3. Production: DNS and TLS](#3-production-dns-and-tls)
- [4. First-time setup: secrets](#4-first-time-setup-secrets)
- [5. Build, push, deploy](#5-build-push-deploy)
- [6. First 2.0 deployment (legacy data migration)](#6-first-20-deployment-legacy-data-migration)
- [7. Database backup and restore](#7-database-backup-and-restore)
- [8. Rollback](#8-rollback)
- [9. Runbook: create a new event](#9-runbook-create-a-new-event)
- [10. Event day and after](#10-event-day-and-after)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Reference](#12-reference)

---

## 1. Architecture

One public host, `https://quiz.events.gravitee.io`, three paths, three small services, one database.

```
                      https://quiz.events.gravitee.io
                                   |
                   nginx ingress (TLS by cert-manager)
        .------------------+--------------------+------------------.
        | /api             | /admin             | /  (everything else)
        v                  v                    v
  quiz-backend:8000   quiz-admin-console:80   quiz-web:80
  FastAPI, 2 pods     nginx static SPA        nginx static, 2 pods
        |                  (served under /admin/)   hub, /{slug}, /{slug}/scoreboard
        v
  quiz-db:5432  PostgreSQL 15 + PVC (5Gi)
```

| Piece | Image | Notes |
|---|---|---|
| `quiz-backend` | `dobl1/quiz-backend:2.0.0` | `APP_ENV=production`; runs the Alembic migrations at startup (advisory lock) |
| `quiz-web` | `dobl1/quiz-web:2.0.0` | static player app; `/shared/`, `/assets/` and a generated `/config.js` |
| `quiz-admin-console` | `dobl1/quiz-admin-console:2.0.0` | static SPA served under `/admin/` (path preserved end to end) |
| `quiz-db` | `postgres:15-alpine` | unchanged, data on PVC `quiz-db-pvc` |

Images are `linux/amd64`. Everything is same-origin: no CORS needed, `API_BASE_URL=/api`.
The old `quiz-game-client` and `quiz-scoreboard` apps are gone (their job is `quiz-web` now).

Routing rules of `quiz-web` (nginx, `web/nginx.conf`): `/` hub, `/{slug}` event game, `/{slug}/scoreboard`
scoreboard, static prefixes first (`/shared/ /assets/ /css/ /js/ ...`), reserved slugs and unknown deep paths
answer a 404 page. Headers (CSP, `Permissions-Policy` with `bluetooth=(self)`, nosniff...) and caching
(HTML/JS/CSS revalidated, fonts/icons/images immutable) are set by the containers, see ARCHITECTURE section 7.

## 2. Local stack (docker compose)

Prerequisites: Docker Desktop (or Docker Engine + compose v2).

```bash
cp .env.example .env            # optional, every value has the same default
docker compose up -d --build    # first start builds the images and migrates a fresh database
open http://localhost:8080
```

| URL | What |
|---|---|
| http://localhost:8080/ | hub |
| http://localhost:8080/api-masters | event game (the seeded API Masters event) |
| http://localhost:8080/api-masters/scoreboard | scoreboard |
| http://localhost:8080/admin/ | admin console, `admin` / `admin` |
| http://localhost:8080/api/docs | OpenAPI UI (dev only) |
| http://127.0.0.1:8000 / `127.0.0.1:5432` | backend / PostgreSQL directly (loopback only) |

The `gateway` container routes exactly like the production ingress (`/api` backend, `/admin` console,
`/` web), so there is one origin and nothing to configure. `docker compose ps` shows `healthy` for every
service once the whole chain gateway -> backend -> database works.

**Dev mode (default).** `docker-compose.override.yml` is merged automatically: `./backend` is mounted and
uvicorn reloads on change; `./web`, `./shared`, `./admin-console`, `./assets` are mounted read-only into the
nginx containers, so an edit shows after a browser refresh (HTML/JS/CSS are `no-cache`; fonts, icons and
images are cached as immutable: hard-refresh after replacing one).

**Production-like run** (the images as they will be deployed, no mounts):

```bash
docker compose -f docker-compose.yml up -d --build
```

Useful commands:

```bash
docker compose logs -f backend              # follow one service
docker compose down                         # stop, keep the data
docker compose down -v                      # stop and DELETE the local database (fresh start, re-seeds api-masters)
GATEWAY_PORT=9090 docker compose up -d      # another entry port when 8080 is taken
```

Test from a phone on the same Wi-Fi: `http://<your-LAN-IP>:8080` (the gateway port is published on all
interfaces on purpose). Web Bluetooth (buzzers) needs a secure context: it works on `localhost` and on the
production HTTPS host, not on a plain `http://192.168.x.y` address.

## 3. Production: DNS and TLS

- **DNS.** `quiz.events.gravitee.io` already resolves to the cluster's ingress IP through the `*.events.gravitee.io`
  wildcard (the ingress controller's public IP). Nothing to create. Check with `dig +short quiz.events.gravitee.io`
  and compare with `kubectl get ingress -n quiz-game`.
- **TLS.** The ingress carries `cert-manager.io/cluster-issuer: google-ca-http01` and `tls.secretName: quiz-events-tls`.
  cert-manager creates the certificate and the secret by itself via HTTP-01. The first issuance takes 1 to 2 minutes
  after the first apply; until then the host serves the ingress controller's fake certificate. Follow it with
  `kubectl get certificate -n quiz-game -w` (wait for `READY True`).
- **Only this host is exposed.** The previous host `api-masters.events.gravitee.io` is no longer in the ingress.
  Its old certificate secret `quiz-tls-secret` is orphaned and can be removed once the new host is verified
  (`kubectl get certificate -n quiz-game` should then list `quiz-events-tls` only; cert-manager drops the old `Certificate`
  object by itself): `kubectl delete secret quiz-tls-secret -n quiz-game`.
- TLS ends at the ingress: the containers only speak plain HTTP behind it. HSTS, if wanted, comes from the ingress-nginx
  controller configuration (its default is on), not from the containers.

## 4. First-time setup: secrets

Two secrets are involved, neither is ever committed or applied from a file.

| Secret | Keys | Managed by |
|---|---|---|
| `quiz-db-secret` | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL` | already in the cluster, only read by the manifests. The password is baked into the PostgreSQL volume: do not change it |
| `quiz-backend-secret` | `SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `k8s/create-backend-secret.sh` |

With `APP_ENV=production` the backend **refuses to start** on the placeholder `SECRET_KEY`, a key shorter than
32 characters, or `ADMIN_PASSWORD=admin`. The live `quiz-backend-secret` still holds the old placeholder key and no
admin password, so run this once before the first 2.0 deploy:

```bash
kubectl config current-context            # must be your quiz AKS cluster
k8s/create-backend-secret.sh --dry-run    # shows what would change, prints no secret
k8s/create-backend-secret.sh              # asks for confirmation, then fills in what is missing
```

It never overwrites a good value, never prints a secret, and shows the freshly generated **admin password once**:
put it in the team password manager right away. `k8s/secrets.example.yaml` documents the keys; it is deliberately
not part of `k8s/kustomization.yaml` (applying a Secret manifest would overwrite the live values with placeholders).

To rotate the admin password later, remove the key, let the script generate a new one, then restart the backend:

```bash
kubectl patch secret quiz-backend-secret -n quiz-game --type json -p '[{"op":"remove","path":"/data/ADMIN_PASSWORD"}]'
k8s/create-backend-secret.sh
kubectl rollout restart deployment/quiz-backend -n quiz-game     # pods read the secret at start only
```

### Database password and network isolation

The `quiz-db-secret` created with the very first deployment still holds the **default password published in the repository
history** (`quiz_password`, from the old `k8s/secrets.yaml`). Two layers limit the damage:

- `k8s/networkpolicy.yaml` (applied with the rest) lets **only the backend pods** open `quiz-db:5432`; every other pod of the
  cluster, including other namespaces, is refused. Backups, restores and the probes run inside the database pod and are not affected.
- Rotate the password once, **outside an event** (about a minute of API errors: the backend and the database restart; the data
  is not touched). Paste it into a throwaway `bash` session (it sets `set -e`) pointing at the right cluster; nothing is printed, the password only travels through stdin:

```bash
set -euo pipefail; NS=quiz-game; NEW="$(openssl rand -hex 24)"
DBUSER="$(kubectl get secret quiz-db-secret -n $NS -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)"
DBNAME="$(kubectl get secret quiz-db-secret -n $NS -o jsonpath='{.data.POSTGRES_DB}' | base64 -d)"
# 1. new password inside PostgreSQL
printf 'ALTER USER "%s" PASSWORD '"'"'%s'"'"';\n' "$DBUSER" "$NEW" | kubectl exec -i -n $NS deploy/quiz-db -- sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
# 2. same password in the secret (both keys)
printf '{"data":{"POSTGRES_PASSWORD":"%s","DATABASE_URL":"%s"}}' \
  "$(printf '%s' "$NEW" | base64 | tr -d '\n')" \
  "$(printf 'postgresql://%s:%s@quiz-db:5432/%s' "$DBUSER" "$NEW" "$DBNAME" | base64 | tr -d '\n')" \
  | kubectl patch secret quiz-db-secret -n $NS --type merge --patch-file /dev/stdin >/dev/null
# 3. restart the two consumers (the database pod exports the password that backup-db.sh uses)
kubectl rollout restart deployment/quiz-backend deployment/quiz-db -n $NS
unset NEW
```

Check afterwards: `curl -fsS https://quiz.events.gravitee.io/api/health` and `k8s/backup-db.sh`.

## 5. Build, push, deploy

Prerequisites: `docker login` to Docker Hub (org `dobl1`, push rights), Docker with `buildx` (Docker Desktop has it; the images
are cross-built for `linux/amd64`, slow but fine on Apple Silicon), `kubectl` pointing at your quiz AKS cluster
(check: `kubectl config current-context`), `curl`. The commands below are written from the repository root.

```bash
k8s/deploy.sh --dry-run           # rehearsal: nothing is built, pushed or changed
k8s/deploy.sh                     # tag 2.0.0: build + push + backup + deploy + smoke checks
k8s/deploy.sh 2.0.1               # another tag (the repository is not modified: a temporary copy of the kustomization is applied)
k8s/deploy.sh --help
```

| Option | Effect |
|---|---|
| `--build-only` / `--push-only` / `--deploy-only` / `--no-deploy` | select the stages |
| `--prune-legacy` | delete the old `quiz-game-client` / `quiz-scoreboard` deployments and services after a successful rollout |
| `--restart` | `rollout restart` the three app deployments (same tag, re-pushed image or changed secret) |
| `--skip-backup` | skip the pre-deploy database backup (not recommended) |
| `--dry-run` | change nothing: checks the cluster and both secrets (read only), renders the manifests for the tag and validates them with `kubectl apply --dry-run=client`. Run it first |
| `--yes` | no confirmation prompt |

What the deploy stage does, in order: checks the cluster is reachable and both secrets are complete (**refuses to deploy
when `quiz-backend-secret` has no `ADMIN_PASSWORD`**), asks for confirmation, takes a database backup into `backups/`,
applies the manifests, waits for the rollouts (`quiz-backend`, `quiz-web`, `quiz-admin-console`, `quiz-db`, up to 5 minutes each),
optionally prunes the legacy apps, then curls `https://quiz.events.gravitee.io/api/health`, `/api/events`, `/` and `/admin/`
(retrying up to 3 minutes so a first-time certificate has time to be issued). Any failure exits non-zero.

Manual equivalent, if you ever need it:

```bash
docker buildx build --platform linux/amd64 -t dobl1/quiz-backend:2.0.0 -f backend/Dockerfile --push .
docker buildx build --platform linux/amd64 -t dobl1/quiz-web:2.0.0 -f web/Dockerfile --push .
docker buildx build --platform linux/amd64 -t dobl1/quiz-admin-console:2.0.0 -f admin-console/Dockerfile --push .
kubectl kustomize k8s/ | less                 # review
kubectl apply --dry-run=client -k k8s/        # validate
k8s/backup-db.sh && kubectl apply -k k8s/
```

Rolling updates are zero-downtime (`maxUnavailable: 0`, readiness probes on `/health`, backend and web run 1 replica each, as in the original deployment; scale up with `kubectl scale` if wanted).
Static files are not cached beyond revalidation, so a new `web` image is visible on the next page load; fonts and images
are immutable by design, rename a file when you change it.

## 6. First 2.0 deployment (legacy data migration)

The production database holds the legacy API Masters data (categories, questions, players, scores). On the first start the
2.0 backend **migrates it in place** (Alembic, one transaction, advisory lock): it creates the event `api-masters`
from the legacy settings and attaches every existing category, question, player and game to it. Nothing is lost, but the
schema change is one-way, so:

1. **Schedule it outside any live event**: from the moment the new backend starts, the old frontends no longer work
   (the API changed); the new ones take over at the same time.
2. `k8s/create-backend-secret.sh` (section 4).
3. `k8s/deploy.sh --prune-legacy` (a database backup is taken automatically; keep that file until the event is over).
4. Verify: `https://quiz.events.gravitee.io/` lists the `API Masters` event; `/api-masters` plays; `/admin/` logs in with
   the new admin credentials and shows the same questions and results as before.
5. Import the World AI Summit event (section 9.C: `python3 scripts/quizctl.py import events/world-ai-summit-2026.json`; the
   production database is not empty, so nothing seeds it by itself) and open `/world-ai-summit-2026` on a phone.
6. When satisfied, optionally clean the old certificate secret (section 3).

## 7. Database backup and restore

```bash
k8s/backup-db.sh          # -> backups/quiz-<UTC timestamp>.dump   (pg_dump custom format, mode 600, gitignored)
```

`pg_dump` runs inside the `quiz-db` pod and streams to your machine; nothing is written in the cluster and the database
password never leaves the pod. The dump contains personal data (names, e-mails, phones): keep it private.
Take one **before every deploy** (`deploy.sh` does) and before any manual data operation. Restore procedure:
[`k8s/restore-db.md`](../k8s/restore-db.md).

## 8. Rollback

Pick the smallest rollback that fixes the problem.

**a) Bad frontend or backend release, database still fine** (new schema kept): go back to the previous 2.x tag.

```bash
k8s/deploy.sh 2.0.0 --deploy-only --skip-backup --restart     # re-apply the previous tag
# or, quickest for one component:
kubectl rollout undo deployment/quiz-web -n quiz-game
```

**b) Data damaged** (bad import, accidental deletion): restore a 2.0 dump with the 2.0 images, see `k8s/restore-db.md`.

**c) Back to the pre-2.0 stack (1.0.5)**: last resort. The 1.0.5 backend does not know the new schema, so the database
must go back to the dump taken **before** the first 2.0 deploy, and the old manifests must be re-applied:

```bash
# 1. stop the writers
kubectl scale deployment/quiz-backend -n quiz-game --replicas=0
kubectl wait --for=delete pod -l app.kubernetes.io/name=quiz-backend -n quiz-game --timeout=90s
# 2. restore the pre-2.0 dump           -> k8s/restore-db.md, step 2
# 3. old manifests, from the last commit before the rework (42311c9). The old kustomization lists a
#    secrets.yaml with placeholder values: remove it so the live secrets are not overwritten.
OLD="$(mktemp -d)"; git archive 42311c9 k8s | tar -x -C "$OLD"
sed -i.bak '/secrets.yaml/d' "$OLD/k8s/kustomization.yaml"
kubectl apply -k "$OLD/k8s"                     # backend/game-client/admin/scoreboard 1.0.5 + the old host
# 4. remove what the old stack does not know about
kubectl delete deployment/quiz-web service/quiz-web -n quiz-game
```

The old stack serves `https://api-masters.events.gravitee.io` again (cert-manager re-issues the certificate if you already
removed the old secret). Everything players did on 2.0 since the dump is lost: this is why a rollback of this kind is only
realistic in the first minutes after the first 2.0 deploy. Tag the pre-rework commit before merging:
`git tag pre-multi-event 42311c9`.

## 9. Runbook: create a new event

An event is a self-contained quiz: its own branding, categories, questions, rules, players and scoreboard.
Admin credentials are the ones from section 4.

### A. In the admin console (`https://quiz.events.gravitee.io/admin/`)

1. **Events > New event**: slug (lowercase letters, digits and hyphens, e.g. `api-days-paris-2027`: it becomes the URL
   `/{slug}`; reserved words such as `admin`, `api`, `shared` are refused), name, game title (`API Masters`, `AI Masters`...),
   languages (`en`, `fr`), dates and location.
2. **Branding**: primary and accent colours, background style, default theme, optional logo URL. The whole UI derives from
   the two colours.
3. **Game rules**: questions per game, timer, points, time bonus, category weights, question order, phone and consent fields.
4. **Categories and questions**: add them one by one, or import a CSV, or start from a duplicate (below).
5. **Status**: a new event is a `draft` (invisible to the public, visible to you when logged in). Switch it to `live` to list it
   on the hub and open registration. `closed` keeps the scoreboard viewable but stops new games.
6. Open `https://quiz.events.gravitee.io/{slug}` on a phone and play one game; open `/{slug}/scoreboard` on the big screen.

### B. Duplicate an existing event (fastest)

Admin console: event > **Duplicate** (copies branding, rules, categories and questions, never players or results; the copy is
a `draft`). Or:

```bash
export QUIZ_API_URL=https://quiz.events.gravitee.io/api QUIZ_ADMIN_USER=admin   # password: prompted
python3 scripts/quizctl.py duplicate api-masters --slug api-days-paris-2027 --name "API Days Paris 2027"
```

### C. Import a bundle (content prepared offline)

A bundle is one JSON file (`format: gravitee-quiz-event`, ARCHITECTURE section 6): event definition, categories and questions.
`events/world-ai-summit-2026.json` is the AI Masters event for the World Summit AI Amsterdam 2026 (7-8 October); its status is already `live`,
so importing it lists it on the hub right away.

```bash
python3 scripts/quizctl.py import events/world-ai-summit-2026.json              # imported as defined in the bundle (live)
python3 scripts/quizctl.py import events/world-ai-summit-2026.json --status draft   # review it first, publish later in the admin console
python3 scripts/quizctl.py import events/xyz.json --slug other-slug --name "Other name"
python3 scripts/quizctl.py events                                                # check
```

The same operation exists in the admin console (Events > Import). Re-importing an existing slug answers `409`: use `--slug`
or delete the existing event first. To save an event (before a risky edit, or to move it between environments):
`python3 scripts/quizctl.py export <slug> -o backups/<slug>.json`.

### D. Add questions from a CSV

```bash
python3 scripts/quizctl.py import-csv api-masters new-questions.csv --dry-run   # validate, writes nothing
python3 scripts/quizctl.py import-csv api-masters new-questions.csv
```

Columns are those of `questions/API Masters Quiz Questions - quiz_questions.csv`; `question_format` (`true_false` /
`two_choices`) is optional and inferred from the labels. Duplicates are skipped, bad rows are listed with their row number.

## 10. Event day and after

**Before opening the doors**

- `curl -fsS https://quiz.events.gravitee.io/api/health` returns `{"status":"ok","db":"ok"}`.
- The event is `live`; play one full game on a phone (4G, not the office network) and check it on the scoreboard.
- Buzzers: Web Bluetooth only works in Chrome/Edge on Android, Windows, macOS and ChromeOS, over HTTPS (the production host is).
- A fresh database backup: `k8s/backup-db.sh`.

**During the event**

```bash
kubectl get pods -n quiz-game                                   # all Running / Ready
kubectl logs -n quiz-game deploy/quiz-backend --tail=100 -f     # API errors
kubectl top pods -n quiz-game                                   # load (if metrics-server is available)
kubectl scale deployment/quiz-backend -n quiz-game --replicas=4 # more headroom for a big crowd
```

Scaling by hand is reset to the manifest value (2) at the next `deploy.sh`. The scoreboard stream (SSE) is served by every backend
replica and re-checks the database every few seconds, so any number of replicas shows the same ranking.

**After the event**

```bash
python3 scripts/quizctl.py results-csv <slug> -o leads-<slug>.csv    # leads export (personal data, mode 600)
python3 scripts/quizctl.py stats <slug>                              # numbers for the debrief
```

Then set the event to `closed` (scoreboard stays viewable, no new games) in the admin console. Handle the leads file
according to the consent given at registration. `quizctl purge-results <slug> --yes` empties the scoreboard (it deletes game
results, after you type the slug to confirm); deleting the whole event in the admin console also removes its players.

## 11. Troubleshooting

| Symptom | Likely cause / what to do |
|---|---|
| Browser shows a certificate warning right after the first deploy | cert-manager still issuing: `kubectl get certificate -n quiz-game`, `kubectl describe certificate quiz-events-tls -n quiz-game`, `kubectl get challenge -A`. Needs port 80 reachable (HTTP-01) and the DNS name resolving to the ingress IP |
| `502 Bad Gateway` / `503` on a path | no ready pod behind it: `kubectl get pods,endpoints -n quiz-game`, `kubectl describe pod ...`, `kubectl logs deploy/quiz-backend` |
| Backend pod `CrashLoopBackOff`, log says `Refusing to start with APP_ENV=production` | `quiz-backend-secret` has the placeholder `SECRET_KEY` or `ADMIN_PASSWORD=admin`/none: `k8s/create-backend-secret.sh`, then `kubectl rollout restart deployment/quiz-backend -n quiz-game` |
| Backend pod stuck not Ready at first start | the migration is running (up to ~3 min the first time, see the startup probe) or the database is unreachable: `kubectl logs deploy/quiz-backend`, `kubectl get pods -l app.kubernetes.io/name=quiz-db`. Another instance holding the migration advisory lock only delays it |
| Scoreboard on the big screen reconnects every minute | the ingress lost `proxy-read-timeout: "3600"` / `proxy-send-timeout: "3600"` (default is 60 s): re-apply `k8s/ingress.yaml` |
| Page loads but every API call fails | `/config.js` has the wrong `apiBase`: `curl https://quiz.events.gravitee.io/config.js` must say `/api`. Fix `quiz-frontend-config.API_BASE_URL` and restart the web and admin pods (`kubectl rollout restart deployment/quiz-web deployment/quiz-admin-console -n quiz-game`). A malformed value makes the container refuse to start (see its log) |
| Console shows `Refused to ... Content Security Policy` | a page uses an inline script / inline handler / external host. The policy (`default-src 'self'` ...) is set by `web/nginx.conf` and `admin-console/nginx.conf`; fix the page rather than loosening the policy |
| Buzzer cannot pair | unsupported browser (Safari/iOS has no Web Bluetooth) or page not served over HTTPS/localhost |
| `/{slug}` shows the 404 page for a good event | the event is a `draft` and you are logged out of the admin console (or its status is `closed` for games), or the slug is reserved |
| `/something` returns the web 404 page on `/admin` or `/api` paths | check the ingress paths: `kubectl get ingress quiz-ingress -n quiz-game -o yaml` must list `/api`, `/admin`, `/` for host `quiz.events.gravitee.io` only |
| Old URL `api-masters.events.gravitee.io` does not answer | expected: only `quiz.events.gravitee.io` is exposed now |
| Images or CSS look stale after a release | HTML/JS/CSS revalidate on every load; fonts/icons/images are immutable for 30 days: change the file name or hard-refresh |
| Local: port 8080 already in use | `GATEWAY_PORT=9090 docker compose up -d` (and use `http://localhost:9090`) |
| Local: backend not healthy | `docker compose logs backend`; wrong DB password after changing `.env`: `docker compose down -v` |
| `quizctl: authentication failed` | wrong `QUIZ_ADMIN_USER`/`QUIZ_ADMIN_PASSWORD`; 10 failures in 5 minutes lock the login for a while (HTTP 429) |

## 12. Reference

**Environment**

| Where | Variable | Value |
|---|---|---|
| backend (k8s) | `APP_ENV` | `production` |
| | `DATABASE_URL` | secret `quiz-db-secret` |
| | `SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | secret `quiz-backend-secret` |
| | `CORS_ORIGINS`, `ENABLE_DOCS` | configmap `quiz-backend-config` (`https://quiz.events.gravitee.io`, `false`) |
| web / admin (k8s and compose) | `API_BASE_URL` | `/api` (configmap `quiz-frontend-config`); a path, or an absolute http(s) URL. The CSP `connect-src` follows an absolute origin |
| compose | see `.env.example` | local development only |

**Files**

| Path | Purpose |
|---|---|
| `docker-compose.yml`, `docker-compose.override.yml`, `gateway/nginx.conf`, `.env.example` | local stack |
| `web/{Dockerfile,nginx.conf,docker-entrypoint.sh}` | player app container |
| `admin-console/{Dockerfile,nginx.conf,docker-entrypoint.sh}` | admin container |
| `k8s/*.yaml`, `k8s/kustomization.yaml` | cluster manifests (namespace `quiz-game`) |
| `k8s/deploy.sh`, `k8s/create-backend-secret.sh`, `k8s/backup-db.sh`, `k8s/restore-db.md` | operations |
| `scripts/quizctl.py` | admin CLI, see `scripts/README.md` |
