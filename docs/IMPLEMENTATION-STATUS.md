# Implementation status — honest tracker (no cheating)

What is genuinely **real/runnable**, **scaffolded** (structure + interfaces, not yet wired), or **cred/
toolchain-gated** (cannot run or verify in this sandbox). Updated each loop iteration.

## TL;DR — live state (2026-07-01)
**Every credential the user has provided is wired and PROVEN LIVE, end-to-end:**
- **GCP** (Vertex Gemini + Cloud Vision) → identification + honesty-gated narration through the real BFF.
- **Clerk** (auth) → real session token verifies through `@clerk/backend` → our verifier → BFF `/v1/me`. CLI-automated.
- **ElevenLabs** (TTS) + **Deepgram** (STT) → Voxi's spoken voice, a live **two-voice podcast** episode, AND a full
  **realtime conversation turn** (audio → STT → grounded Gemini reply → TTS → audio).
- **Subscriptions**: RevenueCat REMOVED → **StoreKit 2 direct** (device `expo-iap` + server-side App Store
  verification), built + tested.
- **Infra**: `terraform validate` SUCCESS (14 files, providers/modules resolve).

Deterministic validation: **`bun test` 177/0**, selector lint pass, **voice-bot pytest 17/17**, **4/4 RNW converge
GREEN**, web E2E runners GREEN. Remaining (needs user hardware/go-ahead, not code): iOS-native (Mac+Xcode), the
Pipecat WebRTC transport (live extras + a client), the eve durable self-host at scale, and the billing-gated
`terraform apply`.

## Collection persistence — past items keep their photo + generated content — DONE + VERIFIED (2026-07-01)
The bug: a revisited collection item showed a blank image and re-ran (or lost) its content — the running BFF
persisted only a thin thread stub; the photo lived in an in-memory `Map` and the reveal was regenerated live
per stream (dying as `hard_failure` after a restart). Fixed **completely** across all four things an item
produces, BFF-owned + durable (PGlite): the **photo** (`bytea`, served via a signed `/media` URL), the
**reveal** (identification + narration, persisted once + **replayed deterministically** on revisit — no re-run,
no re-bill), the **podcast** episode, and the **conversation**. Plan + reviews in
`docs/COLLECTION-PERSISTENCE-PLAN.md` (`/plan-eng-review` → a 5-lens adversarial workflow: 26 findings, **21
confirmed / 5 refuted**, folded as A1–A17 — incl. two P0s: a default-signing-key photo-exfiltration risk and a
restart-403 that would have broken the whole feature).
- **Store (`pg-stores.ts`).** New `thread_photos`/`reveals`/`podcast_assets`/`messages`/`refunds` tables +
  stores; `threads` gains `band`/`reveal_title`/`photo_mime` (A8: the identified label never overwrites the
  auto-title). Idempotent `ALTER TABLE` migration for existing dirs. `purgeUser` cascades all + deletes OUT_DIR
  MP3s (A14).
- **BFF (`app.ts`, `signing.ts`, `acl.ts`).** Create-time photo persist (real bytes only, A3); `/stream`
  replay-or-generate (durable owner ACL A2, persist only CONFIDENT/PROBABLE A10, `startIndex===0` guard A12,
  durable once-ever refund A15); signed `/media/threads/:id/photo` outside `/v1/*` (full-length HMAC, fail-closed
  in prod A1); list/detail enrichment; owner-scoped podcast (A9) + `messages` routes (partial-index ON CONFLICT
  A6, `{id,duplicate}` A11); redactor strips the photo sig from logs (A13).
- **Client (`apiClient.ts`, `threads.tsx`, `conversation.tsx`).** Collection tiles show a real thumbnail
  (signed URL) + the identified label; revisit hydrates the durable photo; the conversation replays its history
  + persists each turn.
