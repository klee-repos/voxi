# Runtime Foundation — how Voxi is assembled and actually runs

> **Purpose.** `docs/PLAN.md` is the product spec; `docs/IMPLEMENTATION-STATUS.md` tracks real-vs-scaffolded.
> **This document is the coherence guide post for the *runtime*:** how the pieces are assembled into a live,
> end-to-end system, the decisions that shape that assembly, and the invariants to preserve when extending it.
> Written after the session that turned the repo from "proven seams, nothing running" into a verified running
> system (real capture from a physical iPhone through live Gemini/Vision/Deepgram/ElevenLabs/ffmpeg/pgvector).

---

## 0. The one idea that governs everything: seam + assembled entrypoint

The repo was built as **testable seams** — every external dependency is a pluggable interface with a
deterministic fake, so ~200 unit tests pass with no credentials. But a passing test suite is **not** a running
system: for a long time nothing injected the *real* dependencies and served them, and the app never reached a
real backend. This session closed that gap. The governing rule, now foundational:

> **Every capability exists twice: as a SEAM (pure logic + a fake, for tests) and as an ASSEMBLED ENTRYPOINT
> (`*/src/server.ts`, real deps injected, served). Tests exercise the seam; the running system is the
> entrypoint. A fake NEVER appears in an entrypoint to force green.**

Concretely, per service:

| Seam (pure, faked in tests) | Assembled entrypoint (real deps, served) |
|---|---|
| `services/voxi-api/src/app.ts` → `createApp(deps)` | `services/voxi-api/src/server.ts` |
| `services/voxi-podcast-worker/src/render.ts` → `renderPodcast(job, deps)` | `services/voxi-podcast-worker/src/server.ts` |
| `services/voice-bot/voxi_voice/*` (providers/transport protocols) | `services/voice-bot/voice_server.py` |
| `services/eve-agent/agent/agent.ts` (`loadEveRuntime`, registry) | `services/eve-agent/agent/server.ts` |

When you add a capability: add its seam (interface + fake for tests), wire the real implementation into the
relevant `server.ts`, and prove it with a live e2e (§5). Do not stop at "the unit test passes."

---

## 1. Topology — the four processes and how they connect

Start everything (auto-detects LAN IP, tmux 2×2 grid): **`./scripts/dev.sh`** · stop: **`./scripts/dev.sh down`**.

| Service | Entrypoint | Port | Role |
|---|---|---|---|
| **BFF** (Hono) | `services/voxi-api/src/server.ts` | 8787 | the ONLY public surface — auth, ACL, metering, and every route |
| **Podcast worker** | `services/voxi-podcast-worker/src/server.ts` | 8788 | render two-voice episodes (Gemini research/script → gates → ElevenLabs → ffmpeg) |
| **Voice server** (Python) | `services/voice-bot/voice_server.py` | 7071 | realtime "Ask Voxi" — SmallWebRTC signaling + Deepgram→Gemini→ElevenLabs |
| **Metro** (Expo) | `app/` (`npx expo start`) | 8081 | serves the JS bundle to the device |

Plus two Postgres-gated pieces (authored + booted against local Postgres this session, run in prod against
Cloud SQL): the **durable eve runtime** `services/eve-agent/agent/server.ts` (front + poller roles), and the
**schema** `packages/db/migrations/0001_init.sql` + `apply-migrations.ts`.

Trust/data flow (unchanged invariant):

```
iPhone --Clerk JWT--> BFF(:8787) --in-process--> CascadeEveClient (live cascade + catalog moat)
                          |                          |
                          |--> podcast worker(:8788) |--> Vertex Gemini + Cloud Vision + narrator
                          |--> voice server(:7071)   |--> PGlite (threads/entitlements/catalog)  --prod--> Cloud SQL
                          '--> durable eve (Postgres, prod)
```

`userId` (from the verified JWT) is the single ACL key everywhere. 1 photo = 1 durable session = 1 thread row.

---

## 2. What each tier is, in the assembled system (with the real files)

**BFF (`services/voxi-api/src/`).** `app.ts` `createApp(deps)` defines every route + the `Deps` contract
(pluggable collaborators). `server.ts` injects the real ones:
- `verifier` = `clerkVerifier(verifyToken)` — networkless Clerk JWT verify (`CLERK_JWT_KEY` PEM).
- `eve` = `CascadeEveClient` (`cascade-eve-client.ts`) — the live identification cascade, wired with the catalog.
- `store` + `threads` = `pg-stores.ts` (file-backed PGlite; row-atomic `tryDecrement`; survives restart).
- `local-collaborators.ts` — `interviews` (interviewer subagent), `contributions` (real TL0/TL2 trust gate +
  first-report auto-hide), and a **real deletion cascade** that purges every store.
