#!/usr/bin/env bash
#
# Backs up the production PostgreSQL database to a local, gitignored file.
#
#   k8s/backup-db.sh                 -> backups/quiz-<UTC timestamp>.dump   (pg_dump custom format)
#   BACKUP_DIR=/safe/place k8s/backup-db.sh
#
# pg_dump runs INSIDE the quiz-db pod (kubectl exec) and streams to this machine: the database
# password never leaves the pod, nothing is written on the cluster. The dump contains players'
# personal data (names, e-mails, phone numbers): the file is created with mode 600, keep it safe.
# Restore: see k8s/restore-db.md.
#
# Environment: NAMESPACE (default quiz-game), KUBE_CONTEXT (default: current), BACKUP_DIR
#              (default <repo>/backups), KUBECTL (default kubectl)
set -euo pipefail

NAMESPACE="${NAMESPACE:-quiz-game}"
KUBECTL="${KUBECTL:-kubectl}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$repo_root/backups}"

kc() {
  if [ -n "${KUBE_CONTEXT:-}" ]; then "$KUBECTL" --context "$KUBE_CONTEXT" "$@"; else "$KUBECTL" "$@"; fi
}

case "${1:-}" in
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/quiz-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

echo "Cluster context : $(kc config current-context 2>/dev/null || echo '?')"
echo "Backing up      : deployment/quiz-db in namespace $NAMESPACE -> $final"

# shellcheck disable=SC2016  # $POSTGRES_* must be expanded by the shell INSIDE the pod, not here
# POSTGRES_* come from the pod's own environment (secretKeyRef): no credential passes through here.
kc exec -n "$NAMESPACE" deploy/quiz-db -- sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$partial"

# A custom-format dump starts with the magic bytes "PGDMP".
if [ "$(head -c 5 "$partial")" != "PGDMP" ]; then
  echo "ERROR: the dump is empty or not a PostgreSQL custom-format archive. Backup NOT created." >&2
  exit 1
fi

mv "$partial" "$final"
trap - EXIT
size="$(wc -c < "$final" | tr -d ' ')"
echo "OK: $final ($size bytes)"
echo "Verify with:  pg_restore --list '$final' | head"
