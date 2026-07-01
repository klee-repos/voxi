# syntax=docker/dockerfile:1.7
#
# eve POLLER — the NON-serverless workflow poller (PLAN §4.4). Deployed ALWAYS-ON to a Cloud Run Worker Pool
# (manual scaling) or a size-pinned GCE/GKE instance — NOT a stateless autoscaled Cloud Run service. Holds the
# long-lived LISTEN/NOTIFY connection to the Postgres workflow world and drains the run queue.
#
# Same eve codebase as the front (services/eve-agent); the role differs (WORKFLOW_ROLE=poller). Runtime: Bun,
# pinned to the @workflow/world-postgres-compatible range (PLAN §9).
#
# BUILD CONTEXT = repo root:
#   docker build -f infra/docker/eve-poller/Dockerfile -t eve-poller .

FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/db/package.json            packages/db/package.json
COPY services/eve-agent/package.json     services/eve-agent/package.json
COPY services/voxi-api/package.json      services/voxi-api/package.json
COPY services/voxi-podcast-worker/package.json services/voxi-podcast-worker/package.json
COPY app/package.json                    app/package.json
COPY e2e/package.json                    e2e/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock     ./bun.lock

COPY packages/shared       ./packages/shared
COPY packages/db           ./packages/db
COPY services/eve-agent    ./services/eve-agent
COPY tsconfig.base.json    ./tsconfig.base.json
COPY infra/docker/eve-poller/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# The poller is not a client HTTP surface; it exposes only a liveness port for the Worker Pool / MIG probe.
ENV WORKFLOW_ROLE=poller
ENV HEALTH_PORT=8080
ENV POLLER_CONCURRENCY=1
EXPOSE 8080

USER bun
ENTRYPOINT ["./entrypoint.sh"]
