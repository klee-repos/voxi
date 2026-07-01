#!/usr/bin/env bash
# deploy.sh — build, push, and deploy the four Voxi backend services (PLAN §3, §4.4, §11).
#
#   voxi-api        → Cloud Run service, PUBLIC ingress (the ONLY public surface).
#   eve-front       → Cloud Run service, INTERNAL ingress. Serves the eve HTTP channel AND the workflow
#                     self-callbacks. The ingress/URL-map forwards BOTH /eve/* AND /.well-known/workflow/*
#                     to this service (PLAN §4.4 — graphile-worker advances runs by HTTP-calling the app's
#                     own /.well-known/workflow/v1/flow; that route MUST be reachable, ~60s ceiling).
#   eve-poller      → Cloud Run **Worker Pool** (NON-serverless, ALWAYS-ON, manual scaling). Holds the
#                     LISTEN/NOTIFY connection; never scales to zero, never N-each-polling (PLAN §4.4).
#   podcast-worker  → Cloud Run service, INTERNAL ingress (Cloud Tasks target).
#
# Usage:
#   infra/deploy/deploy.sh                 # build + push + deploy everything
#   infra/deploy/deploy.sh --deploy-only   # skip build/push (images already in Artifact Registry; CI path)
#   infra/deploy/deploy.sh --build-only    # build + push, no deploy
#
# Required env (or set near the top of this file):
#   PROJECT_ID   GCP project
#   REGION       e.g. us-central1
#   AR_REPO      Artifact Registry repo (default: voxi)
#   RUN_SA       Cloud Run runtime service account email (least-privilege; PLAN §11)
# Optional env:
#   IMAGE_TAG    image tag to deploy (default: the current git short sha, else 'latest')
#   EVE_FRONT_URL  the eve-front internal URL; if unset it is resolved after the eve-front deploy.
#
# Secrets are bound by REFERENCE from Secret Manager (never baked into images) — see infra/deploy/README.md
# for the full var → service → secret-ref inventory. This script wires those bindings via --set-secrets.
#
# RULES: this script runs `gcloud` (no creds in the build sandbox — it is authored, not executed here). It is
# idempotent: re-running updates the existing services/worker-pool/URL-map in place.
set -euo pipefail

# ---- config (env-overridable) -------------------------------------------------------------------
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-voxi}"
RUN_SA="${RUN_SA:-}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo latest)}"

# Service names
SVC_API="voxi-api"
SVC_EVE_FRONT="eve-front"
WP_EVE_POLLER="eve-poller"          # a Worker Pool, not a service
SVC_PODCAST="podcast-worker"
SVC_VOICE_BOT="voice-bot"           # realtime SmallWebRTC media plane (Python/uvicorn, §6.3)
JOB_MIGRATE="voxi-db-migrate"       # one-shot Cloud Run JOB that applies packages/db migrations at deploy

# External HTTPS LB pieces that forward /eve/* and /.well-known/workflow/* to eve-front.
URL_MAP="voxi-eve-urlmap"
NEG_EVE_FRONT="neg-eve-front"
BACKEND_EVE_FRONT="be-eve-front"

