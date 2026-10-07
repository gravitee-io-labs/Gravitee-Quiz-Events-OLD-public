#!/usr/bin/env bash
#
# Build, push and deploy Gravitee Quiz Events (https://quiz.events.gravitee.io) to AKS.
#
#   k8s/deploy.sh [TAG] [options]        TAG defaults to 2.0.0
#
# Pipeline (each stage can be selected, see options):
#   1. build   docker buildx --platform linux/amd64 for quiz-backend, quiz-web, quiz-admin-console
#   2. push    docker push dobl1/quiz-*:TAG
#   3. deploy  pre-flight (secrets) -> DB backup -> kubectl apply -k -> rollout status -> smoke checks
#
# Options:
#   --build-only      only build the images
#   --push-only       only push images that are already built
#   --deploy-only     only deploy (images must already exist in the registry)
#   --no-deploy       build and push, do not deploy
#   --prune-legacy    after a successful rollout, delete the old quiz-game-client and
#                     quiz-scoreboard deployments and services (the pre-2.0 apps)
#   --skip-backup     do NOT take a database backup before applying (not recommended)
#   --restart         rollout restart the app deployments after apply (needed when only a secret
#                     or a re-pushed image changed: the same tag does not roll pods by itself)
#   --yes, -y         do not ask for confirmation before touching the cluster
#   --dry-run         change nothing: no build, no push, no backup, no apply. Checks the cluster and
#                     the secrets (read only), renders the manifests with TAG and validates them
#                     against the cluster with `kubectl apply --dry-run=client`
#   --help, -h        this help
#
# Environment: NAMESPACE (default quiz-game), KUBE_CONTEXT (default: current context),
#              PUBLIC_URL (default https://quiz.events.gravitee.io)
#
# Safety: the manifests are applied from a temporary copy (the repository is never modified), the
# script refuses to deploy when quiz-backend-secret has no ADMIN_PASSWORD (create it with
# k8s/create-backend-secret.sh), and a failed pre-flight aborts before anything changes.
set -euo pipefail

REGISTRY="dobl1"   # Docker Hub organisation; also hard-wired in k8s/kustomization.yaml
NAMESPACE="${NAMESPACE:-quiz-game}"
PUBLIC_URL="${PUBLIC_URL:-https://quiz.events.gravitee.io}"
TAG="2.0.0"
SERVICES=(backend web admin-console)          # image dobl1/quiz-<service>, Dockerfile <service>/Dockerfile
DEPLOYMENTS=(quiz-backend quiz-web quiz-admin-console)

BUILD=true
PUSH=true
DEPLOY=true
PRUNE_LEGACY=false
BACKUP=true
RESTART=false
ASSUME_YES=false
DRY_RUN=false

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
step()    { echo "${BLUE}==>${NC} $*"; }
ok()      { echo "${GREEN}OK${NC}  $*"; }
warn()    { echo "${YELLOW}WARN${NC} $*"; }
fail()    { echo "${RED}ERROR${NC} $*" >&2; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --build-only)   PUSH=false; DEPLOY=false ;;
    --push-only)    BUILD=false; DEPLOY=false ;;
    --deploy-only)  BUILD=false; PUSH=false ;;
    --no-deploy)    DEPLOY=false ;;
    --prune-legacy) PRUNE_LEGACY=true ;;
    --skip-backup)  BACKUP=false ;;
    --restart)      RESTART=true ;;
    --yes|-y)       ASSUME_YES=true ;;
    --dry-run)      DRY_RUN=true ;;
    --help|-h)      usage; exit 0 ;;
    -*)             fail "unknown option: $arg"; usage; exit 2 ;;
    *)              TAG="$arg" ;;
  esac
done

if ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  fail "invalid image tag: '$TAG'"; exit 2
fi

cd "$(dirname "$0")/.."     # repository root: the Docker build context

kc() {
  if [ -n "${KUBE_CONTEXT:-}" ]; then kubectl --context "$KUBE_CONTEXT" "$@"; else kubectl "$@"; fi
}

echo ""
echo "=========================================="
echo "  Gravitee Quiz Events - deployment"
echo "=========================================="
echo "  Registry : $REGISTRY"
echo "  Tag      : $TAG"
echo "  Stages   : build=$BUILD push=$PUSH deploy=$DEPLOY"
if [ "$DRY_RUN" = true ]; then echo "  Mode     : DRY RUN (nothing is built, pushed or changed)"; fi
if [ "$DEPLOY" = true ]; then
  echo "  Target   : $PUBLIC_URL (namespace $NAMESPACE)"
  echo "  Options  : backup=$BACKUP restart=$RESTART prune-legacy=$PRUNE_LEGACY"
fi
echo "=========================================="
echo ""

