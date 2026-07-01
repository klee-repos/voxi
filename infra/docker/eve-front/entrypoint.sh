#!/usr/bin/env sh
# eve FRONT entrypoint (PLAN §4.4 — stateless eve request front on Cloud Run).
#
# The front serves the eve HTTP channel: it answers the BFF's session create/stream calls AND the workflow
# self-callbacks. graphile-worker advances a run by HTTP-calling the app's OWN /.well-known/workflow/v1/flow,
# so the same process that serves /eve/* MUST also serve /.well-known/workflow/* (the ingress forwards both;
# see infra/deploy/deploy.sh and cloudbuild.yaml). This is the WORKFLOW_ROLE=front half of the split topology;
# the poller half (WORKFLOW_ROLE=poller, non-serverless) runs the long-lived LISTEN/NOTIFY loop.
#
# Cloud Run contract: bind 0.0.0.0:$PORT. The front is stateless and autoscaled; do NOT run the poller here
# (min-instances=1 is necessary-but-not-sufficient — N>1 instances would each poll; PLAN §4.4).
set -eu

: "${PORT:=8080}"
export PORT
export WORKFLOW_ROLE="front"

echo "eve-front starting: role=front port=${PORT} base=${EVE_SELF_URL:-<unset>}"

# EVE_SELF_URL is this service's own public-within-VPC base URL; the workflow runtime calls back into it.
if [ -z "${EVE_SELF_URL:-}" ]; then
  echo "WARN: EVE_SELF_URL is unset — the /.well-known/workflow self-callback needs the service's own base URL (PLAN §4.4)." >&2
fi

# The eve agent's front server. services/eve-agent provides agent.ts + channels/eve.ts (the Clerk AuthFn) and,
# once scaffolded, an HTTP entry; this wrapper boots it in front mode. Until that entry lands the wrapper is
# the documented seam — it fails loudly rather than serving a fake.
if [ -f /app/services/eve-agent/agent/server.ts ]; then
  exec bun run /app/services/eve-agent/agent/server.ts
elif [ -f /app/services/eve-agent/dist/server.js ]; then
  exec node /app/services/eve-agent/dist/server.js
else
  echo "ERROR: no eve front entry found (services/eve-agent/agent/server.ts). This is the eve-backend (G3) seam." >&2
  exit 1
fi
