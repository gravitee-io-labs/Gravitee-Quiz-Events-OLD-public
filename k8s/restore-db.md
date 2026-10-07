# Restoring the production database

These are **manual** procedures: nothing here is automated on purpose. Restoring replaces data, so
do it deliberately, with the dump file at hand and the backend stopped.

All commands target the namespace `quiz-game`. Check `kubectl config current-context` first.

## 0. Take a safety backup of the current state first

Even if the current state is broken, you may want it back:

```bash
k8s/backup-db.sh          # -> backups/quiz-<timestamp>.dump  (gitignored, mode 600, contains personal data)
```

Check a dump is readable before you rely on it:

```bash
pg_restore --list backups/quiz-20261006T180000Z.dump | head      # needs a local PostgreSQL client
```

## 1. Stop the writers

The backend must not write while the database is replaced.

```bash
kubectl scale deployment/quiz-backend -n quiz-game --replicas=0
kubectl wait --for=delete pod -l app.kubernetes.io/name=quiz-backend -n quiz-game --timeout=90s   # until the pods are gone
```

## 2. Restore

The dump is in `pg_dump --format=custom`. Restore into a clean database: drop and recreate it
(from the `postgres` maintenance database, because you cannot drop the database you are connected to).

```bash
DUMP=backups/quiz-20261006T180000Z.dump

# a) recreate an empty database (credentials come from the pod's own environment)
kubectl exec -n quiz-game deploy/quiz-db -- sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""'

# b) load the dump (stdin of pg_restore)
kubectl exec -i -n quiz-game deploy/quiz-db -- sh -c '
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-acl --exit-on-error' < "$DUMP"
```

## 3. Bring the backend back

Which images you start decides which schema must be in the dump:

| You want | Dump taken | Images |
|---|---|---|
| Undo a bad data change, stay on 2.0 | any 2.0 dump | `dobl1/quiz-backend:2.0.0` (migrations are idempotent: nothing to re-run) |
| **Roll back to 1.0.5** | the dump taken **before** the first 2.0 deploy (legacy schema) | `dobl1/quiz-backend:1.0.5` + the old frontends, see "Rollback" in `docs/DEPLOYMENT.md` |

Never run the 1.0.5 backend on a database that already went through the 2.0 migration: the legacy
code does not know `event_id` and its inserts fail.

```bash
kubectl scale deployment/quiz-backend -n quiz-game --replicas=2
kubectl rollout status deployment/quiz-backend -n quiz-game
curl -fsS https://quiz.events.gravitee.io/api/health
```

## 4. Check

- `https://quiz.events.gravitee.io/api/events` lists the expected events.
- Admin console > event > Results shows the expected players and scores.
- `python3 scripts/quizctl.py events` (see `scripts/README.md`) prints the same event list with counts.

## Restoring into a local database (to inspect a production dump safely)

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U quiz_user -d gravitee_quiz --no-owner --clean --if-exists < backups/quiz-....dump
```
