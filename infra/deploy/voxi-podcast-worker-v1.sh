#!/usr/bin/env bash
#
# Voxi v1 deploy — the Deep Dive podcast render worker as a SECOND Cloud Run service (voxi-podcast-worker). The BFF
# (voxi-api) gates the credit then hands the render here over HTTP (x-worker-secret shared secret); this service runs
# the REAL pipeline (Firecrawl→OpenAI research → OpenAI script → honesty gates → ElevenLabs TTS → ffmpeg mux), UPLOADS the MP3
# to a PUBLIC GCS bucket, and keeps render status + the asset in a PRIVATE GCS bucket. It reuses the voxi-api SA.
#
# SCALE-TO-ZERO: fully stateless (keyed on (item,version) in GCS), so it runs --min-instances 0 → $0 idle, a few
# cents per render. --no-cpu-throttling keeps CPU allocated so the fire-and-forget render completes AFTER the 202;
# a mid-render instance loss self-heals (render.ts reclaims a stale `rendering` lease). Audio is served DIRECTLY by
# GCS (Range-native), so playback never cold-starts the worker.
#
# The project (eighth-duality-354701) is SHARED, so every resource is namespaced voxi-*. Idempotent; re-runnable.
#
# Usage:  bash infra/deploy/voxi-podcast-worker-v1.sh            # buckets + IAM + build + deploy
#         STEP=images bash infra/deploy/voxi-podcast-worker-v1.sh  # just rebuild+redeploy the image
set -euo pipefail

PROJECT="${VOXI_PROJECT:-eighth-duality-354701}"
REGION="${VOXI_REGION:-us-central1}"
AR_REPO="voxi"
SVC="voxi-podcast-worker"
SA="voxi-api-sa"                                  # reuse the BFF runtime SA (Vertex + secretAccessor already bound)
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SVC}"
AUDIO_BUCKET="voxi-podcast-audio-${PROJECT}"     # PUBLIC — holds ONLY episode.mp3 (GET-only allUsers)
STATE_BUCKET="voxi-podcast-state-${PROJECT}"     # PRIVATE — status + asset.json (transcript never public)
ROLE_ID="voxiPublicObjectGet"                    # custom role: storage.objects.get ONLY (no LIST → no enumeration)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | sed -E "s/^$1=//; s/[[:space:]]+#.*$//; s/^\"//; s/\"$//; s/[[:space:]]+$//"; }

gcloud config set project "$PROJECT" >/dev/null

if [ "${STEP:-all}" = "all" ]; then
  # ── Shared BFF↔worker secret ──────────────────────────────────────────────────────────────────
  say "Shared worker secret 'voxi-podcast-worker-secret'"
  if ! gcloud secrets describe voxi-podcast-worker-secret --project "$PROJECT" >/dev/null 2>&1; then
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create voxi-podcast-worker-secret --data-file=- --project "$PROJECT"
  fi
  gcloud secrets add-iam-policy-binding voxi-podcast-worker-secret --project "$PROJECT" \
    --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null
  if ! gcloud secrets describe voxi-elevenlabs-key --project "$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: secret voxi-elevenlabs-key is missing — run infra/deploy/voxi-api-v1.sh first." >&2; exit 1
  fi
  # OpenAI + Firecrawl are REQUIRED (research/script run on OpenAI gpt-5.4-mini over Firecrawl; the worker boot asserts
  # both). Both are seeded by voxi-api-v1.sh, so fail fast here if a fresh checkout skipped it.
  for K in voxi-openai-key voxi-firecrawl-key; do
    if ! gcloud secrets describe "$K" --project "$PROJECT" >/dev/null 2>&1; then
      echo "ERROR: secret $K is missing — run infra/deploy/voxi-api-v1.sh first." >&2; exit 1
    fi
  done

  # ── GCS buckets: PUBLIC audio + PRIVATE state ─────────────────────────────────────────────────
  say "GCS buckets ${AUDIO_BUCKET} (public) + ${STATE_BUCKET} (private)"
  # Public bucket: do NOT enforce public-access-prevention, so the allUsers GET binding is permitted.
  gcloud storage buckets describe "gs://${AUDIO_BUCKET}" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud storage buckets create "gs://${AUDIO_BUCKET}" --project "$PROJECT" --location "$REGION" \
         --uniform-bucket-level-access --no-public-access-prevention
  # Private bucket: enforce public-access-prevention — never public.
  gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud storage buckets create "gs://${STATE_BUCKET}" --project "$PROJECT" --location "$REGION" \
         --uniform-bucket-level-access --public-access-prevention

  # ── IAM (BEFORE the worker deploy so the first render can PUT — P5) ───────────────────────────
  # Custom role = storage.objects.get ONLY. roles/storage.objectViewer ALSO grants storage.objects.list, which on a
  # public bucket lets any anonymous caller enumerate every key (the keys embed a Clerk userId) — a real leak. GET
  # (+ Range) is all the iOS player needs.
  say "Custom GET-only role + bucket IAM"
  if ! gcloud iam roles describe "$ROLE_ID" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam roles create "$ROLE_ID" --project "$PROJECT" \
      --title "Voxi public object GET (no list)" --stage GA --permissions storage.objects.get >/dev/null
  fi
  # The SA writes audio + reads/writes state + deletes both. Bucket-scoped (the SA is SHARED across other apps).
  for B in "$AUDIO_BUCKET" "$STATE_BUCKET"; do
    gcloud storage buckets add-iam-policy-binding "gs://${B}" --project "$PROJECT" \
      --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin >/dev/null
  done
  # Anonymous GET (no list) on the audio bucket only.
  gcloud storage buckets add-iam-policy-binding "gs://${AUDIO_BUCKET}" --project "$PROJECT" \
    --member allUsers --role "projects/${PROJECT}/roles/${ROLE_ID}" >/dev/null
  # Let a fresh binding propagate before the worker's boot GCS self-check runs (IAM is eventually-consistent).
  echo "waiting 20s for IAM propagation…"; sleep 20
