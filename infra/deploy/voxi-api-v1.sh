#!/usr/bin/env bash
#
# Voxi v1 deploy — the SIMPLIFIED backend for a personal TestFlight build:
#   ONE Cloud Run service (voxi-api, the BFF running the in-process live cascade) + ONE Cloud SQL Postgres
#   (durable collection) + Secret Manager + native Cloud SQL unix-socket connector. No eve-front/poller,
#   no VPC connector, no CDN — those are the full-architecture build-out (infra/terraform), not v1.
#
# The project (eighth-duality-354701) is SHARED with other apps, so every resource is namespaced `voxi-*`.
# Idempotent: safe to re-run. BILLABLE steps are marked ⚠. Requires ADC first: `gcloud auth application-default login`.
#
# Usage:  bash infra/deploy/voxi-api-v1.sh            # full deploy
#         STEP=images bash infra/deploy/voxi-api-v1.sh  # just rebuild+redeploy the image
set -euo pipefail

PROJECT="${VOXI_PROJECT:-eighth-duality-354701}"
REGION="${VOXI_REGION:-us-central1}"
AR_REPO="voxi"
SQL_INSTANCE="voxi-pg"
SQL_TIER="${VOXI_SQL_TIER:-db-g1-small}"     # cheapest sane Postgres; bump to db-custom-1-3840 for more headroom
DB_NAME="voxi"
DB_USER="voxi_app"
SVC="voxi-api"
SA="voxi-api-sa"
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SVC}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
# Read a value from .env.local, stripping an inline `# comment` and surrounding quotes/whitespace.
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | sed -E "s/^$1=//; s/[[:space:]]+#.*$//; s/^\"//; s/\"$//; s/[[:space:]]+$//"; }

gcloud config set project "$PROJECT" >/dev/null

# ── 1. APIs ─────────────────────────────────────────────────────────────────────────────────────
if [ "${STEP:-all}" = "all" ]; then
  say "Enabling required APIs (idempotent)"
  gcloud services enable \
    run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com \
    aiplatform.googleapis.com vision.googleapis.com \
    cloudtrace.googleapis.com logging.googleapis.com iam.googleapis.com --project "$PROJECT"

  # ── 2. Artifact Registry ──────────────────────────────────────────────────────────────────────
  say "Artifact Registry repo '${AR_REPO}'"
  gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location "$REGION" --project "$PROJECT"

  # ── 3. Runtime service account + IAM ──────────────────────────────────────────────────────────
  say "Runtime service account ${SA_EMAIL} + roles"
  gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$SA" --display-name "Voxi API runtime" --project "$PROJECT"
  for role in roles/aiplatform.user roles/serviceusage.serviceUsageConsumer \
              roles/cloudsql.client roles/secretmanager.secretAccessor \
              roles/logging.logWriter roles/cloudtrace.agent; do
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member "serviceAccount:${SA_EMAIL}" --role "$role" --condition=None >/dev/null
  done

  # ── 4. Cloud SQL (⚠ BILLABLE; ~10 min to create) ──────────────────────────────────────────────
  say "Cloud SQL Postgres 16 instance '${SQL_INSTANCE}' (${SQL_TIER}) ⚠ billable"
  if ! gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud sql instances create "$SQL_INSTANCE" \
      --project "$PROJECT" --region "$REGION" \
      --database-version "${VOXI_PG_VERSION:-POSTGRES_15}" --tier "$SQL_TIER" \
      --storage-size 10 --storage-auto-increase
  fi
  gcloud sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud sql databases create "$DB_NAME" --instance "$SQL_INSTANCE" --project "$PROJECT"

  # App user (durable password stashed in Secret Manager as the DSN).
  DB_PW="$(gcloud secrets versions access latest --secret voxi-db-app-password --project "$PROJECT" 2>/dev/null || true)"
  if [ -z "$DB_PW" ]; then
    DB_PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
    printf '%s' "$DB_PW" | gcloud secrets create voxi-db-app-password --data-file=- --project "$PROJECT" 2>/dev/null \
      || printf '%s' "$DB_PW" | gcloud secrets versions add voxi-db-app-password --data-file=- --project "$PROJECT"
  fi
  gcloud sql users describe "$DB_USER" --instance "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1 \
    && gcloud sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --project "$PROJECT" --password "$DB_PW" \
    || gcloud sql users create "$DB_USER" --instance "$SQL_INSTANCE" --project "$PROJECT" --password "$DB_PW"

  CONN="${PROJECT}:${REGION}:${SQL_INSTANCE}"

  # Grant the app user CREATE on the public schema (PG15+ revokes it by default) via the Cloud SQL Auth Proxy.
  say "Granting ${DB_USER} schema privileges (one-time, via cloud-sql-proxy)"
  PG_SUPER_PW="$(gcloud secrets versions access latest --secret voxi-db-postgres-password --project "$PROJECT" 2>/dev/null || true)"
  if [ -z "$PG_SUPER_PW" ]; then
    PG_SUPER_PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
    printf '%s' "$PG_SUPER_PW" | gcloud secrets create voxi-db-postgres-password --data-file=- --project "$PROJECT" 2>/dev/null \
      || printf '%s' "$PG_SUPER_PW" | gcloud secrets versions add voxi-db-postgres-password --data-file=- --project "$PROJECT"
  fi
  gcloud sql users set-password postgres --instance "$SQL_INSTANCE" --project "$PROJECT" --password "$PG_SUPER_PW"
  PROXY="${REPO_ROOT}/.voxi-data/cloud-sql-proxy"
  if [ ! -x "$PROXY" ]; then
    mkdir -p "${REPO_ROOT}/.voxi-data"
    ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH="arm64" || ARCH="amd64"
    curl -sSL "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.darwin.${ARCH}" -o "$PROXY"
    chmod +x "$PROXY"
  fi
  # --token uses the gcloud CLI's own OAuth token, so no separate ADC login is required.
  "$PROXY" --port 5433 --token "$(gcloud auth print-access-token)" "$CONN" >/dev/null 2>&1 &
  PROXY_PID=$!; sleep 6
  PGGRANT_URL="postgresql://postgres:${PG_SUPER_PW}@127.0.0.1:5433/${DB_NAME}" \
    bun -e 'const{Client}=require("pg");const c=new Client(process.env.PGGRANT_URL);await c.connect();await c.query("GRANT ALL ON SCHEMA public TO '"$DB_USER"'");await c.query("GRANT ALL ON DATABASE '"$DB_NAME"' TO '"$DB_USER"'");console.log("schema granted to '"$DB_USER"'");await c.end()'
  kill $PROXY_PID 2>/dev/null || true

  # ── 5. Secrets (namespaced voxi-*) ────────────────────────────────────────────────────────────
  say "Seeding Secret Manager (namespaced voxi-*)"
  put() { # put <secret-name> <value>
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --project "$PROJECT" 2>/dev/null \
      || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT"
    gcloud secrets add-iam-policy-binding "$1" --project "$PROJECT" \
      --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null
  }
  put voxi-clerk-jwt-key    "$(envval CLERK_JWT_KEY)"
  put voxi-url-signing-key  "$(envval VOXI_URL_SIGNING_KEY)"
  EL="$(envval ELEVENLABS_API_KEY)"; [ -n "$EL" ] && put voxi-elevenlabs-key "$EL" || true
  # Sentry error-monitoring DSN — low-sensitivity (public key) but kept in Secret Manager for consistency. Optional:
  # only seeded when SENTRY_DSN is in .env.local, so the backend degrades to `sentry_disabled` until you provision it.
  SD="$(envval SENTRY_DSN)"; [ -n "$SD" ] && put voxi-sentry-dsn "$SD" || true
  put voxi-database-url "postgresql://${DB_USER}:${DB_PW}@/${DB_NAME}?host=/cloudsql/${CONN}"