- **Verified this round.** `bun test` **292/0** (incl. `pg-stores.test` 8 durable close/reopen + `app-persistence.test`
  5 full-restart integration: replay determinism, `/media` ACL, podcast-after-restart with the worker
  unreachable, message idempotency, UNKNOWN-never-persisted, refund-once-across-restart). Selector lint +
  testid-coverage GREEN. **20/20 web E2E + converge runners GREEN**, incl. the new **`collection-persistence-rnw`**
  (a real capture over the real BFF → the real collection shows a thumbnail `<img>` the browser **decodes**
  (`naturalWidth>0`) + the identified label, **survives a full page reload**, and revisits), **`agentic-collection`**
  (an autonomous Agent perceives its way through the REAL sign-in → real shutter capture → revisit from the real
  collection; the durable content is pinned deterministically), and **`run-sc-durable-revisit`** (a real `evict()`
  restart → the owner replays the reveal, a non-owner is 404'd). voice-bot pytest GREEN.

## Reveal narration overhaul + spoken British voice — DONE + VERIFIED (2026-07-01)
The post-capture analysis is now **specific + valuable + grounded**, and the reveal **speaks itself** in Voxi's
British voice. Plan + reviews in `docs/ANALYSIS-VOICE-PLAN.md` (drafted → `/plan-eng-review` → a 5-dimension
adversarial workflow: 20 raw findings, **10 confirmed** and folded as A6–A15, 10 refuted).

- **Grounded enrichment (Part A).** A new `LiveResearcher` (`services/eve-agent/agent/providers/live-research.ts`)
  runs a Vertex Gemini **Google-Search-grounded** call (no new creds; `geminiGrounded` in `gcp-vision.ts` — NOTE:
  grounding is mutually exclusive with `responseSchema` on 2.5, so facts are derived from `groundingMetadata`).
  `factsFromGrounding()` maps each grounded segment → citable `IdEvidence` with its source URL; ungrounded segments
  are dropped. The cascade merges these into the narrator's closed evidence — **CONFIDENT keys on the corroborated
  make+base-model** (never the VLM-only year/sub-variant, A8); **PROBABLE keys on the category only** (class-level,
  still hedged, A9); UNKNOWN never researches. Best-effort: an 8s-timeout/error → web-evidence-only, never blocks
  the reveal. The narrator prompt now demands a specific description + one grounded interesting fact and reconciles
  the year via a cited `date` fact (A6); the flavor auditor is broadened to catch non-numeric smuggling (A7).
- **Spoken reveal (Part B).** New `POST /v1/threads/:id/speech` (`app.ts`) voices the **server-owned** narration
  (captured once + pinned per session via `NarrationStore`, A11) through a `NarrationTtsProvider` seam
  (`LiveNarrationTts` → ElevenLabs "George"); a content-hash cache makes a stable narration synthesize once (A10);
  absent seam → 503 loud. The reveal has a labelled **"Hear it" / "Stop"** button (`reveal.playNarration`) that
  plays the audio (`reveal.narrationAudio`); best-effort autoplay is gated on a new **"Speak results aloud"**
  setting (A13, not reduce-motion), render-gated so there's no dead control (A14).
- **Autoplay-blocked fix (2026-07-01, follow-up).** Autoplay is blocked by browsers/iOS without a user gesture, and
  the play control's state had desynced (it optimistically showed "playing" while the blocked audio was paused, so
  a tap paused nothing). Fixed: `AudioElement` now reports its REAL playing state back via `onPlayingChange`
  (handling the blocked-autoplay `play()` rejection + `play`/`pause`/`ended` events) and `seekToStartOnPlay` makes
  the button a true replay; native decodes the `data:` URI to a cache file for TrackPlayer. The reveal converge
  proof was hardened to model the real autoplay policy (block `play()` until a real DOM gesture) and now asserts
  **nothing plays on load** AND that a **SINGLE tap** plays it — a negative control (revert the sync → the
  single-tap check goes RED) proves the test has teeth (the earlier retry-until-playing loop had masked the bug).
- **Verified this round.** `bun test` **240/0**, selector lint pass, **testid-coverage GREEN**, **voice-bot pytest
  pass** (1 expected Pipecat skip). All **11 web E2E runners GREEN** + **5/5 RNW converge proofs GREEN** — the
  `reveal-rnw` converge now proves the spoken reveal end-to-end on the REAL screen (CONFIDENT → tap orb → real
  `/speech` → `data:audio/mpeg` src → `currentTime` advances) with a **negative control** (no TTS seam → 503, no
  fake audio). LIVE (creds present): `spikes/live-research.ts` → **5 grounded, source-cited facts** for the 1976
  Canon AE-1 ("first SLR with a digital IC", "~5.7M units", "Canon FD mount"); `spikes/live-speech.ts` →
  `LiveNarrationTts` → a valid 223 KB MP3 in the British voice.

## Environment reality (probed)
- ✅ Node 20, npm, **bun 1.3.11**, Python 3.12, gcloud SDK; npm + eve.dev reachable → can write/install/build code.
- ❌ **No full Xcode** (Command Line Tools only), no CocoaPods/watchman/simulator → **cannot build or run an
  iOS app or iOS-native E2E here.** iOS-native verification needs a Mac w/ Xcode or a device cloud.