# --------------------------------------------------------------------------- build
if [ "$DRY_RUN" = true ]; then
  if [ "$BUILD" = true ]; then
    for svc in "${SERVICES[@]}"; do warn "[dry-run] would build $REGISTRY/quiz-$svc:$TAG (linux/amd64, $svc/Dockerfile)"; done
  fi
  if [ "$PUSH" = true ]; then
    for svc in "${SERVICES[@]}"; do warn "[dry-run] would push $REGISTRY/quiz-$svc:$TAG"; done
  fi
  BUILD=false
  PUSH=false
fi
if [ "$BUILD" = true ]; then
  command -v docker >/dev/null || { fail "docker is required"; exit 1; }
  step "Building images for linux/amd64 (context: repository root)"
  for svc in "${SERVICES[@]}"; do
    step "quiz-$svc"
    docker buildx build --platform linux/amd64 \
      -t "$REGISTRY/quiz-$svc:$TAG" \
      -f "$svc/Dockerfile" \
      --load .
    ok "built $REGISTRY/quiz-$svc:$TAG"
  done
fi

# --------------------------------------------------------------------------- push
if [ "$PUSH" = true ]; then
  command -v docker >/dev/null || { fail "docker is required"; exit 1; }
  step "Pushing images to the registry"
  for svc in "${SERVICES[@]}"; do
    docker push "$REGISTRY/quiz-$svc:$TAG"
    ok "pushed $REGISTRY/quiz-$svc:$TAG"
  done
fi

