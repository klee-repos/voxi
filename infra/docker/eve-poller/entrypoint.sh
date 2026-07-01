#!/usr/bin/env sh
# eve POLLER entrypoint (PLAN §4.4 — the NON-serverless workflow poller).
#
# The Postgres workflow world is NOT serverless-compatible: it needs a long-lived process holding a
# LISTEN/NOTIFY connection and draining the run queue via SELECT ... FOR UPDATE SKIP LOCKED. This process is
# therefore pinned ALWAYS-ON (Cloud Run Worker Pool with manual scaling, or a size-pinned GCE/GKE instance) —
# never autoscaled to zero, never N-of-many-each-polling like a stateless Cloud Run service.
#
# It is NOT a public HTTP surface: it serves only a local /healthz for the platform liveness probe (Worker
# Pools / MIGs health-check a port). All client traffic and the workflow self-callbacks go to the eve FRONT;
# the poller reaches the front's base URL (EVE_FRONT_URL) to advance runs past the ~60s self-call ceiling by
# keeping each step short (PLAN §4.4 — checkpoint-everything).
#
# This is WORKFLOW_ROLE=poller. The eve-backend (G3) workflow owns the actual poll loop; this wrapper boots it
# in poller mode and is the documented seam until that entry lands.
set -eu

export WORKFLOW_ROLE="poller"
: "${HEALTH_PORT:=8080}"
export HEALTH_PORT

echo "eve-poller starting: role=poller health_port=${HEALTH_PORT} front=${EVE_FRONT_URL:-<unset>} concurrency=${POLLER_CONCURRENCY:-1}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is required — the poller holds the LISTEN/NOTIFY connection to the workflow world." >&2
  exit 1
fi
if [ -z "${EVE_FRONT_URL:-}" ]; then
  echo "WARN: EVE_FRONT_URL is unset — the poller advances runs by calling the front's /.well-known/workflow (PLAN §4.4)." >&2
fi

# POLLER_CONCURRENCY > 1 is only safe if @workflow/world-postgres confirms multi-poller correctness via
# SELECT ... FOR UPDATE SKIP LOCKED (a G3 acceptance output). Default to a single poller (documented failover
# + throughput ceiling) until that is proven; see PLAN §4.4 / §22.6.
if [ -f /app/services/eve-agent/agent/poller.ts ]; then
  exec bun run /app/services/eve-agent/agent/poller.ts
elif [ -f /app/services/eve-agent/dist/poller.js ]; then
  exec node /app/services/eve-agent/dist/poller.js
else
  echo "ERROR: no eve poller entry found (services/eve-agent/agent/poller.ts). This is the eve-backend (G3) seam." >&2
  exit 1
fi