- ✅ **Live GCP reachable via the gcloud CLI** (project `eighth-duality-354701`, no ADC / no SA key — a
  bearer from `gcloud auth print-access-token`). **Vertex Gemini 2.5-flash + Cloud Vision (WEB_DETECTION,
  SAFE_SEARCH_DETECTION) confirmed returning 200s** → the identification cascade runs live here (see "Live tier").
- ❌ Still no vendor keys for **Clerk / ElevenLabs / Deepgram** (subscriptions are StoreKit 2 DIRECT — no billing
  vendor — needing only an App Store Connect key for the LIVE store), and the **eve durable framework
  is not installable here** (G3 boots it against local Postgres, but the live Vertex-backed durable workflow +
  voice/podcast tiers remain cred/toolchain-gated).

## Verification boundary (what "verified" can mean where)
| Tier | Runs | Verifiable here? |
|---|---|---|
| Web/logic E2E (Playwright vs Expo web build + BFF test-mode + replayed tapes + seeded DB) | here / any CI | **Yes** |
| Backend unit/contract (eve tools, BFF, schema, validators) on a local Postgres | here | **Yes** |
| iOS-native E2E (Maestro/Appium: camera, push-to-talk voice, IAP, deep-link) | Mac w/ Xcode or device cloud | No (needs toolchain) |
| **Live identification cascade** (real Vertex Gemini + Cloud Vision → arbiter → BFF NDJSON) | here, via gcloud CLI | **Yes — PROVEN this round** (see "Live tier") |
| Live voice/podcast/auth (ElevenLabs/Deepgram/Clerk) + StoreKit 2 subscriptions (direct, no vendor) + eve durable self-host at scale | with vendor creds + framework | No (needs creds/toolchain) |

## Verified runs in this sandbox (no creds, no mocks-to-force-green) — re-audited 2026-06-30
True, reproduced results this round (every line below was actually executed, not inferred):
- **`bun test` → 173 pass / 0 fail** (17 files, 521 expect() calls): per-file —
  `packages/shared` catalog-logic 8, events 7, safety 20, **arbitration-honesty 6** (moderate-VLM contradiction
  hedges, whole-token corroboration, ungrounded-VLM never CONFIDENT — the adversarial-review regressions);
  `packages/db` catalog 4 (real PGlite SQL); `services/eve-agent` agent 28 + tools/identify 10 (real arbitration +
  real PGlite catalog) + **cascade 14** (the identify+narrate stream bridge: safety→identify→band→narration tokens,
  refusal branches, classifier-fault→hard_failure, narrator opt-in/skip, contract round-trip) + **live-safety 6**
  (SafeSearch→category mapping) + **live-vision 6** (parseYear rejects RANGES, agreement-based web confidence) +
  **live-narrator 9** (band-as-evidence: CONFIDENT may assert the model, PROBABLE/UNKNOWN forced to hedge;
  ungrounded/smuggled claims dropped by the REAL honesty gate); `services/voxi-api` app 10 (BFF integration: 401,
  signed-URL cross-tenant denial, session-ownership 403, scan cap, idempotent podcast 402, deletion, **StoreKit 2
  purchase verify + Apple webhook + anti-replay**) + core 16 + intake-pipeline 5 (CSAM→redact ordering, RT-2/4) +
  **appstore 10** (direct StoreKit 2 entitlement verification — the RevenueCat replacement);
  `services/voxi-podcast-worker` render 10 (honesty + defamation
  gate, idempotency, fail-closed); `e2e/framework` agent 4. No `.skip/.only/.todo` anywhere.
- **Web E2E — all runners GREEN** (real Chromium → real DOM testIDs → real `voxi-api` `createApp` BFF):
  `run-auth` (auth-01, id-03, sub-01) ·
  `run-coverage` (settings/`/me`, signOut, deleteAccount cascade, offline banner) ·
  the **agentic suite over the REAL screens** (`bun run e2e:web:agentic` — `agentic-auth`/`agentic-collection`/
  `reveal-agentic`/`agentic-sweep`, plus `agentic-explore-ab` running the same planners over the agent-browser
  backend as a `Driver`; the mock-shell `run-agent-pw`/`run-agent-collection`/`run-explore-mcp` were retired) ·
  `run-sc-auth-extra` (17 checks: auth-02 persisted session, auth-03 protected-route redirect + 401, proc-05 real network-drop reconnect via `?startIndex=`, owner-scoped) ·
  `run-sc-conversation` (conv-02/06 durable thread + owner-scoped replay) ·
  `run-sc-kb` (kb-03 TL-gate differential, kb-04 auto-hide) · `run-sc-podcast` (pod-01/03/04, cached replay no double-decrement) ·
  `run-sc-reveal-proc` (27/27: proc-04 long-wait, proc-06 failure+retry, reveal-05 real correction write) ·
  `run-sc-subs-a11y-safety` (a11y-03 transcript pairing, safety-refusal distinct surface) ·
  `run-sc-threads` (thread-02/03 durable session, cross-user revisit denied). `bun run lint:selectors` → passed.
