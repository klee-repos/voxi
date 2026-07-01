# Prompt-quality overhaul + formal research layer + progressive facts + LLM-judge tests — PLAN

Status: FINAL (plan-eng-review + outside-voice + 5-lens adversarial workflow folded). Ready to implement.
Author: Claude. Date: 2026-07-01.

### Locked decisions

1. **Research is ASYNC; the reveal never blocks.** The reveal fires on band-settle (title + a fast first-pass
   description on existing evidence, today's latency). Deep research runs off the reveal path; its outputs arrive
   as **late stream events on the same open stream** (see §3.B4 stream lifecycle) and land durably.
2. **Facts stream in one-by-one, as each is found AND verified**, each rendered as its **own icon/chip**
   (replacing the single tray), appearing progressively — never a batch at the end.
3. **Every fact carries provable provenance.** `fact` = `{ text, sourceUrl, sourceTitle, quote, index }`; a fact is
   admitted only when the verbatim `quote` is a substring of the fetched source AND the entailment judge confirms
   **`quote ⊨ text`** (see §2.2 — the provenance loop is closed). The `{sourceUrl,quote}` is the durable "proof if
   challenged", saved and shown per fact.
4. **Chat gets the durable dossier + LIVE web lookups** (text inline; voice defers a live lookup to a follow-up
   turn so the sub-second loop is never blocked).
5. **Ship the creds-free wins first.** P1 (title + single-primary + wider grounded description) runs and verifies
   with no new creds; the dossier infra (P2) is second.

### Environment reality (adversarial #13)

This repo is **gcloud-only** today (Vertex Gemini + Cloud Vision on the gcloud token). The deep-research loop's
brain (Claude via `@ai-sdk/anthropic`) and web tools (Firecrawl) are **two net-new paid vendors not present
here** — so any *live* research / tape-record / `judge:reveal:live` is **gated on the user provisioning
`ANTHROPIC_API_KEY` + `FIRECRAWL_API_KEY`**. To keep the loop spikeable + the reveal path verifiable creds-free,
the research provider **falls back to the retained Gemini-grounding source** (`geminiGrounded`, Vertex on gcloud),
and the loop brain may bind to **Vertex Gemini (`@ai-sdk/google-vertex`)** so the full tool-loop runs with no new
vendor. P1 + the deterministic judge gate (replay) + the Gemini-grounded research path are all verifiable here;
the Firecrawl/Claude live tier is the user-provisioned upgrade.

## 0. Problem

La Croix reveal fails three ways, chat is thin:
1. Title all over the place → no reliable, human-friendly name of the ONE primary object.
2. Read-aloud description is filler → not *this thing* at encyclopedia depth.
3. No interesting facts → want **three**, each with provable provenance.
4. Chat can't go deep → "tell me more" only has the thin identification.

**Direction:** a formal deep-research layer on the eve/AI-SDK stack produces one **durable, grounded,
fully-cited `ResearchDossier`** that powers the reveal, the podcast, and the conversation. Research is async; facts
appear progressively with attached source proof; the dossier is durable and reused everywhere. **Keep the
persona:** Voxi, an AI cataloguing *human-made* things — dry, witty, British; encyclopedia *depth*, Voxi's *voice*.

## 1. Current state (code-cited)

- **eve = the Vercel AI SDK stack.** `agent/agent.ts`: root agent `voxi`, brain Claude Sonnet 4.6
  (`@ai-sdk/anthropic`, `ai@7`), durable postgres world (`@workflow/world-postgres`). Self-hosting the durable
  world off-Vercel is UNPROVEN (agent.ts header). The AI SDK's own `generateText`+tools loop runs WITHOUT the
  durable world — that is the research engine (§2.6).
- **Subagent pattern.** `subagents/storyteller/index.ts`: pure `buildX(input, proposedDraft, opts)` runs the real
  honesty gate → closed claim-structured output. Its draft is single-shot; a *research* draft is multi-step
  tool-looping (§2.6 keeps it runnable/testable).
- **Identify → title.** `identify-object.md` + `geminiIdentify()` (`lib/gcp-vision.ts:79`) → VLM fields;
  `Candidate.name=[year,make,model].join(' ')` (`live-vision.ts:104`). No single-primary rule / clean title.
  Title = `result.label` → `confidence_band.title` (`cascade.ts:141`). `IdentifyResult` carries
  `granularity_level` — the confirmed specificity (used for the class-scope guard, §3.B2).
- **Enrich + narrate are INLINE + SERIAL.** `cascade.ts:156-171` `await researcher.research()` THEN
  `await narrator.narrate()` THEN first `token` — a dossier-cited description would block the first word. The
  instant reveal keeps the fast narrator on existing evidence; the dossier upgrades the description LATE.
- **Honesty gate.** `validateClaims` (`confidence.ts:77`) checks each clause against its ONE cited `evidence.ref`;
  the `EntailmentJudge` (`confidence.ts:54`) grades **`evidence.claim ⊨ clause.text`** and is **currently OFF**
  (`LiveNarrator` constructed with no judge, `live-narrator.ts:84`). `Evidence` (`confidence.ts:47`) has **no
  `quote` field**. Every producer sets `evidence.claim` to model-authored text (`live-vision.ts:135` page title;
  `live-research.ts:59` a Gemini answer segment). ⇒ the provenance fix (§2.2) must feed the *quote* to the judge.
- **Facts.** None. `events.ts` union (`token|tool_start|tool_result|confidence_band|partial_id|error|done`) has no
  `fact`; `parseEventLine` THROWS on unknown (`events.ts:30`). The app consumes NDJSON via `parseEventLine` in its
  stream generator — a throw **kills the whole reveal stream** for that client; the app is a **shipped App-Store
  binary bundling its own `packages/shared`** ⇒ tolerant reader needed BEFORE emitting `fact` (§2.4).
- **Stream + persistence.** `cascade.ts:174` yields terminal `done` then returns; the BFF drains
  `deps.eve.stream()` in a `for await` and `controller.close()`s (`app.ts:446-494`); `processing.tsx` navigates to
  reveal on `done`; `reveal.tsx` renders a drained `captureStore` snapshot and opens no live stream. `RevealStore`
  is **first-write-wins** (`app.ts:478`), `RevealRecord` stores `events: StreamEvent[]` + `narration`;
  `replayReveal` (`app.ts:264`) iterates `events` filtered by `ev.index < startIndex` (persist replay gated to
  `startIndex===0`). The refund tap (`app.ts:456-464`) fires once-ever `markRefunded` on any `error` code
  `safety_refusal|hard_failure`, **not** guarded on whether a band already settled. `/speech` reads the frozen
  first-pass `narration` (`app.ts:514`) / the NarrationStore (refuses overwrite, `narration-store.ts`).
- **Reveal UI.** `reveal.tsx` renders `title`/`whatItIs`/quip/candidates; `whatItIs` from `token` events
  (`captureStore.ts:54`). No facts UI. testIDs `app/src/lib/testid.ts` ↔ `e2e/framework/testids.ts`.
- **Conversation.** Voice-bot `item_context: str` → `voxi_voice/prompts/item-context.md` (`providers.py:294`);
  `bff_bridge.py` bridges tools + transcript write-back. Voice loop is sub-second (a ~6s crawl can't block a turn).
- **Storyteller reuse.** `StorytellerInput={subject,evidence,sources}` — dossier maps directly.
- **Determinism.** `createWebHarness` uses a fake `eveStreamFor` (`server.ts:55`); `vendor-tape.ts:27` keys on
  `sha256(stableStringify(req))` — chained provider tapes drift-couple ⇒ tape the end-to-end reveal per fixture
  (§3.D).

### Data flow (target)

```
 photo ─► safety_gate ─► identify_object ─► arbitrate ─► confidence_band{title=displayTitle}
                                              │            + first-pass token description (existing evidence)
                                              │            └─► client NAVIGATES to reveal on band-settle (NOT on done)
                                              ▼                    stream stays open; done DEFERRED to true end
   ASYNC research (same open stream; AI-SDK generateText tool-loop, bounded maxSteps + Firecrawl fan-out cap):
     find a candidate fact ─► fetch source ─► verifyQuote(quote ⊆ source) + sourceMatchesSubject
                              + judge(quote ⊨ text) ─► VERIFIED ─► emit fact{...,index} (append to shared store)
     synthesize overview ─► (visual-only v1) emit description-upgrade  ─────────────────────────────────┐
   dossier{subject,scope,overview[],facts[],evidence[],sources[]} ─ persist RevealRecord.dossier (idempotent late) │
        ├─► reveal "Curious facts": each verified fact = its own chip + tap-to-see source proof  ◄────────┘
        ├─► richer description replaces first-pass (visual)         done emitted once, after the last fact
        ├─► podcast storyteller (input ← dossier)
        └─► conversation item_context (+ LIVE web_search/web_crawl; voice defers to a follow-up turn)
   revisit / reconnect: replayReveal yields pinned events[], THEN synthesizes fact+description-upgrade events
                        from RevealRecord.dossier at indices continuing past `done`.
```

## 2. Principles & invariants

1. **Honesty gate is load-bearing.** Depth + facts come from MORE grounded evidence, never a weaker gate. UNKNOWN →
   no dossier/facts; PROBABLE → class-level (deterministic guard, §3.B2); CONFIDENT → may assert the identity.
2. **Grounding is a CLOSED provenance loop (adversarial #1, the marquee guarantee).** For every dossier fact:
   `buildDossier`/the provider builds the gate `Evidence` with **`claim := the verified verbatim quote`** (not a
   model paraphrase/title) and `sourceUrl := fact.sourceUrl`; a fact is admitted only if **BOTH** hold:
   (a) `verifyQuote`: the `quote` is a **minimally-normalized (case + whitespace only)** substring of the fetched
   source **AND** `sourceMatchesSubject` (the fetched page's subject — title / URL slug / reverse-image entity —
   matches the dossier subject's make/model, so a bare-spec quote from a *different* model's page is rejected);
   (b) the **entailment judge** grades **`quote ⊨ fact.text`** (over the verified external quote, NOT model text).
   `verifyQuote`+`sourceMatchesSubject` are the deterministic external anchors and the primary defense; the judge
   is a **fallible model** (`confidence.ts:15`) that **fail-closes on low confidence** and, where feasible, uses a
   **different provider than the drafter** — never relied on alone. Reuse the `EntailmentJudge` seam; the only
   change is that its evidence carries the quote.
3. **BFF is the only public surface; ownership server-derived.** Dossier is owner-scoped on the reveal record.
4. **Forward-compatible stream (adversarial #10).** The client's tolerant parser reads the `.type` discriminator
   FIRST and skips ONLY types not in the known set; a KNOWN type that fails schema validation still throws/logs
   loud (never a blanket try/catch around `StreamEvent.parse`). Shipped before `fact` is emitted.
5. **The LLM never decides CI pass/fail.** CI gate = deterministic structural assertions + per-assertion negative
   controls. The `--live` LLM judge measures/reports vs a committed baseline and is **not in `bun test`** —
   re-record is a creds-gated checkpoint with human promotion (§3.D), never a silent CI flake.
6. **Research runs on the AI SDK, not the durable world (adversarial #13).** The live draft is a bounded
   `generateText`-with-tools loop injected into `cascade.ts` as a provider — runnable/spikeable/tapeable with
   creds; creds-free here via the Gemini-grounding fallback (loop brain optionally Vertex Gemini). The **per-fact
   `gate + verifyQuote + sourceMatchesSubject` is ONE shared primitive** called identically by the live provider
   (inline, per fact, as it streams) and by pure `buildDossier(input, draft)` (over each fact in a supplied draft)
   — the code that admits a live fact IS the code under test, covered creds-free from both `buildDossier` and the
   provider unit (faked web tools). The eve `researcher` subagent is a thin durable wrapper; the reveal path never
   depends on it.
7. **No cheating.** Recorded/replayed tapes or live — never stubbed green. Golden prompt tests updated in lockstep.

## 3. Workstreams (phase order §3a)

### A. Single primary object + human-friendly title (creds-free, P1)

- `identify-object.md`: focus on the **single most prominent human-made object**; ignore background/incidental;
  read badges/OCR on that object. New outputs `display_title` (2–5 words, Title Case) + `subject_note` (audit).
- `ID_SCHEMA`/`GeminiId` add the fields; `Candidate.displayTitle?` + `IdentifyResult.displayTitle` (VLM-set,
  display-only; arbitration unchanged). CONFIDENT title → `displayTitle ?? label`; PROBABLE/UNKNOWN unchanged.
- Tests: update `identify-object.md` golden; candidate-mapping; arbitration passthrough.

### B. Formal deep-research layer — `researcher` (AI-SDK loop) → durable `ResearchDossier` (P2)

**B1. Web tools** `tools/web_research.ts`: `WebResearchProvider` seam + `LiveFirecrawl` (`/v2/search` +
`/v2/scrape`, markdown/onlyMainContent), `FIRECRAWL_API_KEY`-gated, per-call `AbortController` ~6s, best-effort;
**Gemini-grounding fallback source kept**. Registered in `AGENT.tools` (also live in chat, §3.E).
`.env.example` += `FIRECRAWL_API_KEY`, `ANTHROPIC_API_KEY`.

**Cost & rate-limit posture (adversarial #11):** a concrete per-scan research budget — **`maxSteps` ≤ 8**, a
**hard Firecrawl fan-out cap (≤ 4 search+scrape calls/scan)**, and the resulting token+crawl ceiling; Anthropic /
Firecrawl rate-limit posture under load. The dossier is **owner-scoped / per-RevealRecord**, so the same subject
is re-researched per user — **cross-scan dedup is deferred (§7)**, routed (when built) through the existing
`promote.ts` moderation-hold path keyed on the catalog embedding-bucket+category (never a `displayTitle` cache,
never bypassing the owner-scoped ACL / moderation).

**B2. Research provider + `researcher` subagent.**
- **Live provider** (`providers/live-research.ts`, evolved additively — the existing `researchPrompt` +
  `factsFromGrounding` stay as the fallback source): a bounded AI-SDK `generateText` tool-loop that **finds facts
  one at a time**; for each fact it applies the shared per-fact primitive (§2.6) — `verifyQuote` +
  `sourceMatchesSubject` + `judge(quote ⊨ text)` — and, if VERIFIED, **yields it immediately** (progressive), then
  continues; finally synthesizes the `overview`. The loop is **seeded from `researchPrompt`**: at `'item'` scope
  the make+base-model, at **`'class'` scope the CATEGORY ONLY** (preserving `live-research.ts:70-76` keying — the
  primary structural scope defense). Exposes an async iterator (`{fact}`… then `{overviewReady}`).
- **`subagents/researcher/{index.ts,SUBAGENT.md}`** — `SUBAGENT.md` = the deep-research spec (authoritative
  sources, cross-check, cite everything with a verbatim quote; class scope names no make/model). `index.ts` pure
  `buildDossier(input, proposedDossier, opts)` = the shared per-fact primitive over each drafted fact +
  `OUTPUT_SCHEMA`:
  - ≥1 overview clause; **≥3 verified facts** or surface survivors, **never fabricate**;
  - every falsifiable clause cited; each fact carries `sourceUrl`+`quote` and passes the closed provenance loop;
  - **class-scope predicate (deterministic backstop, adversarial #6):** reject any fact whose `text` OR `quote`
    names an entity more specific than the confirmed `granularity_level` from `identify_object` — a proper-noun /
    token check against the confirmed subject terms (NOT `smugglesFalsifiable`, which is the flavor auditor and
    never runs on a typed grounded fact);
  - **atomic-claim rule (adversarial #7):** one `evidenceRef` ⇒ one atomic claim; a clause may NOT fuse two
    evidence facts into a new causal/superlative/comparative relation — split into separately-cited clauses or drop.
  Registered in `AGENT.subagents` as the durable wrapper. Tests supply `proposedDossier` directly (creds-free).

**B3. `ResearchDossier`** (`packages/shared/src/dossier.ts`, Zod):
```
DossierFact     = { text, claimType, evidenceRef, sourceUrl, sourceTitle, quote, index, order }  // provenance + replay order
ResearchDossier = { subject, scope:'item'|'class', overview: Clause[], overviewIndex: number,
                    facts: DossierFact[], evidence: Evidence[], sources: Source[],
                    provenance:{model,generatedAt,toolCalls} }
```
`index`/`order` (adversarial #2/#4) let the durable revisit reconstruct fact + description-upgrade events at the
exact monotonic indices reconnection depends on.

**B4. Async orchestration, stream lifecycle, persistence.**

*Stream lifecycle & `done` semantics (adversarial #1/#3, decision — model (a) deferred-`done` on one stream):*
`cascade.ts` flushes the instant reveal (band + first-pass `token`s) at today's latency, but **the client
navigates to reveal on band-settle, NOT on `done`** (`processing.tsx` routes when `captureStore.band` settles; the
shared `captureStore` keeps being appended by the still-running stream consumer, and `reveal.tsx` renders it
reactively). The cascade then drives the research provider on the **same open stream**, yielding each verified
`fact` and (when ready) a `description-upgrade`, and emits the terminal **`done` exactly once** after the last late
event (bounded by the research timeout). The BFF does **not** `controller.close()` (and defers `RevealRecord`
persistence, currently pinned at first drain) until that deferred `done`. In prod the poller/schedule that runs
research **appends** fact/upgrade events to the durable eve session; the still-open `eve.stream` subscription
forwards them, so a separate worker never needs the request-scoped controller.

*One index authority (adversarial #4):* the instant reveal and the research writer share a SINGLE monotonic
`index` sequence per session; events appended to the durable session/event log get the next `index` atomically at
append time (the cascade's local `i` is only the pre-persistence seed; a fresh 0-based counter is forbidden — the
reconnection filter `ev.index < startIndex` would drop them). A re-run worker is idempotent on already-appended
fact indices.

*Refund-tap safety (adversarial #9):* phase-2 research/enrichment failures are swallowed to "facts absent" and
**MUST NOT emit any terminal `error`** (never `hard_failure`/`safety_refusal`) on the reveal stream — those codes
are reserved for phase-1 identification failure that drives the once-ever scan refund. The refund tap
(`app.ts:456-464`) is additionally **hardened to fire only before a reveal has settled** (guard: no
CONFIDENT/PROBABLE band seen yet in this drain).

*Persistence + revisit (adversarial #2):* on completion the dossier is written to **`RevealRecord.dossier`** via an
**idempotent late update** (owner-scoped; NOT first-write-wins on that field; late fact/upgrade events live **only**
in `dossier`, never in the pinned `events[]` — no double-emit). `pg-stores` `get()` rehydrates `dossier`. The
durable-revisit branch (`replayReveal` / `GET /stream`) detects a persisted `dossier` and, **after** yielding the
pinned `events[]`, synthesizes one `fact` event per `dossier.facts[]` plus one description-upgrade from
`dossier.overview`, at the persisted indices (continuing past the stored `done`). A mid-scan `?startIndex=` past
`done` yields only the dossier-sourced facts. Best-effort + bounded throughout: any research failure leaves the
instant reveal exactly as today.

### C. Progressive facts + richer description (with provenance) (P2)

- **`fact` event** `{type:'fact', index, text, sourceUrl, sourceTitle, quote}` in `events.ts` (union +
  `parseEventLine`). Plus a **`description-upgrade`** event carrying the upgraded description text (visual). Emitted
  as each fact verifies.
- **Client forward-compat FIRST (§2.4):** the tolerant parser (type-discriminator-first skip; malformed known type
  still throws) ships before any `fact`. Then `captureStore` `facts: DossierFact[]` + `appendFact`;
  `whatItIs`-upgrade handler; `apiClient` routes `fact`→`appendFact`, `description-upgrade`→upgrade.
- **UI = individual progressive icons (decision 2):** `reveal.tsx` renders each fact as its own chip/icon
  (`reveal.fact`, container `reveal.facts`) appearing one-by-one; each has a **source affordance**
  `reveal.factSource` (tap → sourceTitle + quote + link). Replaces the single tray. testIDs both registries.
- **Description depth:** re-narrated from `dossier.evidence` when ready → a `description-upgrade` that replaces the
  first-pass **visually**. `LiveNarrator` gains the dossier + the **entailment judge turned ON** (§2.2) + the
  **atomic-claim rule**; `narration.system.md` keeps persona, budget ~60–110 words, 4–7 clauses. The instant
  first-pass narrator (existing thin evidence, P1 budget-bumped prompt) is unchanged.
- **`/speech` (adversarial #8 — decision: VISUAL-ONLY v1):** the dossier description-upgrade + facts are
  **visual-only in v1**; `/speech` voices the **P1 budget-bumped first-pass description** (the immutable
  first-write `narration`). Voicing the dossier description / a fact is a fast-follow (would need `/speech` to
  prefer a mutable `dossier.overview`-derived field). Noted, not built now.
- **Lockstep `fact` consumers (each tested):** shared union+parse (+tolerant path); tolerant client handler; BFF
  `/stream` passthrough (forwards, doesn't whitelist) **and its refund tap** (§B4); fake `eveStreamFor` + shell
  loop; converge test; reconnection replay + the durable-revisit dossier synthesis (§B4).

### D. LLM-judge test framework (deterministic gate + non-gating live judge) (P3)

**D1. Real-cascade converge seam + fixture-level tapes.** `HarnessOpts.eve?` (default `eveStreamFor`); the judge
rig injects a real cascade. **Determinism:** tape the **end-to-end reveal output per fixture** (`{title,
description, facts[]}`), keyed by the **fixture id**. Re-record is **deliberate + creds-gated** (`judge:reveal:live`):
its operator re-runs the deterministic gate and sees any threshold miss before committing — never a silent CI flake.

**D2. Fixtures** `e2e/judge/fixtures.ts`: La Croix, Canon AE-1, Cannondale SuperSix EVO + a **cluttered scene**.
Use **committed immutable source snapshots** (frozen markdown/HTML or Wikipedia `oldid` permalinks — never bare
editable URLs); pick **high-density subjects** so ≥3 verified facts is reliable at record time. Each fixture
declares `requiredDescriptionTokens` + a title allowlist/regex.

**D3. Deterministic gate (the ONLY CI pass/fail) + per-assertion negative controls.** Read via testIDs, assert:
**title** ≤6 words, matches the fixture's title allowlist/regex (not one hard-coded string), not a banned
bare-category; **description** contains ≥1 of the fixture's `requiredDescriptionTokens` (positive, per-fixture; the
≥45-word + not-a-template checks secondary); **facts** ≥3, distinct, each with a non-empty `quote` that is a
substring of its cited source + a `sourceUrl` ∈ the stream's evidence sources (provenance asserted), ≠ description.
**Split negative controls** (each turns the gate RED for exactly its assertion): (a) bare-category title only;
(b) description missing required tokens; (c) <3 facts; (d) a fact whose quote isn't a substring of its source;
(e) a fact whose quote is real-but-on-a-different-subject page (`sourceMatchesSubject`); (f) a fact whose real
quote does not support its text (`quote ⊭ text`); (g) a class-scope (PROBABLE) fact naming a specific model.

**D4. LLM judge = measurement, NOT a CI gate.** `judge.ts` `Judge` seam (Claude via `@ai-sdk/anthropic`, or a
different provider than the drafter where feasible); rubrics title/description/facts/dossier. `judge:reveal:live`
records to a **staging tape path** and prints per-fixture scores + a before/after delta vs `baseline.json`;
**promotion into the committed CI golden is an explicit human-reviewed step** (review the `{title,description,
facts[]}` diff + the score delta). Never wired into `bun test`.

**D5.** `e2e/judge/run-reveal-judge.web.ts`; `package.json` `judge:reveal` (replay, deterministic gate + negative
controls) + `judge:reveal:live` (record-to-staging + measure). Extend `lint:selectors`.

### E. Conversation & voice reuse (dossier + live lookups) (P4)

- BFF serves the owner-scoped dossier; `item_context` enriched with subject + compact overview + facts (with
  sources) + evidence refs → honesty-gated "tell me more".
- **Live lookups:** web tools available to the root agent. **Text chat**: inline; the web result is closed evidence
  (sourceUrl) through the same gate; the reply cites it. **Voice** (sub-second): acknowledge ("let me check…") and
  return the grounded answer in a **follow-up turn** — a live crawl never blocks the media loop. No dossier
  re-research.
- `item-context.md` + `instructions.md`/`skills/voice.md` gain a `research_dossier` + live-lookup section.
- Tests: voice-bot pytest (item-context renders the dossier; ungrounded follow-up refused; a live-lookup claim
  cites its source); TS (dossier route owner-scoped ACL + durable replay).

## 3a. Phasing

- **P1 — Title + single-primary + wider grounded description (A + narration budget).** Creds-free; runs+verifies
  today. Update goldens. Ship + measure first.
- **P2 — Research layer + progressive facts (B, C).** Tolerant client FIRST → `fact`/`description-upgrade` events +
  provenance → web tools → AI-SDK research provider + `buildDossier` (shared per-fact primitive) → `ResearchDossier`
  → deferred-`done` stream lifecycle + one-index authority + `RevealRecord.dossier` persistence + revisit synthesis
  → progressive facts UI. Entailment judge turned on only after its FP/miss-rate is measured acceptable on the
  golden set (adversarial #1).
- **P3 — Judge framework (D).** Validates P1+P2 (replay gate + negative controls; live measurement report).
- **P4 — Conversation reuse (E).**

## 4. File-by-file

**Prompts/specs:** `identify-object.md`, `narration.system.md`, `subagents/researcher/SUBAGENT.md` (NEW),
`skills/voice.md`, `instructions.md`, voice-bot `item-context.md`.
**eve-agent:** `agent.ts` (register web tool + researcher); `lib/gcp-vision.ts` (`display_title`/`subject_note`);
`tools/identify_object.ts` (`displayTitle`); `providers/live-vision.ts` (map it); `tools/web_research.ts` (NEW);
`subagents/researcher/index.ts` (NEW `buildDossier` + shared per-fact primitive + class-scope predicate +
atomic-claim + `OUTPUT_SCHEMA`); `providers/live-research.ts` (evolve to AI-SDK tool-loop provider streaming
verified facts; keep grounding fallback); `providers/live-narrator.ts` (dossier + entailment judge on +
atomic-claim; description-only + budget); `cascade.ts` (displayTitle title; deferred-`done` lifecycle; drive
research provider → progressive `fact`/`description-upgrade`); `schedules/` (research worker, prod).
**shared:** `dossier.ts` (NEW); `arbitration.ts` (`Candidate.displayTitle?`); `events.ts` (`fact` w/ provenance +
`description-upgrade` + **tolerant `parseEventLine` variant**: type-first skip, malformed-known still throws);
`confidence.ts` (extend `Evidence`/the judge path to carry the verified `quote` so `judge(quote ⊨ text)` — the
minimal change §2.2 requires).
**BFF (voxi-api):** `RevealRecord.dossier` field + idempotent late update + `pg-stores.get()` rehydrate;
`replayReveal`/revisit branch synthesizes `fact`+`description-upgrade` from `dossier` (continued indices); defer
`controller.close()`+persistence to deferred `done`; harden the refund tap (fire only pre-settle); owner-scoped
dossier read route; `/stream` passes `fact` through; one-index allocator on the durable event log.
**app:** tolerant stream consumer (type-first skip; malformed-known throws); navigate to reveal on band-settle
(background stream keeps appending to `captureStore`); `captureStore` facts+appendFact+description-upgrade;
`apiClient` routing; `reveal.tsx` progressive fact chips + per-fact source proof; `src/lib/testid.ts`.
**e2e:** `framework/testids.ts`; `web/server.ts` (`HarnessOpts.eve?` + fake `fact` events w/ provenance +
deferred-done model); `e2e/judge/*` (NEW). `.env.example` (FIRECRAWL_API_KEY, ANTHROPIC_API_KEY).

## 5. Test coverage

```
[+] A: display_title onto Candidate / CONFIDENT title       [ADD] live-vision + cascade units; [CRIT] update goldens
[+] events: fact(+provenance)/description-upgrade round-trip;
      tolerant parse SKIPS unknown WITHOUT throwing AND a
      malformed KNOWN type (token missing index) STILL throws [ADD] events unit (both directions)
[+] client stream consumer skips unknown; navigates on
      band-settle; background append keeps filling store       [ADD] apiClient + captureStore units
[+] web_research: absent key → loud/skip                      [ADD] unit; [→SPIKE] spikes/live-firecrawl.ts
[+] shared per-fact primitive (provider inline AND buildDossier):
      admit only if quote⊆source AND sourceMatchesSubject
      AND judge(quote⊨text); drop uncited; drop off-source;
      drop wrong-subject; drop quote-not-entailing-text;
      <3 → survivors never fabricate; class-scope predicate
      drops model-named fact; atomic-claim drops 2-fact fusion [ADD] researcher/index + provider units (creds-free)
[+] dossier zod round-trip incl. index/order                  [ADD] unit
[+] cascade: reveal instant on band-settle; done deferred;
      dossier fail → no facts, reveal ok, NO terminal error;
      success → progressive facts + description-upgrade;
      one monotonic index across phases                        [ADD] cascade units
[+] BFF: RevealRecord.dossier idempotent late update; revisit
      synthesizes fact+upgrade from dossier at indices past
      done; ?startIndex past done → only dossier facts;
      owner-scoped read (user B blocked); refund tap does NOT
      fire post-settle on a phase-2 error                      [ADD] app + app-persistence units
[+] LiveNarrator dossier description + entailment on + atomic  [ADD] unit (persona + gate)
[+] judge deterministic gate + per-assertion NEGATIVE CONTROLS [→E2E] run-reveal-judge (replay)
[+] judge live measurement + baseline delta (staging→promote)  [→EVAL] judge:reveal:live (non-gating)
[+] progressive facts UI: chips appear per event live on FIRST
      view (not only revisit); source proof shows sourceUrl+quote [→E2E] converge reveal-rnw (+facts)
[+] conversation item_context + live lookup gating (voice defer) [ADD] voice-bot pytest + TS route test
[+] entailment judge FP/miss-rate measured on golden set BEFORE
      enabling in the reveal path                              [ADD] a golden-set miss-rate check (P2 gate)
```
**Regression (critical):** `prompts.test.ts` goldens for `identify-object.md` + `narration.system.md` updated
byte-exact in P1.

## 6. Failure modes

| Failure | Handled | User sees | Test |
|---|---|---|---|
| Firecrawl/research down | best-effort → grounding fallback, else none; NO terminal error | instant reveal as today; facts absent | cascade best-effort |
| Synthesis hallucination | closed provenance loop (quote⊆source + sourceMatchesSubject + quote⊨text) | fewer facts, never fabricated/mis-sourced | primitive units |
| Research slow | async; deferred done; never blocks reveal | reveal instant; facts pop in progressively | cascade + converge |
| Stale client gets `fact` | tolerant reader skips unknown; malformed-known surfaces | reveal works; no chips (graceful) | events + apiClient units |
| Phase-2 error on stream | forbidden; refund tap guarded pre-settle | no false scan credit-back | BFF refund unit |
| Dossier read cross-user | owner-scoped ACL | 403/404 | app ACL unit |
| Live lookup in voice | deferred to a follow-up turn | "let me check…" then grounded answer | voice-bot test |
| Judge/live creds absent | loud skip; not in CI | CI green on deterministic gate | run-reveal-judge replay |

## 7. NOT in scope

Cross-user research dedup (per-user re-research; a scaling follow-up via `promote.ts` moderation-hold keyed on
embedding-bucket+category — cost multiplier stated §B1); voicing the dossier description / facts in `/speech`
(visual+proof in v1); podcast dossier wiring (storyteller already takes `{subject,evidence,sources}` — opportunistic
one-liner); multi-object reveal; non-English research; a stronger NLI entailment model beyond the plumbed judge;
eve durable self-host at scale.

## 8. What already exists (reused)

`LiveResearcher`/`factsFromGrounding` (grounding fallback source), storyteller/interviewer subagent pattern,
`validateClaims` + the plumbed `EntailmentJudge` (turn on, feed it the quote), `RevealRecord.events`/`narration` +
`RevealStore`/`pg-stores.ts` (extend with `dossier`, NOT a new store), `StorytellerInput`, the `item_context` path,
`vendor-tape.ts`, converge harness + `reveal-rnw` negative-control pattern, `spikes/accuracy-spike.ts` +
`spikes/live-research.ts`, `promote.ts` moderation-hold (future dedup).

## 9. Parallelization

- **Lane A (P1):** `agent/lib`+`tools/identify`+`shared/arbitration`+`narration.system.md`. Independent, first.
- **Lane B (P2):** `shared/{events,dossier,confidence-quote}` + tolerant client + `agent/{tools/web_research,
  subagents/researcher,providers,cascade}` + BFF (`RevealRecord.dossier` + revisit synthesis + deferred-done +
  refund guard + index allocator) + `reveal.tsx` facts. Internally sequential; the `shared/events` + tolerant
  client sub-step can start parallel with Lane A.
- **Lane C (P3, `e2e/judge`)** and **Lane D (P4, voice-bot + BFF route)** follow B.

## 10. Done + verified

- `bun test` green incl. updated goldens + new units; `typecheck`, `lint:selectors`, voice-bot pytest green;
  existing converge green (facts added).
- `bun run judge:reveal` (replay) GREEN incl. every per-assertion negative control.
- Creds-free here: P1 wins visible; the research provider runs via the Gemini-grounding fallback; the deterministic
  judge gate replays. **Firecrawl/Claude live tier + `judge:reveal:live` are gated on the user provisioning
  `FIRECRAWL_API_KEY` + `ANTHROPIC_API_KEY`** — that run shows title/description/facts/dossier improved vs baseline;
  La Croix → clean title, encyclopedia-depth grounded description in Voxi's voice, ≥3 facts appearing progressively
  each with a tappable source proof.
- "Tell me more" answers from the dossier (+ a gated live lookup when it goes beyond), no re-research.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | Step-0 scope challenge (phased, no cut); 2 user decisions (async, live-chat); creds-free-first + reuse folded |
| Outside Voice | Claude subagent (Codex unavailable) | Independent 2nd opinion | 1 | issues_found | 10 findings; 8 folded (description-blocking, injected-provider, tolerant-client, reuse-record, entailment-on, per-fixture tape, non-gating judge, ship-order) |
| Adversarial | 5-lens Workflow, each finding verified | Refute-by-default hardening | 1 | issues_found | 33 raw → 21 verified → 13 edits (3 P1, 10 P2), all folded |

- **ADVERSARIAL:** 3 P1s closed in this doc — (1) closed provenance loop `quote ⊨ text` fed to the judge;
  (2) durable revisit synthesizes facts+upgrade from `RevealRecord.dossier`; (3) deferred-`done` single-stream
  lifecycle (navigate on band-settle). 10 P2s folded: one-index authority, `sourceMatchesSubject`, deterministic
  class-scope predicate, atomic-claim rule, `/speech` visual-only decision, refund-tap guard, tolerant-parser
  known-vs-unknown branch, per-scan cost bounds + deferred dedup, hardened test gate + staging→promote, §2.6 creds
  honesty + shared-primitive coverage.
- **CROSS-MODEL:** outside-voice + adversarial agreed on the description-latency/persistence gap and the
  stale-client crash; both are closed.
- **UNRESOLVED:** none blocking. Open (deferred, tracked in §7): cross-user research dedup; voicing dossier
  content in `/speech`.
- **VERDICT:** ENG CLEARED — plan is implementable phase-by-phase; the creds-free P1 lands + verifies here, the
  Firecrawl/Claude live tier is user-provisioned. Ready to implement P1.
</content>