fi

# ── Build + push the image (⚠ Cloud Build minutes; amd64, includes ffmpeg) ────────────────────────
say "Building ${SVC} image via Cloud Build (amd64) ⚠"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --config "${REPO_ROOT}/infra/deploy/cloudbuild.voxi-podcast-worker.yaml" \
  --substitutions "_IMAGE=${IMAGE},_SHA=${SHA}"

# ── Deploy Cloud Run (⚠ BILLABLE per render; $0 idle) ─────────────────────────────────────────────
# min-instances 0 = scale to zero. --no-cpu-throttling keeps CPU for the post-202 fire-and-forget render. The
# worker's boot GCS self-check (server.ts) crash-loops the revision if the SA can't write — so a missing/unpropagated
# storage grant fails THIS deploy, not the first user render (P5).
say "Deploying Cloud Run service '${SVC}' (scale-to-zero) ⚠"
# GEMINI_MODEL is no longer set on the worker: research/script moved to OpenAI gpt-5.4-mini, and the native-Gemini
# research fallback defaults to gemini-3.5-flash inside providers.ts (read from the env only if overridden).
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE}:${SHA}" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --set-secrets "ELEVENLABS_API_KEY=voxi-elevenlabs-key:latest,PODCAST_WORKER_SECRET=voxi-podcast-worker-secret:latest,OPENAI_API_KEY=voxi-openai-key:latest,FIRECRAWL_API_KEY=voxi-firecrawl-key:latest" \
  --set-env-vars "GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},GEMINI_LOCATION=global,OPENAI_BASE_URL=https://api.openai.com/v1/,VOXI_ENV=production,PODCAST_OUT_DIR=/tmp/voxi-podcasts,GCS_AUDIO_BUCKET=${AUDIO_BUCKET},GCS_STATE_BUCKET=${STATE_BUCKET},SENTRY_RELEASE=${SHA}" \
  --memory 2Gi --cpu 2 --min-instances 0 --max-instances 1 --no-cpu-throttling --concurrency 8 --timeout 600

WORKER_URL="$(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
say "DONE. WORKER_URL = ${WORKER_URL}  (audio bucket: ${AUDIO_BUCKET})"
echo "Auth-gate check (expect 403 — /status is x-worker-secret gated, which proves it's serving):"
curl -sS -o /dev/null -w '%{http_code}\n' "${WORKER_URL}/status?item=noop&version=1" || true
echo
echo "NEXT: redeploy voxi-api so the BFF picks up PODCAST_WORKER_URL + GCS_AUDIO_BUCKET/GCS_STATE_BUCKET:"
echo "  STEP=images bash infra/deploy/voxi-api-v1.sh"
