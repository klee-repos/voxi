# Plan — Valuable, grounded reveal descriptions + spoken British narration

Status: **IMPLEMENTED + VERIFIED (2026-07-01)** — drafted → `/plan-eng-review` → adversarial review (10 confirmed,
folded as A6–A15) → implemented → E2E-verified. See `docs/IMPLEMENTATION-STATUS.md` for the verification results.
Scope: the post-capture **analysis** (the "what it is" description on the reveal) and **speaking it aloud** in
Voxi's British voice. No change to the identification/arbitration/safety/honesty invariants themselves.

## Problem (from the user)

1. After a photo is taken, the description is generic. It should be **specific to the specific item** — the
   exact make, **model, and year**, the details that most matter for *what it is*, plus **an interesting fact or
   two** — while keeping the **dry, witty British** voice. Keep it **succinct**.
2. After the results appear, they should be **spoken to the user in a British voice**.

## Why it's generic today (root cause)

The reveal narration is produced by `LiveNarrator` (`services/eve-agent/agent/providers/live-narrator.ts`) and
passed through the **real honesty gate** (`packages/shared/src/confidence.ts`): any falsifiable clause (spec,
date, provenance, causal, superlative, comparative) is **dropped unless it cites a grounded evidence ref**.

The only evidence the narrator gets today is:
- On CONFIDENT: a synthetic `id` ref (claim = the label) so it *may state the identity*, and
- `web1..webN` refs whose `claim` is a **Cloud Vision reverse-image page _title_** (e.g. "Canon AE-1 — Wikipedia").

Page titles carry almost no citable *facts*, so the gate correctly strips any specific detail → the narrator
falls back to identity + generic flavor. **The fix is not to loosen the gate; it is to give the narrator real,
grounded facts to cite.**

---

## Part A — Grounded enrichment → specific, valuable descriptions (keep it honest + witty)

### A1. New provider: `services/eve-agent/agent/providers/live-research.ts`

A `Researcher` seam that, given a **CONFIRMED** identity, returns grounded facts as `IdEvidence[]`:

```ts
export interface ResearchInput { label: string; make?: string; model?: string; year?: number; category?: string }
export interface Researcher { research(input: ResearchInput): Promise<IdEvidence[]> }
```

- `LiveResearcher` calls **Vertex Gemini with Google Search grounding** (a new
  `geminiGroundedResearch()` helper in `agent/lib/gcp-vision.ts` — same gcloud-CLI auth, **no new creds**;
  `tools: [{ googleSearch: {} }]`). It asks for a compact set of the **most defining facts** about *this exact
  make/model/year* (what it is / what it's for, 1–2 defining specs or design facts, and one genuinely
  interesting fact).
- The response's `groundingMetadata` (`groundingChunks[].web.{uri,title}` + `groundingSupports[]`) is mapped to
  `IdEvidence[]` — **each fact clause paired with the source URL that grounds it** — by a **pure, unit-tested
  function** `factsFromGrounding(text, groundingMetadata)`. Facts with no grounding chunk are dropped (no
  ungrounded "facts").
- Capped (≤ ~5 facts) and deduped. Best-effort: any error → returns `[]` (never throws).

Deterministic tests use a `FakeResearcher` returning fixed `IdEvidence[]`; the live call is proven by a spike
(cred-gated), exactly like the other live tiers.

### A2. Wire enrichment into the cascade (CONFIDENT-only)

`services/eve-agent/agent/cascade.ts`: add optional `researcher?: Researcher` to `CascadeDeps`. **Only when the
band is CONFIDENT** (identity actually confirmed) and a narrator is present:

```
let evidence = result.evidence
if (deps.researcher && result.confidence_band === 'CONFIDENT') {
  try { evidence = [...evidence, ...await deps.researcher.research({ label, make, model, year, category })] }
  catch { /* enrichment is best-effort; fall back to web evidence only */ }
}
narration = await narrator.narrate({ ...evidence })
```

**Honesty invariant preserved:** on **PROBABLE/UNKNOWN we do NOT research** (no confirmed identity → nothing
safe to ground; researching a guess would smuggle a specific model the gate is meant to suppress). PROBABLE
still hedges exactly as today (`narrationEvidence` still withholds the `id` ref). This is the load-bearing rule
and it does not move.

