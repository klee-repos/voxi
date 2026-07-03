# infra/deploy — build, push & deploy the Voxi backend

Containerises and deploys the four backend services to GCP per the corrected eve topology (PLAN §3, §4.4,
§11). Nothing here runs in the build sandbox (no creds — PLAN constraint); these are **authored IaC + scripts**
that an operator or Cloud Build runs against a real project.

## What deploys where

| Service | Image (`infra/docker/<svc>/Dockerfile`) | Target | Ingress | Scaling |
|---|---|---|---|---|
| `voxi-api` | `voxi-api` | Cloud Run service | **public** (only public surface) | autoscale 0→20 |
| `eve-front` | `eve-front` | Cloud Run service | internal + LB | warm 1→10 |
| `eve-poller` | `eve-poller` | Cloud Run **Worker Pool** (or GCE MIG / GKE) | **none** (no requests) | **always-on, manual, size-pinned** |
| `podcast-worker` | `podcast-worker` | Cloud Run service | internal (Cloud Tasks) | autoscale 0→10, concurrency 1 |

`eve-front` and `eve-poller` are the **same eve codebase** (`services/eve-agent`) run in two roles
(`WORKFLOW_ROLE=front|poller`). The Postgres workflow world is **not serverless-compatible**, so the poller is
pinned always-on and never N-of-many-each-polling (PLAN §4.4 — this is gate **G3**, a hard go/no-go).

## The two route-forwarding requirements (PLAN §4.4)

`deploy.sh` wires an external HTTPS Load Balancer URL map that forwards **both** path prefixes to `eve-front`:

- `/eve/*` — the eve HTTP channel the BFF proxies (session create/stream).
- `/.well-known/workflow/*` — graphile-worker advances a run by HTTP-calling the app's **own**
  `/.well-known/workflow/v1/flow` (a ~60s route ceiling). This route **must** be reachable, so it is forwarded
  to the same `eve-front` backend, and `EVE_SELF_URL` / `EVE_FRONT_URL` point the service at its own base URL.

Because each eve step must stay under ~60s, long work (the podcast render) is offloaded to `podcast-worker`
via Cloud Tasks — the eve turns checkpoint frequently (PLAN §4.4(c), §6.2).

## Usage

```bash
# everything (build + push + deploy)
PROJECT_ID=my-proj REGION=us-central1 RUN_SA=voxi-run@my-proj.iam.gserviceaccount.com \
  infra/deploy/deploy.sh

# CI path: images already pushed by cloudbuild.yaml, just roll out
VOXI_DEPLOY=1 PROJECT_ID=… REGION=… IMAGE_TAG=$SHORT_SHA infra/deploy/deploy.sh --deploy-only

# build + push only
PROJECT_ID=… REGION=… infra/deploy/deploy.sh --build-only
```

`cloudbuild.yaml` runs the same flow in CI: it builds + pushes the four images (tagged `$SHORT_SHA` + `latest`)
to Artifact Registry, then calls `deploy.sh --deploy-only` so CI and a manual operator use **identical** run
flags (ingress, dual routing, always-on poller, secret bindings).

---

## Env / secrets inventory (var → service → Secret Manager ref)

Secrets are bound **by reference** from Secret Manager via `gcloud run --set-secrets` (never baked into an
image, never in env files). Plain config is `--set-env-vars`. The Cloud Run runtime SA (`RUN_SA`) needs
`roles/secretmanager.secretAccessor` on each referenced secret.

**Legend — Service:** A=`voxi-api`, F=`eve-front`, P=`eve-poller`, W=`podcast-worker`.
**Kind:** 🔐=Secret Manager reference, ⚙️=plain env var (non-secret config).