# Secret Manager references (NAME:VERSION). The IDs MUST match the containers Terraform creates from
# var.secret_ids (infra/terraform/variables.tf) + the accessor map in secrets.tf — a mismatch means a workload
# binds a non-existent secret and the deploy 500s. This block is the single source of the mapping and is
# grep-verified against secrets.tf. Reconciled 2026-07-01 (task #22):
#   * DATABASE_URL is SPLIT: `database-url-app` (voxi-api + podcast-worker, app.*) vs `database-url-eve`
#     (eve front + poller, workflow.*) — matching cloudsql.tf's two generated URLs.
#   * `url-signing-key` (was voxi-url-signing-key), `vertex-ai-key` (was gemini-api-key), `cloud-vision-key`
#     (was vision-api-key), `elevenlabs-key` (was elevenlabs-api-key), `deepgram-key` (was deepgram-api-key),
#     `photodna-key` (was ncmec-credentials — the CSAM hash-match key, §15/RT-4).
#   * RevenueCat is REMOVED (StoreKit 2 DIRECT) → `appstore-connect-api-key` for server-side entitlement verify.
SECRET_CLERK_JWT_KEY="${SECRET_CLERK_JWT_KEY:-clerk-jwt-key:latest}"
SECRET_URL_SIGNING_KEY="${SECRET_URL_SIGNING_KEY:-url-signing-key:latest}"
SECRET_DATABASE_URL_APP="${SECRET_DATABASE_URL_APP:-database-url-app:latest}"   # voxi-api + podcast-worker (app.*)
SECRET_DATABASE_URL_EVE="${SECRET_DATABASE_URL_EVE:-database-url-eve:latest}"   # eve front + poller (workflow.*)
SECRET_VERTEX_AI_KEY="${SECRET_VERTEX_AI_KEY:-vertex-ai-key:latest}"            # Gemini + embeddings (D8)
SECRET_CLOUD_VISION_KEY="${SECRET_CLOUD_VISION_KEY:-cloud-vision-key:latest}"   # web detection + SafeSearch (§15)
SECRET_ELEVENLABS_KEY="${SECRET_ELEVENLABS_KEY:-elevenlabs-key:latest}"
SECRET_DEEPGRAM_KEY="${SECRET_DEEPGRAM_KEY:-deepgram-key:latest}"               # STT for the realtime voice loop (§6.3)
SECRET_APPSTORE_KEY="${SECRET_APPSTORE_KEY:-appstore-connect-api-key:latest}"   # StoreKit 2 server-side verify (§13)
SECRET_PHOTODNA_KEY="${SECRET_PHOTODNA_KEY:-photodna-key:latest}"               # CSAM hash-match first pass (§15/RT-4)
# Non-Terraform-managed extras (created out-of-band iff used; left overridable). NOT in var.secret_ids, so the
# deploy references them ONLY when the corresponding feature is enabled — never bound blindly.
SECRET_EVE_SCOPED_SIGNING="${SECRET_EVE_SCOPED_SIGNING:-eve-scoped-token-key:latest}"  # per-session voice-bot token key
SECRET_CRON_KEY="${SECRET_CRON_KEY:-cron-shared-secret:latest}"                 # Cloud Scheduler → /internal/cron/*

# Non-secret config (plain env vars).
GCS_PHOTO_BUCKET="${GCS_PHOTO_BUCKET:-${PROJECT_ID}-voxi-photos}"
GCS_AUDIO_BUCKET="${GCS_AUDIO_BUCKET:-${PROJECT_ID}-voxi-audio}"
VPC_CONNECTOR="${VPC_CONNECTOR:-voxi-conn}"          # private egress to Cloud SQL / internal services
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:-}"           # PROJECT:REGION:INSTANCE for the --add-cloudsql-instances flag

MODE="all"
case "${1:-}" in
  --deploy-only) MODE="deploy" ;;
  --build-only)  MODE="build" ;;
  "" )           MODE="all" ;;
  * ) echo "unknown arg: $1" >&2; exit 2 ;;
esac

sa_flag() { [ -n "$RUN_SA" ] && echo "--service-account=$RUN_SA" || echo ""; }
sql_flag() { [ -n "$CLOUDSQL_INSTANCE" ] && echo "--add-cloudsql-instances=$CLOUDSQL_INSTANCE" || echo ""; }

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# =================================================================================================
# 1. BUILD + PUSH
# =================================================================================================
build_push() {
  log "Building + pushing images (tag=$IMAGE_TAG) to $REGISTRY"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  # Context is the repo root for every image (the Dockerfiles COPY across packages/ + services/).
  local ROOT
  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  for svc in "$SVC_API" "$SVC_EVE_FRONT" "$WP_EVE_POLLER" "$SVC_PODCAST" "$SVC_VOICE_BOT"; do
    log "build $svc"
    DOCKER_BUILDKIT=1 docker build \
      -f "$ROOT/infra/docker/$svc/Dockerfile" \
      -t "$REGISTRY/$svc:$IMAGE_TAG" \
      -t "$REGISTRY/$svc:latest" \
      "$ROOT"
    docker push "$REGISTRY/$svc:$IMAGE_TAG"
    docker push "$REGISTRY/$svc:latest"
  done
}

# =================================================================================================
# 2. DEPLOY
# =================================================================================================

