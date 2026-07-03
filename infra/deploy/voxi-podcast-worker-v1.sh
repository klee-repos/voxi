#!/usr/bin/env bash
#
# Voxi v1 deploy — the Deep Dive podcast render worker as a SECOND Cloud Run service (voxi-podcast-worker). The
# BFF (voxi-api) gates the credit then hands the render here over HTTP (x-worker-secret shared secret); this
# service runs the REAL pipeline (Vertex research → Gemini script → honesty gates → ElevenLabs TTS → ffmpeg mux)
# and serves the resulting MP3 range-safe. It reuses the voxi-api runtime SA (already has Vertex + secret roles).
#
# SINGLE always-on instance on purpose: the in-memory job map + local audio files must stay coherent, and the
# fire-and-forget render continues AFTER the 202 — which on Cloud Run needs CPU allocated (--no-cpu-throttling).
#
# The project (eighth-duality-354701) is SHARED, so every resource is namespaced voxi-*. Idempotent; re-runnable.
#
# Usage:  bash infra/deploy/voxi-podcast-worker-v1.sh            # build + deploy
#         STEP=images bash infra/deploy/voxi-podcast-worker-v1.sh  # just rebuild+redeploy the image
set -euo pipefail

PROJECT="${VOXI_PROJECT:-eighth-duality-354701}"
REGION="${VOXI_REGION:-us-central1}"
AR_REPO="voxi"
SVC="voxi-podcast-worker"
SA="voxi-api-sa"                                  # reuse the BFF runtime SA (Vertex + secretAccessor already bound)
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SVC}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | sed -E "s/^$1=//; s/[[:space:]]+#.*$//; s/^\"//; s/\"$//; s/[[:space:]]+$//"; }

gcloud config set project "$PROJECT" >/dev/null

if [ "${STEP:-all}" = "all" ]; then
  # ── Shared BFF↔worker secret (namespaced voxi-*) ──────────────────────────────────────────────
  # A random secret both services carry: the BFF sends it as x-worker-secret, the worker rejects any /render or
  # /status without it. Created once; the accessor binding lets the shared SA read it from both services.
  say "Shared worker secret 'voxi-podcast-worker-secret'"
  if ! gcloud secrets describe voxi-podcast-worker-secret --project "$PROJECT" >/dev/null 2>&1; then
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create voxi-podcast-worker-secret --data-file=- --project "$PROJECT"
  fi
  gcloud secrets add-iam-policy-binding voxi-podcast-worker-secret --project "$PROJECT" \
    --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null

  # The ElevenLabs key must already exist (seeded by voxi-api-v1.sh). Fail loud if not — the worker's TTS is real.
  if ! gcloud secrets describe voxi-elevenlabs-key --project "$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: secret voxi-elevenlabs-key is missing — run infra/deploy/voxi-api-v1.sh first." >&2
    exit 1
  fi
fi

# ── Build + push the image (⚠ Cloud Build minutes; amd64, includes ffmpeg) ────────────────────────
say "Building ${SVC} image via Cloud Build (amd64) ⚠"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --config "${REPO_ROOT}/infra/deploy/cloudbuild.voxi-podcast-worker.yaml" \
  --substitutions "_IMAGE=${IMAGE},_SHA=${SHA}"

# ── Deploy Cloud Run (⚠ BILLABLE — single always-CPU instance) ────────────────────────────────────
say "Deploying Cloud Run service '${SVC}' ⚠"
GEMINI_MODEL="$(envval GEMINI_MODEL)"; GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE}:${SHA}" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --set-secrets "ELEVENLABS_API_KEY=voxi-elevenlabs-key:latest,PODCAST_WORKER_SECRET=voxi-podcast-worker-secret:latest" \
  --set-env-vars "GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},GEMINI_MODEL=${GEMINI_MODEL},VOXI_ENV=production,PODCAST_OUT_DIR=/tmp/voxi-podcasts,SENTRY_RELEASE=${SHA}" \
  --memory 2Gi --cpu 2 --min-instances 1 --max-instances 1 --no-cpu-throttling --concurrency 20 --timeout 300

WORKER_URL="$(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"

# ── Second pass: point the worker's public audio base at its own URL ──────────────────────────────
# The rendered episode's audioUrl is `${PODCAST_PUBLIC_BASE}/audio/...`, fetched DIRECTLY by the iOS player, so it
# must be the worker's own public https URL (known only after the first deploy). Idempotent: a re-run just re-sets
# it to the same value.
say "Setting PODCAST_PUBLIC_BASE=${WORKER_URL}"
gcloud run services update "$SVC" --project "$PROJECT" --region "$REGION" \
  --update-env-vars "PODCAST_PUBLIC_BASE=${WORKER_URL}" >/dev/null

say "DONE. WORKER_URL = ${WORKER_URL}"
echo "Health check (expect 404 'not found' — the worker has no health route, which proves it's serving):"
curl -sS -o /dev/null -w '%{http_code}\n' "${WORKER_URL}/status?token=noop" || true
echo
echo "NEXT: redeploy voxi-api so the BFF picks up PODCAST_WORKER_URL=${WORKER_URL} + the shared secret:"
echo "  STEP=images bash infra/deploy/voxi-api-v1.sh"