To get make/model/year into the cascade, `identify_object` already returns `granularity`/candidates; thread the
chosen candidate's `{make, model, year, category}` alongside `label` (additive to `IdentifyResult` if not
already present — `candidates[0]` carries them).

### A3. Richer, still-honest, still-succinct narrator prompt

`live-narrator.ts` system/user prompt (behaviour, not gate, changes):
- Demand a **specific** description of *this* item (on CONFIDENT it may name make/model/year via `id`), the
  **details that matter most for what it is**, and **one genuinely interesting fact** — every falsifiable clause
  citing a `factN`/`webN` ref from the (now richer) evidence list.
- Keep **2–4 short clauses, ≤ ~55 words total**, dry British wit, no gush, no lists, no meta.
- Unchanged: `flavor` is the only un-cited type; the auditor still catches smuggled years/specs; PROBABLE forced
  to hedge.

### A4. (DEFERRED by eng review) Batched entailment judge

Considered: an `EntailmentJudge` validating cited clauses against their evidence. **Deferred to v2** — the facts
we cite now come from *our own* grounded-research step (each already paired with a real source URL), so
ref-existence + the flavor auditor are sufficient for v1, and a per-reveal judge call adds latency + a class for
marginal gain. Tracked as a TODO. The gate is unchanged and still works.

### A5. Latency + fail-closed (eng review decisions)

Enrichment adds **one** grounded Gemini call before narration (the band is already computed, so *identification*
is not delayed — only the narration tail). Because processing **drains the whole stream before routing to
reveal**, this lengthens the pre-reveal wait.
- **Decision:** accept for v1 (processing already shows a long-wait ack at ~9s); progressive narration fill is a
  UX refactor → deferred.
- **Hard requirement:** the research call is wrapped in a **timeout (~8s) + try/catch**. Timeout/error → empty
  facts → narration proceeds on web evidence only. Research can **never** change the band, drop the reveal, or
  hang the stream. This is the fail-closed contract for the new live codepath.

---

## Part B — Speak the results in a British voice

Voxi's spoken voice is **ElevenLabs "Samara X"** (British, dry) — live-proven (`spikes/live-tts.ts`, needs
`ELEVENLABS_API_KEY`; the `voice_id` is hardcoded in code, no env). We add a BFF speech route + client playback on the reveal.

### B1. BFF route `POST /v1/threads/:id/speech` (new) — SERVER-AUTHORITATIVE text

**Eng-review decision: the narration text is server-owned, NOT client-supplied.** The repo ethos is
"the BFF never trusts the client." So the client sends **no text** — it just asks to hear *this thread's*
narration, and the server voices the exact honesty-gated clauses it already produced. This removes the
"client makes Voxi say anything" abuse surface entirely.

- **Capture:** the `EveClient` gains `narrationText?(sessionId, userId): Promise<string | null>`. Both real
  clients capture it generically: while streaming, they accumulate `token` event text per session (the same
  approved clauses the app renders as `whatItIs`). `CascadeEveClient` (prod) and the E2E harness eve adapter
  both implement it; the test fake returns a fixed string. Since processing **drains the whole stream before
  routing to reveal**, the text is captured server-side before the reveal ever requests speech.
- New `NarrationTtsProvider` seam in `Deps`: `speech?: { tts: { synthesize(text: string): Promise<Uint8Array> } }`.
- `LiveNarrationTts` (`services/voxi-api/src/live-tts.ts`) → ElevenLabs George, mp3 (reuses the proven
  `spikes/live-tts.ts` request shape). Wired in `server.ts` from env; **absent env → route 503 (loud, not fake)**.
- Route order (fail-closed, mirrors `voice-routes.ts`): auth (401) → **thread-ownership ACL** (403) →
  `speech` configured? (503) → read server-owned `narrationText` (→ 404 `no_narration` if none / empty) →
  synthesize → return `audio/mpeg` bytes. A synth error → 502 (loud, non-fatal on the client).
- Not metered (the spoken reveal is part of the free core experience); ACL + server-owned text bound abuse.

### B2. Client: `ApiClient.speakNarration(threadId)`

`app/src/lib/apiClient.ts` — POST to `/v1/threads/:id/speech` (no body), read `arrayBuffer()`, return a
**base64 `data:audio/mpeg` URL** (cross-platform playable source; web `<audio>` and native both accept a data
URI via the seam below). On 404 `no_narration` / 502 → return `null` (caller no-ops gracefully).

