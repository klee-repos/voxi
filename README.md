# Voxi

**Identify any human-made object from a single photo, then explore it in depth.**

Point your phone at an object and Voxi identifies it as specifically as possible — a *2008 Cannondale SuperSix EVO*, not "a bike" — and tells you what it is and what it's for. From there you can generate a short podcast about it, have a voice or text conversation about it, and save it to a growing collection. Identifications are grounded and honest: when Voxi isn't confident, it says so instead of guessing.

Voxi is iOS-first and also runs on the web.

## Features

- **Specific identification** — make, model, and year where the evidence supports it, with an honest confidence level when it doesn't.
- **Narrated descriptions** — each object gets a concise description of what it is and why it matters.
- **On-demand podcasts** — a ~5-minute, two-voice episode about any identified object.
- **Voice and text conversation** — a natural, low-latency voice chat about what you just scanned; keyboard optional.
- **A persistent collection** — every photo becomes a saved thread, and every identification adds to a crowd-sourced catalog of specific objects.

See [CLAUDE.md](CLAUDE.md) for the product overview and architecture.

## Architecture

Monorepo. `services/voxi-api` (the BFF) is the only public surface; everything else is private and reached through it.

```
app/                      Expo / React Native client (iOS-first; also builds for web)
services/
  voxi-api/               BFF / API gateway — the only public surface (auth, metering, signed URLs)
  eve-agent/              durable agent backend — identification, narration, conversation
  voxi-podcast-worker/    async podcast rendering (ffmpeg + TTS → HLS)
  voice-bot/              realtime voice pipeline (Python)
packages/
  shared/                 shared types + Zod schemas — the boundary contracts
  db/                     Postgres + pgvector migrations and the seed catalog
e2e/                      hybrid deterministic + agentic end-to-end test framework
infra/                    Terraform, Docker images, and deploy scripts (GCP / Cloud Run)
```

## Requirements

- **Bun** ≥ 1.3 and **Node** ≥ 20 — the runtime is Bun workspaces
- **Python** 3.12 — for the voice bot only
- **Docker** — for the local observability stack
- A **Mac + Xcode** for the native iOS build; **gcloud** and vendor API keys for the live AI / auth / voice tiers

## Setup

```sh
bun install                       # install all workspaces
cp .env.example .env.local        # then fill in credentials (gitignored)
```

`.env.example` documents every credential and which tier it unlocks.

## Running locally

Start the whole backend (four services plus the observability stack) with one command:

```sh
./scripts/dev.sh                  # BFF :8787 · podcast-worker :8788 · voice :7071 · Metro :8081 · Grafana :3000
./scripts/dev.sh down             # stop everything
```

Run just the app:

```sh
cd app && bun run web             # run on web (also what E2E drives)
cd app && bun run ios             # native iOS build (Mac + Xcode)
```

> Metro requires Node ≥ 20.19.4 (Expo SDK). A physical iPhone on the same Wi-Fi reaches the API at `http://<LAN_IP>:8787`.

## Testing

```sh
bun test                          # whole TS suite
bun test services/voxi-api        # one workspace / path filter
bun test -t "session ownership"   # a single test by name
python3 -m pytest services/voice-bot/ -q   # the Python voice-bot suite

bun run typecheck                 # tsc -b across project references
bun run lint:selectors            # enforce the testID registry used by E2E
bun run e2e:web:auth              # deterministic web E2E (runs in CI without creds)
bun run e2e:web:explore           # agentic exploration
bun run e2e:live                  # hit real APIs instead of recorded tapes (needs creds)
```

## Database

```sh
bun run db:migrate                # apply Postgres + pgvector migrations
```

Migrations and the seed catalog live in `packages/db/`.

## Deployment

Provision cloud infrastructure (Cloud Run, Cloud SQL / AlloyDB, GCS, Cloud Tasks, and so on) with Terraform:

```sh
cd infra/terraform && terraform init && terraform apply
```

Build and deploy the backend services to Cloud Run (requires `gcloud` auth and `PROJECT_ID` / `REGION` set):

```sh
infra/deploy/deploy.sh            # build + push + deploy everything
infra/deploy/deploy.sh --build-only
infra/deploy/deploy.sh --deploy-only
```

`voxi-api` deploys with public ingress (the only public surface); `eve-front`, `eve-poller` (a non-serverless worker pool), `podcast-worker`, and `voice-bot` are internal. Secrets are bound by reference from Secret Manager and never baked into images.