- `podcast-client.ts` — gate → enqueue to the worker → proxy honest status (never fabricates "ready").
- `voice-routes.ts` — mounted at `/v1/voice/*`; gates `voiceMin`, mints a per-session connect URL.
- `planFor=voyager` in dev (full access, no paywall); `appStore` (Apple JWS verify) intentionally unwired — it
  needs an Apple sandbox purchase to exercise, so wiring a positive path would be unverifiable.
- **`/v1/threads` accepts TWO intake shapes:** JSON `{photoUrl}` (photoUrl may be a `data:` URI) OR a
  multipart `photo` file part. Both become a `data:` URI the cascade decodes.

**Identification cascade (`services/eve-agent/agent/`).** `cascade.ts` `runIdentificationCascade` =
safety_gate → identify_object → narrator. `providers/live-vision.ts` (Vertex Gemini VLM + Cloud Vision
WEB_DETECTION → arbiter), `live-safety.ts` (SafeSearch, fail-closed), `live-narrator.ts` (honesty-gated).
Auth via the gcloud CLI bearer (`lib/gcp-vision.ts` `gcloudToken()`, no ADC/SA-key).

**Catalog moat — Stage 3 (`packages/db/catalog.ts`, `agent/lib/embedding.ts`).** ADDITIVE + GUARDED:
`LiveVisionProvider` takes optional `CatalogDeps { catalog, embedder }`; each scan embeds the image
(`multimodalembedding@001`, 1408-dim), `searchPartitioned` (visibility ACL in SQL), injects a `catalog`
candidate iff `dist < 0.15`, and upserts the accepted id as a PRIVATE item after CONFIDENT/PROBABLE. **With no
catalog, or on any embedding/catalog error, the result is byte-identical to the vlm+web-only path.**

**Persistence.** Runtime uses file-backed PGlite (real SQL, survives restart). Production schema authored in
`packages/db/migrations/0001_init.sql` (extensions `vector`+`pgcrypto`; `app.*` + `workflow.*` schemas;
`catalog_items.embedding vector(1408)` with partitioned HNSW cosine indexes; threads/entitlements/gen_tokens/
podcast_assets/tips/reports/interviews/messages/turns) + `apply-migrations.ts` runner. Migrating the BFF stores
from PGlite to Cloud SQL is the prod step.

**Podcast (`services/voxi-podcast-worker/src/`).** `render.ts` is the pipeline (idempotent CAS; **two
fail-closed honesty controls run on the script BEFORE any audio**: claim-structured grounding + defamation
gate). `providers.ts` = search-grounded Gemini research + claim-structured script; `live-tts.ts` = ElevenLabs
two-voice; the ffmpeg `Muxer` (loudnorm). `server.ts` serves render/status/audio; the asset carries the real
speaker-tagged transcript.

**Voice (`services/voice-bot/`).** `voice_server.py` (FastAPI/uvicorn SmallWebRTC `/offer`), `transport.py`
wires Deepgram STT → Gemini LLM → ElevenLabs TTS + Silero VAD; `providers.py` real vendor impls behind the
protocols. App client: `app/src/lib/pipecat.ts` (`PipecatClient` + `RNSmallWebRTCTransport`) with a concrete
`voiceMediaManager.native.ts` and a **fail-safe** `createVoiceSession` (any error → deterministic stub).

**Durable eve runtime (`services/eve-agent/agent/server.ts`).** `loadEveRuntime()` + `@workflow/world-postgres`
world (front + poller), serves `/eve/v1/session[/:id/stream]` with durable NDJSON + reconnection + ACL. The
BFF's `CascadeEveClient` is the in-process cascade; the durable runtime is the prod backend for the full agent.

---

## 3. The app-client realities that constrain the backend (hard-won)

- **Photo intake:** on RN iOS you CANNOT build a Blob from an ArrayBuffer, and a `{uri}` multipart part is
  rejected by Expo's `winter` fetch ("Unsupported FormDataPart"). The working path is
  `app/src/lib/photo.native.ts` → `expo-file-system` `readAsStringAsync(base64)` → `data:image/jpeg;base64,…`
  → `POST /v1/threads` (JSON). (The BFF also accepts multipart, kept as a fallback.)
- **react-native-webrtc must be LAZY** — importing it at boot crashes on the main thread
  (`MediaDevices._registerEvents: undefined is not a function`). `nativeStartup.native.ts` `require()`s the
  voice MediaManager only at voice-session start.