### B3. Reveal screen: repurpose the play orb to actually speak

`app/app/reveal.tsx`:
- The `reveal.playNarration` orb currently (incorrectly) navigates to `/podcast`. **Repurpose it** to
  **play/pause the spoken narration** of *this* reveal.
- Render an `AudioElement` (new id `reveal.narrationAudio`) fed the TTS data URL; `playing` toggled by the orb.
- **Best-effort autoplay** on mount for CONFIDENT/PROBABLE (browsers may block without a gesture → the orb is
  the guaranteed manual trigger; respects reduce-motion / a future mute pref).
- The podcast path stays reachable via the primary pill + the "Podcast" secondary link (unchanged).
- Native playback seam: `AudioElement` already splits web (DOM `<audio>`) vs native (TrackPlayer). Extend the
  native side (or a small `speakData()` control) to play the short data-URI clip; native audio is device-gated
  like the rest (verified on device, not CI) — the **web path is fully E2E-verified**.

### B4. Registry

Add `reveal.narrationAudio` to `e2e/framework/testids.ts` (`reveal` group). `reveal.playNarration` already
exists — only its behaviour changes.

---

## Contract / blast radius

- **No change** to the NDJSON event taxonomy (`packages/shared/src/events.ts`). Narration still streams as
  `token`s; TTS is a separate lazy fetch. This keeps the 4 converge proofs + stream reconnection intact.
- Enrichment + judge are **optional deps** — every existing cascade/narrator test stays green (fakes don't pass
  them). The honesty gate is untouched.

## Tests & verification (no cheating)

Deterministic (`bun test`, no creds):
- `factsFromGrounding()` mapping (grounded → evidence; ungrounded facts dropped; cap/dedupe).
- Cascade with a `FakeResearcher`: CONFIDENT merges facts into narration evidence; **PROBABLE/UNKNOWN do NOT
  call the researcher**; researcher throw → narration still emitted (non-fatal). Existing cascade invariants
  unchanged.
- Narrator: richer prompt still gate-drops uncited specifics; PROBABLE still forced to hedge (existing tests).
  Batched judge: a cited-but-unsupported clause is dropped.
- BFF `/v1/threads/:id/speech`: 401 / 403 (non-owner) / 503 (no tts) / 404 (no narration captured) / happy
  path returns real `audio/mpeg` bytes from a `FakeTts`; synth throw → 502. Scan quota untouched.
- `EveClient.narrationText` capture: streaming a CONFIDENT scan stores the concatenated token text; a
  non-owner read returns null; UNKNOWN/refusal → null/empty.
- `ApiClient.speakNarration` shape (returns data URL; null on 404/502).

E2E web (real BFF + real reveal screen, no creds — the FakeTts returns a valid tiny MP3):
- Extend `run-sc-reveal-proc.web.ts` (or a converge check): on a CONFIDENT reveal, tap `reveal.playNarration`
  → the client calls the **real** `/speech` route → `reveal.narrationAudio` **plays** (assert via the existing
  `expect.playing()` pattern). Negative control: no `tts` dep → 503 surfaces, no silent success.
- Full regression: `bun test`, `bun run lint:selectors`, all web runners + 4 converge proofs stay GREEN.

Live spikes (cred-gated, run when creds present):
- `spikes/live-research.ts` — grounded facts for a known object (e.g. "1976 Canon AE-1") with source URLs.
- Voice already proven by `spikes/live-tts.ts`; extend `spikes/live-bff-scan.ts` to hit `/speech` end-to-end.

---

## Eng review outcome (applied)

### Data flow (with enrichment + voice)

```
 photo ─▶ BFF POST /v1/threads ─▶ eve.createSession ─▶ processing streams /stream (NDJSON)
                                                             │
   safety_gate ─▶ identify_object (VLM ∥ web ∥ catalog → arbiter) ─▶ confidence_band ──┐
                                                             │                          │ band shown
                                        band == CONFIDENT ?  │                          ▼
                                         ├─ yes ─▶ LiveResearcher.research(label)   [timeout 8s, non-fatal]
                                         │          └─▶ grounded facts (fact+sourceUrl) ─┐
                                         └─ no (PROBABLE/UNKNOWN) ─▶ NO research (hedge)  │
                                                                                         ▼
                                     LiveNarrator.narrate(evidence = web ⊕ facts) ─▶ honesty gate
                                                                                         │ approved clauses
                                                                        stream `token` events ──▶ whatItIs
                                                             │ (eve client also captures token text per session)
   reveal card renders (READY-on-mount) ─── tap play orb ──▶ ApiClient.speakNarration(threadId)
                                                             │
                          BFF POST /v1/threads/:id/speech ── auth ▶ ACL ▶ speech? ▶ narrationText(server-owned)
                                                             │           └─▶ TtsProvider.synthesize (ElevenLabs George)
                                                             ▼
                          audio/mpeg ─▶ data: URL ─▶ AudioElement plays (British voice)
```

