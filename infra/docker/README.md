# infra/docker — one Dockerfile per backend service

Containers for the four Voxi backend services (PLAN §3, §4.4). Every Dockerfile builds with **context = the
repo root** (they COPY across `packages/` + `services/`), so always invoke from the root:

```bash
docker build -f infra/docker/voxi-api/Dockerfile        -t voxi-api .
docker build -f infra/docker/eve-front/Dockerfile       -t eve-front .
docker build -f infra/docker/eve-poller/Dockerfile      -t eve-poller .
docker build -f infra/docker/podcast-worker/Dockerfile  -t podcast-worker .
```

(or just `infra/deploy/deploy.sh --build-only`, which builds + pushes all four.)

| Dir | References service dir | Runtime | Notes |
|---|---|---|---|
| `voxi-api/` | `services/voxi-api` | Bun 1.3.11 | The BFF + only public surface. `server.ts` here wraps the service's `createApp` Hono app for `$PORT`; serves `/healthz`. |
| `eve-front/` | `services/eve-agent` (role=front) | Bun 1.3.11 | Stateless eve request front. `entrypoint.sh` boots `WORKFLOW_ROLE=front`; serves `/eve/*` + `/.well-known/workflow/*`. |
| `eve-poller/` | `services/eve-agent` (role=poller) | Bun 1.3.11 | **Non-serverless** workflow poller (LISTEN/NOTIFY). `entrypoint.sh` boots `WORKFLOW_ROLE=poller`; always-on. |
| `podcast-worker/` | `services/voxi-podcast-worker` | Bun 1.3.11 + **ffmpeg** | Cloud Tasks target; single-call multi-speaker TTS + ffmpeg HLS split (D7). |

`eve-front` and `eve-poller` share the **same** `services/eve-agent` codebase; only `WORKFLOW_ROLE` differs.

Each Dockerfile has a sibling `Dockerfile.dockerignore` (BuildKit per-Dockerfile ignore) so the root build
context is trimmed (no `node_modules`, `ios/`, `android/`, terraform, secrets, e2e artifacts).

The eve and worker `entrypoint.sh` wrappers are **documented seams**: they `exec` the real entry
(`agent/server.ts`, `agent/poller.ts`, `src/server.ts`) once the eve-backend (gate G3) and worker workflows
scaffold it, and **fail loudly** otherwise — they never serve a fake. The image shapes (runtime, ffmpeg,
roles, ports, non-root user) are final.