| Var | Services | Kind | Secret Manager ref (NAME:VERSION) | Purpose / PLAN ref |
|---|---|---|---|---|
| `CLERK_JWT_KEY` | A, F | 🔐 | `clerk-jwt-key:latest` | Networkless Clerk JWT verify (PEM/JWKS). Used by `auth.ts` `clerkVerifier` + the eve AuthFn (§12). |
| `VOXI_URL_SIGNING_KEY` | A | 🔐 | `voxi-url-signing-key:latest` | HMAC key for short-TTL, user-bound signed GCS URLs (`signing.ts`, §11/D9). |
| `DATABASE_URL` | A, F, P, W | 🔐 | `database-url:latest` | Cloud SQL Postgres+pgvector DSN. **The poller holds the LISTEN/NOTIFY connection** on this (§4.4, §11). |
| `EVE_SCOPED_TOKEN_KEY` | A, F, P | 🔐 | `eve-scoped-token-key:latest` | Signs the BFF-minted **per-session scoped token** the Pipecat bot uses to reach eve tools (§3, §6.3). |
| `GEMINI_API_KEY` | F, P, W | 🔐 | `gemini-api-key:latest` | Gemini 3 Flash/Pro (Vertex) — ID hypothesis, grounding, podcast research/script (§5, §6.2). |
| `VISION_API_KEY` | F | 🔐 | `vision-api-key:latest` | Cloud Vision web detection + SafeSearch (§5, §7.5, §15). |
| `SERPAPI_KEY` | F | 🔐 | `serpapi-key:latest` | SerpApi Lens long-tail grounding fallback (§5, pluggable). |
| `ELEVENLABS_API_KEY` | F, W | 🔐 | `elevenlabs-api-key:latest` | ElevenLabs TTS — narrator description + podcast premium swap (§6.1, §6.2). |
| `DEEPGRAM_API_KEY` | (voice-bot¹) | 🔐 | `deepgram-api-key:latest` | Streaming STT for realtime voice (§6.3). Listed for completeness; the Pipecat bot is a sibling workflow. |
| `APPSTORE_CONNECT_KEY` | A | 🔐 | `appstore-connect-api-key:latest` | Direct StoreKit 2 server-side entitlement verification (App Store Server API / Notifications V2) — **no billing vendor**; the transaction's `appAccountToken` = Clerk user id (§9, §13). Only needed for the LIVE App Store; JWS verification itself uses Apple's public root certs. |
| `NCMEC_CREDENTIALS` | (intake²) | 🔐 | `ncmec-credentials:latest` | 2258A CSAM report path credentials (§15/RT-4). Bound to whichever service runs the intake pipeline. |
| `GCS_PHOTO_BUCKET` | A, F | ⚙️ | — (`${PROJECT}-voxi-photos`) | Redacted photos bucket (§11). |
| `GCS_AUDIO_BUCKET` | A, P-no, W | ⚙️ | — (`${PROJECT}-voxi-audio`) | Audio/HLS bucket, CDN-fronted, audio cached by item id is global-only (§6.2, §11). |
| `EVE_FRONT_URL` | A, P | ⚙️ | — (resolved post-deploy) | The eve-front internal base URL. The BFF proxies sessions here; the **poller calls back** here for the workflow self-callback (§4.3, §4.4). |
| `EVE_SELF_URL` | F | ⚙️ | — (= eve-front's own URL) | eve-front's own base URL, so the workflow runtime can self-call `/.well-known/workflow/v1/flow` (§4.4). |
| `WORKFLOW_ROLE` | F=`front`, P=`poller` | ⚙️ | — | Selects front vs poller behaviour from the shared eve image (§4.4). |
| `POLLER_CONCURRENCY` | P | ⚙️ | — (default `1`) | Concurrent workers in the poller. >1 only if `@workflow/world-postgres` proves SKIP-LOCKED multi-poller safety (a G3 output, §4.4/§22.6). |
| `POLLER_INSTANCES` | P | ⚙️ | — (default `1`) | Worker Pool size. ≥2 = HA at ~$30–80/mo (§22.6); each instance is a poller, so multi-poller correctness must be proven first. |
| `PORT` | A, F, W | ⚙️ | — (Cloud Run injects; default `8080`) | HTTP listen port. |
| `HEALTH_PORT` | P | ⚙️ | — (default `8080`) | Liveness port for the Worker Pool / MIG probe (the poller serves no client traffic). |
| `VPC_CONNECTOR` | A, F, P, W | ⚙️ | — | Serverless VPC connector for private egress to Cloud SQL + internal services (§11). |
| `CLOUDSQL_INSTANCE` | A, F, P, W | ⚙️ | — (`PROJECT:REGION:INSTANCE`) | Cloud SQL connection (`--add-cloudsql-instances`) when not using the VPC connector path. |
| `VOXI_TEST_MODE` | (non-prod) | ⚙️ | — | `=1` enables the `test:<userId>` verifier (`auth.ts`). **Never set in prod** — `voxi-api/server.ts` requires `CLERK_JWT_KEY` instead. |

¹ `DEEPGRAM_API_KEY` and the `voice-bot` (Pipecat, Python) container are owned by a sibling workflow; the
secret is inventoried here so the Secret Manager set is complete. ² The image-intake pipeline
(`services/voxi-api/src/intake-pipeline.ts`) is wired by the service that ingests uploads; `NCMEC_CREDENTIALS`
binds to that service. Both are listed for a complete secrets manifest, not deployed by `deploy.sh`.

### Secret Manager bootstrap (one-time, per project)

```bash
# Create each secret, then add a version. Example:
for s in clerk-jwt-key voxi-url-signing-key database-url eve-scoped-token-key \
         gemini-api-key vision-api-key serpapi-key elevenlabs-api-key elevenlabs-voice-id \
         deepgram-api-key appstore-connect-api-key ncmec-credentials; do
  gcloud secrets create "$s" --replication-policy=automatic --project="$PROJECT_ID" 2>/dev/null || true
done
# Add versions out-of-band (do NOT commit secret material):
#   printf '%s' "$VALUE" | gcloud secrets versions add clerk-jwt-key --data-file=- --project=$PROJECT_ID
# Grant the runtime SA access:
#   gcloud secrets add-iam-policy-binding <name> \
#     --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor --project=$PROJECT_ID
```

Override any ref at deploy time, e.g. pin a version: `SECRET_CLERK_JWT_KEY=clerk-jwt-key:7 infra/deploy/deploy.sh`.

---

## Build contexts & images

Every Dockerfile builds with **context = repo root** (they COPY across `packages/` + `services/`). Each has a
per-Dockerfile `Dockerfile.dockerignore` (BuildKit) so the root context stays lean. The TS services run on
**Bun 1.3.11** (the repo's pinned runtime); `podcast-worker` adds **ffmpeg** (PLAN §6.2/D7). The `voxi-api`
image uses an entry under `infra/docker/voxi-api/server.ts` (it wraps the service's `createApp` Hono app —
the service itself exports no long-lived server, and infra owns the container, not the service code).

## Known gaps / seams (honest)

In short: the eve `front`/`poller` and
`podcast-worker` entrypoints are **documented seams** that boot the real entry once the eve-backend (G3) and
worker workflows land their `server.ts`/`poller.ts`; until then the wrappers **fail loudly**, never serve a
fake. The Worker Pool deploy assumes `gcloud beta run worker-pools`; `deploy.sh` prints the GCE-MIG / GKE
always-on fallback (and `infra/terraform` carries the IaC) if that surface is unavailable.