deploy_voxi_api() {
  log "Deploy voxi-api → Cloud Run (PUBLIC — the only public surface)"
  # shellcheck disable=SC2046
  gcloud run deploy "$SVC_API" \
    --image="$REGISTRY/$SVC_API:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed \
    --ingress=all \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=1 --memory=512Mi \
    --min-instances=0 --max-instances=20 \
    --concurrency=80 \
    --timeout=120 \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-env-vars="GCS_PHOTO_BUCKET=$GCS_PHOTO_BUCKET,GCS_AUDIO_BUCKET=$GCS_AUDIO_BUCKET,EVE_FRONT_URL=${EVE_FRONT_URL:-},CLERK_PUBLISHABLE_HINT=server-verify-only" \
    --set-secrets="CLERK_JWT_KEY=$SECRET_CLERK_JWT_KEY,VOXI_URL_SIGNING_KEY=$SECRET_URL_SIGNING_KEY,DATABASE_URL=$SECRET_DATABASE_URL_APP,APPSTORE_CONNECT_API_KEY=$SECRET_APPSTORE_KEY,EVE_SCOPED_TOKEN_KEY=$SECRET_EVE_SCOPED_SIGNING,CRON_SHARED_SECRET=$SECRET_CRON_KEY"
}

deploy_eve_front() {
  log "Deploy eve-front → Cloud Run (INTERNAL; serves /eve/* AND /.well-known/workflow/*)"
  # min-instances=1 keeps a warm front for the self-callback, but is NOT the poller (PLAN §4.4).
  # shellcheck disable=SC2046
  gcloud run deploy "$SVC_EVE_FRONT" \
    --image="$REGISTRY/$SVC_EVE_FRONT:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed \
    --ingress=internal-and-cloud-load-balancing \
    --no-allow-unauthenticated \
    --port=8080 \
    --cpu=1 --memory=1Gi \
    --min-instances=1 --max-instances=10 \
    --concurrency=40 \
    --timeout=300 \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-env-vars="WORKFLOW_ROLE=front,GCS_PHOTO_BUCKET=$GCS_PHOTO_BUCKET,EVE_SELF_URL=${EVE_FRONT_URL:-}${ELEVENLABS_VOICE_ID:+,ELEVENLABS_VOICE_ID=$ELEVENLABS_VOICE_ID}" \
    --set-secrets="CLERK_JWT_KEY=$SECRET_CLERK_JWT_KEY,DATABASE_URL=$SECRET_DATABASE_URL_EVE,VERTEX_AI_KEY=$SECRET_VERTEX_AI_KEY,CLOUD_VISION_KEY=$SECRET_CLOUD_VISION_KEY,ELEVENLABS_KEY=$SECRET_ELEVENLABS_KEY,PHOTODNA_KEY=$SECRET_PHOTODNA_KEY,EVE_SCOPED_TOKEN_KEY=$SECRET_EVE_SCOPED_SIGNING"

  # Resolve the front's URL and re-point EVE_SELF_URL at itself (the workflow runtime calls back into it).
  if [ -z "${EVE_FRONT_URL:-}" ]; then
    EVE_FRONT_URL="$(gcloud run services describe "$SVC_EVE_FRONT" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
    export EVE_FRONT_URL
    log "Resolved EVE_FRONT_URL=$EVE_FRONT_URL — updating EVE_SELF_URL for the self-callback"
    gcloud run services update "$SVC_EVE_FRONT" \
      --region="$REGION" --project="$PROJECT_ID" \
      --update-env-vars="EVE_SELF_URL=$EVE_FRONT_URL"
  fi
}

