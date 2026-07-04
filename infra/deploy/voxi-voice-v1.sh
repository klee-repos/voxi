#!/usr/bin/env bash
#
# Voxi v1 deploy — the realtime voice media plane as a THIRD Cloud Run service (voxi-voice-bot). The BFF
# (voxi-api) gates a voice minute, mints a per-session connect URL, and points the app's Pipecat SmallWebRTC client
# here; this service runs the STT→LLM→TTS cascade over real WebRTC media (services/voice-bot/voice_server.py). It is
# the MEDIA plane, NOT an auth surface: it is INTERNAL-only ingress (`--ingress internal`), reachable only by the
# BFF in the same project, and it calls agent tools back through the BFF via a per-session scoped token.
#
# SCALE-TO-ZERO: the SmallWebRTC /offer spins up a per-connection pipeline on demand → --min-instances 0 → $0 idle.
# A cold /offer adds ~2-4s of first-word latency (Pipecat boot + ICE); acceptable for v1, optimized later.
#
# The project (eighth-duality-354701) is SHARED, so every resource is namespaced voxi-*. Idempotent; re-runnable.
#
# Usage:  bash infra/deploy/voxi-voice-v1.sh            # secrets + IAM + build + deploy
#         STEP=images bash infra/deploy/voxi-voice-v1.sh  # just rebuild+redeploy the image
#
# AFTER: redeploy voxi-api with VOICE_SERVER_BASE_URL=<printed URL> so the BFF's /v1/voice/* mount admits sessions.
set -euo pipefail

PROJECT="${VOXI_PROJECT:-eighth-duality-354701}"
REGION="${VOXI_REGION:-us-central1}"
AR_REPO="voxi"
SVC="voxi-voice-bot"
SA="voxi-api-sa"                                  # reuse the BFF runtime SA (Vertex/Gemini + secretAccessor already bound)
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${SVC}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | sed -E "s/^$1=//; s/[[:space:]]+#.*$//; s/^\"//; s/\"$//; s/[[:space:]]+$//"; }

gcloud config set project "$PROJECT" >/dev/null

if [ "${STEP:-all}" = "all" ]; then
  # ── Vendor secrets (STT + TTS). ElevenLabs is shared with the podcast worker; Deepgram is voice-only. ──────
  say "Vendor secrets (voxi-elevenlabs-key shared, voxi-deepgram-key voice-only)"
  if ! gcloud secrets describe voxi-elevenlabs-key --project "$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: secret voxi-elevenlabs-key is missing — run infra/deploy/voxi-api-v1.sh first." >&2; exit 1
  fi
  if ! gcloud secrets describe voxi-deepgram-key --project "$PROJECT" >/dev/null 2>&1; then
    DEEPGRAM="$(envval DEEPGRAM_API_KEY)"
    if [ -z "$DEEPGRAM" ]; then
      echo "ERROR: DEEPGRAM_API_KEY not set in .env.local — the voice bot needs it for STT." >&2; exit 1
    fi
    printf '%s' "$DEEPGRAM" | gcloud secrets create voxi-deepgram-key --data-file=- --project "$PROJECT"
  fi
  for S in voxi-elevenlabs-key voxi-deepgram-key; do
    gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
      --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null
  done
  # Let a fresh binding propagate before the voice-bot boots (IAM is eventually-consistent).
  echo "waiting 20s for IAM propagation…"; sleep 20

  # ── TURN relay secrets (OPTIONAL — B1 root cause: STUN-only can't traverse a UDP-blocked network). Created
  # only on a full deploy when TURN_URL/USER/PASS are ALL set in .env.local. TURN_SECRETS (consumed by the
  # deploy below) is recomputed in the main body so a STEP=images redeploy preserves an existing TURN config.
  TURN_URL="$(envval TURN_URL)"; TURN_USER="$(envval TURN_USER)"; TURN_PASS="$(envval TURN_PASS)"
  if [ -n "$TURN_URL" ] && [ -n "$TURN_USER" ] && [ -n "$TURN_PASS" ]; then
    say "TURN relay secrets (voxi-turn-url/user/pass)"
    for pair in "voxi-turn-url:$TURN_URL" "voxi-turn-user:$TURN_USER" "voxi-turn-pass:$TURN_PASS"; do
      S="${pair%%:*}"; V="${pair#*:}"
      printf '%s' "$V" | gcloud secrets create "$S" --data-file=- --project "$PROJECT" 2>/dev/null \
        || printf '%s' "$V" | gcloud secrets update "$S" --data-file=- --project "$PROJECT"
      gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
        --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor >/dev/null
    done
    echo "waiting 20s for TURN IAM propagation…"; sleep 20
  else
    say "TURN relay secrets: SKIPPED (TURN_URL/USER/PASS not all set in .env.local → STUN-only; voice may fail on UDP-blocked networks)"
  fi
fi

# TURN_SECRETS is recomputed from .env.local on EVERY deploy (incl. STEP=images) so a redeploy preserves TURN.
TURN_URL="$(envval TURN_URL)"; TURN_USER="$(envval TURN_USER)"; TURN_PASS="$(envval TURN_PASS)"
TURN_SECRETS=""
if [ -n "$TURN_URL" ] && [ -n "$TURN_USER" ] && [ -n "$TURN_PASS" ]; then
  TURN_SECRETS=",TURN_URL=voxi-turn-url:latest,TURN_USER=voxi-turn-user:latest,TURN_PASS=voxi-turn-pass:latest"
fi

# ── Build + push the image (⚠ Cloud Build minutes; amd64, includes ffmpeg/libsndfile/libopus) ────────────
say "Building ${SVC} image via Cloud Build (amd64) ⚠"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --tag "${IMAGE}:${SHA}" \
  --substitutions "_DOCKERFILE=infra/docker/voice-bot/Dockerfile"

# ── Deploy Cloud Run (INTERNAL ingress → BFF-only; scale-to-zero; ⚠ BILLABLE per session) ───────────────
# --ingress internal: only same-project/VPC traffic reaches /offer (the BFF is the sole internal caller), so the
# voice-bot's media plane is never public. min-instances 0 = $0 idle; a /offer cold-start spins a pipeline on demand.
say "Deploying Cloud Run service '${SVC}' (internal ingress, scale-to-zero) ⚠"
GEMINI_MODEL="$(envval GEMINI_MODEL)"; GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
gcloud run deploy "$SVC" --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE}:${SHA}" \
  --service-account "$SA_EMAIL" \
  --ingress internal \
  --allow-unauthenticated \
  --set-secrets "ELEVENLABS_API_KEY=voxi-elevenlabs-key:latest,DEEPGRAM_API_KEY=voxi-deepgram-key:latest${TURN_SECRETS}" \
  --set-env-vars "GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},GEMINI_MODEL=${GEMINI_MODEL},VOXI_ENV=production,VOICE_PORT=7071,SENTRY_RELEASE=${SHA}" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 3 --no-cpu-throttling --concurrency 16 --timeout 300

VOICE_URL="$(gcloud run services describe "$SVC" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
say "DONE. VOICE_URL = ${VOICE_URL}"
echo
echo "NEXT: redeploy voxi-api with VOICE_SERVER_BASE_URL=${VOICE_URL} so the BFF /v1/voice/* mount admits sessions:"
echo "  VOICE_SERVER_BASE_URL=${VOICE_URL} STEP=images bash infra/deploy/voxi-api-v1.sh"
echo "  (then on-device: flip VOICE_AVAILABLE in conversation.tsx once the client F5 mint + watchdog land)"
