#!/usr/bin/env bash
# C0 BOOT — the day-1 eve-off-Vercel boot proof (PLAN.md §22.3, ordered FIRST in §20.1).
#
#   eve init → rip every Vercel adapter → does it even boot and run ONE photo→session→streamed-turn loop
#   with ZERO Vercel platform services, world = @workflow/world-postgres?
#
# If this fails, the §4.5 fallback fires immediately. This is the cheapest falsifier in the gate.
# SKELETON: the boot + drive steps are operator/cred-gated and fail loudly rather than faking green.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

EVE_PROJECT_DIR="${EVE_PROJECT_DIR:-${G3_DIR}/../../services/eve-agent}"

log "C0 boot proof — eve off Vercel on world-postgres"
require_eve_pinned
require_world

# (1) Assert the Vercel-adapter rip is complete (static — runnable here, no creds).
assert_vercel_ripped "$EVE_PROJECT_DIR" || { record C0 fail reason=vercel-adapters-present; exit 1; }

# (2) Boot the split topology locally: FRONT (Cloud Run analogue) + POLLER (non-serverless analogue).
#     Locally these are two processes against one docker-compose Postgres; on GCP they are the Cloud Run
#     service + the Worker Pool / GCE poller. Ingress must forward /eve/* AND /.well-known/workflow/* (§4.4).
log "booting eve FRONT (stateless) + POLLER (non-serverless) against world-postgres ..."
operator_required \
  "Boot the eve FRONT and POLLER here. Locally:" \
  "  - docker compose up -d postgres   (the world-postgres durable world)" \
  "  - WORKFLOW_ROLE=front  eve start   (serves /eve/* + /.well-known/workflow/*)" \
  "  - WORKFLOW_ROLE=poller eve worker  (the graphile-worker poller + LISTEN/NOTIFY)" \
  "On GCP: deploy services/eve-agent FRONT to Cloud Run and POLLER to a Worker Pool / GCE VM (see infra topology)."

# (3) Drive ONE photo→session→streamed-turn loop through the eve HTTP channel and assert the NDJSON
#     stream reaches 'done' (event enum per §4.3). Pseudocode the operator/CI wires once FRONT is up:
#
#     curl -sN "$FRONT_URL/eve/sessions" -H "Authorization: Bearer $CLERK_JWT" \
#          -F image=@fixtures/seed-object.jpg \
#       | tee out/c0-stream.ndjson \
#       | grep -q '"type":"done"'   # PASS when the turn completes end-to-end
#
# record C0 pass    # <- only the operator/CI may write this, AFTER a real streamed 'done'