- **`services/voice-bot` pytest → 17 pass / 0 fail / 0 skipped** (re-probed 2026-06-30: `pytest 9.1.1` +
  `pytest-asyncio 1.4.0` PRESENT, `configfile: pyproject.toml`, `asyncio: mode=Mode.AUTO` confirmed active →
  all 13 async tests RAN this round, 4 sync + 13 async = 17). Honesty caveat (F1) stands: in a sandbox WITHOUT
  `pytest-asyncio` the suite would be **4 pass / 13 SILENTLY SKIPPED / exit 0** because `asyncio_mode=auto`
  needs the plugin; the 13 async tests (metering hard-cutoff, persona voice consistency, transcript-writeback
  idempotency, cross-session denial, tool-bridge scoping) are the load-bearing ones. With the plugin (this env)
  the real pipeline logic genuinely passes. The one conditional `pytest.skip` (Pipecat-present honesty path) did
  NOT trigger — Pipecat is absent here, so that test ran its real `RuntimeError` assertion. See findings F1.
- **eve G3 boot spike (`services/eve-agent/g3-spike/boot.ts`) → C0 PASS, REPRODUCED** against a live local
  Postgres (`scripts/up.sh` initdb + real `@workflow/world-postgres` migrations): all 5 stages green
  (import eve off-Vercel, world start, session+ACL, real safety_gate+identify tools, durable NDJSON
  streamed-turn round-trip + `?startIndex=` resume). Fresh `runId` each run proves it is a real run, not a
  replayed artifact. Needs Postgres binaries (present) — NOT cred-gated; the live Vertex/GCP tier still is.
- **RNW convergence proofs — 4 runners, all GREEN** (`e2e/web/converge/{reveal,camera,conversation,threads}-rnw.web.ts`):
  each renders a REAL unmodified `app/app/*` Expo screen under react-native-web (esbuild bundle of the real
  component tree — real `ui.tsx`, real `Orb`, real `ApiClient` → real BFF, real Zustand store) in real Chromium
  via Playwright, driven by the SAME registry testIDs as the harness shell. Reproduced 2026-06-30:
  `reveal-rnw` (PROBABLE/id-03 chip + band + evidence auto-elevate + nav intent; header now reports **full
  parity, 0 divergence to close** — the earlier F4/F5 Title/Body-drop-`tid` + evidence-elevate divergences are
  resolved, only informational parity notes remain) · `camera-rnw` (real shutter → real BFF createThread →
  `/processing` nav; the shutter→nav assertion is bound to **real metering** — adversarially confirmed: with the
  seed entitlement set to 0 the real BFF 402s and the screen navigates to `/paywall`, so the assertion FAILS
  fail-closed, proving it is not stubbed-to-green) · `conversation-rnw` (real pipecat in-process stub session:
  orb settle, live-mic, push-to-talk, keyboard round-trip into the real transcript surface — assertion matches
  the REAL app stub reply in `app/src/lib/pipecat.ts`, not a harness constant) · `threads-rnw` (real empty state
  + populated grid of exactly 3 threads created on the real BFF via real `createThread`, then real owner-scoped
  `useQuery`/`listThreads`; the react-query converge shim calls the real `queryFn` — no faked data). All 4 are
  fail-closed (`process.exit(fails()===0?0:1)`, no unconditional exit-0/skip path).

## Live tier — PROVEN this round (real GCP via gcloud CLI, project eighth-duality-354701)
The identification cascade now runs **live, end-to-end, through the real BFF HTTP routes** — no mocks in the
identification path, auth/quota plumbing aside. Reproduced 2026-06-30:
- **`spikes/live-identify.ts` / `live-tool-scan.ts`** — the REAL `identify_object` tool + `LiveVisionProvider`
  (real Vertex Gemini 2.5-flash Stage-1 + Cloud Vision WEB_DETECTION Stage-2 → shared arbiter) on a live image →
  the reveal-shaped `{label, confidence_band, candidates, route, unsupported_fields}`. This is what exposed and
  then confirmed the fix to a **real arbitration bug**: Cloud Vision's noisy `bestGuess` ("omega speedtimer")
  was overriding the correct structured VLM ("Omega Speedmaster Professional 145.022"). Fixed in
  `arbitration.ts`: the web stage now **corroborates** the VLM (matched against the ranked `webEntities`, not the
  single headline label) and can never replace it; a genuine disagreement downgrades to PROBABLE and surfaces
  BOTH. The correct identity is always the structured VLM; the web is grounding only.