### Test coverage map

```
CODE PATHS                                                       USER FLOWS
[+] agent/providers/live-research.ts                            [+] CONFIDENT reveal → hear it
  ├── factsFromGrounding()                                        ├── [★★★ →E2E] tap play → /speech → audio plays
  │   ├── [★★★] grounded fact → evidence w/ sourceUrl            ├── [★★★ neg-ctrl] no tts dep → 503, no fake play
  │   ├── [★★★] ungrounded fact dropped                          └── [★★  ] 404 no-narration → orb no-op
  │   └── [★★★] cap + dedupe
  └── LiveResearcher.research() live ......... [→spike, cred-gated]
[+] agent/cascade.ts (researcher hook)
  ├── [★★★] CONFIDENT → facts merged into narration evidence   [+] Description quality (honesty)
  ├── [★★★ REGRESSION] PROBABLE/UNKNOWN → researcher NOT called   ├── [★★★] PROBABLE still forced to hedge
  ├── [★★★] researcher throws → narration still emitted           └── [★★★] uncited specifics still dropped
  └── [★★★] researcher timeout → non-fatal, band unchanged
[+] voxi-api/src/app.ts  POST /v1/threads/:id/speech
  ├── [★★★] 401 / 403(non-owner) / 503(no tts) / 404(no narration) / 200 bytes / 502(synth throw)
[+] eve clients narrationText()  ── [★★★] capture on CONFIDENT; null for non-owner / UNKNOWN
[+] voxi-api/src/live-tts.ts  LiveNarrationTts ... [→spike, cred-gated] + FakeTts unit
[+] app apiClient.speakNarration() ── [★★] returns data URL; null on 404/502
[+] app reveal.tsx play orb ──────── [★★★ →E2E converge] plays real narration audio

COVERAGE TARGET: 100% of new deterministic paths (live provider + TTS synth are spike-gated, per repo boundary)
```

### Failure modes (each new codepath)

| Codepath | Failure | Test? | Error handling | User sees |
|---|---|---|---|---|
| research call | timeout / 5xx | ✅ | try/catch + 8s timeout → empty facts | honest, slightly-less-rich narration (never worse) |
| research map | ungrounded "fact" | ✅ | dropped in `factsFromGrounding` | never cited → gate-safe |
| /speech | no tts configured | ✅ | 503 loud | orb no-op (not a fake success) |
| /speech | narration not captured | ✅ | 404 `no_narration` | orb no-op |
| /speech | ElevenLabs throws | ✅ | 502 | orb no-op, tappable to retry |
| reveal autoplay | browser blocks autoplay | n/a (design) | tap-gesture orb is the guaranteed trigger | taps to play |

No critical silent-failure gaps: every new path has a test **and** graceful, visible-but-non-fatal handling.

### What already exists (reused, not rebuilt)

- `LiveNarrator` + `packages/shared/confidence` honesty gate — **extended** (richer evidence), not replaced.
- `spikes/live-tts.ts` ElevenLabs George request shape — **reused** by `LiveNarrationTts`.
- `voice-routes.ts` auth→ACL→meter→503 ordering — **mirrored** by `/speech`.
- `AudioElement` (web DOM `<audio>` + native TrackPlayer seam) — **reused** for narration playback.
- `captureStore.whatItIs` (already holds the streamed narration) + `reveal.playNarration` orb — **repurposed**.
- `geminiJSON`/`geminiIdentify` Vertex call shape — **reused** by the new grounded helper.

### NOT in scope (v1)

- **Entailment judge** (A4) — deferred; facts already carry source URLs; marginal gain vs latency/complexity.
- **Progressive narration fill** on the reveal (show card at band-settle, stream narration/audio after) — UX
  refactor; accept the drained-stream wait for v1.
