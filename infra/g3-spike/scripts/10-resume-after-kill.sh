#!/usr/bin/env bash
# C1 RESUME — session resume after instance kill (TEST-PLAN infra-01; the G3 durability falsifier).
#
# Start a turn that crosses >=2 durable checkpoints, KILL the poller mid-run, then prove a fresh poller
# resumes the run from its last checkpoint and the streamed session completes with NO duplicated side-effects.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log "C1 resume-after-kill (infra-01)"
require_eve_pinned
require_world

# (1) Kick a turn that is guaranteed to cross multiple checkpoints (identify → ground → narrate are separate
#     short steps by design, §4.4 checkpoint-frequently). Capture the sessionId/continuationToken.
# (2) While step 2/3 is in flight, kill the poller:
#       local:  docker kill voxi-eve-poller
#       GCP:    drain/kill one Worker Pool replica, or stop the GCE poller VM (no graceful unlease)
# (3) Start a fresh poller; it must claim the orphaned run (lease expiry / SKIP-LOCKED) and finish it.
# (4) Assert: the NDJSON stream reaches 'done' AFTER the kill, and side-effecting tools ran exactly once
#     (enqueue_podcast / embed_image / catalog_upsert are idempotent per §4.6) — check via sql/idempotency-probe.sql.

operator_required \
  "Run the kill-resume sequence (needs a live FRONT+POLLER+world):" \
  "  1. POST a turn, save SESSION_ID + CONT_TOKEN" \
  "  2. mid-run: kill the poller instance (docker kill / Worker-Pool replica drain / GCE VM stop)" \
  "  3. start a fresh poller; reconnect the stream at ?startIndex=<last> (§4.3 reconnection semantics)" \
  "  4. assert stream hits 'done' post-kill AND psql -f sql/idempotency-probe.sql shows no double side-effects"

# record C1 pass   # <- only after a real post-kill 'done' with single-execution side-effects
