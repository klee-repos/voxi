# syntax=docker/dockerfile:1.7
#
# voxi-podcast-worker — the Deep Dive render worker. A private Bun HTTP service the BFF hands gated render jobs to
# over HTTP (x-worker-secret). Runs the REAL pipeline: search-grounded Vertex research → claim-structured Gemini
# script → honesty/defamation gates → live ElevenLabs two-voice TTS → ffmpeg loudnorm mux → a real MP3 it serves
# range-safe. Deployed to Cloud Run as a SINGLE always-CPU instance (in-memory job map + local audio files must
# stay coherent, and the fire-and-forget render needs CPU allocated after the 202).
#
# BUILD CONTEXT = repo root (the entry imports services/voxi-podcast-worker/src/* and services/eve-agent/agent/*).
#   docker build -f infra/docker/voxi-podcast-worker/Dockerfile -t voxi-podcast-worker .

# ---- deps: install workspace node_modules once, cached on the lockfile ----------------------------
FROM oven/bun:1.3.11-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/telemetry/package.json     packages/telemetry/package.json
COPY packages/db/package.json            packages/db/package.json
COPY services/voxi-api/package.json      services/voxi-api/package.json
COPY services/eve-agent/package.json     services/eve-agent/package.json
COPY services/voxi-podcast-worker/package.json services/voxi-podcast-worker/package.json
COPY app/package.json                    app/package.json
COPY e2e/package.json                    e2e/package.json
# --frozen-lockfile: fail on a stale lockfile. --production: no dev deps. --ignore-scripts: the root postinstall
# is app-only patch-package (a devDep, absent here) — skipping avoids exit 127; the worker's runtime is pure JS.
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---- runtime: copy source + modules, add ffmpeg, run the worker entrypoint ------------------------
FROM oven/bun:1.3.11-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg is the muxer's hard dependency (loudnorm re-encode → the player-safe MP3). Install as root before we
# drop privileges. Clean the apt lists to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/bun.lock     ./bun.lock

# Only the source this service imports: the worker itself, the eve-agent providers it reuses (gcp-vision token +
# the flavor auditor), and the shared/telemetry packages.
COPY packages/shared             ./packages/shared
COPY packages/telemetry          ./packages/telemetry
COPY services/eve-agent          ./services/eve-agent
COPY services/voxi-podcast-worker ./services/voxi-podcast-worker
COPY tsconfig.base.json          ./tsconfig.base.json

# Cloud Run injects PORT (server.ts honors it); default for local `docker run`.
ENV PORT=8080
# Rendered MP3s land here — /tmp is always writable by the non-root user (the default .voxi-data path is not).
ENV PODCAST_OUT_DIR=/tmp/voxi-podcasts
EXPOSE 8080

# Drop privileges — the oven/bun image ships a non-root `bun` user.
USER bun

ENTRYPOINT ["bun", "run", "services/voxi-podcast-worker/src/server.ts"]