- **Narration audio caching / CDN** — synth per reveal is fine at current volume; revisit on cost signal.
- **Native-device TTS E2E in CI** — device-gated, consistent with the repo's verification boundary (web path
  is fully E2E-verified; native verified on device).
- **Per-vertical fact calibration** — depends on real-data H2, out of scope.

### Parallelization

```
Lane A (agent/eve): live-research.ts + gcp-vision helper → cascade hook → narrator prompt → cascade-eve-client narrationText
Lane B (voxi-api):  live-tts.ts + /speech route + narrationText seam + harness wiring
Lane C (app):       apiClient.speakNarration + reveal.tsx play orb + testids.narrationAudio
```
Lane A and Lane B share the `EveClient.narrationText` contract (B defines the interface, A/harness implement) →
land the interface first, then A and C are independent. Small enough for one sequential pass; no worktree split
needed.

### Implementation Tasks

- [ ] **T1 (P1)** — agent — grounded research provider + `factsFromGrounding` mapping (+ unit tests).
- [ ] **T2 (P1)** — agent — cascade researcher hook, CONFIDENT-only, timeout+non-fatal (+ regression tests:
      PROBABLE/UNKNOWN skip, throw/timeout non-fatal).
- [ ] **T3 (P2)** — agent — richer+succinct narrator prompt; assert existing gate/hedge tests stay green.
- [ ] **T4 (P1)** — voxi-api — `NarrationTtsProvider` seam + `/v1/threads/:id/speech` route + `LiveNarrationTts`
      (+ tests: 401/403/503/404/200/502); wire `server.ts` from env.
- [ ] **T5 (P1)** — voxi-api/agent — `EveClient.narrationText` capture in `CascadeEveClient` + harness adapter
      (+ tests).
- [ ] **T6 (P2)** — app — `ApiClient.speakNarration` + repurpose `reveal.playNarration` to play narration via
      `AudioElement`; add `reveal.narrationAudio` to the registry.
- [ ] **T7 (P1)** — e2e — extend reveal E2E/converge: CONFIDENT reveal → tap play → real `/speech` → audio
      plays; negative control (no tts → 503). Keep all existing runners + converge GREEN.
- [ ] **T8 (P3)** — spikes — `spikes/live-research.ts` (grounded facts) + extend `live-bff-scan.ts` to hit
      `/speech` (cred-gated).

## Out of scope (v1)

See "NOT in scope" above.

## Adversarial review outcome — 10 confirmed / 10 refuted (all confirmed folded in)

A 5-dimension multi-agent adversarial workflow (honesty · security · live-provider · regression · product/UX),
each finding verified by an independent skeptic (default-refute). 20 raw → **10 CONFIRMED, 10 REFUTED**. The
confirmed findings are folded in as these binding amendments (they supersede the body above where they conflict):

**A6 (P1, honesty→feature) — Year via a grounded fact, not a suppressed field.** The narrator prompt today hard-
says "NEVER assert unsupported fields: year", which fights the grounded year fact research now supplies. Reword
`live-narrator.ts` to: *"Do NOT assert these fields UNLESS a `factN` evidence ref grounds them — then label the
clause `date`/`spec` and cite the `factN`: {…}."* Keep the (broadened, see A7) auditor. Test: CONFIDENT
make_model + a FakeResearcher grounded year-date fact → the year appears **citing factN**; an *uncited* year is
still dropped. This is what actually delivers the user's headline **make/model/YEAR**.

**A7 (P2, honesty) — Broaden the flavor auditor beyond numbers.** `smugglesFalsifiable` only catches 4-digit
years + number+unit. A non-numeric falsifiable claim self-labeled `flavor` ("designed by Canon's engineers",
"the first SLR with a microprocessor", "which is why it outsold rivals") sails through uncited — exactly the
"interesting fact" category research surfaces and Part B voices authoritatively. Broaden the narration-path
detector to also flag: proper-noun runs (`/\b[A-Z][a-z]+ [A-Z][a-z]+\b/`, the pattern already used in
render/core tests), superlative markers (first|only|-est|most|least), and causal/comparative connectives
(which is why|because|than|compared to). Tests for each. Correct the A4/§A3 wording that implied the auditor
already covered the invariant.

