# syntax=docker/dockerfile:1.7
#
# voxi-api — the BFF and the ONLY public surface (PLAN §3, §6.4). Runtime: Bun (the repo's package manager
# and the runtime services/voxi-api is written for: Hono app + `Bun.serve`). Deployed to Cloud Run as a
# stateless, autoscaled service.
#
# BUILD CONTEXT = repo root (the entry imports both infra/docker/voxi-api/server.ts and
# services/voxi-api/src/*). Build with:
#   docker build -f infra/docker/voxi-api/Dockerfile -t voxi-api .
#
# Image runs as non-root, listens on $PORT (Cloud Run injects it; default 8080), and serves /healthz.

# ---- deps: install workspace node_modules once, cached on the lockfile ----------------------------
FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
# Only the manifests + lockfile, so `bun install` is cached unless deps actually change.
COPY package.json bun.lock ./
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/db/package.json            packages/db/package.json
COPY services/voxi-api/package.json      services/voxi-api/package.json
COPY services/eve-agent/package.json     services/eve-agent/package.json
COPY services/voxi-podcast-worker/package.json services/voxi-podcast-worker/package.json
COPY app/package.json                    app/package.json
COPY e2e/package.json                    e2e/package.json
# --frozen-lockfile: fail the build if the lockfile is stale rather than silently resolving new versions.
# --production: this service needs no dev deps (playwright/agent-browser are e2e-only).
RUN bun install --frozen-lockfile --production

# ---- runtime: copy source + the installed modules, run the infra entrypoint -----------------------
FROM oven/bun:1.3.11-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node_modules from the deps stage (already resolved; no network at runtime-build).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock     ./bun.lock

# Only the source this service actually needs (keeps the image small + the attack surface tight).
COPY packages/shared        ./packages/shared
COPY services/voxi-api      ./services/voxi-api
COPY infra/docker/voxi-api  ./infra/docker/voxi-api
COPY tsconfig.base.json     ./tsconfig.base.json

# Cloud Run sets PORT; default for local `docker run`.
ENV PORT=8080
EXPOSE 8080

# Drop privileges — the oven/bun image ships a non-root `bun` user.
USER bun

# Bun's own healthcheck-friendly start. The entry serves /healthz for the platform probe.
ENTRYPOINT ["bun", "run", "infra/docker/voxi-api/server.ts"]