route_eve_paths() {
  # The dual-route mandate: an external HTTPS Load Balancer URL map forwards BOTH path prefixes to eve-front.
  # On Cloud Run a service already receives every path, so this URL map is what makes /eve/* and
  # /.well-known/workflow/* land on eve-front from a shared ingress (PLAN §4.4(a)). Idempotent create-or-update.
  log "Wire URL map: forward /eve/* AND /.well-known/workflow/* → eve-front"

  gcloud compute network-endpoint-groups create "$NEG_EVE_FRONT" \
    --region="$REGION" --project="$PROJECT_ID" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$SVC_EVE_FRONT" 2>/dev/null || true

  gcloud compute backend-services create "$BACKEND_EVE_FRONT" \
    --global --project="$PROJECT_ID" \
    --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null || true
  gcloud compute backend-services add-backend "$BACKEND_EVE_FRONT" \
    --global --project="$PROJECT_ID" \
    --network-endpoint-group="$NEG_EVE_FRONT" \
    --network-endpoint-group-region="$REGION" 2>/dev/null || true

  gcloud compute url-maps create "$URL_MAP" \
    --project="$PROJECT_ID" \
    --default-service="$BACKEND_EVE_FRONT" 2>/dev/null || true

  # BOTH prefixes are path matchers pointing at the same backend — the explicit "forward both" requirement.
  gcloud compute url-maps add-path-matcher "$URL_MAP" \
    --project="$PROJECT_ID" \
    --path-matcher-name=eve-matcher \
    --default-service="$BACKEND_EVE_FRONT" \
    --new-hosts='*' \
    --backend-service-path-rules='/eve/*='"$BACKEND_EVE_FRONT"',/.well-known/workflow/*='"$BACKEND_EVE_FRONT" \
    2>/dev/null \
    || gcloud compute url-maps edit "$URL_MAP" --project="$PROJECT_ID" --quiet 2>/dev/null \
    || echo "NOTE: path matcher already present — /eve/* and /.well-known/workflow/* already routed to $BACKEND_EVE_FRONT"
}

deploy_eve_poller() {
  log "Deploy eve-poller → Cloud Run WORKER POOL (NON-serverless, ALWAYS-ON; PLAN §4.4)"
  # A Worker Pool has NO request ingress and NO scale-to-zero. manual-instance-count pins it ON.
  # This is the corrected topology: the poller is a single (or size-pinned) always-on process, NOT an
  # autoscaled service where every instance would poll. --min/--max are NOT used (that is a *service* concept);
  # a Worker Pool is sized by --instances / --scaling=manual.
  # shellcheck disable=SC2046
  gcloud beta run worker-pools deploy "$WP_EVE_POLLER" \
    --image="$REGISTRY/$WP_EVE_POLLER:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --scaling=manual \
    --instances="${POLLER_INSTANCES:-1}" \
    --cpu=1 --memory=1Gi \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-env-vars="WORKFLOW_ROLE=poller,POLLER_CONCURRENCY=${POLLER_CONCURRENCY:-1},EVE_FRONT_URL=${EVE_FRONT_URL:?eve-front URL must be resolved before the poller}" \
    --set-secrets="DATABASE_URL=$SECRET_DATABASE_URL_EVE,VERTEX_AI_KEY=$SECRET_VERTEX_AI_KEY,CLOUD_VISION_KEY=$SECRET_CLOUD_VISION_KEY,PHOTODNA_KEY=$SECRET_PHOTODNA_KEY,EVE_SCOPED_TOKEN_KEY=$SECRET_EVE_SCOPED_SIGNING" \
  || {
    cat >&2 <<'EOF'
NOTE: `gcloud beta run worker-pools` is the preferred always-on non-serverless target. If it is unavailable
in this gcloud/region, deploy the same image to a size-pinned alternative that is ALSO always-on:
  - a single GCE VM via a Managed Instance Group with target-size=1 (a container-optimised OS + this image), or
  - a single GKE Deployment with replicas=1 and a PodDisruptionBudget.
Either way the poller is pinned ON and never scales to zero (PLAN §4.4). See infra/terraform for the IaC.
EOF
    exit 1
  }
}

deploy_podcast_worker() {
  log "Deploy podcast-worker → Cloud Run (INTERNAL; Cloud Tasks target; ffmpeg in image)"
  # shellcheck disable=SC2046
  gcloud run deploy "$SVC_PODCAST" \
    --image="$REGISTRY/$SVC_PODCAST:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed \
    --ingress=internal \
    --no-allow-unauthenticated \
    --port=8080 \
    --cpu=2 --memory=2Gi \
    --min-instances=0 --max-instances=10 \
    --concurrency=1 \
    --timeout=900 \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-env-vars="GCS_AUDIO_BUCKET=$GCS_AUDIO_BUCKET${ELEVENLABS_VOICE_ID:+,ELEVENLABS_VOICE_ID=$ELEVENLABS_VOICE_ID}" \
    --set-secrets="DATABASE_URL=$SECRET_DATABASE_URL_APP,ELEVENLABS_KEY=$SECRET_ELEVENLABS_KEY"
}

