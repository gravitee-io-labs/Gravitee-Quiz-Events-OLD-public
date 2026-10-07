#!/usr/bin/env bash
#
# Creates or completes the Kubernetes secret `quiz-backend-secret`.
#
#   SECRET_KEY      JWT signing key. Generated (random, 64 chars) when missing, still the legacy
#                   placeholder, or shorter than 32 chars. Rotating it only signs admins out.
#   ADMIN_USERNAME  Defaults to "admin" when missing.
#   ADMIN_PASSWORD  Generated (random, 24 chars) when missing, empty or "admin".
#
# Existing good values are never touched. Secrets are never printed, with ONE exception: a
# freshly generated ADMIN_PASSWORD is shown once, at the end. Store it in a password manager.
#
# Why this script and not secrets.yaml: applying a Secret manifest overwrites the live values with
# whatever is in the file. This script only fills in what is missing.
#
# Usage: k8s/create-backend-secret.sh [--yes] [--dry-run]
#   --yes       do not ask for confirmation
#   --dry-run   show what would be created / changed, change nothing
#
# Environment: NAMESPACE (default quiz-game), KUBE_CONTEXT (default: current context),
#              ADMIN_USERNAME_DEFAULT (default admin), KUBECTL (default kubectl)
set -euo pipefail

NAMESPACE="${NAMESPACE:-quiz-game}"
SECRET="quiz-backend-secret"
KUBECTL="${KUBECTL:-kubectl}"
ADMIN_USERNAME_DEFAULT="${ADMIN_USERNAME_DEFAULT:-admin}"
LEGACY_PLACEHOLDER="your-secret-key-change-in-production"

ASSUME_YES=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

kc() {
  if [ -n "${KUBE_CONTEXT:-}" ]; then "$KUBECTL" --context "$KUBE_CONTEXT" "$@"; else "$KUBECTL" "$@"; fi
}

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

context="$(kc config current-context 2>/dev/null || echo '?')"
echo "Cluster context : $context"
echo "Namespace       : $NAMESPACE"
echo "Secret          : $SECRET"

if ! kc get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Namespace $NAMESPACE not found (or cluster unreachable). Apply k8s/namespace.yaml first." >&2
  exit 1
fi

# Value of one key of the live secret ("" when absent). Held in a variable, never echoed.
# A kubectl failure aborts the script (set -e): an unreadable key must never be mistaken for a
# missing one, or a transient API error would rotate good credentials.
secret_value() {
  local raw
  raw="$(kc get secret "$SECRET" -n "$NAMESPACE" -o "jsonpath={.data.$1}")"
  if [ -n "$raw" ]; then printf '%s' "$raw" | openssl base64 -d -A; fi
}

exists=false
if kc get secret "$SECRET" -n "$NAMESPACE" >/dev/null 2>&1; then exists=true; fi

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
gen_secret_key() { openssl rand -base64 48 | tr -d '\n'; }
gen_password() { openssl rand -base64 18 | tr '+/' 'Zk' | tr -d '\n='; }

new_secret_key=""
new_admin_user=""
new_admin_password=""
actions=()

if [ "$exists" = true ]; then
  cur_key="$(secret_value SECRET_KEY)"
  cur_user="$(secret_value ADMIN_USERNAME)"
  cur_pass="$(secret_value ADMIN_PASSWORD)"
  if [ -z "$cur_key" ]; then
    new_secret_key="$(gen_secret_key)"; actions+=("SECRET_KEY: missing -> generate")
  elif [ "$cur_key" = "$LEGACY_PLACEHOLDER" ] || [ "${#cur_key}" -lt 32 ]; then
    new_secret_key="$(gen_secret_key)"; actions+=("SECRET_KEY: legacy placeholder / too short -> rotate (admin sessions are signed out)")
  fi
  if [ -z "$cur_user" ]; then
    new_admin_user="$ADMIN_USERNAME_DEFAULT"; actions+=("ADMIN_USERNAME: missing -> $ADMIN_USERNAME_DEFAULT")
  fi
  if [ -z "$cur_pass" ] || [ "$cur_pass" = "admin" ]; then
    new_admin_password="$(gen_password)"; actions+=("ADMIN_PASSWORD: missing or default -> generate")
  fi
  unset cur_key cur_user cur_pass
else
  new_secret_key="$(gen_secret_key)"
  new_admin_user="$ADMIN_USERNAME_DEFAULT"
  new_admin_password="$(gen_password)"
  actions+=("secret does not exist -> create with SECRET_KEY, ADMIN_USERNAME, ADMIN_PASSWORD")
fi

if [ "${#actions[@]}" -eq 0 ]; then
  echo "OK: $SECRET already has a strong SECRET_KEY, ADMIN_USERNAME and ADMIN_PASSWORD. Nothing to do."
  exit 0
fi

echo "Planned changes :"
for a in "${actions[@]}"; do echo "  - $a"; done

if [ "$DRY_RUN" = true ]; then
  echo "(dry run: nothing changed)"
  exit 0
fi

if [ "$ASSUME_YES" != true ]; then
  answer=""
  read -r -p "Apply to context '$context'? [y/N] " answer || { echo ""; echo "Aborted: no answer on stdin (use --yes for non-interactive runs)."; exit 1; }
  case "$answer" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# Secret material only travels through stdin, never through command-line arguments.
if [ "$exists" = false ]; then
  kc create -f - >/dev/null <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $SECRET
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/name: quiz-backend
    app.kubernetes.io/part-of: gravitee-quiz
type: Opaque
data:
  SECRET_KEY: $(b64 "$new_secret_key")
  ADMIN_USERNAME: $(b64 "$new_admin_user")
  ADMIN_PASSWORD: $(b64 "$new_admin_password")
EOF
else
  # JSON merge patch: only the keys listed below change, everything else stays as is.
  patch='{"data":{'
  sep=""
  if [ -n "$new_secret_key" ]; then patch+="${sep}\"SECRET_KEY\":\"$(b64 "$new_secret_key")\""; sep=","; fi
  if [ -n "$new_admin_user" ]; then patch+="${sep}\"ADMIN_USERNAME\":\"$(b64 "$new_admin_user")\""; sep=","; fi
  if [ -n "$new_admin_password" ]; then patch+="${sep}\"ADMIN_PASSWORD\":\"$(b64 "$new_admin_password")\""; sep=","; fi
  patch+='}}'
  printf '%s' "$patch" | kc patch secret "$SECRET" -n "$NAMESPACE" --type merge --patch-file /dev/stdin >/dev/null
fi

echo "Done: $SECRET updated in namespace $NAMESPACE."
if [ -n "$new_admin_password" ]; then
  user="${new_admin_user:-$(secret_value ADMIN_USERNAME)}"
  echo ""
  echo "  ================ ADMIN CREDENTIALS (shown once) ================"
  echo "   login    : $user"
  echo "   password : $new_admin_password"
  echo "  ================================================================"
  echo "  Store the password in a password manager now: it cannot be read back from this script."
fi
if [ "$exists" = true ]; then
  echo "Running backend pods keep their old values until restarted:"
  echo "  kubectl rollout restart deployment/quiz-backend -n $NAMESPACE"
fi
