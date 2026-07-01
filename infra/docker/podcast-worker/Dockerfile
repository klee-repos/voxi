# syntax=docker/dockerfile:1.7
#
# voxi-podcast-worker — async podcast render (PLAN §6.2 / D7). A Cloud Tasks target on Cloud Run. Needs FFMPEG
# on PATH (loudnorm + ducked bed + crossfades + local HLS split) — the whole reason this is a worker and not
# an in-eve justbash step. Runtime: Bun (the worker is TypeScript); ffmpeg added on top of the bun base.
#
# BUILD CONTEXT = repo root:
#   docker build -f infra/docker/podcast-worker/Dockerfile -t podcast-worker .

FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/db/package.json            packages/db/package.json
COPY services/voxi-podcast-worker/package.json services/voxi-podcast-worker/package.json
COPY services/voxi-api/package.json      services/voxi-api/package.json
COPY services/eve-agent/package.json     services/eve-agent/package.json
COPY app/package.json                    app/package.json
COPY e2e/package.json                    e2e/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg is the load-bearing dependency for this image (PLAN §6.2 step 4). Pin via the distro and clean apt
# lists to keep the layer small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock     ./bun.lock

COPY packages/shared              ./packages/shared
COPY services/voxi-podcast-worker ./services/voxi-podcast-worker
COPY tsconfig.base.json           ./tsconfig.base.json
COPY infra/docker/podcast-worker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=8080
EXPOSE 8080

USER bun
ENTRYPOINT ["./entrypoint.sh"]
