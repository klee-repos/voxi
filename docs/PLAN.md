# Voxi — Master Implementation Plan (v2, post-review)

**A real-world Pokédex / "the Guide".** Photograph any human-made object → Voxi (a dry, witty,
omniscient *British* narrator) identifies it *as specifically as possible* ("2008 Cannondale SuperSix
EVO", never "bike"), tells you what it is and what it's for, can spin a ~5-minute two-voice podcast
about its history, and keeps talking with you about it — voice-first, keyboard optional. Every photo is
a persistent thread. Every identification grows a crowd-sourced catalog of *specific* objects.

> **Status: planning, v2.** Revised after a 10-voice review (CEO×2, design×2, eng×2, DX, adversarial
> technical/business/safety-legal) + auto-decisions. Companion: `design-notes.md`. Decision audit trail: §21.
>
> **Scope rule (from the brief): build everything — no features are cut.** The build sequence (§20) is a
> *dependency order* with **validation gates that run first but cut nothing**. The review panel argued
> strongly for a vertical-first *phased launch*; that direction is preserved on the record in §21 and its
> de-risking is absorbed as gates and a seed-vertical launch focus, but per the explicit "build everything"
> directive nothing is removed from scope. iOS first; Android is a fast-follow on the same codebase.
>
> **Brand/IP note:** user-facing and marketing copy say **"the Guide" / "Voxi"**, never "Hitchhiker's
> Guide." The persona is *inspired-by*, must stand on its own with every Douglas-Adams reference deleted,
> and ships only after IP + voice-rights clearance by counsel (gate G5, §18).

---

## 0. Core hypotheses, kill-metrics & validation gates

The product rests on four bets. Each gets a falsifiable hypothesis, a metric, and a pre-committed kill
threshold. These **gates run first and in parallel with foundations** (§20.1); they reshape *positioning
and emphasis*, not scope.

| # | Bet | Hypothesis | Metric | Kill / pivot threshold |
|---|---|---|---|---|
| H1 **Demand/Retention** | People photograph objects *repeatedly* for the persona/podcast, not once | In a seed vertical, **≥30% (pass) of new users scan ≥3 distinct objects and return in week 2 unprompted** (benchmark vs Vivino/Merlin W2) | W2 repeat-scan rate | **<15% = kill** (loop isn't a habit; add a retention mechanic §1 or narrow further); 15–30% = iterate before scaling |
| H2 **Accuracy** | Gemini 3 + grounding + catalog hits exact make/model/year often enough to feel magic *in the seed vertical* | exact make/model(/year) hit-rate on a curated seed-vertical held-out set | <~80% exact-model in-vertical → reposition from "specificity guaranteed" to "the Guide's *experience*"; lean on interview-as-feature |
| H3 **eve durability** | eve self-hosts durably on GCP off its golden path | session resume survives instance kill; multi-poller correctness | resume fails / multi-instance unsafe → fall back to own durable-session layer over Postgres + queue (§4.5) |
| H4 **Podcast demand** | Users actually consume the 5-min two-voice podcast | completion rate + unprompted repeat requests in the concierge test | <50% completion / rare repeat → demote podcast from pillar to flourish (still built; de-emphasized in onboarding) |

**Cheap validation before heavy build (gate G1, runs alongside §20.1):** a 2-week concierge / Wizard-of-Oz
in ONE enthusiast vertical (bikes or cameras/watches): 100–200 recruited users, photos answered by Gemini
+ a hand-written British paragraph + a handful of hand-made podcasts. Instrument H1/H2/H4. Cost ≈ days +
~$1–2k. This does not delay building the architecture; it *informs which promise we market* and de-risks
the panel's #1 concern without cutting scope. Pre-commit the thresholds above.

---

## 1. Product summary & first principles

- **One screen that matters after login:** the camera. Open straight to a viewfinder. Everything flows
  from a single captured photo.
- **The delight is the persona + the collection, not the ID call.** Raw "what is this" is commoditizing
  toward free (Google Lens, Apple Visual Intelligence ships it in iOS 26 today). Voxi's defensible value =
  *specificity-in-a-vertical* + *personality* + *serial-podcast storytelling* + a *crowd/curated catalog of
  specific objects* + a *collection you build*.
- **Retention mechanic (built in, not decoration):** the catalog is a **Pokédex you fill** — collection /
  rarity / "uncatalogued objects near you" pressure, plus a lightweight **catalog-as-content** surface
  (browse/share specific entries and community podcasts). This is the answer to "why open it again," and
  H1 measures whether it works.
- **Honesty is a feature, enforced by the pipeline, made charming by the persona** (§8.3).
- **The catalog is the flywheel and the cost engine** — but it's empty at launch, so we **pre-seed one
  vertical with curated data** (§19) rather than waiting on the crowd (§7, §13).
- **Foundational, not fragile.** Subscription/entitlement/metering, visibility, moderation, deletion, and
  redaction plumbing all ship in v1.

---

## 2. Differentiation, honest competitive teardown & wedge

| Pillar | Who already does part of it (June 2026) | Honest status |
|---|---|---|
| Specific make/model/year ID | Google Lens (brand+buy link); Apple VI on-device for art/books/landmarks/plants, routes the rest to ChatGPT/Google | **Not a moat** — platforms match/beat the commodity layer; we win only *in a curated vertical* where density makes us more specific |
| Persona + per-object voice chat | Herodot AI ships photo→AI-audio-story with selectable personas incl. a "witty Local Buddy"; scoped to landmarks | **Copyable in a sprint** — Herodot→objects is a prompt change; not the moat |
| 5-min two-voice podcast | Google NotebookLM ships on-demand two-voice Audio Overviews | **Copyable** — a format, not a moat |
| Crowd/curated catalog of *specific* objects + a retained community | Vivino (wine), Merlin (birds) — single verticals w/ passionate experts + natural data + SEO traffic | **The actual wedge** — but only if we pick a vertical, seed it to density, and earn SEO/community distribution |

**The wedge, stated honestly:** not "Shazam for all human-made objects" (that's the horizontal space
Apple/Google own). It is **a beloved character + a deep, curated, community-owned catalog + an indexable
web surface in ONE enthusiast vertical**, expanding outward only after that flywheel turns. *"What do we do
the week Apple ships a narrator voice?"* — we have a vertical community, proprietary curated data, and an
ongoing job (catalog/value/log your collection) that a horizontal OS feature won't build for a niche.
**Why now:** specific-model VLM ID, cheap two-voice TTS, and natural realtime voice all crossed the
cost/quality line in 2025–26 — but so can competitors, which is exactly why the moat must be data +
community, not tech. (CEO-6, B3, B4, B9, B10.)

---

## 3. System architecture (overview)

```
┌────────────────────────────┐         ┌────────────────────────────────────────────────────┐
│  iOS app (Expo / RN)       │  HTTPS  │  Google Cloud (one project, one region)            │
│  Camera · Orb · Audio(HLS) │ ──────▶ │  Cloud Run: voxi-api  (thin BFF, ONLY public)      │
│  Realtime(Pipecat/WebRTC)  │ ◀─SSE── │     verify Clerk JWT · sign short-TTL user-bound URL│
│  Auth (Clerk Expo SDK)     │         │     enforce entitlements/metering · per-user ACL    │
└─────────┬──────────────────┘         │            │ proxy session create/stream            │
          │ WebRTC (SmallWebRTC P2P)    │            ▼                                        │
  ┌────────▼─────────┐                 │  eve durable agent  ── runs as TWO parts ──┐        │
  │ Pipecat bot      │  scoped token   │   (A) HTTP channel  → Cloud Run (stateless front)   │
  │ (Cloud Run, Py): │ ──────────────▶ │   (B) workflow POLLER → Cloud Run **Worker Pool** / │
  │ STT→LLM→11Labs   │  per-session    │        single GCE/GKE pod (NON-serverless; see §4)  │
  └──────────────────┘                 │            │                                        │
                                       │            ▼                                        │
                                       │  Cloud SQL Postgres(+pgvector) ▶ AlloyDB(ScaNN) on  │
                                       │   a measured trigger · eve workflow.* + app.*       │
                                       │  Cloud Tasks ▶ voxi-podcast-worker (ffmpeg+TTS)     │
                                       │  GCS (photos[redacted], audio/HLS) ▶ Cloud CDN      │
                                       │  Clerk (auth, JWKS verify) · Secret Mgr · Vertex AI │
                                       │  Cloud Vision (web detection, SafeSearch) ·         │
                                       │  PhotoDNA/CSAI hash-match · face/plate redactor     │
                                       └────────────────────────────────────────────────────┘
```

`voxi-api` is the **only public surface**. The eve **request front** is stateless on Cloud Run; the eve
**workflow poller** runs on a **non-serverless runtime** (see §4.4 — this is the corrected topology). The
**Pipecat voice bot** (a Python Cloud Run service) reaches eve only via a **BFF-minted per-session scoped
token** (no broad creds). Auth is **Clerk** — its JWTs verify statelessly (networkless JWKS) in the BFF/eve,
so all data + compute stay on GCP while the identity control plane is Clerk's SaaS (see §12).

---

## 4. The eve backend

**One root eve agent** ("Voxi"), filesystem-first. eve = Vercel's open-source durable-agent framework
(**public beta, pre-GA**; the workflow line is beta — pin exactly, expect churn). (DX-2, eng-F2.)

### 4.1 Why eve maps cleanly
1 photo = 1 durable session = 1 thread (persist `{eveSessionId, continuationToken}` on our `threads` row;
revisit = continue). Identification = a TOOL (app runtime, not sandbox). Catalog/RAG = TOOLS over our own
Postgres+pgvector. Podcast script = a SUBAGENT (`storyteller`, task mode, `outputSchema`); rendering is
offloaded to the async worker. Interview / add-a-tip = SKILLS. Conversation = the durable session loop;
live voice = a sidecar that shares thread state (§6.3).

### 4.2 Project layout (`/agent`) — unchanged in spirit; see §4.6 for the tool I/O schemas
`agent.ts` (brain default `anthropic("claude-sonnet-4-6")`; compaction on; workflow world = postgres),
`channels/eve.ts` (custom AuthFn verifying the **Clerk** session JWT networkless via `@clerk/backend`
`verifyToken` + JWKS, + per-user session-ownership ACL), `sandbox.ts`
(`justbash()`), `lib/db.ts`, `skills/{voice.md, interview-unknown-item/, contribute-tip.md}`,
`tools/{identify_object, web_ground_image, catalog_search, catalog_upsert, embed_image, safety_classify,
redact_pii, enqueue_podcast}.ts`, `subagents/{storyteller/, interviewer/}`, `schedules/{dedup, promote}.ts`,
`instrumentation.ts`.

### 4.3 BFF↔eve API contract (DX-6 — a real spec, not three bullets)
A dedicated `docs/api-contract.md` defines: typed request/response bodies; the **full NDJSON stream event
enum** (`token | tool_start | tool_result | confidence_band | partial_id | error | done`) with payload
shapes; the error envelope + HTTP status mapping; the `sessionId ↔ continuationToken ↔ threads.eve_session_id`
mapping; **`?startIndex=` reconnection → event-index semantics**; how the photo signed-URL file-part is
structured; idempotency/retry keys per turn. The **Pipecat-bot→eve bridge** (which tools are exposed, MCP-vs-HTTP,
the per-session scoped-token auth) is specified in the same doc.

### 4.4 Hosting — corrected topology (eng-F1/F4/F10/F12, DX-1/2, adversarial-tech) **[GATE G3]**
The Postgres workflow world's own docs state it **does not run on serverless** — it needs a long-lived
poller + LISTEN/NOTIFY. Cloud Run is serverless/autoscaling, so `min-instances=1` is **necessary but not
sufficient** (no instance pinning; N>1 instances each poll). **Decision: split the deployment.**
- **eve request front** → Cloud Run, stateless, autoscaled (serves the HTTP channel/streaming).
- **eve workflow poller** → a **non-serverless runtime**: Cloud Run **Worker Pool** (manual scaling) or a
  single GCE VM / single GKE pod (managed instance group size-pinned). Confirm `@workflow/world-postgres`
  supports **multiple concurrent pollers via SELECT … FOR UPDATE SKIP LOCKED**; if yes, run ≥2 with
  documented lease semantics; if genuinely single-poller, document the failover + throughput ceiling.
- **Self-callback gotcha (corrected):** graphile-worker advances runs by HTTP-calling the app's *own*
  `/.well-known/workflow/v1/flow`, which has a ~60s route ceiling. So: (a) ingress forwards `/eve/*` **and**
  `/.well-known/workflow/*`; (b) the service must reach its own base URL; (c) **design turns to checkpoint
  frequently** rather than run one long opaque step (a single long synchronous identify+ground+narrate step
  would breach the ~60s ceiling — offload genuinely-long work like the podcast render to the async Cloud
  Tasks worker per §6.2/D7 and keep eve steps short).
- **D1 is demoted from "documented path" to "spike-gated & contested."** Gate G3 (§18) is a hard go/no-go
  *before* any backend feature work in §20.

### 4.5 eve risk controls (eng-F2, DX-5)
- **Thin adapter** wraps `@workflow/*` so an API break is contained to one module.
- **Version compatibility matrix** (eve + bundled `@workflow/*` + `@workflow/world-postgres`), a **CI smoke
  test** ("session resume after restart") on every bump, a renovate/changelog watch + manual upgrade gate,
  and a **documented rollback** (snapshot Cloud SQL before any world-schema migration).
- **Pre-committed fallback** if G3 fails: our own durable-session layer over Postgres + a queue +
  continuation tokens. **Cost honesty (see §22.3):** this reuses the thread row but **abandons the eve
  agent-framework model** and re-implements durable checkpointing/leasing — **~30–50% reuse, not a cheap
  drop-in** — with a "re-architect the agent layer" line item.

### 4.6 Agent-facing tool I/O schemas (DX-8) — typed enums the model/validator switch on
`identify_object`→`{label, granularity_level, confidence_band, evidence[], unsupported_fields[]}` (§8.3);
`catalog_search(filters)→ranked {entryId, name, cosine, visibility}[]`; `catalog_upsert(entry+embedding+
moderation_flag)→{id,status}`; `embed_image(uri)→vector(1408)`; `safety_classify(image)→{category enum,
action enum, confidence}` (§8.4); `redact_pii(image)→{redacted_uri, regions[]}`. Untrusted text (OCR, web
facts, UGC) is passed as **delimited, non-authoritative data, never instructions** (eng-F7 voice1).

---

## 5. Identification pipeline (the hard part)

4-stage cascade, GCP-native; Stages 1 & 3 run in parallel; catalog hit short-circuits the web stage.

1. **VLM hypothesis:** Gemini 3 Flash (Vertex) forced JSON `responseSchema` + "agentic vision," escalate
   to Gemini 3 Pro on hard items. **Cap agentic-vision iterations + hard wall-clock budget** on the sync
   path; on exceed, return best partial as PROBABLE (eng-F11).
2. **Web grounding:** Cloud Vision Web Detection → Gemini reconciliation; Gemini Search grounding for the
   thin ~15%; SerpApi Lens long-tail fallback (pluggable). Escalation/grounding **trigger criteria are
   explicit** so they don't fire on every frame (eng-F11).
3. **Catalog match:** Vertex multimodalembedding@001 → filtered pgvector ANN. **Gate embedding** behind the
   on-device quality pre-check + a near-dup check vs the thread's own prior frames; cap exemplar density per
   item (eng-F9). Run **before** the web stage so a hit avoids paid grounding.
4. **Confidence routing + arbitration (eng-F3):** per-category-calibrated thresholds set by the H2 spike
   (not global constants). **Arbitration rule:** catalog hit ≥0.92 with model-string agreement
   short-circuits; else web verification is tiebreaker; on **high-confidence disagreement** (catalog says X,
   web says Y) → downgrade to PROBABLE and surface both candidates in "How sure are you?" as a user choice
   (a labeling signal). No stage clears its band → interview with the partial ("I can narrow it to 2007–2009").

**Accuracy reality:** ~55–75% exact make/model/year first-pass on mainstream goods, lower on vintage. H2
gates whether we market "specificity" or "the experience," **per seed vertical**. Multi-photo capture
("show me the badge") and graceful partials are first-class, not edge cases. **Never surface Stage-1 output
unverified.**

---

## 6. Voice & audio

### 6.1 Voxi's narrator voice — ONE consistent voice
**ElevenLabs** is the brand voice (a single signature dry-British `voice_id`, owned/cleared per G5):
**v3** for the pre-rendered description, **Flash v2.5** (streaming) for live chat — same `voice_id` (verified
to carry across v3/Flash). The §18 voice-consistency A/B is a **gate** before committing the cascade; the
Gemini-Live cost-alt accepts a *different* timbre, so it is a *fallback*, not a co-equal — the "one voice"
claim is honored by the ElevenLabs path (eng-F11, D6).

### 6.2 The 5-minute two-voice podcast (`storyteller` subagent + `voxi-podcast-worker`)
Two hosts distinct from Voxi: **Arlo** (enthusiast) & **Mave** (skeptic/fact-checker, embodies the honesty
policy). Pipeline:
1. **Grounded research:** Gemini 3 Flash + Search → a *closed* `facts[]` array `{claim, sourceUrl, confidence}`.
2. **Script:** Claude Sonnet 4.6 → **claim-structured output** (§8.3): each clause carries
   `{text, claim_type, evidence_ref|null}`; a validator **hard-rejects** any `spec|provenance|date|causal|
   superlative|comparative` clause with no evidence ref, and checks **claim↔fact entailment** (cheap NLI/judge),
   not mere citation presence. **Fail-closed:** if repair still leaves an uncited/unsupported claim, drop the
   segment or fail the episode in-persona ("I couldn't verify enough to tell this properly") — **never ship
   unvalidated audio to cache** (eng-F7, RT-1, RT-9). A **defamation filter** routes negative claims about an
   identifiable entity to human review/drop, and requires ≥2 independent sources (RT-9).
3. **TTS — ONE call for consistency (reverses old D5; eng-F1):** render the full ~750-word two-speaker
   script in a **single Gemini multi-speaker call** (well within input / 655s output limits), guaranteeing
   timbre consistency. **Honest consequence (resolves the progressive contradiction):** a single call returns
   only when the whole episode is synthesized, so there is **no true "segment 1 in seconds"** — we own a
   **15–40s "composing your episode" wait** in the player/processing UX (§10.2.7) and then split the finished
   audio **locally by timestamp into HLS chunks** (this is progressive *download*, not progressive
   *generation*). An **optional "fast-start" mode** (behind a flag, used only if the spike shows the wait is
   unacceptable) renders **exactly 2 calls** (beats 1–2 then 3–8) with a **shared speaker-conditioning
   seed/reference** across both calls, a **concrete timbre-similarity threshold**, and a **fail action
   (re-render as a single call)** — never 8 independent calls. ElevenLabs v3 Text-to-Dialogue is the premium
   swap behind `TtsProvider`.
4. **Assemble:** ffmpeg in the worker (loudnorm, royalty-free sting, ducked bed, crossfades).
5. **Deliver (HLS):** after the single-call render, write the locally-split chunks + the finished
   `playlist.m3u8` (VOD) to GCS; client `react-native-track-player` (native HLS) streams progressively *as a
   download*. (Only the optional 2-call fast-start mode produces an early first chunk.) The "atomic playlist
   swap" of the idempotency design (below) matches this: the finished playlist is published in one swap.
6. **Cache + regen:** GCS keyed by **catalog item id + content version**; first viewer pays, others stream
   ~$0. **Fast cache-invalidation** so a flagged episode is pulled immediately; a "report this episode" control.

**Worker idempotency (eng-F8):** idempotency key per `(catalog_item_id, version)`; `podcast_assets.status`
compare-and-set so one worker proceeds; versioned segment paths + atomic playlist swap; push deduped on
status transition. **Latency honesty:** cold-path first-segment is realistically 15–40s, not 3–5s — the
processing UX (§10) covers the real distribution, not a warm-path best case (adversarial-tech).

### 6.3 Realtime conversation (voice-default, keyboard optional) — **Pipecat (chosen over LiveKit)**
eve is wrong for a sub-second loop → a **separate stateless Pipecat voice bot** sharing thread state.
**Why Pipecat over LiveKit (the two are capability-equivalent for our case):** Voxi is always **1 user ↔ 1
bot**, so we don't need LiveKit's media-server/SFU; Pipecat is a Python *pipeline* orchestrator that sits on a
transport, and its **SmallWebRTC** transport is peer-to-peer (aiortc) — **no SFU to run, just a plain Python
Cloud Run service**, which is a *lighter and more GCP-native* self-host than LiveKit Cloud or a self-hosted
LiveKit SFU on GKE. Pipecat also gives finer control over the STT→LLM→TTS graph and ships **SmartTurnDetection**
(an LLM-based end-of-turn classifier — fewer false barge-ins on mid-thought pauses than VAD silence
thresholds), which suits a persona voice product.
- **Transport:** Pipecat **SmallWebRTC** (P2P, OSS, self-hosted on Cloud Run — default, best GCP fit for 1:1)
  with **Daily** (managed WebRTC, by Pipecat's authors) as the drop-in fallback if NAT-traversal/TURN or scale
  needs it. Client: `@pipecat-ai/react-native-small-webrtc-transport` + the Pipecat RN client (`PipecatClient`);
  still requires **EAS dev builds** (uses react-native-webrtc; not Expo Go) — same constraint as LiveKit.
- **Brain+voice (default cascade for voice consistency):** Pipecat pipeline = streaming STT (Deepgram/Gemini)
  → Gemini 3.5 Flash (Claude premium) → **ElevenLabs Flash v2.5 (canonical Voxi voice_id)**, with
  SmartTurnDetection for barge-in. **Latency budget is a per-hop table** (endpointing + STT final + LLM
  first-token + TTS first-audio + RTT) summing to a defensible **~1.2–1.5s perceived first-audio** (§22.4),
  with streaming partials + speculative LLM start. Pipecat also supports **Gemini Live / OpenAI Realtime**
  speech-to-speech as a swappable low-latency tier (different timbre) — a config change, not a rewrite.
- **Persona+context:** one canonical persona injected as session instructions; sidecar loads item record +
  prior transcript on connect; calls eve tools via the **BFF-minted per-session scoped token** enforcing the
  same `userId↔sessionId` ACL (eng-F6 voice1).
- **Transcript write-back (eng-F5):** the sidecar **appends finalized turns via the eve session follow-up
  endpoint** (`POST /eve/v1/session/:id`) with a **per-turn idempotency key** — eve stays the *single writer*;
  **no dual-write** to `app.messages`. Barge-in partial turns are committed-as-interrupted or discarded
  explicitly. Reconnect dedup is defined.
- **Mic model (resolves D6):** **push-to-hold / tap-to-toggle by default** (protects minute caps, gives a
  clear privacy indicator); VAD/barge-in reserved for paid tiers. A persistent live-mic indicator. Voice↔
  keyboard is one toggle with defined in-flight-turn behavior. Recorded; disclosed (RT-11).

### 6.4 Metering & cost safety — named enforcement point (eng-F6/F8)
The **BFF** (only public surface) **atomically checks/decrements entitlements before enqueueing any paid
generation**, passing a **single-use generation token** the worker validates; enqueue is **idempotent** on
`(item, user, version)` so retries/double-taps collapse. The **Pipecat bot hard-disconnects** the session at
the minute cap with a graceful in-persona message (soft warning at 80/90%, grace to finish the turn).
**Keyboard chat is metered too** (it's a billed LLM call) with generous soft caps + per-user/per-IP rate
limits + persona prompt caching. **Per-vendor circuit-breakers + fallback triggers**, ordered to **protect the
one-voice brand**: ElevenLabs degraded → **first failover is a second owned/cloned Voxi voice on a separate
ElevenLabs account/region (same timbre)**; only on a **full ElevenLabs outage** do we drop to a generic
narrator (Chirp 3 HD) **with an in-persona acknowledgement** ("my usual voice is indisposed") — so §6.1's
"one consistent voice" is best-effort and degrades *audibly and honestly*, never silently mid-sentence.
Deepgram down → Gemini STT; TTS/STT both down → degrade to keyboard mode, not a dead screen. **Unified daily spend dashboard + per-vendor + global kill-switches** (eng-F8).

---

## 7. The crowd/curated catalog (the moat)

### 7.1 Instance-first, not concept-first
`catalog_items` models a *specific* object (attributes, identifying_features, reference images, embeddings,
provenance) linked up to a generic `category`. Retrieval returns "2008 SuperSix EVO," not "bicycle."

### 7.2 Growth, dedup-on-create & retrieval
High vector match (≥0.92) + model agreement → attach a **redacted** reference exemplar (density). Confident
VLM + low match → **create** a new entry. **Concurrent-create race guard (eng-F10):** a short-window dedup
guard (advisory lock / upsert on an embedding bucket) so two users photographing the same new object
converge to one entry. De-dup sweep (`schedules/dedup`) blocks by category + ANN, LLM-judge ≥0.95 → reversible
auto-merge; 0.88–0.95 → trusted-user/human queue.

### 7.3 Unknown-item interview (`interviewer` subagent) — momentum-preserving (F5 design2)
Confidence <0.5 → in-persona Q&A, **capped at 2–3 questions**, **skip/"later" on every step**, the thread is
**kept (private, minimal entry) even if the user bails** (nothing lost), and the **shared/private choice is a
single low-friction toggle defaulting to private**, decoupled from the Q&A burden. A "why am I asked this"
one-liner. Visual transition reads as "co-writing an entry," not "an error form."

### 7.4 Visibility, sybil-resistant promotion & consent (RT-2, RT-6, F3 design2)
`visibility ∈ {private, pending_global, global}`; retrieval **always** filters `global OR owner=:me`; private
and global vector spaces are **physically partitioned** (also serves §11's recall fix). New-from-capture =
private. **Promotion (`schedules/promote`)** runs a *system-context* clustering ANN (elevated visibility,
exempt from the per-user filter) that clusters private entries by embedding+category **across users**, counts
**distinct owners weighted by account-age + device-attestation + capture geo/time dispersion**, caps how fast
one entry accrues confirmations, and on ≥N (start 3–5, tunable) mints a **fresh global record from structured
fields only** (never private notes/transcripts). New global entries and any TL<3 edit are **auto-hidden /
held for moderation before becoming a matchable vector OR a generation input.** **Photo→public consent:** a
user capture becomes a *global* exemplar **only after explicit plain-language opt-in** (at first-run and at
first-exemplar), **redacted** (§7.5 / RT-2); the high-match exemplar path respects the same shared/private
choice as the interview (no silent globalization).

### 7.5 Contributions, moderation & redaction
Tips/corrections attach with a `status`; **Discourse-style 5-level trust ladder**, but **trust is bound to
verified contributions, not raw activity** (RT-6), with **flag-weighted demotion** + per-account/per-IP rate
limits. **Every uploaded image runs face/plate redaction (§11/RT-2) + Cloud Vision SafeSearch + CSAM
hash-match (§15) before embedding/storage/visibility.** UGC text runs Gemini Flash-Lite moderation and is
**escaped/sanitized before entering any model prompt** (prompt-injection defense, eng-F7/RT-6). Full Apple-1.2
report/block/ban/EULA/24h subsystem is in §15 (a real subsystem, not a checkbox). `moderation_event` audit log.

---

## 8. Persona & safety system

### 8.1 Voxi (the Guide's voice)
Dry, omniscient-yet-charming, faintly absurd, **British**, warmer than Adams' aloof original. Rules: short
declaratives; **one** witty aside per reveal; payload before punchline; British spelling/idiom; succinct.
Banned: emoji in Voxi's copy, exclamation spam, US slang, sycophancy, fabricated claims as fact, and the
Adams trademark phrases. Sample lines unchanged from v1 (confident / "confident maybe" / "first witness").
Persona must remain distinctive with every Adams reference removed (G5).

### 8.2 Podcast hosts — Arlo & Mave (§6.2); visually distinct on the page (§10/D8).

### 8.3 Confidence + honesty — **claim-structured, not field-structured (RT-1)**
The vision step emits `{label, granularity_level, confidence_band, evidence[], unsupported_fields[]}` *before*
Voxi writes. **Generation (description AND podcast) is claim-structured:** the model emits clauses
`{text, claim_type, evidence_ref|null}`; a **deterministic validator hard-rejects** any clause typed
`spec|provenance|date|causal|superlative|comparative` lacking an evidence ref (and checks entailment), then a
**deterministic renderer** stitches approved clauses into prose. Only `flavor` clauses that assert nothing
falsifiable are free. Bands → fixed registers (CONFIDENT states plainly / PROBABLE hedges + "confident maybe"
chip / UNKNOWN → interview). An "How sure are you?" panel shows evidence and lets the user **correct** the ID
(feeds the catalog). Conservative downgrade bias (VLMs are over-confident). An **adversarial fabrication eval
set** (sparse-web items) measures fabrication rate as a launch gate (twin of the H2 spike).

### 8.4 Safety policy (deterministic pre-classifier `safety_classify` before the persona)
- **People/faces:** objects, never people; **and** faces/plates are **detected + irreversibly redacted before
  any embedding/storage** (RT-2 — not just "no face recognition"). Onboarding + policy state this plainly.
- **Pills/medical (RT-8):** a **hard category** in `safety_classify` with a **false-positive-biased** threshold
  that forces a fixed non-identifying refusal and **suppresses make/model/spec generation entirely** (the
  persona never sees it as identifiable); curated pill-imprint negative test set; disclaimer is secondary.
- **Weapons (RT-13):** **conservative default until counsel signs off per market** — category-level naming
  only (no model/caliber/acquisition/modification), applied to the voice/text **follow-up loop** too.
- **NSFW/CSAM:** §15 (regulated subsystem, not a line item).
- **Trademark / where-to-buy (RT-7):** naming = nominative fair use; **crowd free-text purchase links are NOT
  exposed in v1** (drop or restrict to a server-curated retailer set); registered DMCA agent + 512(c)
  repeat-infringer policy; FTC disclosure if monetized.

---

## 9. React Native / Expo client stack

Expo (managed) + EAS + CNG + **dev-client** (not bare RN; **Expo Go cannot run** vision-camera/WebRTC/MMKV —
a stated first-day note). Baseline **SDK 55** (RN 0.83, React 19.2, New-Arch-only); fast-follow SDK 56.
Choices (unchanged): expo-router v6; **react-native-vision-camera v4** (frame processors); TanStack Query v5
+ Zustand v5; MMKV + expo-sqlite + expo-secure-store; **react-native-track-player v4** (HLS, background,
lock-screen); **`@pipecat-ai/react-native-small-webrtc-transport` + `PipecatClient`** (realtime voice;
+ `@clerk/clerk-expo` for auth); **Reanimated 4** (+ worklets) + **React Native Skia** + **Rive** (orb
state machine); gesture-handler v2; **StoreKit 2 DIRECT** via `expo-iap` (no billing vendor — server-verified
via the App Store Server API + Notifications V2). All vendor keys server-side. The StoreKit transaction's
`appAccountToken` = Clerk user id. Realtime client = `@pipecat-ai/react-native-small-webrtc-transport` +
`PipecatClient` (replaces the LiveKit RN SDK). Backend runtimes **pinned per service** (eve front, poller,
worker; **Pipecat voice bot = Python**)
to the `@workflow/world-postgres`-compatible range (DX-10).

---

## 10. Design system & screens (full inventory + states + a11y)

**Concept:** *the Guide as a living cosmic museum.* Dark, atmospheric, editorial; a luminous **orb** is
Voxi's one character. Palette/type/motion per `design-notes.md`. (Reanimated reconciled to **4** in
design-notes; D10.)

### 10.1 Orb spec (D3 — decided)
**Crystalline-gem / Tolan direction** (flagged most-on-brand). One-page spec: form; the 5 states
(idle/listening/thinking/speaking/uncertain) with reference frames; **per-context dock behavior** (camera
corner / reveal-card header / podcast cover "presenting" / full-screen voice / collapsed text-thread avatar);
amplitude→bloom mapping. Built once in Rive; unblocks every screen.

### 10.2 Screens (all v1) with **state matrix (D1)**
For **each** screen, specify `{loading, empty, partial, error, offline, permission-denied}` with copy + orb
state + recovery, prioritizing: empty-collection (first run), camera/mic permission-denied, identification-
failed, **partial-confidence reveal**, voice-minutes-exhausted, podcast-generation-failed.
1. **Welcome/auth** — email-first magic-link, orb-branded; **EULA + age-gate accept** (§15); **plain-language
   privacy + photo-sharing consent** lines (RT-3/RT-5/F3).
2. **First-run (NEW, D2/F1):** "Meet Voxi" (1–2 persona lines + the promise), **camera & mic permission
   priming** before the OS prompts (mic = voice chat), first-capture coaching ("try a bike, a camera, a
   bottle"), "objects, not people" + "your photos may help build the Guide (opt-in)" disclosure.
3. **Camera capture** (default landing) — viewfinder + corner reticle, one shutter.
4. **Processing — event-driven, not fixed-timeline (D7/F7 design2):** looping witty lines until a *terminal
   event* → one of three designed outcomes (REVEAL card rises / **PARTIAL** card with amber "confident maybe"
   that does **not** silently mutate — shows "narrowing…" then settles, refinements surfaced as an explicit
   "I've confirmed it" / **INTERVIEW** reframes the orb to "curious"). After ~8–12s, Voxi acknowledges the
   wait in-persona; explicit **failure/refusal/offline/reconnect** states (orb "uncertain").
5. **Entry reveal (D5):** lead with **specific title + a confidence chip whose treatment changes by band**
   (solid CONFIDENT / amber "confident maybe" PROBABLE), then the quip, then what-it-is/what-it's-for; the
   captured photo is a **thumbnail**, not the hero; **one primary action** (Generate story or Ask Voxi);
   "Add a tip" demoted to secondary/contextual; "How sure are you?" **auto-elevates only in PROBABLE/low**.
6. **Confidence "How sure?" panel (F4 design2):** microcopy library mapping bands to in-persona phrasing,
   warm museum palette (not error colors), evidence framed as Voxi "showing its working," correction as an
   **invitation**; **visually distinct from a safety-refusal**.
7. **Podcast player** — generative cover; **per-speaker visual system** for Arlo/Mave (color/avatar/type) in
   the read-along transcript (D8); orb recedes to a "presenting" state; scrubber + 15s skip + speed;
   progressive HLS; **report-episode** control.
8. **Conversation** — default full-screen orb **push-to-talk** voice mode + ⌨️ toggle; persistent live-mic
   indicator; mic-permission priming if not yet granted; voice discovery nudge at peak delight (F8 design2).
9. **Threads / collection** — X "Chat History" model; **designed empty state** ("0 of ∞ catalogued — the
   Guide is vast…", prominent "Capture your first object," silhouette teaser) (F2 design2); the retention
   engine (collection pressure / catalog-as-content).
10. **Unknown-item interview** (§7.3) — momentum-preserving.
11. **Add-a-tip / contribution** — contextual, first-time explanation of what/who-sees-it, **trust-level-
    honest** post-submit ("a moderator will review" TL0 / "live now" TL2+), tied to the correction loop (F6 design2).
12. **Settings/account** — subscription; **privacy (no facial recognition; photos & sharing; data
    deletion/export)**; **account deletion (Apple-required)**; sign-out.

### 10.3 Accessibility (D4 — was absent)
Reduce-motion (swap particle sequences for cross-fade, still the orb); **contrast-validated tokens** on both
the dark shell and the **parchment reading surface** (two token sets + a defined dark→parchment transition,
D9); **the read-along transcript + a text transcript of every Voxi spoken turn are the official caption /
VoiceOver path** (persisted on the thread); Dynamic Type with serif min/max clamps; **44pt** min touch
targets (verify the reveal action cluster).

---

## 11. GCP architecture & data model

One project/region. Cloud Run (BFF front + eve front), **non-serverless eve poller** (§4.4), **Cloud SQL
Postgres + pgvector** → **managed AlloyDB (ScaNN) on a measured trigger** (p95 filtered-ANN latency > X **or**
recall@10 < Y at Z rows — quantified, instrumented from day one; eng-F4). GCS (`voxi-photos` **redacted**,
`voxi-audio`) + Cloud CDN; **Clerk** (auth SaaS — verified networkless, no GCP service needed); Vertex AI;
Cloud Vision (web detection + SafeSearch); **PhotoDNA/
CSAI hash-match**; **face/plate redactor**; Cloud Tasks; Secret Manager; Cloud Logging/Trace.

**Vector recall fix (eng-F4):** the core query is filtered ANN under the visibility predicate — pgvector
HNSW's post-filter weak spot. Mitigation: **physically partition** the read-mostly **global** index (near-
unfiltered ANN) from the small per-user **private** set (searched separately and merged) → two clean queries
instead of one over-filtered one; per-category indexes; a hard latency budget for `catalog_search` with a
fallback (skip-catalog → web stage).

**Schema (`app.*`):** as v1, **plus**: redaction/PII columns and `redacted_object` on images; **retention TTL
+ deletion-cascade markers**; consent records (`photo_sharing_consent`, `age`, `region`); `generation_tokens`
(metering); `report`/`block`/`ban` tables; `moderation_event`; `csam_report` (quarantine + preservation, §15).
Signed-URL policy (eng-F5): **short TTL, user-bound, non-enumerable UUID keys; private assets never on a
shared/cacheable CDN path; audio cached by item id is global-only.**

**Cost envelope @ ~10k MAU:** infra ≈ $120–350/mo on Cloud SQL (+ the non-serverless poller node ~$15–40/mo)
or $450–700/mo if AlloyDB is adopted early, + variable AI (§13). Serve all audio via Cloud CDN.

---

## 12. Auth (Clerk) + abuse controls — **changed from Firebase**

**Decision: Clerk, not Firebase/Identity Platform.** Firebase is *not* the easiest path on Expo — its JS SDK
defaults to in-memory persistence in RN (the "auth will not persist" warning) and needs manual AsyncStorage
wiring, and its auth emails/console are clunky. **Clerk's `@clerk/clerk-expo` is purpose-built**: a
`tokenCache` backed by `expo-secure-store` (iOS Keychain) persists sessions with zero custom code,
email-OTP/magic-link + password reset + verification are fully managed (incl. the emails), and the backend
verifies the session JWT **networkless** via `@clerk/backend` `verifyToken` with the cached JWKS/PEM. This is
the "dead-simple, secure, fast" pick.

**This does not break the GCP-hosting mandate.** Hosting = where *data and compute* live (eve, Cloud SQL,
GCS, Vertex — all GCP). Auth-as-a-service stores only *identities*; token verification is a stateless
signature check that runs identically on Cloud Run. So the eve/voxi-api backend stays 100% on GCP; only the
identity control plane is Clerk's SaaS. We store our own `users` row keyed to `claims.sub` from day one, so
all app data (threads/catalog/subs) is portable if we ever switch providers.

**Cost / free tier:** Clerk Free covers **~10k MRU** (Monthly Retained Users; confirm current figure — some
2026 sources cite a higher free tier), then Pro **$25/mo to 50k** + $0.02/MRU. Cheap through early traction;
budget the $25/mo as a near-certain early cost. Email OTP/reset emails are included (no separate email bill).

**Alternatives considered (decisive tradeoff each):**
- **WorkOS AuthKit** — genuinely **free to ~1M MAU** with a clean Expo (PKCE) example; pick this if
  *free-at-scale* matters more than Clerk's last 10% of DX polish. Strong second choice.
- **Better Auth** — OSS, runs **in our own Cloud SQL** (which eve already provisions) → *zero auth vendor,
  identity data stays inside GCP, no per-MAU cost*; the most GCP-purist reading. Cost: we own the session
  surface + email sending (use Resend), and it's more setup than Clerk. Pick this if "no third-party identity
  vendor" is a hard requirement.
- **Identity Platform** — the GCP-native option, free to 50k MAU; only revisit if "no SaaS auth at all" is
  mandated *and* Better Auth's self-host ownership is unwanted.

**Abuse (B6/RT-6):** Clerk ships bot/abuse protection; on top, add **per-device/per-IP rate limits +
account-age/velocity weighting** for free-tier quota, catalog submission, and promotion counting; device
attestation for trust-level gains.

---

## 13. Unit economics, subscriptions & free tier (honest)

**Model picks** unchanged (Gemini 3 Flash→Pro + Cloud Vision for ID; Gemini 3.5 Flash for description/chat;
Claude Sonnet 4.6 for podcast script; Flash-Lite for moderation; Vertex embeddings). Prompt caching on the
persona.

**Per-action cost — split easy vs hard (eng-F11):** easy scan ≈ $0.02–0.04; **hard scan (agentic crop + Pro
+ search) ≈ $0.10–0.20**; 5-min podcast ≈ $0.15–0.24 generated once, ~$0 cached; 5-min live chat ≈
$0.07–0.25.

**Margin stated honestly (F2):** the 72% Explorer margin holds **only at low utilization**. Add a **worst-
case full-utilization COGS row** (unlimited scans + 15 fresh podcasts + 60 premium voice-min ≈ ~$6.90 vs
~$6.79 net = break-even). Therefore: **premium ElevenLabs live voice → Voyager only**; lower Explorer voice
minutes; **fresh-podcast generation is a metered consumable**, never "unlimited."

**Free tier tightened to ~$0 marginal (B6):** 5 scans/mo (safety-refusals and hard-fails **don't count**,
F9), **metered** keyboard chat (soft cap), **cached community podcasts only — zero free fresh generation**,
hard device-level voice cap, per-device/per-IP rate limits + abuse detection. Reframe free quota around
**contribution-positive actions** (new object, confirm ID, add tip).

**Worst-case COGS for the premium tier (Voyager) too (B-new):** Voyager carries the highest-cost line
(premium ElevenLabs live voice $0.07–0.25/5-min + 200 voice-min + metered fresh podcasts). Add a Voyager
full-utilization COGS row and **set the Voyager voice-minute cap + price so that row stays positive** — the
cost-exposed tier must be modeled, not just Explorer.

**Conversion thesis as a falsifiable bet (B5; matches §0 discipline):** target **≥6% free→paid within 60
days** via the **"no free fresh podcast / scan-cap" paywall trigger**; **<3% → packaging/price is wrong,
revisit at G1.** Recurring reason-to-pay = the collection + fresh podcasts + voice minutes.

**Pricing frame (reconciled; supersedes any monthly figure elsewhere):** the v1 monthly tiers are
**placeholders**; the **leading hypothesis to test at G1 is a lower annual anchor — ~$19.99–29.99/yr (≈
$2.49–2.99/mo equivalent), or a one-time + consumable model** — given episodic use, vs PictureThis/Vivino
($30–48/yr). **Do not finalize pricing until H1/H2 prove recurring behavior** (gate G1). Metering: §6.4.

---

## 14. Test & evals strategy (was absent; eng-F3)

A `tests/` plan + CI: (1) **identification accuracy harness** with category/make/model/year scoring, run on
every prompt/model change (doubles as the H2 spike artifact, per seed vertical); (2) **golden-set tests** for
the claim-structured honesty validator + the numeric-spec-without-source blocker + an **adversarial
fabrication eval** (sparse-web items); (3) **eve session resume-after-instance-kill** integration test (the
G3 falsifier, automated; runs on every dependency bump); (4) **voice-minute metering** test (barge-in/partial
accounting, hard-cutoff); (5) **podcast-worker idempotency** under duplicate Cloud Task delivery + concurrent
partial-playlist writes; (6) **visibility-filter ACL** test (cannot bypass via catalog_search, vector match,
or the MCP bridge); (7) **prompt-injection** test (OCR/UGC/web text cannot steer tools or moderation);
(8) **pill/medical suppression** test (curated imprint negatives); (9) load test the streaming-voice turn
pattern + multi-instance poller correctness to a stated turns/sec + concurrent-session target.

---

## 15. Legal, privacy, trust & safety workstream (regulated subsystems — v1)

A named workstream with a counsel owner; **launch blockers**.
- **Biometric/PII (RT-2/RT-10):** face+plate **redaction before embed/store**; raw-photo **retention TTL**
  (e.g. 30–90d unless attached to a kept thread); **per-user delete/export cascading** across GCS photos/
  audio + embeddings + contributions + eve `workflow.*`; **Apple-required account deletion (5.1.1(v))**;
  consent + lawful basis recorded; **IL/TX/WA geofence**; DPA; counsel sign-off that a stored multimodal
  embedding is not a "biometric identifier" in launch jurisdictions; promoted-contribution fate on deletion
  decided (anonymize vs retain under documented basis).
- **CSAM (RT-4):** treat as a regulated 18 U.S.C. 2258A workflow — **NCMEC registration**, **hash-matching
  (PhotoDNA / CSAI Match)** as first-pass, a **report-preserve-do-not-redistribute** pipeline routing **only**
  to NCMEC, 90-day preservation, quarantine + access logging. Remove "the model provider does it for free"
  framing.
- **Apple 1.2 UGC (RT-3):** per-entry/per-tip/per-photo **report**; **account block + ban** that removes a
  banned user's contributions from global retrieval; **published zero-tolerance EULA + signup gate**;
  **auto-hide-on-first-report** + a **staffed <24h queue with a named owner**; proactive filter (SafeSearch +
  text mod) **before** global visibility.
- **Age-gate + recording disclosure (RT-5/RT-11):** real minimum age + collection (DOB / Apple Declared Age
  Range), feature-gate UGC/voice accordingly; pre-permission priming; precise NS*UsageDescription strings;
  disclose recording/transcription before first voice session; bound audio retention.
- **Content liability (RT-9):** defamation/disparagement filter on podcast/chat claims about identifiable
  entities; ≥2 sources for negative claims; cache-invalidation + report-episode.
- **IP (RT-12/CEO-7) [G5]:** real IP clearance on persona/name/marketing; scrub "Hitchhiker's Guide" from all
  user-facing/marketing copy; clear/owned ElevenLabs voice.

---

## 16. Decision log (resolved; ⟳ = changed from v1)

| # | Decision | Why |
|---|---|---|
| D1 ⟳ | **eve self-host on GCP is spike-gated & contested** (was "documented"); poller on a **non-serverless runtime**, front on Cloud Run | Postgres world isn't serverless-compatible (§4.4) |
| D2 ⟳ | **Auth = Clerk** (was Identity Platform) — `@clerk/clerk-expo` + networkless `verifyToken`; WorkOS AuthKit (free to ~1M MAU) / Better Auth (own Cloud SQL) as alternatives | Firebase isn't the easiest on Expo; auth-as-a-service doesn't break the GCP mandate (data/compute stay on GCP) |
| D3 | Cloud SQL+pgvector now → managed AlloyDB on a **measured** trigger | cheapest viable; ScaNN when recall/latency bites |
| D4 ⟳ | **Realtime = Pipecat** (was LiveKit) — SmallWebRTC P2P (self-host on Cloud Run, no SFU) + Daily fallback; cascade w/ ElevenLabs Voxi voice; Gemini Live/OpenAI Realtime = swappable low-latency tier | 1:1 voice needs no SFU; Python bot is lighter + more GCP-native than LiveKit; SmartTurnDetection; user preference |
| D5 ⟳ | **Podcast TTS = ONE multi-speaker call, split locally** (was 8 parallel calls) | cross-call timbre drift breaks the two-host voices (eng-F1) |
| D6 | Voxi voice = one ElevenLabs voice_id (v3 + Flash v2.5) | character voice is the brand |
| D7 | Podcast render = async Cloud Task → worker (ffmpeg) | justbash can't run ffmpeg; long renders; idempotent |
| D8 | Vision = Gemini 3 Flash→Pro + Cloud Vision + Vertex embeddings | grounded localization, GCP-native |
| D9 | Photo transport = short-TTL, user-bound, non-enumerable signed URL | avoids token bloat + cross-tenant leak |
| D10 ⟳ | **Honesty gate is claim-structured** (clauses carry evidence refs; deterministic renderer) | field/regex gate let prose fabricate (RT-1) |
| D11 ⟳ | **Mic = push-to-talk/tap-to-toggle default**; barge-in = paid | cost caps + privacy indicator (D6 design) |
| D12 ⟳ | **Faces/plates redacted before embed/store**; consent before any global exemplar | biometric/privacy (RT-2) |
| D13 ⟳ | **Free tier: no fresh podcast generation, metered chat, hard caps** | $0-marginal free tier (B6) |
| D14 ⟳ | **Crowd free-text "where to buy" not exposed v1** (curated set only) | counterfeit/trademark (RT-7) |
| D15 ⟳ | **Seed ONE vertical, pre-seed curated catalog data**, indexable web surface | bootstrap moat + SEO + retention (B4/B10) |

---

## 17. Top risks & mitigations (updated)

1. **Demand/retention unproven** (H1, CEO-1, B1/B2) → §0 hypotheses + concierge gate G1 + a real retention
   mechanic (§1) + seed-vertical focus.
2. **Specific-ID accuracy is the thesis and is ~55–75%** (H2, CEO-4, B11) → per-vertical accuracy gate sets
   positioning; confidence bands; interview-as-feature; seed deep.
3. **eve durability on Cloud Run is likely-broken as first drawn** (eng-F1, DX-1) → §4.4 decoupled poller +
   gate G3 + pre-committed fallback (§4.5).
4. **Confident fabrication** (RT-1) → claim-structured honesty gate + adversarial eval (§8.3/§14).
5. **Biometric/CSAM/UGC/GDPR legal** (RT-2/3/4/10) → §15 regulated subsystems, launch-blocking.
6. **Platform absorption + commoditization + Herodot overlap** (CEO-6, B3, B9) → wedge = vertical community +
   curated data + SEO, not persona/format (§2).
7. **Cold-start moat** (B4) → pre-seed curated vertical data, contribution made locally-beneficial, defer
   crowd reliance.
8. **Unit-economics bleed** (F2/F3/B6) → honest worst-case, tightened free tier, metered chat, enforcement
   point (§6.4/§13).
9. **No distribution plan** (B10) → §19 GTM + indexable web surface.
10. **Voice latency / vendor sprawl / metering exactness / write-back drift / podcast idempotency / vector
    recall / prompt injection** → the eng fixes in §5/§6/§11/§14.

---

## 18. Spikes & validation gates (front-loaded; cut no scope)

- **G1 (H1/H2/H4) demand+accuracy concierge** in the seed vertical — *before/parallel to* heavy build;
  pre-committed kill thresholds (§0).
- **G3 eve self-host spike** — session resume after instance kill, multi-poller SKIP-LOCKED correctness, the
  self-callback/60s route, Clerk JWT verify in the AuthFn; **hard go/no-go** before backend feature work (§4.4) with the
  §4.5 fallback pre-committed.
- **G4 voice-consistency A/B** (ElevenLabs v3 vs Flash v2.5 timbre; cascade vs Gemini Live persona) — gate
  before committing the cascade vendor (§6.1).
- **G5 IP + voice-rights clearance** (counsel) before marketing/launch (§15).
- **Embedding bake-off** (Vertex vs SigLIP 2) on look-alikes; **threshold calibration** per category;
  **vector-recall** trigger measurement; **podcast first-segment latency** under cold start.

---

## 19. Go-to-market & distribution (was missing; B10)

- **Seed vertical first** (recommend bikes or cameras/watches — make/model/year matters, communities document
  obsessively, willingness-to-pay exists). Pick via G1.
- **Pre-seed catalog density** with a concrete **data-acquisition plan** (license/scrape a make/model dataset
  + reference images + a handful of pre-generated podcasts for top-N objects) so the cold-start is a content
  problem we control, not a crowd problem we wait on (B4, D15).
- **Channel:** community + influencer within the seed vertical (forums, subreddits, enthusiast YouTubers),
  not broad paid; estimate CAC vs LTV before any paid spend.
- **Viral/organic loops:** shareable entry cards + shareable community podcasts; **a public, indexable web
  surface for global catalog entries** so the data earns Google traffic → contributors → more entries → more
  traffic (the Vivino/Wikipedia precedent the in-app-only catalog otherwise forfeits).
- **Conversion:** define the paywall trigger + target free→paid % (§13); don't finalize price until G1.

---

## 20. Build sequence (dependency order; everything still in scope, gates first)

1. **Foundations + gates:** GCP project/region/IAM; Cloud SQL+pgvector; Secret Manager; **Clerk** (Expo SDK +
   networkless `verifyToken` in the BFF/eve AuthFn); GCS+CDN+**redactor (fail-closed) + CSAM hash-match +
   SafeSearch proactive scan** (pulled forward per §22.6 so nothing in step 3 touches an un-scanned image);
   Expo dev-client + EAS profiles; Clerk email-OTP/magic-link + secure-store tokenCache;
   `users/threads/messages` schema (keyed to `claims.sub`) + retention/deletion/consent + **age(16+)/region** columns.
   **Run, front-loaded and in parallel: the day-1 eve-off-Vercel boot spike → G3 (eve durability), G1
   (concierge demand/accuracy), G4 (voice-consistency A/B) + embedding bake-off + threshold calibration**;
   **G5 IP clearance (incl. the seed-dataset imagery, §22.6) kicked off.** Backend shape isn't committed until
   the boot spike + G3 pass (else the §4.5/§22.3 fallback fires).
2. **eve backend + thread loop (post-G3):** deploy the eve **front (Cloud Run)** + **poller (non-serverless)**
   per §4.4; `voxi-api` BFF (JWT verify, signed URLs, session proxy, ownership ACL, metering enforcement
   point); persona + `voice.md`; **`docs/api-contract.md`**; end-to-end photo→session→streamed Voxi text.
3. **Identification pipeline:** the cascade + arbitration + per-category calibration + agentic cap; the
   reveal card with band-colored confidence chip + evidence panel; tool I/O schemas.
4. **Catalog + interview + contributions + moderation + legal** *(pre-seed blocked on G1's vertical pick,
   §22.6)*: interviewer subagent; partitioned visibility + the cross-user promotion-clustering index (§22.4);
   dedup-on-create + sybil-resistant promotion; trust ladder; **Apple-1.2 report/block/ban/EULA + the 2258A
   CSAM report-preserve pipeline + deletion/export** (§15; image scanning already live from step 1);
   dedup/promote schedules (Cloud-Scheduler-drivable, §22.3).
5. **Narrator voice + podcast** *(precondition: G4 cleared, §22.6)*: ElevenLabs Voxi voice + an owned fallback
   voice (§6.4); storyteller subagent with the **claim-structured + independent-claim_type-auditor +
   defamation** validators (§22.1); worker (Cloud Tasks + **single-call** multi-speaker TTS + ffmpeg + HLS,
   idempotent); player UI with per-speaker transcript + report-episode; own the 15–40s "composing" wait.
6. **Realtime conversation** *(precondition: G4 cleared, §22.6)*: Pipecat voice bot (Python, Cloud Run) +
   SmallWebRTC transport + cascade (ElevenLabs Voxi voice) + SmartTurnDetection; Pipecat RN client; scoped-token
   bridge to eve tools; transcript write-back via eve follow-up; push-to-talk; metering hard-cutoff.
7. **Threads/collection UI + retention mechanic, orb (Rive states) + event-driven processing, accessibility,
   settings/privacy/deletion.**
8. **Subscriptions:** StoreKit 2 DIRECT (no billing vendor) — device `expo-iap` + server-side App Store Server
   API/Notifications V2 verification + entitlements + metering tables + tier gating (paywall dark-launched);
   abuse rate-limits.
9. **Hardening + launch:** the §14 test suite (incl. honesty validator-recall bar, a11y/contrast check,
   multi-poller load test with the pinned turns/sec target) + load test; observability (correlation id,
   workflow-table diagnostics, spend dashboard, kill-switches); App Store review prep (permission priming, UGC
   subsystem, privacy labels, account deletion); **final G4/G5 re-confirm** (both first cleared earlier per
   §22.6); TestFlight → App Store; **GTM in the seed vertical** (§19); Android fast-follow.

---

## 21. Strategic dissent on record + decision audit trail

**On record (the panel's #1 recommendation, preserved):** all four strategy voices (CEO×2 + business
red-team) classified **"build everything, no phases"** as the single largest avoidable risk and recommended a
**vertical-first phased launch** — ship camera→ID→persona→thread in one seed vertical, validate H1/H2, then
*earn* the podcast/catalog/voice machinery. **Per the explicit "build everything" directive, no scope is
cut.** The de-risking is absorbed as: (a) gates G1/G3/G4/G5 that run first but remove nothing; (b) a
seed-vertical *launch focus* + curated pre-seed (§19); (c) honest economics + a retention mechanic. If at any
point G1 fails its kill threshold, this section is the standing recommendation to revisit scope.

**Auto-decision audit (autoplan 6 principles; classification → action):**
- *User challenges* (panel vs the user's stated direction): **build-everything/no-phases** → kept per explicit
  directive; dissent recorded here (not auto-decided away). retention-mechanic, photo-consent, vertical-first
  GTM, claim-structured honesty, pgvector partition → **absorbed as additive** (no scope cut), principle P1
  (completeness) + P2 (boil-lakes).
- *Mechanical* (one right answer) → applied silently: eve poller decoupling, redaction-before-embed, CSAM
  workflow, Apple-1.2 subsystem, metering enforcement point, single-call TTS, signed-URL hardening, sidecar
  ACL token, API contract, tool schemas, state matrix, accessibility, account deletion, version matrix.
- *Taste* (reasonable disagreement) → decided by P3/P5 (pragmatic/explicit) and noted: pricing — lead
  hypothesis **~$19.99–29.99/yr** per §13, *flagged, not finalized* (gate G1 decides; old monthly figures are
  placeholders); AlloyDB-now-vs-later — later, on a measured trigger; seed vertical (bikes vs cameras/watches)
  — decided by G1; weapon model-naming — conservative default until counsel.

> Net: every feature the user asked for remains in scope. The plan now (1) corrects the load-bearing eve/Cloud
> Run topology, (2) makes the honesty gate actually enforce, (3) treats biometric/CSAM/UGC/GDPR as real
> subsystems, (4) closes the design state/accessibility/orb/voice-mechanic gaps, (5) hardens metering, vector
> recall, idempotency, and the API contract, and (6) adds the missing demand-validation, retention, economics,
> and distribution layers — with the panel's vertical-first dissent preserved on the record.

---

## 22. Convergence patch (v2.1 — resolves the verification round's residual gaps)

A 6-voice adversarial verification of v2 returned **minor_gaps** across the board (no major gaps; all prior
criticals resolved). The remaining residuals are closed here; each amends the referenced section.

### 22.1 Honesty gate hardening (verify: RT-1 / claim_type / judge)
- **Self-labeling is audited.** The generator's `claim_type` is **re-classified by an independent auditor**
  (different model or rule+NLI). Any clause tagged `flavor` that contains a named entity, date, place, or
  factual predicate is **flagged and fail-closed**. "Flavor" is *not* a free channel. (Amends §8.3.)
- **Honesty gate is "fail-closed, judge-gated," not "deterministic."** The renderer is deterministic; the
  accept/reject hinges on an NLI/judge with its own error rate. **§14 adds a measured validator-recall bar**
  (e.g. catch ≥95% of seeded unsupported/mislabeled claims) + a periodic **human audit sample**; the judge
  biases fail-closed on low confidence. The adversarial-fabrication eval gets a **numeric launch threshold**
  (twin of H2). (Amends §8.3, D10, §14.)
- **Persona wit survives (verify: claim-gate vs §8.1).** A clause rubric distinguishes **obvious non-literal
  hyperbole** (`flavor`, allowed — "over-engineered to a fault") from **factual superlatives/comparatives**
  ("the lightest frame of 2008", which require an evidence_ref). **§14 tracks a persona-wit-survival rate** so
  the gate is tuned to preserve voice, not just block fabrication. (Amends §8.1, §8.3, §14.)
- **Source independence (verify: RT-9):** "≥2 independent sources" = **distinct registrable domains +
  non-syndicated-text check**; shared-parent/wire-copy → human review. (Amends §6.2, §15.)

### 22.2 Privacy/safety pipeline ordering & values (verify: RT-2/4/5)
- **Pipeline order is fixed:** **CSAM hash-match the *original* FIRST** → if match, route the **untouched
  original** to the 2258A quarantine (no redaction, no normal store, no human eyes outside the legal path,
  90-day preserve); **if clear, redact the derivative**, embed/store only the redacted copy, and **TTL-delete
  the original**. The "redact before store" and "preserve original for NCMEC" rules no longer collide.
- **Redactor is fail-closed:** redactor error/timeout/low-confidence → **reject/queue the upload, never store
  unredacted**, with an alert. (Amends §7.5, §8.4, §11, §15.)
- **Minimum age committed: 16+** at signup (sidesteps COPPA <13 and GDPR-K <16 edge handling for a
  UGC+voice+biometric-adjacent app); under-threshold = hard block. Wired into §10.2 screen 1 + the consent
  schema. (Amends §15.)
- **Geofence posture:** **redaction-before-embed + counsel's "embedding ≠ biometric identifier" opinion is
  the primary, jurisdiction-independent defense**; the IL/TX/WA geofence is a **secondary backstop** using
  device-locale + IP-geo with **conservative over-blocking** (ambiguous region treated as covered). (Amends §15.)
- **Moderation/NCMEC coverage for a small team:** **auto-hide-on-first-report** makes the human <24h SLA
  non-blocking for exposure; **CSAM detection + the NCMEC report path are automated** (do not depend on a
  human being awake); a contract/outsourced escalation rota covers hits. (Amends §15.)
- **Weapon is an explicit `safety_classify` category** with its own action (category-naming-only, follow-up
  loop suppressed) + a **§14 curated negative test set** mirroring pills. (Amends §4.6, §8.4, §14.)

### 22.3 eve backend honesty & the existence-proof spike (verify: §4.5 / off-Vercel)
- **§4 prose softened:** self-hosting the eve **agent layer** (channels/subagents/skills + sandbox→justbash,
  model→Vertex, secrets→Secret Manager) off Vercel is **unproven on the public record; G3 is the existence
  proof**, not a documented path.
- **New day-1 boot spike (ordered FIRST in §20.1, before G3's durability tests):** `eve init` → rip out every
  Vercel adapter → **does it even boot and run one photo→session→streamed-turn loop with ZERO Vercel platform
  services?** If boot fails, the §4.5 fallback fires immediately.
- **§4.5 fallback re-costed honestly:** it **abandons the eve agent-framework model** (subagents/skills/
  channels) and requires re-implementing durable checkpointing/leasing — realistically **~30–50% reuse, not
  90%**, plus a **"re-architect the agent layer" line item** (cascades into §4.2/§6.2). Still a real survival
  path, but not a cheap drop-in.
- **G3 acceptance criteria expanded** to two named binary checks referencing the known-bad paths
  (vercel/workflow #1483 the >60s self-call ceiling; #1416 cross-version transport breakage): (a) a >60s
  self-call either completes on the Cloud Run topology *or is proven impossible* (making checkpoint-everything
  mandatory); (b) the **exact pinned (eve, @workflow/*, world-postgres) triple is recorded as a G3 output** and
  the §4.5 CI resume-test is green on it.
- **eve `schedules/*` self-host risk:** add to the G3 checklist whether dedup/promote run under world-postgres;
  **cheap insurance — spec them to be drivable by Cloud Scheduler → a BFF cron route** independent of eve's
  scheduler, so the moat machinery doesn't inherit scheduling risk. (Amends §4.2, §7, G3.)

### 22.4 AI-pipeline & vector residuals (verify: F4/promotion/recall)
- **Promotion needs a cross-user index (verify: §7.4 vs §11):** §11's private partition must support **both**
  per-user filtered reads **and** a **system-context, category-bucketed cross-user clustering index** (or a
  periodic offline snapshot the promote job clusters) for `schedules/promote`; state its bounded cost.
  (Amends §11, §7.4.)
- **Redaction↔recall symmetry & occlusion:** the **query image is redacted symmetrically** with stored
  exemplars before embedding; the **§18 bake-off / §14 harness measures redacted-vs-raw recall@10**; if a
  redacted face/plate region overlaps the detected object bbox, **flag low-quality → multi-photo capture**
  rather than embed a corrupted crop. (Amends §5.3, §7.2, §11, §14, §18.)
- **Realtime latency floor corrected to ~1.2–1.5s** (the ~0.7s endpointing line item leaves no room for a 1.0s
  floor on a 4-hop cascade; aggressive semantic endpointing can pull endpointing to ~0.3–0.5s if a lower floor
  is wanted). (Amends §6.3.)
- **Confidence numbers are seed defaults:** the 0.92 / 0.75 / 0.5 in §5.4/§7.2 are **seed-vertical defaults the
  H2 calibration overrides per category**, not hardcoded constants. (Clarifies §5.4.)

### 22.5 Design artifacts to produce (verify: D1/D4 still template-not-filled)
- **State matrix becomes a real artifact** (`docs/state-matrix.md`) before §20.7 — at minimum the
  `{offline, error}` cells for the four media-heavy screens (processing, reveal, podcast, conversation),
  whose failure modes (mid-stream HLS offline, half-rendered reveal) are non-obvious. (Amends §10.2, §20.7.)
- **Accessibility acceptance gate = WCAG AA (4.5:1 text, 3:1 UI/large).** The two highest-risk pairs — the
  PROBABLE chip on parchment and any text on the orb gradient — are **explicitly measured**; a **contrast/a11y
  check is added to §14** (which had none). (Amends §10.3, §14.)
- **"Confident maybe" chip = a specific warm/gold museum token**, with the **true caution/error hue reserved
  exclusively for safety-refusals**, so hedging and refusal are chromatically separated. (Amends §10.2.5/.6.)
- **Interview question bank + per-band confidence microcopy + "why am I asked this"** are authored in §20.4
  persona work and tested in G1 (the copy *is* the product). (Amends §7.3, §10.2.6, §20.4.)
- **Three-voice (Arlo/Mave/orb) color/avatar/type assignments** are produced in §20.5/§20.7 (structure decided
  §10.2.7; values to fill). (Amends §10.2.7.)

### 22.6 Sequencing corrections (verify: gate ordering)
- **G4 (voice-consistency) + the embedding bake-off + threshold calibration move into the front-loaded gate
  block** (§20.1) or as an explicit **precondition of §20.5/§20.6** — they must clear *before* building on the
  cascade, with only a final re-confirm at §20.9. (Amends §18, §20.)
- **CSAM hash-match + SafeSearch proactive scan move into §20.1 foundations** (with the redactor), so no
  identification work in §20.3 ever touches an un-scanned user image. (Amends §20.)
- **§20.4 catalog pre-seed is explicitly blocked on G1** (the vertical pick). (Amends §20.4.)
- **Seed-dataset IP gate:** **extend G5 (counsel) to cover the seed catalog's reference imagery** — license/
  provenance sign-off; prefer **licensed/owned datasets over scraping**; documented fallback to first-party
  captured exemplars if scraped imagery can't be cleared. (Amends §15/G5, §19, D15.)
- **Poller HA cost** (§11) is **re-noted as ~$30–80/mo** if ≥2 pollers are run for HA (was "~$15–40"); the
  **multi-poller load-test target (turns/sec, concurrent sessions) is pinned before §20.9.** (Amends §11, §14.)

**Convergence statement:** after this patch, every prior critical/high finding is resolved and every
self-introduced contradiction is reconciled. The plan is **implementation-ready**, with the explicit and
correct caveat that three things are *gate-validated spikes, not settled facts* — **G1** (demand/accuracy/
podcast in the seed vertical), **G3** (eve self-hosts durably off-Vercel, incl. the day-1 boot proof), and
**G4/G5** (voice consistency + IP/voice-rights clearance). Those gates run first by design; the §4.5 fallback
and the §21 vertical-first dissent are the pre-committed responses if a gate fails. Nothing in the user's
"build everything" scope is cut.