- **`spikes/accuracy-spike.ts` (H2, honest arbitrated scoring through the REAL tool)** — 12 labeled objects
  (Wikipedia lead images = clean, canonical shots = the OPTIMISTIC upper bound), across camera/watch/guitar/
  console/car/bike. Result (post-adversarial-fix run): **10/12 CONFIDENT & correct (safe to assert), 12/12 correct
  answer surfaced.** Every CONFIDENT is ENTITY-corroborated (the VLM identity AND Cloud Vision's reverse-image
  entities agree on make+model — two grounded signals). The hedges are HONEST, not misses — they return the
  CORRECT make+model at PROBABLE on a genuine web disagreement (e.g. the Casio F-91W's bestGuess "terrorist watch",
  or a sub-trim the entities don't confirm), never a false confident assertion. WHICH items hedge varies per run
  (Cloud Vision entities are non-deterministic); the honesty is invariant. The adversarial-fix hardening cost ZERO
  accuracy — same 10/12 as before, now honestly grounded instead of resting on a raw entity score. Caveat recorded
  in the spike output: **real phone photos are the true test** (drop them in `.gcp/spike-images/` + `labels.csv`);
  per-vertical band calibration is deferred to real-data H2 (§16/§22.4), not tuned on clean images.
- **`spikes/live-bff-scan.ts` — the full app path (IDENTIFY + NARRATE), LIVE.** A real photo → real `voxi-api`
  `createApp` routes (`POST /v1/threads` charges a scan + mints the eve session; `GET /v1/threads/:id/stream`
  streams NDJSON) backed by a production-shaped `CascadeEveClient` running the REAL `runIdentificationCascade`
  (LiveSafetyClassifier + LiveVisionProvider + **LiveNarrator** → live Cloud Vision + Gemini → arbiter + honesty
  gate → the `events.ts` contract). Verified end-to-end: Canon AE-1 → `confidence_band CONFIDENT "1976 Canon AE-1
  (…)"` → **four honesty-gated persona `token`s in Voxi's dry British voice** ("…a commemorative edition, presumably
  for those who enjoyed the Games, or perhaps just cameras.") → `done`; monotonic indices, **every line re-parsed
  through the client's real `parseEventLine`** (the bridge can never emit an off-contract event). Load errors (dead
  URL) are a typed `hard_failure` (retryable), NOT a safety refusal — the image is fetched once, reused everywhere.
- **`services/eve-agent/agent/providers/live-narrator.ts` — the persona narration ("what it is / its use"), LIVE
  and honesty-gated.** A Vertex Gemini TEXT call (same gcloud-CLI auth — NO new creds; ElevenLabs is only the later
  VOICE/TTS layer) that emits CLAIM-STRUCTURED clauses, each validated by the REAL shared `validateClaims` gate
  before a word reaches the user. The load-bearing wiring: the arbiter's BAND becomes evidence — on CONFIDENT the
  confirmed identity is a citable ref so the persona MAY assert the model; on PROBABLE/UNKNOWN that ref is absent so
  any model-asserting clause is DROPPED (the persona is mechanically forced to hedge, §8.3). Falsifiable claims
  without a valid web-evidence ref are dropped; a `flavor` clause smuggling a year/spec is caught by the auditor.
  This is the DESCRIPTION path (render approved-only), never "narrate anyway". HONESTY note: without an entailment
  judge the gate checks ref-EXISTENCE + the flavor auditor (not full NLI entailment); a Gemini-as-judge upgrade
  (cred-free) is the next rigor step, and richer narration scales with grounded research evidence (a further step).
- **Deterministic no-creds coverage of the new bridge** (runs in `bun test`, no GCP): `cascade.test.ts` (10 tests:
  monotonic-index + terminal-done invariant, CONFIDENT reveal, PROBABLE-surfaces-both, UNKNOWN interview,
  pills/nsfw refusal terminate BEFORE identification with **no label leak**, weapon category-name-only, dead-URL
  hard_failure, identify-throw hard_failure — every emitted event round-tripped through the real Zod contract);
  `providers/live-safety.test.ts` (6 tests: SafeSearch→category mapping, highest-severity-wins, medical
  false-positive bias, safe floor).
