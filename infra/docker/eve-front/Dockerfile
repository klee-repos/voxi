# syntax=docker/dockerfile:1.7
#
# eve FRONT — stateless eve request front (PLAN §4.4). Cloud Run, autoscaled. Serves the eve HTTP channel:
# the BFF's session create/stream AND the graphile-worker self-callbacks at /.well-known/workflow/* — both
# routes are forwarded by ingress (see infra/deploy/). This is the SERVERLESS half of the corrected eve
# topology; the poller (eve-poller/Dockerfile) is the NON-serverless half.
#
# Runtime: Bun (eve is a TypeScript durable-agent framework; the backend runtimes are pinned per service to
# the @workflow/world-postgres-compatible range — PLAN §9). Same eve codebase as the poller; different role.
#
# BUILD CONTEXT = repo root:
#   docker build -f infra/docker/eve-front/Dockerfile -t eve-front .

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
COPY infra/docker/eve-front/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=8080
ENV WORKFLOW_ROLE=front
EXPOSE 8080

USER bun
ENTRYPOINT ["./entrypoint.sh"]