- **Metro needs Node ≥20.19.4** (SDK 57 CLI); `./scripts/dev.sh` selects the newest nvm v22.
- **ATS:** keep `NSAllowsLocalNetworking` in `app.json` (a `--clean` prebuild regenerates `Info.plist`).
- **Do not add `expo-apple-authentication`** unless used — its Sign-In-with-Apple entitlement won't provision on
  a personal team and breaks device signing.
- **bun is the package manager** — a stray root `package-lock.json` broke bun's `babel-preset-expo` link and the
  Metro transformer. Keep npm out of the repo.
- **Build fixes baked in:** `npx install-skia` before `pod install`; the expo-iap Swift
  `Subscription?`→`OpenIAP.Subscription?` patch (patch-package can't reach the bun store, so it's applied
  directly). See CLAUDE.md "Running the whole thing on a physical iPhone".
- **UI note:** `app/app/(tabs)/camera.tsx`, `reveal.tsx`, `threads.tsx` were redesigned to a Shazam layout
  (`AppHeader`/`CaptureOrb`/`RecentlyIdentified`). The core data flow (capture → `createThread` → `/processing`
  → reveal; revisit routes through `/processing`) is preserved inside the redesign. There is one **non-fatal**
  `TypeError` + a `FadeRise` `useNativeDriver` warning in the redesign — app functions through them; unresolved.

---

## 4. Verification harness — no cheating

Vendor calls are live or recorded tapes, never stubbed to force green; e2e asserts real observable state through
stable `testID`s; the honesty gate is a real pipeline stage. `bun test` = 201 pass. Live end-to-end proofs
(`spikes/`, run from repo root):

| Spike | Proves |
|---|---|
| `e2e-live-http.ts` | the **running** BFF over HTTP: token → photo → CONFIDENT reveal + persisted thread + voice session |
| `e2e-live-loop.ts` | in-process assembled loop (auth enforced, grounded reveal, narration) |
| `e2e-catalog.ts` | real Vertex embedding + pgvector ranking + visibility ACL + persistence |
| `e2e-durable-bff.ts` | threads/entitlements survive a real close/reopen restart + deletion purges |
| `e2e-podcast-bff.ts` | BFF gate → worker render → real MP3 (ffprobe) + transcript |
| `e2e-bff-services.ts` | interviews / trust-gated tips / first-report auto-hide / deletion cascade |
| `services/voice-bot/verify_pipeline.py` | real Deepgram STT → Gemini (Guide persona) → ElevenLabs TTS |
| `spikes/live-podcast.ts` | full real render → real WAV/MP3 episode |

**Verified on a physical iPhone this session:** capture uploads a real ~1.8 MB photo → `/v1/threads → 200` →
the live cascade runs. **Environment-gated (not this repo):** `terraform apply` / Cloud Run deploy (needs GCP),
Apple StoreKit verification (needs a sandbox purchase), and on-device podcast *audio playback* + full voice
*mic* loop (compiled into the build; needs the user to confirm sound/mic on the device).

---

## 5. Coherence guide posts — invariants to preserve

1. **The BFF is the only public surface.** New routes go under `/v1/*` behind the auth middleware and ACL by
   `userId` (server-derived, never trusted from the client). Private services are reached via injected clients.
2. **Seam + assembled entrypoint (see §0).** Never fake a dependency in a `server.ts` to make something "work".
   Unwired integration points fail loudly (503 / a typed hard_failure), never a fake success.
3. **Additive + guarded** for anything layered onto the working path (the catalog moat, the voice client): with
   the feature absent or erroring, degrade to the exact previously-verified behavior.
4. **The honesty gate stays real** — the narrator hedges unless the ID is grounded and confident; the podcast
   drops rather than ship an unvalidated claim. Don't weaken a gate to pass a test.
5. **Business state is server-derived** — identity, entitlements, plan, ownership, trust level. The client
   proposes; the BFF decides.
6. **Persistence path:** PGlite in dev (`pg-stores.ts`, `packages/db/catalog.ts`) ↔ Cloud SQL in prod (same SQL,
   `packages/db/migrations/`). Keep the two in lockstep; the ACL SQL is the part that must be identical.
7. **`docs/api-contract.md` is code-cited — the code is canonical.** TypeScript is `strict` with
   `noUncheckedIndexedAccess`.
8. **Local dev = one command / one session.** `./scripts/dev.sh` up, `./scripts/dev.sh down` down; four services
   in one tmux grid. The `*/src/server.ts` files are the source of truth for "how it runs."