**A8 (P2, honesty) — Key research on CORROBORATED fields only.** A CONFIDENT web-corroboration proves make +
*base* model (arbitration `corroborates()` strips `(…)` editions and never checks year). So the VLM's year/
sub-variant is uncorroborated — never feed it as a research key or research grounds facts about a possibly-wrong
item. `research()` receives **make + base-model** (strip parentheticals with the same regex); include `year`
**only when `chosen.source !== 'vlm'`** (catalog/web carried it). The `LiveResearcher` prompt treats year/edition
as unknown unless the sources establish it. Test: a VLM-confirmed CONFIDENT with year+"(…Ed.)" → ResearchInput
carries make + base model only.

**A9 (P1, product) — PROBABLE gets class-level grounded enrichment (still hedged).** CONFIDENT-only left the
common non-CONFIDENT reveal generic (the exact complaint). On PROBABLE, research the **least-specific granularity
the candidates agree on** (category / shared make — never the specific model), feed as `factN` evidence, and let
the narrator carry **one** grounded class-level fact **while still hedging** (still no `id` ref → any model/year-
asserting clause is dropped by the gate; the A7 auditor catches smuggled specifics). Same 8s-timeout/non-fatal
contract. Tests: PROBABLE carries a grounded class fact but never the specific model; gate still drops model/year
clauses; researcher throw/timeout on PROBABLE stays non-fatal.

**A10 (P1, security) — /speech is content-hash cached (pulls caching into v1).** Unmetered **and** uncached is a
paid-vendor cost/DoS hole (one HTTP call → one ElevenLabs synth, unbounded; autoplay+tap already double-synths
the same text). Add a `speech.cache?: { get(key), put(key, bytes) }` seam (in-memory fake in tests, object-store
in prod). Key = `sha256(narrationText)`. On hit → return bytes, **zero** vendor call. Absent cache → synth-
through (fail-safe, not fake). Keep the route free-to-user. Test: two POSTs for the same thread → **exactly one**
`FakeTts.synthesize` call (second served from cache).

**A11 (P1, security/honesty) — Idempotent, pinned narration capture.** The narrator is temperature 0.7 and
`stream()` re-runs it on every call (retry, revisit, `?startIndex=` reconnect). Capturing naïvely would double/
truncate the stored text and let `/speech` diverge from the `whatItIs` the user read. Rule: capture the **full**
approved narration keyed by sessionId **on the first run**, tapping the raw cascade token text **before** the
`startIndex` filter, **guarded by an already-captured flag** that refuses to overwrite/append on later
`stream()` calls. Test: a second `stream()` (reconnect and a fresh retry) leaves captured narrationText unchanged.

**A12 (P1, regression) — E2E runs on the real-screen converge proof, not the frozen shell.** `run-sc-reveal-
proc.web.ts` drives the frozen harness shell, which renders **no** play orb / audio element and never calls
`speakNarration`. Move T7 to `e2e/web/converge/reveal-rnw.web.ts` (real `reveal.tsx` under RNW + real BFF):
(1) add a **CONFIDENT** seed path (it only runs PROBABLE today); (2) extend `createWebHarness` with an optional
**FakeTts** speech dep (the harness *wiring* is editable; only the HTML shell is frozen); (3) land the app
changes first so `reveal.playNarration` (a Pressable, so tappable under RNW) + `reveal.narrationAudio` reach the
DOM. Assert: CONFIDENT → tap play → real `/speech` → `narrationAudio` plays (`expect.playing()`); negative
control = harness **without** the FakeTts dep → 503, orb no-op. `reveal.narrationAudio` surfaces as an
informational app↔harness divergence in `testid-coverage.ts` (not a hard failure — `playNarration` already is).
The **FakeTts must return a genuinely valid tiny MP3** (bundled Playwright Chromium decodes MP3 fine; a WAV stub
would diverge from the prod `audio/mpeg`).

**A13 (P2, product) — Audio pref, not reduce-motion; ship a stop control.** Do **not** gate autoplay on
reduce-motion (a *motion* signal). Add a persisted **"Speak results aloud"** pref (default ON) in Settings; gate
autoplay on it. The play orb doubles as the **stop/replay** control (a real in-v1 way to silence Voxi in a shop).
Native auto-plays when the pref is ON; web attempts autoplay and falls back to the orb tap — the orb is the one
universal manual trigger. Test: pref OFF → no autoplay on either surface; orb still works.