deploy_voice_bot() {
  log "Deploy voice-bot → Cloud Run (INTERNAL; realtime SmallWebRTC media plane, §6.3)"
  # The voice-bot calls agent tools THROUGH the BFF via a per-session scoped token (never a broad credential),
  # so it needs the BFF's URL. Resolve it from the deployed voxi-api if not already provided.
  if [ -z "${VOXI_API_URL:-}" ]; then
    VOXI_API_URL="$(gcloud run services describe "$SVC_API" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)' 2>/dev/null || echo '')"
    export VOXI_API_URL
  fi
  # The realtime voice media plane (Python/uvicorn). The BFF (voice-routes.ts) mints a per-session connect URL
  # that points a client here AFTER a voiceMin entitlement check — the BFF stays the only auth surface. Internal
  # ingress; the client reaches it via the same LB the BFF fronts. WebRTC media needs a warm instance + higher
  # concurrency than a request/response service; min-instances=1 keeps the ICE/handshake path warm.
  # shellcheck disable=SC2046
  gcloud run deploy "$SVC_VOICE_BOT" \
    --image="$REGISTRY/$SVC_VOICE_BOT:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed \
    --ingress=internal-and-cloud-load-balancing \
    --no-allow-unauthenticated \
    --port=7071 \
    --cpu=2 --memory=2Gi \
    --min-instances=1 --max-instances=10 \
    --concurrency=20 \
    --timeout=3600 \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-env-vars="GCP_PROJECT=$PROJECT_ID,VOXI_API_URL=${VOXI_API_URL:-},BFF_INTERNAL_URL=${VOXI_API_URL:-}${ELEVENLABS_VOICE_ID:+,ELEVENLABS_VOXI_VOICE_ID=$ELEVENLABS_VOICE_ID}" \
    --set-secrets="DEEPGRAM_API_KEY=$SECRET_DEEPGRAM_KEY,ELEVENLABS_API_KEY=$SECRET_ELEVENLABS_KEY,EVE_SCOPED_TOKEN_KEY=$SECRET_EVE_SCOPED_SIGNING"
}

run_db_migrations() {
  # Apply packages/db migrations (task #22 runner) against the app database BEFORE the services take traffic.
  # Runs as a one-shot Cloud Run JOB built from the voxi-api image (which ships packages/db + bun). The job
  # binds DATABASE_URL=database-url-app and runs `bun packages/db/apply-migrations.ts`, which is idempotent
  # (app.schema_migrations ledger) so a re-deploy is a no-op. The job FAILS the deploy loudly if a migration
  # errors — never a silent success (the DB is the one thing a bad migration can corrupt; §4.5 mandates a
  # Cloud SQL snapshot before a world-schema migration — take it out-of-band before a destructive change).
  log "DB migrate → run packages/db migrations as a one-shot Cloud Run Job (idempotent)"
  # shellcheck disable=SC2046
  gcloud run jobs deploy "$JOB_MIGRATE" \
    --image="$REGISTRY/$SVC_API:$IMAGE_TAG" \
    --region="$REGION" --project="$PROJECT_ID" \
    --vpc-connector="$VPC_CONNECTOR" --vpc-egress=private-ranges-only \
    $(sa_flag) $(sql_flag) \
    --set-secrets="DATABASE_URL=$SECRET_DATABASE_URL_APP" \
    --command=bun \
    --args="packages/db/apply-migrations.ts" \
    --max-retries=1 --task-timeout=600
  log "DB migrate → execute the job (blocks until migrations complete or fail)"
  gcloud run jobs execute "$JOB_MIGRATE" --region="$REGION" --project="$PROJECT_ID" --wait
}

deploy_all() {
  run_db_migrations     # apply app.* schema BEFORE any service takes traffic (idempotent)
  deploy_voxi_api
  deploy_eve_front      # resolves + exports EVE_FRONT_URL
  route_eve_paths       # forwards BOTH /eve/* and /.well-known/workflow/* to eve-front
  deploy_eve_poller     # always-on, non-serverless; needs EVE_FRONT_URL
  deploy_podcast_worker
  deploy_voice_bot      # realtime media plane (§6.3)
  log "Deploy complete. Public surface: voxi-api. Poller is always-on (non-serverless). Migrations applied."
}

# =================================================================================================
case "$MODE" in
  build)  build_push ;;
  deploy) deploy_all ;;
  all)    build_push; deploy_all ;;
esac
