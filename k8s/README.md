# Kubernetes manifests (namespace `quiz-game`)

Production topology of Gravitee Quiz Events on AKS. Full guide (DNS/TLS, secrets, deploy, rollback,
runbooks): **[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)**.

```
https://quiz.events.gravitee.io  (ingress quiz-ingress, cert-manager google-ca-http01, secret quiz-events-tls)
  /api    -> quiz-backend:8000        1 replica    dobl1/quiz-backend:2.0.0
  /admin  -> quiz-admin-console:80    1 replica    dobl1/quiz-admin-console:2.0.0
  /       -> quiz-web:80              1 replica    dobl1/quiz-web:2.0.0
quiz-db:5432   PostgreSQL 15 + PVC quiz-db-pvc (5Gi)
```

| File | Content |
|---|---|
| `namespace.yaml` | namespace `quiz-game` |
| `configmaps.yaml` | `quiz-backend-config` (CORS origin, docs off), `quiz-frontend-config` (`API_BASE_URL=/api`) |
| `database.yaml` | PVC, `quiz-db` deployment (Recreate) and service: unchanged from 1.0.5 |
| `backend.yaml` | `quiz-backend`: `APP_ENV=production`, probes on `/health`, rolling update with `maxUnavailable: 0` |
| `web.yaml`, `admin-console.yaml` | static nginx deployments and services |
| `networkpolicy.yaml` | only the backend pods may open `quiz-db:5432` (the DB password is still the old default, see `docs/DEPLOYMENT.md`) |
| `ingress.yaml` | single host, Prefix paths `/api` `/admin` `/`, 3600 s proxy timeouts for the scoreboard SSE stream |
| `kustomization.yaml` | resources + image tags (`2.0.0`) |
| `secrets.example.yaml` | **reference only**, not applied (it would overwrite live secrets) |
| `deploy.sh` | build, push, back up, apply, wait, smoke-check (`--help`) |
| `create-backend-secret.sh` | creates / completes `quiz-backend-secret` (random `SECRET_KEY` and `ADMIN_PASSWORD`, only what is missing) |
| `backup-db.sh`, `restore-db.md` | `pg_dump` to `backups/` (gitignored) and the restore procedure |

## Everyday commands

```bash
kubectl config current-context                  # make sure it is the right cluster
kubectl kustomize k8s/                          # render
kubectl apply --dry-run=client -k k8s/          # validate (never changes the cluster)
k8s/create-backend-secret.sh                    # once, before the first 2.0 deploy
k8s/deploy.sh --dry-run                         # rehearsal: checks + validation, changes nothing
k8s/deploy.sh                                   # build + push + deploy 2.0.0
k8s/deploy.sh 2.0.1 --deploy-only               # roll out an already pushed tag
k8s/backup-db.sh                                # database backup
kubectl get pods,ingress,certificate -n quiz-game
```

## Rules of this directory

- **Secrets are never part of the kustomization.** `quiz-db-secret` exists in the cluster; `quiz-backend-secret` is managed by
  `create-backend-secret.sh`. Never commit a secret value.
- `commonLabels` in `kustomization.yaml` are part of the immutable Deployment selectors: do not change them.
- The ingress serves **only** `quiz.events.gravitee.io`.