**A14 (P3, product) — Gate the orb's RENDER, not just autoplay.** On UNKNOWN/empty-narration reveals `/speech`
404s and the orb no-ops → a dead affordance. Render `reveal.playNarration` + `reveal.narrationAudio` **only when
narration exists** (`(band==='CONFIDENT'||band==='PROBABLE') && whatItIs`). (Also removes today's stray
navigate-to-/podcast on UNKNOWN.)

**A15 (P3, build) — Correct binary body type.** Declare the seam
`synthesize(text): Promise<Uint8Array<ArrayBuffer>>` (bare `Uint8Array` = `ArrayBufferLike` fails `tsc` against
Hono's `Data`). Impl + FakeTts return `new Uint8Array(await r.arrayBuffer())` / `new Uint8Array(mp3.buffer)`.

**Non-blocking nuggets folded from refuted findings:** (i) `CascadeEveClient.purgeUser` also clears the
narration map (one line beside the photos purge). (ii) The research/synth timeout uses `AbortController` (not a
bare `Promise.race`) so a hung fetch is actually aborted, no leaked socket per reveal.

### Updated Implementation Tasks (supersedes the earlier list)

- [ ] **T1 (P1)** agent — `live-research.ts` (`Researcher`, `LiveResearcher`) + `geminiGrounded()` helper (NO
      `responseSchema`; `tools:[{googleSearch:{}}]`; AbortController timeout) + `factsFromGrounding()` (from
      `groundingSupports[].segment.text` + `groundingChunks[].web.uri`; drop ungrounded; cap+dedupe). Unit tests.
- [ ] **T2 (P1)** agent — cascade researcher hook: CONFIDENT keys on corroborated make+base-model (+year iff
      non-vlm) [A8]; PROBABLE keys on least-specific-agreed granularity [A9]; timeout+non-fatal. Regression tests
      (PROBABLE class-only, UNKNOWN skip, throw/timeout non-fatal, no-researcher path byte-identical).
- [ ] **T3 (P1)** agent — narrator prompt: specific+succinct+one interesting fact; year via grounded factN [A6];
      PROBABLE one class fact while hedging [A9]; broaden `smugglesFalsifiable` [A7]. Keep all gate/hedge tests
      green + add the new ones.
- [ ] **T4 (P1)** voxi-api — `speech` seam (`tts` [A15] + `cache` [A10]) + `POST /v1/threads/:id/speech`
      (401/403/503/404/200/502; cache-hit → one synth) + `LiveNarrationTts`; wire `server.ts` from env.
- [ ] **T5 (P1)** agent/voxi-api — `EveClient.narrationText` idempotent pinned capture [A11] in `CascadeEveClient`
      (+ purgeUser clears it) and the harness eve adapter (+ FakeTts). Tests.
- [ ] **T6 (P1)** app — `ApiClient.speakNarration`; repurpose `reveal.playNarration` to play/pause via
      `AudioElement`; render-gate the orb [A14]; "Speak results aloud" pref + Settings toggle [A13]; add
      `reveal.narrationAudio` to the registry.
- [ ] **T7 (P1)** e2e — CONFIDENT converge proof [A12]: tap play → real `/speech` → audio plays; negative control.
- [ ] **T8 (P3)** spikes — `spikes/live-research.ts` + extend `live-bff-scan.ts` to `/speech` (cred-gated).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (SCOPE_REDUCED) | 9 issues, 0 critical gaps |
| Adversarial | multi-agent workflow | Independent challenge (5 dims × skeptic) | 1 | CLEAR | 20 raw → 10 confirmed (folded), 10 refuted |

- **CROSS-MODEL:** the adversarial skeptics refuted 10 over-claims (incl. the "unsupported_fields must be
  gate-enforced" and "entailment-judge deferral is a regression" honesty over-reaches) — those are correctly NOT
  actioned. All 10 confirmed are folded as A6–A15 above.
- **SCOPE:** enrichment now covers CONFIDENT (identity-grounded) **and** PROBABLE (class-grounded, still hedged);
  `/speech` is server-authoritative + content-hash cached; capture is idempotent/pinned; verification is the real
  CONFIDENT converge proof.
- **UNRESOLVED:** 0.
- **VERDICT:** ENG + ADVERSARIAL CLEARED — ready to implement the verified final plan.