- **Adversarial review round (2026-06-30) — 7 real findings, all FIXED + regression-tested.** A background
  multi-agent workflow (4 dimensions: arbitration honesty, cascade contract/safety, live-provider fail-closed,
  no-cheating test audit) with an independent skeptic verifying each finding returned **10 findings, 7 confirmed
  real, 3 refuted** (the 3 refuted were over-claims the verifier correctly rejected). All 7 fixed:
  (1) HIGH — a MODERATE (0.5–0.69) VLM that contradicted a verified web label was silently discarded so the noisy
  web label reached CONFIDENT (the Omega bug's sibling); the disagreement hedge was gated on `strongVlm≥0.7`. Fixed:
  any CONCRETE contradicting VLM now forces PROBABLE + both, at any confidence.
  (2) HIGH — web `confidence` was a raw, unbounded Cloud Vision entity relevance score capped at 1, so
  `webVerified` meant "an image matched", not "confident in the label". Fixed: `webConfidence()` now scores
  bestGuess↔entity AGREEMENT (0..1).
  (3) HIGH — `corroborates()` substring-matched the primary model token ("fm" ⊂ "fm2" wrongly confirmed a
  different model). Fixed: WHOLE-TOKEN matching + short-token (≤2 char) requires the full model.
  (4) HIGH — safety fail-*OPEN*: Cloud Vision's batch endpoint returns HTTP 200 with a per-image
  `responses[0].error` and NO annotation, which mapped to all-UNKNOWN → 'safe'. Fixed: `visionSafeSearch` throws on
  a per-image error/absent annotation → `safety_gate` fail-closes (suppress).
  (5) MEDIUM — a transient classifier fault (Vision outage) surfaced to the user as a content refusal ("not
  something I'm willing to look at"). Fixed: `safety_gate` flags `fault`; the cascade maps it to a retryable
  `hard_failure`, still fail-closed on identification.
  (6) MEDIUM — `parseYear` extracted the FIRST year of a range ("1998-2004"→1998) and asserted make_model_year.
  Fixed: a year is asserted ONLY from a single unambiguous token; ranges stay unsupported.
  (7) MEDIUM — the accuracy spike's per-token substring scoring let a wrong label ("Nikon FM2") score as a
  correct "Nikon F" (single-letter 'f' matches everywhere). Fixed: WHOLE-TOKEN scoring — the honest metric.
- **HONESTY caveat**: this bridge proves the IDENTIFICATION half of the workflow live. The witty storyteller
  narration + two-voice podcast + voice conversation are the LLM/ElevenLabs/Deepgram tiers and remain cred-gated;
  the cascade streams the `confidence_band` reveal, and narration layers `token` events on the same contract.

## Re-audit verdict (2026-06-30, re-run pass)
The runnable-here layer (shared logic, BFF, DB, podcast worker, voice-bot pipeline, eve G3 boot, web E2E,
agentic E2E, 4 RNW convergence proofs) is genuinely real and green — real code, injected deterministic fakes
with real assertions, no stub forced green, no agentic step deciding pass/fail. This round's full re-run is
reproduced: **118/0 unit, 11/11 web runners GREEN, 4/4 RNW converge GREEN, lint passes (now WITH registry
membership enforced), voice-bot 17/17 (0 skipped, plugin present)**. The 3 new artifacts (`camera-/conversation-
/threads-rnw`) were adversarially spot-checked: they mount the REAL unmodified `app/app/*` screens, assert
against real BFF/UI state and the real app's own copy/stub output, locate only by registry `ids.*`, and are
fail-closed — a negative-control mutation (seed entitlement → 0) was confirmed to turn the camera shutter
assertion RED (real 402 → `/paywall`), proving it is not stubbed-to-green. The earlier app/ divergences (F4/F5)
are now RESOLVED — `reveal-rnw` reports full parity. Remaining gaps are honesty-of-harness/doc-accuracy only:
(a) voice-bot silent-skip without `pytest-asyncio` (F1, env-conditional — passes here); (b) the **selector lint
does NOT govern the `e2e/web/converge/*` runners** (`isGoverned` matches `run-*.web.ts`/`*.scenario.ts`/Maestro
flows, not `*-rnw.web.ts`), so the converge runners are unguarded by the lint — though inspected directly they
contain only registry-bound `[data-testid="${ids.*}"]` locators and no raw selectors. None are a vendor stubbed
to force green or a hardcoded-state assertion in place of real UI/BFF/DB state.

## Component status
| Component | Status | Notes |
|---|---|---|
| Repo + monorepo scaffold | ✅ real | dirs, README, root workspace |
| `docs/PLAN.md`, `design-notes.md`, `TEST-PLAN.md` | ✅ real | plan v2.1; full test matrix |
| E2E framework (`e2e/`) | ✅ **real + runs green here** | testid registry, Driver/Scenario model, **PlaywrightDriver (deterministic web)**, **Agent planner (agentic)**, vendor record/replay, selector lint, Maestro flow. Two end-to-end runs GREEN in this sandbox against the real BFF (below). |
| agent-browser (agentic web backend) | ✅ **real + runs green here** | v0.31.1. Now wrapped as a `Driver` (`e2e/framework/drivers/agent-browser-driver.ts`) so the SAME `Agent`+`Planner` that drive the Playwright agentic runners drive it too, against the **REAL screens** — `e2e/web/converge/agentic-explore-ab.web.ts` signs in + captures a PROBABLE reveal by perception, GREEN. The app bundle is served from a **separate process** (`e2e/web/converge/app-harness-server.ts`) because agent-browser's detached daemon **inherits the spawning process's open fds**: an in-process `Bun.serve` *listening socket* would be inherited + held, blocking the launch handshake (redirecting stdout didn't help — the socket, not stdout, was the held fd). Pre-start the daemon once via `open`; hard per-command timeout (fail-closed, never hang); `--json` reads. If the CLI/Chrome is unavailable the runner **SKIPS cleanly (exit 0)**; the Playwright agentic runners remain the CI-portable path. |
| `packages/shared` (confidence gate, arbitration) | ✅ **real + tested** | `confidence.ts` (claim-structured honesty gate + auditor + entailment), `arbitration.ts` (cascade). Zod/NDJSON event schemas next. |
| `services/voxi-api` (BFF) | ✅ **real + tested + E2E** | `app.ts` Hono routes (auth/sign/threads/stream/podcast/interview/tips/reports/me/account), `metering.ts`, `visibility.ts`, `signing.ts`, `intake-pipeline.ts`. Driven by the real web E2E AND 27 unit/integration tests. `testVerifier` fail-closes unless `VOXI_TEST_MODE=1`; real `clerkVerifier` seam. |
| `packages/db` (Postgres+pgvector migrations) | ✅ **real + tested** | `catalog.ts` runs real SQL on in-process PGlite; 4 tests + drives identify/agent tests (ACL + cosine ranking). |
| `services/eve-agent` | ✅ **G3 C0 PROVEN here** | boot.ts boots eve off-Vercel on real local Postgres `@workflow/world-postgres`; agent config + ACL + tools tested (38 tests). Live Vertex/Secret-Manager tier still cred-gated. |
| `services/voxi-podcast-worker` | ✅ **real + tested** | `render.ts` honesty + defamation gate, idempotency, compare-and-set lease, fail-closed (10 tests). ffmpeg/TTS live tier needs creds. |
| `services/voice-bot` (Pipecat, Python) | ✅ **real + tested (plugin-gated)** | `pipeline.py` real cascade (persona-once, barge-in discard, voice-consistency gate, metering cutoff, idempotent writeback). 17 tests pass **with `pytest-asyncio` installed**; without it 13 silently skip (F1). Pipecat/aiortc live extras cred-gated. |
| `app/` (Expo RN) | 🟡 **real + web-renderable; 4 screens converge-proven, F4/F5 resolved** | full screen set; testIDs from the shared registry via `tid()`. RNW convergence proofs now render 4 real screens (`reveal`, `camera`, `conversation`, `threads`) against the real BFF — all GREEN; `reveal-rnw` reports full parity (earlier F4 Title/Body-drop-tid + F5 evidence-auto-elevate divergences resolved). iOS-native needs Xcode. No TypeScript installed → `tsc -b` cannot run here (F6). |
| `infra/` (GCP) | ✅ **validated** (fmt + init + `terraform validate` SUCCESS) | 14 `.tf` files (Cloud Run front/BFF/worker + non-serverless eve-poller split, Cloud SQL/AlloyDB + pgvector, Cloud Tasks, GCS/CDN, Secret Manager, IAM). `terraform validate` → **Success** on Terraform v1.15.6 (providers + modules resolve, refs consistent); `fmt` clean; `.terraform.lock.hcl` pinned. `plan`/`apply` are the deploy step — gated on you (GCS state bucket + billing). |

## What is now LIVE-proven cred-free (gcloud CLI only) vs still needs you
**Proven live this round (no new creds):** the CORE LOOP — photo → specific make/model identification → honesty-
gated persona narration — runs end-to-end through the real BFF routes + real cascade + real Vertex Gemini + Cloud
Vision. This is the heart of the product.

**Clerk auth — ✅ LIVE + VERIFIED (2026-06-30).** Automated end-to-end via the official `clerk` CLI (v1.5.0):
`clerk apps create "Voxi"` → `clerk link` → `clerk env pull` wrote the keys to `.env.local`, and the JWKS-derived
SPKI public key is set as `CLERK_JWT_KEY` for networkless verify. Proven live by `spikes/verify-clerk-live.ts`: a
REAL Clerk-issued session token (minted via the Backend API for a test user) verifies through `@clerk/backend`,
through our `channels/eve.ts` `clerkVerifier` (networkless PEM → correct `userId`), AND through the REAL BFF
`createApp` with the real `auth.ts` `clerkVerifier` — `GET /v1/me` → 200 + correct user; malformed/missing tokens
→ null/401 (fail-closed). App id `app_3FsowBMR6ebn3qzvsHzm4uksnUQ`, dev instance `resolved-dove-95`. `@clerk/backend`
declared at the repo root. The ONLY manual step was the browser OAuth login (`clerk auth login`).

**Voice (ElevenLabs TTS + Deepgram STT) — ✅ LIVE + VERIFIED (2026-06-30).** Keys in `.env.local`. Voxi's voice is
ElevenLabs **"George"** (British, mature, dry storyteller — `JBFqnCBsd6RMkjVDRZzb`). Proven live:
`spikes/live-tts.ts` synthesizes the REAL honesty-gated narration to a valid 311 KB MP3; `spikes/live-voice-
roundtrip.ts` closes the loop — narration TEXT → ElevenLabs → MP3 → Deepgram STT (confidence **1.000**) → recovers
the identity (canon/1976/35/reflex/camera).
- **Two-voice PODCAST render — LIVE** (`spikes/live-podcast.ts`): the REAL `renderPodcast` pipeline end-to-end —
  closed grounded facts → Gemini writes a claim-structured ARLO/MAVE script → the REAL honesty + defamation gates
  → live ElevenLabs multi-voice TTS (George + Alice) → a real **52s / 814 KB MP3 episode**. `ElevenLabsTts`
  (`services/voxi-podcast-worker/src/live-tts.ts`) implements the `TtsProvider` seam (per-speaker voice, ID3-strip
  MP3 concat); `mergeTurns` + `stripId3` unit-tested (4 tests). ffmpeg loudnorm/HLS segmentation is the one prod
  step not runnable here (ffmpeg absent) — the synthesis is proven.
- **Realtime conversation TURN — LIVE** (`spikes/live-voice-turn.ts`): the full loop the Pipecat pipeline
  orchestrates — user AUDIO → Deepgram STT → Gemini (Voxi persona, grounded, honesty-constrained) → ElevenLabs
  TTS → reply AUDIO, re-transcribed to confirm the answer is grounded (mentions 1976). The conversation LOGIC is
  covered by the Python voice-bot suite (**17/17**: persona-once, honesty, metering cutoff, transcript writeback);
  the only unexercised piece is the Pipecat/aiortc **WebRTC transport** (needs the live extras + a client).

**Still needs YOU (creds / hardware) — each unlocks a specific remaining slice:**
3. **~~RevenueCat~~ REMOVED** — subscriptions are now **StoreKit 2 DIRECT, no billing vendor**: device `expo-iap`
   + server-side App Store Server API/Notifications V2 verification (`services/voxi-api/src/appstore.ts`, wired at
   `/v1/purchases/verify` + `/appstore/notifications`). Live App Store validation needs only an **App
   Store Connect API key** (issuer id + key id + .p8), and that comes with the Apple Developer / iOS setup — JWS
   verification itself uses Apple's public root certs (no vendor, no shared secret). 14 new tests (appstore 10 +
   BFF route 4): product→plan, revoke/refund/expiry→free, anti-replay (a transaction stamped for another user is
   rejected), the Apple webhook needs no Clerk auth, unverifiable → fail-closed. Device: `expo-iap` behind a Metro
   platform-split so the web/converge bundle never imports it (camera converge proof re-run GREEN).
4. **A provisioned GCP project via `infra/` Terraform** (Cloud Run, Cloud SQL/AlloyDB, Cloud Tasks, GCS/CDN,
   Secret Manager) → a real deploy. Put secrets in `.env.local` (gitignored) — do NOT paste them in chat.
5. **A Mac with Xcode** (or a device cloud) → iOS-native E2E (camera, push-to-talk, IAP, deep-link).

**Cred-free next steps I can still take (refinements, lower value than unlocking voice/auth above):** a
Gemini-as-entailment-judge for the narrator (closes the ref-existence-vs-entailment gap), a grounded-research step
for richer narration evidence, and the live two-voice podcast SCRIPT via Gemini (audio still needs ElevenLabs).