fi

# ── 6. Build + push the image (⚠ Cloud Build minutes; amd64) ─────────────────────────────────────
say "Building voxi-api image via Cloud Build (amd64) ⚠"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --config "${REPO_ROOT}/infra/deploy/cloudbuild.voxi-api.yaml" \
  --substitutions "_IMAGE=${IMAGE},_SHA=${SHA}"

# ── 7. Deploy Cloud Run (⚠ BILLABLE) ─────────────────────────────────────────────────────────────
say "Deploying Cloud Run service '${SVC}' ⚠"
CONN="${PROJECT}:${REGION}:${SQL_INSTANCE}"
SECRETS="CLERK_JWT_KEY=voxi-clerk-jwt-key:latest,VOXI_URL_SIGNING_KEY=voxi-url-signing-key:latest,DATABASE_URL=voxi-database-url:latest"
gcloud secrets describe voxi-elevenlabs-key --project "$PROJECT" >/dev/null 2>&1 \
  && SECRETS="${SECRETS},ELEVENLABS_API_KEY=voxi-elevenlabs-key:latest"
# Sentry DSN appended ONLY if the secret exists — so a STEP=images redeploy before you've provisioned it deploys
# cleanly (the backend just logs sentry_disabled) instead of failing on a missing --set-secrets reference.
gcloud secrets describe voxi-sentry-dsn --project "$PROJECT" >/dev/null 2>&1 \
  && SECRETS="${SECRETS},SENTRY_DSN=voxi-sentry-dsn:latest"
# Deep Dive worker wiring — appended ONLY when the worker service + shared secret exist. A bare `gcloud run deploy`
# REPLACES the full secret/env set, so this MUST be recomputed on every deploy or a later STEP=images redeploy
# silently drops the wiring and Deep Dive 402s. A redeploy BEFORE the worker is stood up is still clean (Deep Dive
# just stays disabled). See infra/deploy/voxi-podcast-worker-v1.sh.
# The BFF needs the podcast GCS bucket names to purge rendered audio + state in the deletion cascade (the SQL row
# delete alone would orphan the objects). Same names the worker deploy creates.
ENVVARS="GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},GEMINI_MODEL=$(envval GEMINI_MODEL),VOXI_ENV=production,SENTRY_RELEASE=${SHA},GCS_AUDIO_BUCKET=voxi-podcast-audio-${PROJECT},GCS_STATE_BUCKET=voxi-podcast-state-${PROJECT}"
gcloud secrets describe voxi-podcast-worker-secret --project "$PROJECT" >/dev/null 2>&1 \
  && SECRETS="${SECRETS},PODCAST_WORKER_SECRET=voxi-podcast-worker-secret:latest"
WORKER_URL="$(gcloud run services describe voxi-podcast-worker --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
[ -n "$WORKER_URL" ] && ENVVARS="${ENVVARS},PODCAST_WORKER_URL=${WORKER_URL}"
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE}:${SHA}" \
  --service-account "$SA_EMAIL" \
  --add-cloudsql-instances "$CONN" \
  --allow-unauthenticated \
  --set-secrets "$SECRETS" \
  --set-env-vars "$ENVVARS" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 5 --concurrency 40 --timeout 300

BFF_URL="$(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
say "DONE. BFF_URL = ${BFF_URL}"
echo "Health check:"; curl -sS "${BFF_URL}/healthz"; echo
echo
echo "NEXT: put ${BFF_URL} into app/eas.json (production.env.EXPO_PUBLIC_API_BASE_URL), then eas build."