# --------------------------------------------------------------------------- deploy
if [ "$DEPLOY" = true ]; then
  command -v kubectl >/dev/null || { fail "kubectl is required"; exit 1; }
  command -v curl >/dev/null || { fail "curl is required (smoke checks)"; exit 1; }

  step "Pre-flight"
  if ! kc cluster-info >/dev/null 2>&1; then
    fail "cannot reach the Kubernetes cluster: check your kubeconfig / VPN"; exit 1
  fi
  context="$(kc config current-context 2>/dev/null || echo '?')"
  ok "cluster context: $context"

  # The backend (APP_ENV=production) refuses to start without these: fail here, not in a crash loop.
  if ! kc get secret quiz-db-secret -n "$NAMESPACE" >/dev/null 2>&1; then
    fail "secret quiz-db-secret not found in namespace $NAMESPACE (it holds the database credentials)"; exit 1
  fi
  if ! kc get secret quiz-backend-secret -n "$NAMESPACE" >/dev/null 2>&1; then
    fail "secret quiz-backend-secret not found. Create it first:  k8s/create-backend-secret.sh"; exit 1
  fi
  for key in ADMIN_PASSWORD SECRET_KEY ADMIN_USERNAME; do
    if [ -z "$(kc get secret quiz-backend-secret -n "$NAMESPACE" -o "jsonpath={.data.$key}")" ]; then
      fail "quiz-backend-secret has no $key. Fix it with:  k8s/create-backend-secret.sh"; exit 1
    fi
  done
  ok "quiz-backend-secret and quiz-db-secret are complete"

  if [ "$ASSUME_YES" != true ] && [ "$DRY_RUN" != true ]; then
    echo ""
    echo "About to deploy $REGISTRY/quiz-{backend,web,admin-console}:$TAG to context '$context'."
    answer=""
    read -r -p "Continue? [y/N] " answer || { echo ""; echo "Aborted: no answer on stdin (use --yes for non-interactive runs)."; exit 1; }
    case "$answer" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
  fi

  # Backup BEFORE the first start of a new backend: it migrates the schema at startup.
  if [ "$DRY_RUN" = true ]; then
    warn "[dry-run] would back up the database before applying"
  elif [ "$BACKUP" = true ]; then
    if kc get deployment quiz-db -n "$NAMESPACE" >/dev/null 2>&1; then
      step "Database backup (pre-deploy)"
      NAMESPACE="$NAMESPACE" KUBE_CONTEXT="${KUBE_CONTEXT:-}" k8s/backup-db.sh
    else
      warn "quiz-db deployment not found: first install, nothing to back up"
    fi
  else
    warn "--skip-backup: no database backup taken"
  fi

  # Render a TEMPORARY copy of k8s/ with the requested tag: the repository is never modified.
  render_dir="$(mktemp -d)"
  trap 'rm -rf "$render_dir"' EXIT
  cp -R k8s/. "$render_dir/"
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' -E "s/newTag: \".*\"/newTag: \"$TAG\"/" "$render_dir/kustomization.yaml"
  else
    sed -i -E "s/newTag: \".*\"/newTag: \"$TAG\"/" "$render_dir/kustomization.yaml"
  fi
  # Sanity: the rendered manifests must reference the requested tag, nothing else.
  rendered="$(kc kustomize "$render_dir")"
  for svc in "${SERVICES[@]}"; do
    if ! printf '%s\n' "$rendered" | grep -q "image: $REGISTRY/quiz-$svc:$TAG\$"; then
      fail "rendered manifests do not reference $REGISTRY/quiz-$svc:$TAG (check k8s/kustomization.yaml images)"; exit 1
    fi
  done

  if [ "$DRY_RUN" = true ]; then
    step "Dry run: validating the manifests against the cluster (client side, nothing is changed)"
    printf '%s\n' "$rendered" | kc apply --dry-run=client -f -
    warn "[dry-run] would then wait for the rollouts of ${DEPLOYMENTS[*]} quiz-db, run the smoke checks on $PUBLIC_URL"
    ok "dry run finished: nothing was built, pushed or changed"
    echo "  Real run: k8s/deploy.sh $TAG"
    exit 0
  fi

  step "Applying manifests (kustomize, tag $TAG)"
  printf '%s\n' "$rendered" | kc apply -f -

  if [ "$RESTART" = true ]; then
    step "Restarting app deployments"
    for d in "${DEPLOYMENTS[@]}"; do kc rollout restart "deployment/$d" -n "$NAMESPACE"; done
  fi

  step "Waiting for rollouts (the first backend start runs the database migrations)"
  for d in "${DEPLOYMENTS[@]}" quiz-db; do
    if ! kc rollout status "deployment/$d" -n "$NAMESPACE" --timeout=300s; then
      fail "rollout of $d did not complete."
      echo "  Inspect : kubectl logs -n $NAMESPACE deploy/$d --tail=100 ; kubectl describe pod -n $NAMESPACE -l app.kubernetes.io/name=$d"
      echo "  Rollback: kubectl rollout undo deployment/$d -n $NAMESPACE   (see docs/DEPLOYMENT.md > Rollback; a migrated database needs the pre-deploy dump to go back to 1.0.5)"
      exit 1
    fi
  done
  ok "all deployments rolled out"

  if [ "$PRUNE_LEGACY" = true ]; then
    step "Removing the pre-2.0 apps (quiz-game-client, quiz-scoreboard)"
    kc delete deployment quiz-game-client quiz-scoreboard -n "$NAMESPACE" --ignore-not-found
    kc delete service quiz-game-client quiz-scoreboard -n "$NAMESPACE" --ignore-not-found
  elif kc get deployment quiz-game-client -n "$NAMESPACE" >/dev/null 2>&1 \
       || kc get deployment quiz-scoreboard -n "$NAMESPACE" >/dev/null 2>&1; then
    warn "legacy deployments quiz-game-client / quiz-scoreboard still exist and are no longer routed. Remove them with --prune-legacy"
  fi

  # Smoke checks through the public URL. The first deploy may have to wait for cert-manager
  # to issue the certificate for quiz.events.gravitee.io (HTTP-01, usually 1-2 minutes).
  step "Smoke checks on $PUBLIC_URL"
  smoke() {   # smoke <path> <grep pattern or "">
    local path="$1" pattern="$2" attempt out
    for attempt in $(seq 1 36); do
      if out="$(curl -fsS --max-time 10 "$PUBLIC_URL$path" 2>/dev/null)"; then
        if [ -z "$pattern" ] || printf '%s' "$out" | grep -q "$pattern"; then
          ok "GET $path"
          return 0
        fi
      fi
      [ "$attempt" -eq 1 ] && echo "     waiting for $PUBLIC_URL$path (DNS / TLS certificate / pods)..."
      sleep 5
    done
    return 1
  }
  smoke_failed=false
  smoke /api/health '"status"' || smoke_failed=true
  smoke /api/events ''         || smoke_failed=true
  smoke / ''                   || smoke_failed=true
  smoke /admin/ ''             || smoke_failed=true
  if [ "$smoke_failed" = true ]; then
    fail "smoke checks failed. Look at: kubectl get certificate,ingress,pods -n $NAMESPACE"
    echo "  Certificate not ready yet? kubectl describe certificate quiz-events-tls -n $NAMESPACE"
    exit 1
  fi
  ok "smoke checks passed"

  step "Status"
  kc get pods -n "$NAMESPACE"
  kc get ingress -n "$NAMESPACE"
fi

echo ""
echo "=========================================="
echo "  Done"
echo "=========================================="
echo "Images:"
for svc in "${SERVICES[@]}"; do echo "  - $REGISTRY/quiz-$svc:$TAG"; done
if [ "$DEPLOY" = true ]; then
  echo ""
  echo "URLs:"
  echo "  - $PUBLIC_URL/                      hub"
  echo "  - $PUBLIC_URL/{event-slug}          event game"
  echo "  - $PUBLIC_URL/{event-slug}/scoreboard"
  echo "  - $PUBLIC_URL/admin/                admin console"
  echo "  - $PUBLIC_URL/api/health"
  echo ""
  echo "Next: create / import events (docs/DEPLOYMENT.md > Create a new event), e.g."
  echo "  QUIZ_API_URL=$PUBLIC_URL/api python3 scripts/quizctl.py events"
fi
echo ""
