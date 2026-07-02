# Analysis UX redesign — normalized research buckets + icon-dock reveal (morph cards + per-section audio) — PLAN

Status: **IMPLEMENTED + VERIFIED (2026-07-01).** Validated through 3 gates (`/plan-design-review` 6→9 · `/plan-eng-review`
clean · 6-lens adversarial workflow: ~18 raw → 7 confirmed, all folded), then implemented. **Green:** whole TS suite
367/0 (incl. new events/store/narrator/cascade/narration-store/app-route/converge-driver units), `lint:selectors`,
voice-bot pytest, deterministic web-auth E2E, and **all 8 converge runners** — reveal-rnw rewritten to drive the real
dock (buckets flip loading→active/empty, maker never perpetual, per-bucket audio round-trips real `/speech`, the
conversation icon navigates, per-bucket 503 negative control). Visually confirmed via converge screenshots (cream dock,
green/blue lanes, morph card, empty/count states). Live tier (real narrator/TTS producing purpose/maker) is
creds-gated as before; the deterministic path is fully proven here.
Author: Claude. Date: 2026-07-01.

## 0. Intent

Now that Voxi has a formal deep-research layer ([[project-prompt-quality-research-layer]], `docs/PROMPT-QUALITY-PLAN.md`),
redo the **analysis (reveal) UX** around it. Two changes:

1. **Normalize the research into 4 fixed buckets**, always the same four questions about any object:
   - **What it is**
   - **What it's for** (purpose)
   - **Who made it** (maker)
   - **Curious facts** (the interesting facts we already produce)
2. **Reveal UX = an icon dock, not a scroll sheet.** Each bucket is its own **icon** that (a) shows a **loading**
   state while its research is generating, (b) flips to **active** when it lands, (c) on tap **morphs with animation
   into a rectangle card** holding that bucket's content, and (d) on tap **starts that bucket's audio** (Voxi's
   voice). Add a 5th **Ask Voxi** icon (conversation about the item). **Remove the current cream info-sheet ("the
   tray")** that stacks everything in one scroll.

Keep Voxi's persona (dry, witty, British, cataloguing human-made things) and the honesty gate: a bucket that does
not ground out (e.g. "who made it" at PROBABLE/class scope) simply never leaves loading → shows an honest "nothing
to add" — the UI tolerates empty buckets and never fabricates to fill one.

## 1. Locked decisions

- **D1 — Four fixed buckets + one conversation icon.** `what_is_it · purpose · maker · facts` + `Ask Voxi`. The
  four are always the same; content is grounded or absent, never invented.
- **D2 — Icon states: `loading → active` (→ `empty`).** Each research icon breathes (Orb/ring) while its bucket
  streams, lights up when content lands, and — once research completes (`done`) with nothing grounded — settles into
  an honest **empty** state (not a perpetual spinner). The conversation icon is always active.
- **D3 — Tap = morph + audio.** Tapping an active icon morphs it into a content **card** (hero label → grounded body
  → tappable source proof; the facts card shows per-fact chips) AND best-effort auto-plays that bucket's narration;
  the card's play/pause control is the guaranteed trigger. Tap-away / close collapses back to the dock.
- **D4 — Per-bucket audio is real, lazy, server-owned.** Tapping a bucket voices *that bucket's* text via an enum
  extension of the existing `/speech` route (`/speech/:bucket`). Text stays server-owned (the route never voices
  client text). Synthesized on tap, content-addressed cache auto-partitions the clips — never pre-fetch all four.
- **D5 — Minimal contract churn, forward-compatible.** Reuse existing events where possible (`what_is_it` ← the
  existing `whatItIs`/`description_upgrade`, now **scoped to what-clauses only** so buckets are clean partitions;
  `facts` ← existing `fact` events). Add exactly **one** new stream event, `section`, for the two net-new buckets
  (`purpose`, `maker`). Its `bucket` field is `z.string()` (NOT an enum) — the enum lives only on the `/speech/:bucket`
  route param; a `z.enum` in the stream event would crash shipped clients that know `section` but not a future 5th
  bucket value (the tolerant parser skips unknown *types*, not unknown *enum values within a known type* — eng
  review P2-1). New event ⇒ old shipped app binaries skip it via the tolerant parser; graceful degradation to no icon.
- **D6 — `purpose`/`maker` text comes from the ALREADY-gated narrator, section-tagged** — not from new cited
  research facts. This reuses the `validateClaims` clause-vs-`evidenceRef` gate, not `buildDossier`'s `admitFact`.
  **BUT (eng review P1-1) this is a real `narration.system.md` rewrite, not a tagging shim:** today's prompt emits
  "what it is → what it's for → detail → one fact" with **no maker clause** and often *fuses* purpose into the "what
  it is" clause. The rewrite must (a) add an explicit, honesty-gated "who made it" clause, (b) force what-vs-purpose
  clause separation, (c) tag each clause with its bucket, and (d) **re-baseline the `prompts.test.ts` golden**.
  Product expectation: **`maker` is empty most of the time** (forbidden at PROBABLE/class scope; often ungroundable
  at CONFIDENT unless the maker is in the label / a cited source) — the empty-as-honest-answer state (§4.4) is the
  common case, not the exception.
- **D7 — UI-only for identity + trust flow; server owns truth.** Preserve every `reveal.*` / `nav.*` testID and the
  `ConfidenceChip` register; keep the "How sure" evidence panel + candidate correction (the teaching loop). Never
  weaken the BFF/contract or an E2E assertion.
- **D8 — Web/native parity, converge-safe.** All new motion (icon loading, morph, dock) uses RN `Animated` with
  `useNativeDriver:false` (the repo doctrine — `Orb.tsx:10-11`); iconography stays lucide-only (no direct
  `react-native-svg`); carried state rides `data-*` via `tidWith`, not glyph/color.

## 2. Current state (code-cited)

**Reveal screen (`app/app/reveal.tsx`).** `RevealBody` (`reveal.tsx:69`) renders 4 states off `useCaptureStore`:
EMPTY (`:144`), ERROR/REFUSAL (`:159`), LOADING (`:181`), READY (`:211`). READY = full-bleed photo backdrop
(`:224-232`) + a cream **info sheet** in a `ScrollView` (`:240-366`, `styles.sheet` `:390`) holding, in order:
title + `ConfidenceChip` (`:245-252`), quip (`:254`), a "Hear it" narration Pressable + `AudioElement`
(`:260-294`), ONE green primary pill band-branched (`:213-215`, `:297-304`), "What it is" body (`:306-309`),
progressive fact chips (`FactChip` `:44-67`, container `:314-323`), a secondary link row (`nav.openConversation` ·
`nav.openPodcast` · `nav.openContribute`/`reveal.addTip`, `:325-337`), and the auto-elevating "How sure" evidence
panel with candidate options + a correction `TextField` (`:339-364`). **This sheet is "the tray" to remove.** (The
`Tray.tsx` component is the camera-home "recently catalogued" sheet — unrelated to reveal.)

**Narration audio (today).** `hasNarration = (CONFIDENT|PROBABLE) && !!whatItIs` (`reveal.tsx:98`);
`loadNarration()` polls `api.speakNarration(threadId)` up to 6× (`:111-124`); `AudioElement` props are
`{id, src, playing, seekToStartOnPlay, onPlayingChange}` (`AudioElement.tsx:18-26`). The BFF route
`POST /v1/threads/:id/speech` (`services/voxi-api/src/app.ts:530-554`) is **paramless + server-owned**: it voices
only the stored narration for the thread, cache-keys on `sha256(text)` (`app.ts:542`), returns `audio/mpeg`
(`app.ts:553`); TTS is ElevenLabs "George" (`live-tts.ts:11-27`), gated on `ELEVENLABS_API_KEY` (503 otherwise).
`NarrationStore` is `Map<sessionId,string>`, owner-scoped, first-write-pinned (`narration-store.ts:13-32`).
`apiClient.speakNarration` POSTs with no body and returns `data:audio/mpeg;base64,…` (`apiClient.ts:312-333`).

**Events + store.** `StreamEvent` union (`packages/shared/src/events.ts:11-38`): `token · tool_start · tool_result ·
confidence_band · partial_id · error · done · fact · description_upgrade`; every event has `index`.
`fact = {index,text,sourceUrl,sourceTitle(''),quote}` (`:28-35`); `description_upgrade = {index,text}` (`:37`).
`KNOWN_EVENT_TYPES` (`:43-45`) is the tolerant reader's allow-list; `parseEventLineTolerant` (`:59-63`) skips
unknown types (App-Store forward-compat) but throws on a malformed KNOWN type. `captureStore` (`app/src/state/
captureStore.ts`): `appendText` concatenates `token`→`whatItIs` (`:69`), `upgradeDescription` replaces it (`:71`),
`appendFact` idempotent by text+sourceUrl (`:73-74`); `window.__captureStore` E2E seam (`:84-86`).

**Dossier + researcher.** `ResearchDossier` (`packages/shared/src/dossier.ts:55-76`) = `{subject, scope, overview:
Clause[], facts: DossierFact[], evidence, sources, provenance}`. `DossierFact` (`:22-37`) carries provenance; no
bucket field. `buildDossier` (`services/eve-agent/agent/subagents/researcher/index.ts:160-211`) admits a fact only
through the **closed provenance loop** `admitFact` (`:135-153`): `verifyQuote` (quote ⊆ source) +
`sourceMatchesSubject` + class-scope guard + entailment `quote ⊨ text`; never fabricates. **The extract prompt
explicitly FORBIDS definitional "what it is / purpose" facts** (`prompts/research-extract.system.md`) — so today's
`facts` array ≈ **only bucket 4**; buckets 1–3 do not exist as structured output.

**Cascade streaming.** `runIdentificationCascade` (`services/eve-agent/agent/cascade.ts:120`) uses one monotonic
sequencer `at()` (`:126`). Emits `confidence_band` (`:187-192`, the instant reveal), first-pass narration `token`s
(`:210-221`), then an **async research block** (`:229-251`, only when `dossier && narrator && band!=='UNKNOWN'`):
`ResearchEvent 'fact' → fact` event (`:234-235`); `'done' + dossier →` re-narrate over `dossier.evidence` → ONE
`description_upgrade` (`:236-244`); deferred terminal `done` (`:253`). Research errors are swallowed (`:247-249`)
and **must never emit a terminal `error`** (refund-tap safety). Narrator (`providers/live-narrator.ts:86-119`)
returns a **flat clause array**; `NARRATION_SCHEMA` clauses are `{text,claimType,evidenceRef}` — **no section tag**,
cannot group by bucket today.

**Persistence + replay.** `RevealRecord.events: StreamEvent[]` is the replay source of truth (`app.ts:90-100`); the
`/stream` route taps every parsed line into `collected` and persists once on first drain (`app.ts:463-517`);
`replayReveal` yields events by `index ≥ startIndex` (`app.ts:264-270`); Postgres stores `events jsonb` verbatim
(`pg-stores.ts:124,322`). **New event types ride `collected` automatically — the ONLY requirement is adding them to
`KNOWN_EVENT_TYPES`.** `buildItemContext` grounds chat from title + narration + `fact` events (`app.ts:279-290`).

**Conversation.** reveal → `router.push('/conversation')` bare (`reveal.tsx:214,326`); `conversation.tsx` reads
`threadId` from `captureStore` (`:36`), builds a voice session (`pipecat.ts:243`), persists/replays turns via
`postMessage`/`listMessages`. Server grounds via `GET /v1/threads/:id/context` (owner-scoped, `app.ts:559-572`).
The screen itself is unchanged by this redesign — only the entry affordance changes.

**E2E converge.** `e2e/web/converge/reveal-rnw.web.ts` drives the **real** `useCaptureStore` from the **real** BFF
fake stream keyed by `?scan=probable|confident|unknown` (`entry.tsx`), asserting via `[data-testid]` + `data-*`
attrs; verdict is `process.exit(fails()===0)`. It models browser autoplay-block (`:34-44`) and asserts
CONFIDENT: `playNarration` + `narrationAudio` render, blocked-on-load, one tap advances `currentTime`, `≥3` facts,
`factSource` reveals the quote (`:104-177`); PROBABLE: chip band, `askVoxi` primary, evidence panel + `howSure`
toggle, nav intent (`:61-100`); a `speech:false` negative control asserts 503 + no audio (`:206-228`).
`flow-rnw.web.ts` drives camera→processing→reveal via `window.__captureStore.setState` and asserts photo
persistence. **Selector lint** (`e2e/framework/lint-selectors.ts`) requires every literal testID to be in
`e2e/framework/testids.ts` and **bans coordinate taps**; `converge/*.web.ts` are governed. The esbuild bundle
aliases `lucide-react-native` → `shims/lucide.tsx` (only listed glyphs exist), aliases reanimated/gesture/skia to a
**throwing** stub, and applies a `#root{height:100vh}` host fix; the web `AudioElement` `<audio>` branch DOES render
in the bundle (no shim needed).

## 3. Principles & invariants (carried from PROMPT-QUALITY §2, must not regress)

1. **Honesty gate is load-bearing.** UNKNOWN → no reveal/buckets (hands off to interview). PROBABLE → class scope;
   maker/specific claims may be dropped → those buckets render **empty**, never guessed. Every bucket's text stays
   grounded (facts through `admitFact`; what/purpose/maker through the narrator's `validateClaims` gate on each
   clause's `evidenceRef`).
2. **Forward-compatible stream.** The one new `section` event is added to the union AND `KNOWN_EVENT_TYPES`; old
   clients skip it via `parseEventLineTolerant` (no crash). We add only OPTIONAL fields to existing events — never a
   new required field (that would crash in-flight binaries).
3. **BFF is the only public surface; ownership server-derived.** The `/speech/:bucket` route re-uses the existing
   owner ACL; text remains server-owned (enum→stored-text map, never client text). No new trust in the client.
4. **Single monotonic index + deferred `done`.** `section` events go through the same `at()` sequencer; `done`
   still fires last. Replay/reconnect stays coherent; persistence rides `collected` with no per-type code.
5. **Refund-tap safety.** `section` production failures are swallowed like research failures — never a terminal
   `error`; the pre-settle refund guard is untouched.
6. **No cheating in tests.** Converge asserts real observable state through stable selectors; the LLM never decides
   pass/fail; the `/speech` negative control stays. New per-assertion negative controls are added (below).

## 4. Target UX (detailed)

### 4.1 READY layout (replaces the scroll sheet)

The dock **keeps the identification AND its one-line description visible on the face** (design review 1a/3c — the
plain narration is Voxi's core payoff; never gate it behind a tap) and **keeps one prominent band-branded primary
CTA** (1b — never dissolve the only CTA into a `·` footer). The icons are the "go deeper + hear it" layer.

```
┌ full-bleed captured photo (unchanged backdrop) ───────────────┐
│ ‹ back                                                         │
│                   (photo peeks ~45% height)                    │
├ compact dock panel (cream, rounded-xl top, NOT a tall scroll) ─┤
│  <Title reveal.title>            [ConfidenceChip band]         │
│  <one-line whatItIs preview reveal.whatItIs — always visible>  │
│                                                                │
│  ┌ bucket dock (reveal.buckets) ──────────────────────────┐   │
│  │  (📖)     (◎)       (❊)      (💡)   ┊    (💬)           │   │
│  │  What    Purpose    Maker    Facts  ┊   Ask             │   │
│  │ bucketWhat …Purpose …Who   …Facts   ┊  conversationIcon │   │
│  │ green lane (audio) · full-ink glyph=has content         │   │
│  │ each data-state=loading|active|empty|unavailable        ┊blue│
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  [ ► Generate story ]  ← reveal.primaryAction (band-branded)   │
│  How sure? (reveal.howSure)              · Add a tip           │
└────────────────────────────────────────────────────────────────┘

(tap an active bucket → card rises + scales from the icon origin: reveal.bucketCard, data-bucket=…)
  ┌───────────────────────────────────────────┐
  │  WHAT IT'S FOR                       (✕)   │  ← FULL question eyebrow + close
  │  <grounded body — the bucket's text>        │  ← purpose/maker text; what reuses reveal.whatItIs (full)
  │  ▸ Source  “verbatim quote” + link          │  ← reveal.factSource-style proof (when sourceUrl/quote present)
  │  [ ► Hear it / ▮▮ Stop / Preparing… ]        │  ← reveal.playNarration + reveal.narrationAudio (auto-plays: gated)
  │  [ What ][ Purpose ][ Maker ][ Facts ]      │  ← LABELED tab strip (tap to switch; NOT swipe — converge-safe)
  └───────────────────────────────────────────┘
```

The **Facts** card lists the existing `FactChip`s (`reveal.facts` / `reveal.fact` / `reveal.factSource`). The
**What/Purpose/Maker** cards show the grounded body + a single source proof (when a `sourceUrl`/`quote` is present).
The **What** card reuses the full `reveal.whatItIs` text (the dock face shows only its first line). All cards carry
the play control (`reveal.playNarration`) + audio element (`reveal.narrationAudio`), whose `src` is the tapped
bucket's clip. `reveal.primaryAction` stays in READY, band-branded: CONFIDENT → "Generate story" (`reveal.
generateStory` → podcast); PROBABLE → "Tell me which is right" (opens the How-sure correction). The conversation
lane is the blue `Ask` icon, not a footer link.

### 4.2 Information hierarchy (what the user sees first → last)

The reveal is the payoff of the scan. Rank (Krug "don't make me think" / hierarchy-as-service):
1. **The identification** — `Title` (Nunito 700 `heading`) + `ConfidenceChip`. Loudest text. This is *the answer*.
2. **The dock** — the four green research icons (ways to go deeper) + the blue Ask-Voxi icon. Second-loudest;
   the icons are the primary interaction.
3. **Secondary** — "How sure?" (evidence/correction), "Podcast", "Add a tip" — a muted footer row.
4. **Backdrop** — the captured photo (context, never competing; it sits behind the dock panel).

Constraint worship: the resting dock shows exactly **title + chip + 5 icons**. Everything else is one tap away.

### 4.3 Colour lanes (design.md two-lane system — load-bearing; review 5a/5b)

design.md keeps **green = audio/primary** and **blue = people/links/conversation** distinct, and warns "no second
accent hue." Applied precisely so green stays *audio*, not overloaded as "active":
- **Active (has content):** the glyph goes **full-ink `text-primary` `#262524`** — "readable/answered." Green is
  NOT the active colour (that would blur green=audio).
- **Green is reserved for the audio lane:** the per-bucket **play control** and the **loading pulse ring**. Tapping
  a research bucket plays Voxi's voice → the audio affordance is green.
- **Ask Voxi** is the **blue people lane** (`surface.accentSecondary` `#3D89F5`), set off from the research four by
  `space.md` + a hairline. Colour teaches "these four narrate; this one talks back" (also fixes the affordance
  mismatch — it *navigates*, it doesn't morph).

### 4.4 Icon state machine (per research bucket) — 4 states

State is conveyed by **motion + fill + label + SR text**, never colour alone: `data-state ∈ {loading, active,
empty, unavailable}`.
- **loading** — content not yet in store AND research not finished. A **thin green pulse ring** (one ring, PulseRings-
  style, design.md green) around a dimmed glyph — "the Guide is looking into it," NOT four competing auroras
  (review 4c) and NOT a generic spinner. Reduce-motion → a static green ring at 40%, no pulse. `data-state="loading"`,
  `accessibilityState.busy=true`. Tap → gentle nudge, no morph.
- **active** — content present. Full-ink glyph; the **facts** icon carries a small **count badge** that grows as
  facts land (CapWords-style progress delight). `data-state="active"`. Tap → morph + audio.
- **empty** — research finished (`researchComplete` on `done`, incl. a durable replay that carried `done`) AND no
  grounded content. This is an **answer, not a disability** (review 3a — the worst emotional failure to avoid):
  the icon stays **clearly interactive** (full-ink glyph, a small neutral "answered · nothing to add" dot — never a
  greyed-out ghost, never `disabled`). Tap → morph to a short **warm, honest** card in Voxi's voice (never "No
  data"): maker-empty → *"The maker keeps their counsel — nothing I can prove."* No audio on an empty card.
- **unavailable** — the stream **errored / went offline before `done`** (review 2c/7g). This is NOT `empty`
  (conflating "couldn't fetch" with "nothing to know" would be a lie about the object and breaks the honesty
  spine). Distinct retriable treatment: a muted glyph + a small retry affordance; SR "…couldn't reach the Guide,
  tap to retry". `data-state="unavailable"`. **Retry is wired (adversarial E):** it re-enters `/processing` with
  `?startIndex=<lastSeenIndex>` (the existing reconnection-replay seam, `nextStartIndex`) to resume the async
  research — NOT a dead no-op (the original stream loop is gone after the drop).

`what_is_it` is **active whenever the band is settled** (CONFIDENT/PROBABLE — the identity is known and narration is
guaranteed to follow), **not gated on `whatItIs` being fully streamed** (adversarial D — tokens arrive after
band-settle, so gating on non-empty text would flip the primary icon loading→active jarringly). Its card renders
`whatItIs` with a brief skeleton if still mid-stream. `facts` flips active on the first `fact`; `purpose`/`maker` on
their `section` event; residual buckets settle to `empty` on `done` (or `unavailable` on stream error). `Ask Voxi`
is **always active**. A bucket that activates while another card is open updates its dock icon (one-shot pulse) AND,
if the open card's tab strip includes it, that tab fills loading→active in place; navigating to a still-loading
bucket shows *its* loading state inside the card, never a blank card (review 2a).

- **Legacy reveals (adversarial B — no false "empty").** A durable reveal persisted **before** this change has no
  `section` events; on replay its `done` sets `researchComplete`, which would derive purpose/maker to `empty`
  ("the maker keeps their counsel") even for objects whose maker/purpose WAS stated (fused into the old `whatItIs`).
  That's a false claim of absence. Fix: detect a legacy reveal (a settled reveal with a non-empty `whatItIs` but
  **zero `section` events** in the replayed stream) and **hide the purpose/maker buckets entirely** (render only
  What · Facts · Ask) rather than asserting them empty — the full old prose still reads in the What card. New
  reveals (which always emit sections, even if empty) show all four.

### 4.5 Bucket → icon (lucide) mapping (review 4b — true signifiers; `Sparkles` dropped)

| bucket | icon (lucide) | lane | why this glyph |
|---|---|---|---|
| what_is_it | `BookOpen` | green (audio) | the catalogue entry / placard — editorial, not "help" |
| purpose | `Target` | green (audio) | what it's *for* / its aim — not `Wrench` (=tools/settings) |
| maker | `Stamp` | green (audio) | a maker's mark — works for hand-made AND industrial, unlike `Factory` |
| facts | `Lightbulb` | green (audio) | a curious/interesting find — **NOT `Sparkles`** (the "AI-magic" slop glyph, wrong for a *grounded* product) |
| conversation | `MessageCircle` | **blue** | talk to the Guide |

Dock captions are short (What · Purpose · Maker · Facts · Ask); the **card eyebrow carries the full question**
("WHAT IT'S FOR", "WHO MADE IT") so no meaning is lost to truncation (review 5e). The distinctive, product-native
bits are the green loading ring + the facts count badge, not the glyph choice. Every glyph MUST be added to
`e2e/web/converge/shims/lucide.tsx` (`Sparkles`/`Play`/`Pause`/`X`/`ChevronLeft` exist).

### 4.6 Interaction-state table (what the user SEES)

```
 SURFACE                | LOADING                       | EMPTY (answered, honest)       | UNAVAILABLE (offline/err)     | ACTIVE / SUCCESS
 -----------------------|-------------------------------|--------------------------------|-------------------------------|----------------------------------
 bucket icon: what      | (n/a — active on mount)       | (n/a — always has what)        | (n/a — from instant reveal)   | full-ink BookOpen glyph
 bucket icon: purpose   | green pulse ring, dim glyph   | done+none → full-ink + "·" dot | stream err → muted + retry dot| full-ink Target glyph
 bucket icon: maker     | green pulse ring, dim glyph   | done+none → "keeps counsel"    | stream err → muted + retry dot| full-ink Stamp glyph
 bucket icon: facts     | green pulse ring, dim glyph   | done+0 facts → full-ink + "·"  | stream err → muted + retry dot| Lightbulb + count badge (3)
 bucket icon: Ask Voxi  | (always active)               | —                              | —                             | BLUE MessageCircle
 morph card (open)      | body skeleton if text pending | warm honest one-liner, no play | "couldn't reach the Guide"+retry | full eyebrow+body+source proof+play
 per-bucket audio       | play ctrl "Preparing…" (poll) | — (no play on empty)           | "audio unavailable — retry"   | play/pause; autoplay GATED (§4.9)
 whole screen: offline  | OfflineBanner; icons hold     | —                              | loading icons → unavailable   | reconnect resumes stream/replay
```

### 4.7 User journey & emotional arc

```
 STEP | USER DOES                    | USER FEELS                 | PLAN SUPPORTS IT WITH
 -----|------------------------------|----------------------------|-------------------------------------------
 1    | photo → reveal lands         | "it knows what this is"    | title+chip loudest; what-bucket instant
 2    | watches icons breathe/light  | "the Guide is digging in"  | Orb thinking (alive, not a spinner); count badge
 3    | taps a bucket                | curiosity → satisfaction   | morph card + Voxi's voice auto-plays
 4    | sees "who made it" empty     | trust (not "broken")       | warm honest empty copy in Voxi's voice
 5    | taps Ask Voxi                | "I can ask more"           | blue lane icon → conversation (grounded)
```
5-second (visceral): the answer + a living dock. 5-minute (behavioral): tap-hear-tap, sources on demand.
5-year (reflective): watching the Guide *write the catalogue entry before your eyes* becomes Voxi's signature.
Break-risk mitigations: what-bucket is instant (no empty wait); loading is the Orb (character, not a hang); every
bucket resolves to active-or-empty on `done` (nothing spins forever).

### 4.8 Motion spec (converge-safe; `useNativeDriver:false`, lucide-only, NO gesture-handler)

- **Icon → card "morph" (review 7b — cheap, not a layout morph):** the card is a **single overlay view** (scrim-
  backed) that animates `opacity` + `translateY` (rises) + a subtle `scale` 0.92→1 anchored at the tapped icon's
  x-origin (measured via `onLayout`), over `motion.base` (240ms) `Easing.out`. This reads as the icon "growing into"
  the rectangle without an expensive per-node shared-element morph — one view, transform+opacity only, same JS-driver
  budget as the existing `Drawer`/`Orb`. Reduce-motion → **opacity cross-fade at final position/size** (no
  scale/translate). Reverse on close.
- **Between-bucket navigation inside the card:** a **LABELED tab strip** (What · Purpose · Maker · Facts) of
  Pressables — NOT anonymous swipe dots (review 4d) and NOT a pan/swipe gesture (`react-native-gesture-handler` is
  aliased to a throwing stub in the converge bundle — a gesture would break it, review 7d). Tapping a tab switches
  the card content; a still-loading bucket shows its loading state inside the card.
- **Dismiss:** a close `X` (card top-right) + tap-scrim (`scrim rgba(20,18,14,0.35)` over a dimmed photo, design.md
  bottom-sheet dismissal). The card uses the **shallow** shadow token only — no glow/heavy shadow (review 5c).
- **Icon activation:** a one-shot green pulse when a bucket flips loading→active (reduce-motion → none).
- **Loading-ring perf (eng review P3-1):** up to 3 buckets can be `loading` at once on first-view. Drive all
  loading rings from a **single shared `Animated.Value`** (one loop, each ring reads it) rather than 3 independent
  JS-driver loops, and stop it when no bucket is loading — keeps within the Orb/Drawer animation budget.

### 4.9 Responsive & accessibility

- **375px:** five icons at ≥44pt targets with ≥`space.sm` (8px) gaps (design.md `hit.min`); row budget ~44 (icon) +
  ~16 (caption); short captions (What · Purpose · Maker · Facts · Ask), full question in the card eyebrow. Larger
  phones/tablets: dock centered with a max-width; cards max-width ~560, centered. Confirm captions scale / reflow
  under Dynamic Type (review 6e).
- **Screen-reader state contract (review 6a — was missing):** each icon `accessibilityRole="button"`,
  `accessibilityState={{ busy: loading, disabled: false }}` (empty is **never** `disabled` — it's a tappable
  answer), and an `accessibilityLabel` that encodes state: "What it's for, ready to play" / "…still researching" /
  "Who made it, nothing found" / "…couldn't reach the Guide, tap to retry". On card open, move SR focus into the
  card; return it to the originating icon on close (review 2g).
- **Autoplay gating (review 6b — do NOT regress):** card-open autoplay is gated on the existing **`speakAloud`**
  pref AND suppressed when a **screen reader is active** (VoiceOver's speech must not collide with Voxi's TTS).
  Autoplay fires **only on initial open, never on tab-switch** (per-switch narration is hostile, review 2f). The
  manual play control is always present. Pre-warm ONLY the `what` clip when its icon goes active (the near-certain
  first tap); the other three stay lazy (review 3b) — balances the cold-start wait against TTS cost (D4).
- **Reduce-motion:** morph → cross-fade; loading ring → static; no activation pulse.
- **Audio is never the only channel:** the card SHOWS the narrated text, so a muted user reads what a listening user
  hears.
- **Contrast:** state is conveyed by motion/shape/label + SR text, never colour alone (design.md `textTertiary` is
  sub-AA by design → decorative only).

## 5. Workstreams

### A. Shared contract (`packages/shared`)

- **`events.ts`:** add one discriminated member after `description_upgrade` (`:37`):
  `section = {type:'section', index:int, bucket: z.string(), text:string, sourceUrl: z.string().default(''),
  sourceTitle: z.string().default(''), quote: z.string().default('')}`. **`bucket` is `z.string()`, not an enum**
  (eng review P2-1 — forward-compat). Add `'section'` to `KNOWN_EVENT_TYPES` (`:43-45`). `parseEventLine` (strict,
  used at the BFF `/stream` tap + `cascade-eve-client.ts:121`) then accepts `section`, so it rides `collected` and
  replays with no per-type code. Round-trip + tolerant-skip-unknown-type + malformed-known-throws unit tests.
- **`dossier.ts`:** **no change.** (Eng review P2-5: `DossierFact.bucket`/`DossierBucket` would be dead weight —
  facts reuse untagged `fact` events; sections come from narrator clause tags. Adding them is back-compat surface
  for no consumer.) The bucket enum used to validate `/speech/:bucket` input is a small const in the route/shared,
  not on the dossier schema.

### B. Backend — produce the two net-new buckets (`services/eve-agent`)

> **Eng-review clarification (which gate, and why it's safe).** `purpose`/`maker` text comes from the **narrator**
> (`live-narrator.ts` → `validateClaims`, the clause-vs-`evidenceRef` gate), **NOT** from `buildDossier`'s fact path.
> The `research-extract.system.md` prohibition on "definitional what/purpose facts" and `admitFact`'s quote-subset
> loop apply only to `DossierFact`s (the **facts** bucket) — they do **not** govern narrator clauses. The narrator
> already produces definitional prose ("what it is → what it's for → a detail") gated against its evidence refs, so
> section-tagging that gated output introduces **no new ungrounded path**. A `maker` clause naming a specific
> manufacturer at PROBABLE/class scope is dropped by the existing register/`namesDisallowedSpecific` guards → the
> maker bucket empties honestly. The narrator prompt gains an explicit (honesty-gated, best-effort) "who made it"
> clause so the bucket has a chance to populate at CONFIDENT scope. **Source proof** for a `purpose`/`maker` section
> = the clause's `evidenceRef` → `dossier.evidence[ref]` (`sourceUrl` + `claim`=verified quote); a clause with no
> falsifiable evidence (pure flavor) emits an empty `sourceUrl`/`quote` and the card simply shows no proof row.

- **Narrator prompt REWRITE + typed clauses (D6, eng review P1-1/P2-2).** `prompts/narration.system.md`: add an
  explicit optional honesty-gated "who made it" clause, force what-vs-purpose separation, and instruct the model to
  tag each clause with its `bucket` (`what_is_it | purpose | maker`). `providers/live-narrator.ts`: `NARRATION_SCHEMA`
  clauses gain `bucket` (`:35-52`); the return type **changes from `clauses: string[]` to `clauses: {text, bucket,
  evidenceRef}[]`** (`:26-29`) — the gate (`validateClaims`) is unchanged, but the tag+ref must survive it. **Type
  ripple to fix (do not miss):** `onNarration(clauses)` (`cascade.ts:58,220`), the `token` emission (`yield … text:
  clause`, `:221` → `clause.text`), `NarrationStore.capture`, and `CascadeEveClient` `captured`/`.join` (`:115,127`).
  **Re-baseline the `prompts.test.ts` golden** (byte-exact). Source-proof for a section = its clause's `evidenceRef`
  → `dossier.evidence[ref]`; **suppress the source row when `evidenceRef === 'id'`** (band-as-evidence, not a real
  URL/quote — `live-narrator.ts:73`, else the card renders a dead `voxi:cascade` link).
- **Cascade — tag + scope BOTH narrate() calls, and scope the `what` AUDIO too (adversarial A/D/G, the unifying
  fix).** The bucket split must apply to the **first-pass** narration (`cascade.ts:210-221`), not only the async
  dossier upgrade (`:237-244`) — otherwise, in the common case (before/without a dossier), the first-pass streams
  ALL clauses as `token`s → `whatItIs` becomes the full what+purpose+maker composite and purpose/maker buckets are
  empty-but-fused-into-what (adversarial G). So, in **both** narrate calls:
  - Stream **only `what_is_it`-tagged clauses as `token`s** → `whatItIs` = what-only (fixes the composite bleed).
  - Emit `purpose`/`maker` clauses as `section` events via `at()` — from the **first pass** (available early) and
    again from the dossier upgrade (richer/better-sourced). The client's `appendSection` is **last-write-wins per
    bucket** (the dossier version supersedes the first-pass version); idempotent on replay.
  - The async `description_upgrade` also carries **what-only** clauses (refines `whatItIs`).
  - **`what` AUDIO source = what-only clauses (adversarial A):** `onNarration` (`cascade.ts:220`) pins only the
    `what_is_it`-tagged clauses, and the BFF persists `RevealRecord.narration` from that what-only set — so
    `/speech/what` (live AND durable) voices exactly the What card's text, no overlap, no text/audio disagreement.
  Best-effort, swallowed on failure (no terminal `error` — refund safety).
- **Entailment reality (adversarial F — correct the overclaim).** In production the narrator is wired **judge-less**
  (`cascade-eve-client.ts:30` constructs `LiveNarrator` with no judge; `confidence.ts:108` skips entailment when the
  judge is falsy). So a `purpose`/`maker` clause is gated by **evidence-ref presence + `sourceMatchesSubject` +
  register/`namesDisallowedSpecific`**, NOT by `quote ⊨ text` entailment. §5B must not claim entailment protects the
  maker bucket. Hardening (recommended, flagged): pass the `EntailmentJudge` into the narrator for
  `provenance`/`spec` clauses so a maker attribution must be entailed by its quote — measure FP/miss-rate on the
  golden set first (same gate as PROMPT-QUALITY §2.2). Until then the maker bucket stays conservative (often empty).
- **Fakes.** Extend `FakeDossier`/`FakeNarrator` (`cascade.test.ts:258-271,:60-67`) to emit bucket-tagged clauses;
  cascade test asserts what-only `token`s + what-only `description_upgrade`, ordered `section` events (purpose,
  maker) from the first pass and superseded by the dossier upgrade (last-write-wins), monotonic indices before
  `done`, and that a dropped maker clause yields NO maker `section` (empty-bucket).

### C. Per-bucket audio (`services/voxi-api` + client)

- **Route (`app.ts:530-554`).** Extend to `POST /v1/threads/:id/speech/:bucket` with `bucket ∈ {what,purpose,maker,
  facts}` (enum-validated → 400 on unknown, eng review P2-1); keep `POST /v1/threads/:id/speech` as `bucket=what`
  (back-compat — existing tests + old clients unchanged). Resolve server-owned text per bucket via
  `narrationText(id, userId, bucket)`. `sha256(text)` cache (`:542`) auto-partitions the clips; ACL, 503/404/502
  order, and `audio/mpeg` response unchanged. Text stays server-owned (enum, never client text).
- **Live text source — tap the STREAM, not `onNarration` (eng review P1-2, the headline fix).** `onNarration`
  (`cascade.ts:220`) pins ONLY the first-pass `what` narration synchronously; `purpose`/`maker`/`facts` text does not
  exist server-side until the end-of-stream `RevealStore.put` (~a minute later) — so a naive design 404s
  (`no_narration`) for every non-`what` bucket during first-view, killing the marquee interaction. Fix: in
  `CascadeEveClient.stream()` **tap `section` and `fact` events as they pass** (the same seam that taps
  `token`→`captured`, `:118`) into a per-`(sessionId, bucket)` store, so each bucket's text is available the instant
  its icon flips active. `what` still uses the synchronous `onNarration` pin (unchanged).
- **`NarrationStore` (`narration-store.ts:13-32`).** Key on `(sessionId, bucket)`; `what` keeps the first-write pin
  + owner-scope path, but its text is now the **what-only** clause set (adversarial A), so `/speech/what` matches the
  What card; `purpose`/`maker` fed by the stream tap above; `facts` = the joined `fact` texts, but **only enabled
  once `researchComplete`** so the text is stable (a growing join changes the `sha256` key → repeated paid TTS, eng
  review P3-2). Durable revisit derives `purpose`/`maker`/`facts` on demand from the persisted `section`/`fact`
  events (symmetric, no extra store). `EveClient.narrationText?()` (`app.ts:36`) + `cascade-eve-client.ts:60-62`
  gain the bucket param.
- **Client.** `apiClient.speakNarration(threadId, bucket?)` (`apiClient.ts:312-333`) appends the bucket segment; the
  return type is unchanged. `AudioElement` is unchanged (plays any `src`). **Pre-warm** only the `what` clip when its
  icon goes active (the near-certain first tap, review 3b); `purpose`/`maker`/`facts` synthesize lazily on first tap.

### D. Reveal UI (`app/app/reveal.tsx` + new components + store)

- **`captureStore` (`captureStore.ts`).** Add `sections: { purpose?: SectionContent; maker?: SectionContent }`
  (`SectionContent = {text, sourceUrl, sourceTitle, quote}`), `appendSection(bucket, content)` (**last-write-wins per
  bucket** — the dossier version supersedes the first-pass version, adversarial G), `sawAnySection: boolean` (set
  true on the first `section`, for legacy detection — adversarial B), `researchComplete` + `setResearchComplete()`,
  `researchError` + `setResearchError()`, and `lastSeenIndex` (for the `unavailable` retry's `?startIndex=`). All new
  fields go in the `initial` literal so `startCapture`/`reset` clear them (matches the store's convention).
  **Bucket status derivation:** `what_is_it` → active when band settled (not gated on `whatItIs`, adversarial D);
  `purpose`/`maker` → content present → active; else `researchComplete` → (legacy: hidden if `!sawAnySection`; else
  empty); else `researchError`/offline → unavailable; else loading. `facts` → active on first fact.
- **`processing.tsx` — resolve loading buckets on ALL THREE termination paths (eng review P1-3).** Route `section`
  → `appendSection`. The termination handlers must be **unguarded store writes** (a post-navigation `ui()`-guarded
  setter is a no-op, so loading icons would spin forever): (1) `done` branch → `setResearchComplete()`; (2)
  `error`-event branch → if a band already settled, `setResearchComplete()` (research phase-2 error, buckets go
  empty); if pre-band, the existing hard-failure `setError` path (NOT a research `unavailable`); (3) `catch`/abort
  (network drop) → if band settled, `setResearchError()` → `unavailable`; if pre-band, existing hard-failure. So:
  `unavailable` ⇔ a **post-band** client-observed stream drop; `empty` ⇔ `done`/phase-2-error with no content;
  hard-failure ⇔ pre-band drop (unchanged). A server-side research failure is swallowed by the cascade
  (`cascade.ts:247-249`, never a terminal `error`) → ends in `done` → buckets `empty`. The tolerant parser skips
  unknown for old clients; the rebuilt app handles `section`.
- **New components** (converge-safe, `useNativeDriver:false`, lucide-only):
  - `BucketIcon` — circular icon, `data-state` loading|active|empty|unavailable (via `tidWith`), full-ink glyph when
    active, a single green **pulse ring** while loading, count badge for facts; full SR state contract (§4.9).
  - `BucketDock` — the row of 4 green research icons + the blue conversation icon (`reveal.buckets`).
  - `BucketCard` — the overlay (`reveal.bucketCard`, `data-bucket`), single-node scale/rise/fade from the icon origin
    (§4.8), scrim-backed, auto-plays audio (gated §4.9), hosts the full-question eyebrow + grounded body + source
    proof + (for facts) the `FactChip` list + the play control + a **labeled tab strip** (no swipe).
- **`reveal.tsx` READY.** Replace the scroll sheet with the compact dock panel + card overlay. Keep on the DOCK
  FACE (always visible): `reveal.card`, `reveal.title`, `reveal.confidenceChip`, a **one-line `reveal.whatItIs`
  preview** (review 1a), and the band-branded **`reveal.primaryAction`** green pill (review 1b — CONFIDENT →
  `reveal.generateStory`→podcast; PROBABLE → opens the How-sure correction). Keep the back header; keep "How sure"
  (`reveal.howSure`/`evidencePanel`/`candidateOption`/`correctId`) **auto-elevated for `isLow`** as today (review
  1d/7h) — when expanded it opens as its own scrollable evidence sheet so the "compact dock, not a tall scroll"
  invariant holds (review 7j). Keep the Add-a-tip link (`nav.openContribute`/`reveal.addTip`). The FULL `reveal.
  whatItIs` text + the facts block move into their bucket cards; `reveal.playNarration`/`reveal.narrationAudio` live
  in the card. The blue conversation icon (`reveal.conversationIcon`, carrying `reveal.askVoxi` + nav) replaces the
  two old "Ask Voxi" entries. EMPTY/ERROR/LOADING states keep `reveal.primaryAction` unchanged.

### E. Conversation entry

- The `reveal.conversationIcon` uses `router.push('/conversation')` (threadId flows via `captureStore` as today).
- Extend `buildItemContext` (`app.ts:279-290`) to also fold the `purpose`/`maker` section texts into the grounded
  chat context (owner-scoped), so "tell me more" is consistent with all four icons. Honesty instruction preserved.

### F. testIDs + E2E (`e2e/`)

- **`framework/testids.ts`:** add to `reveal.*`: `buckets`, `bucketWhat`, `bucketPurpose`, `bucketWho`, `bucketFacts`
  (each carrying `bucket.state`), `bucketCard`, `conversationIcon`. (Reuse `reveal.facts/fact/factSource`,
  `reveal.whatItIs`, `reveal.playNarration`, `reveal.narrationAudio` inside the cards; reuse `nav.openConversation`
  intent from the conversation icon.)
- **`shims/lucide.tsx`:** add `BookOpen`, `Target`, `Stamp`, `Lightbulb`, `MessageCircle`, `RotateCcw` (retry)
  (`Sparkles`/`Play`/`Pause`/`X`/`ChevronLeft` already exist).
- **`web/server.ts` fake stream:** emit the `section` events (purpose/maker) with provenance in the CONFIDENT rig, so
  the real store populates all four buckets; keep a PROBABLE rig where maker is ABSENT (empty-bucket path). Extend
  `/speech` fake to accept `:bucket` and return distinct clips.
- **`reveal-rnw.web.ts` — a REWRITE, not an "adaptation" (eng review P2-4; this is the deterministic proof layer,
  no cheating).** Six load-bearing CONFIDENT checks (`playNarration`, `narrationAudio`, autoplay-blocked-on-load,
  one-tap-plays, ≥3 `fact` chips, `factSource`) currently assert on the reveal FACE; they move **behind a bucket-card
  tap**. Reconcile the autoplay contract explicitly: **nothing plays on the reveal face at load** (the "loads but
  says nothing" bug guard still holds at the face level) — audio starts only after a card-open tap. The PROBABLE rig
  currently taps `reveal.askVoxi` and asserts `data-last-nav=conversation`; that moves to `reveal.conversationIcon`
  (the blue lane), and the PROBABLE `primaryAction` now opens How-sure. New assertions: `reveal.buckets` + each icon
  renders; `data-state` loading→active transition (poll like the band assertion); tap → `reveal.bucketCard` opens
  with the full-question eyebrow; per-bucket audio (existence + one-tap `currentTime` advance) inside the card;
  maker at PROBABLE shows `data-state="empty"` (honest, tappable, NOT disabled). **Mandatory new regressions:** (a)
  a loading bucket **resolves and never stays perpetual** (drives a fake stream that never sends its `section`, then
  `done` → assert the icon flips loading→empty); (b) a per-bucket `/speech/:bucket` **503 → card shows "unavailable
  — retry", not a fake play**.
- **`web/converge/entry.tsx` — the CONVERGE stream→store driver (adversarial C, do NOT miss).** The converge reveal
  bundle drives the store from `entry.tsx`'s hand-rolled NDJSON loop (`~:64-110`), **not** `processing.tsx`. It only
  handles `token`/`fact`/`description_upgrade`/`confidence_band`/`error` and relies on reader-EOF for `done`. Mirror
  the new client handling here: a `section`→`appendSection` branch, a `done`→`setResearchComplete()` branch, and a
  `catch`→`setResearchError()` (post-band) — otherwise the section/done/abort paths never reach the store and the
  rewritten reveal-rnw assertions + both [CRIT] regressions can never pass.
- **`web/server.ts` fake stream:** emit `section` (purpose/maker) with provenance in a CONFIDENT rig; a PROBABLE rig
  where maker is ABSENT (empty path) + a rig where a `section` never arrives before `done` (never-perpetual path);
  extend the `/speech` fake to accept `:bucket` and return distinct clips + a per-bucket 503 rig.
- **New agentic E2E** driving real clicks through the whole flow (see §7).

## 6. File-by-file

**shared:** `events.ts` (+`section` with `bucket: z.string()` + allow-list + forward-compat/tolerant tests).
`dossier.ts` — **no change**.
**eve-agent:** `prompts/narration.system.md` (**rewrite**: +maker clause, what/purpose separation, per-clause
bucket tag; golden re-baselined); `providers/live-narrator.ts` (`NARRATION_SCHEMA` +`bucket`; return type
`clauses: {text,bucket,evidenceRef}[]`); `cascade.ts:236-244` (group by tag → what-only `description_upgrade` +
`section` per purpose/maker; fix the `onNarration`/`token` clause-object ripple at `:58,:220-221`); `cascade.test.ts`
(bucket-tagged fakes + assertions).
**voxi-api:** `app.ts` (`/speech/:bucket` enum-validated + per-bucket text resolve; `buildItemContext` folds
sections; `EveClient.narrationText?` bucket param); `narration-store.ts` (per-`(session,bucket)`; `what` pin
untouched); `cascade-eve-client.ts` (**tap `section`/`fact` events in `stream()` → per-bucket store**; bucket param
through `narrationText`; fix `captured`/`.join` for clause objects).
**app:** `state/captureStore.ts` (`sections`+`appendSection`+`researchComplete`+`researchError`+status derivation);
`app/processing.tsx` (`section`→`appendSection`; unguarded store writes on all 3 termination paths);
`lib/apiClient.ts` (`speakNarration(threadId,bucket?)`); `components/{BucketIcon,BucketDock,BucketCard}.tsx` (NEW,
shared loading-ring driver); `app/reveal.tsx` (dock face w/ title+chip+whatItIs preview+primary pill; card overlay;
remove scroll sheet; keep How-sure auto-elevated); `lib/testid.ts` (re-export new ids).
**e2e:** `framework/testids.ts` (+bucket ids); `web/converge/shims/lucide.tsx` (+glyphs); `web/converge/entry.tsx`
(**the converge stream→store driver — add `section`/`done`/abort handling**, adversarial C); `web/server.ts` (fake
`section` events, never-perpetual + per-bucket-503 rigs, `/speech/:bucket`); `web/converge/reveal-rnw.web.ts`
(**rewrite** + regressions); new agentic runner.

## 7. Test coverage

```
[+] events: section round-trip; bucket is a FREE STRING (a novel bucket value does NOT throw the
      tolerant OR strict parser); tolerant SKIPS unknown type w/o throw; malformed KNOWN throws  [ADD] events unit
[+] narrator: clauses are {text,bucket,evidenceRef}; gate still drops ungrounded + maker-at-class
      clause; a maker clause citing 'id' → section with source-proof SUPPRESSED                  [ADD] narrator unit
[+] cascade: description_upgrade carries WHAT-ONLY clauses (no purpose/maker text); ordered
      section(purpose,maker) before done; one monotonic index; maker dropped → NO maker section;
      research fail → no section, reveal ok, NO terminal error                                   [ADD] cascade units
[+] cascade-eve-client: tapping section/fact events populates per-(session,bucket) text DURING
      the stream (before end-of-stream persist) → /speech has text on first-view                 [ADD] client unit [CRIT]
[+] termination paths: done→researchComplete; post-band drop→researchError(unavailable);
      pre-band drop→hard-failure (NOT unavailable); all are unguarded store writes               [ADD] processing/store units [CRIT]
[+] /speech/:bucket: enum-validated (400 on unknown); per-bucket server-owned text; sha256 cache
      partitions clips; facts clip stable only after researchComplete; ACL owner-scoped;
      back-compat /speech == what (existing test green); 503 unconfigured                        [ADD] app units
[+] narration-store: per-(session,bucket); what first-write pin + owner-scope UNCHANGED           [ADD] store unit
[+] captureStore: appendSection; researchComplete/researchError; bucket status derivation
      (active/empty/unavailable/loading); what/facts derived                                     [ADD] store unit
[+] apiClient: speakNarration(threadId,bucket) hits /speech/:bucket                               [ADD] apiClient unit
[+] buildItemContext folds purpose/maker; owner-scoped                                            [ADD] app unit
[+] what audio = what-only clauses: /speech/what text == the What card text, live AND durable      [ADD] cascade+app units [CRIT]
[+] legacy reveal (persisted, zero section events): purpose/maker buckets HIDDEN, not empty        [ADD] durable-revisit unit [CRIT]
[+] unavailable retry re-enters /processing with ?startIndex=lastSeen (resumes, not dead)          [ADD] processing unit
[+] converge entry.tsx: section→appendSection, done→researchComplete, abort→researchError          [→E2E] converge (drives the rig)
[→E2E] converge reveal-rnw (REWRITE): 4 bucket icons render; loading→active; maker empty at
      PROBABLE (tappable, not disabled); tap→reveal.bucketCard w/ full-question eyebrow; per-bucket
      audio existence + one-tap advance IN the card; NOTHING plays on the reveal face at load;
      facts card ≥3 chips + source proof; conversationIcon → /conversation nav intent
[→E2E] converge REGRESSIONS [CRIT]: (a) a loading bucket whose section never arrives resolves to
      empty on done (never perpetual); (b) per-bucket /speech 503 → "unavailable — retry", no fake play
[→E2E] agentic: real clicks camera→reveal→tap each bucket→hear audio→open Ask Voxi (real UI)
[+] typecheck, lint:selectors (new ids in registry, no coordinate taps), voice-bot pytest green
```
**Regressions (CRITICAL, IRON RULE):** `prompts.test.ts` golden for `narration.system.md` **re-baselined byte-exact**
(the prompt is rewritten). The existing `/speech` (no-bucket==what) test stays green. `reveal-rnw` CONFIDENT/PROBABLE/
negative rigs are **rewritten** (audio+facts move into cards; PROBABLE nav assertion → `conversationIcon`) — this is
a deliberate proof-layer change, not a weakened assertion. The `type ripple` from typed clauses
(`onNarration`/`token`/`NarrationStore.capture`/`CascadeEveClient`) must keep every existing cascade + persistence
test green.

## 8. Failure modes

| Failure (new codepath) | Handled | User sees | Test | Silent? |
|---|---|---|---|---|
| purpose/maker clause dropped by gate | best-effort; no `section` emitted | bucket settles to **empty** (honest answer) | cascade unit | no |
| maker unattainable (PROBABLE / not in label) | expected common case | maker bucket empty, warm honest copy | cascade + converge | no |
| research down / slow | async; deferred done; never blocks reveal | what active instantly; others load then settle | cascade + converge | no |
| **network drop mid-stream, post-band** | client `catch` → `setResearchError` (unguarded) | loading buckets → **unavailable + retry** (NOT stuck) | processing/store unit [CRIT] | no |
| **network drop, pre-band** | existing hard-failure `setError` | error/refusal screen (unchanged) | existing unit | no |
| **per-bucket audio text absent on first-view** | stream-tap capture (P1-2) makes text available at active | tap plays immediately (not 404) | cascade-eve-client unit [CRIT] | would be silent → fixed |
| stale client gets `section` (or novel bucket) | tolerant parser skips unknown type; `bucket` is a free string | reveal works; no icon for that bucket | events unit | no |
| `/speech/:bucket` unconfigured / 503 | fail-closed | card shows "audio unavailable — retry" (no fake play) | converge per-bucket 503 | no |
| unknown bucket in URL | enum-validated → 400 | n/a (client only sends the 4) | app unit | no |
| dossier read cross-user | owner ACL on `/speech/:bucket` + `/context` | 403/404 | app ACL unit | no |
| morph/loading anim on web bundle | `Animated` `useNativeDriver:false`, lucide-only, shared ring driver | animates identically web+native | converge (no mount error) | no |

No failure mode is both silent AND untested — the two that would be silent (per-bucket audio absent; loading hang)
are closed by the P1-2 stream-tap and the P1-3 unguarded termination writes, each with a [CRIT] test.

### Parallelization (worktree lanes)

| Lane | Modules | Depends on |
|---|---|---|
| A — contract | `packages/shared/events.ts` | — |
| B — client UI | `app/` (captureStore, processing, apiClient, components, reveal.tsx, testid) + `e2e/` | A (event shape) |
| C — backend | `services/eve-agent/` (narrator prompt+provider, cascade) + `services/voxi-api/` (speech route, narration-store, cascade-eve-client) | A |

Lane A first (small, shapes the contract). Then **B and C run in parallel** (different workspaces, no shared files)
— B verifies against the `e2e/web/server.ts` fake stream, C against `cascade`/`app` unit fakes. They converge at
the live E2E. This matches the plan's P1(contract)→{P2 UI, P3 backend} phasing.

## 9. Phasing

- **P1 — Contract + client scaffolding (creds-free).** `section` event + tolerant handling; `captureStore.sections`
  + `researchComplete`; `apiClient.speakNarration(bucket)`; testIDs + lucide shim. Verifies with fakes.
- **P2 — Reveal UI.** `BucketIcon`/`BucketDock`/`BucketCard`; `reveal.tsx` dock + morph; keep How-sure + secondary
  links. Converge `reveal-rnw` bucket assertions + agentic runner. Creds-free (fake stream + fake `/speech`).
- **P3 — Backend buckets + per-bucket audio.** Narrator section tags + `cascade` `section` emission; `/speech/:bucket`
  + `NarrationStore` keying; `buildItemContext` fold. Goldens updated. Live tier (real narrator/TTS) gated on creds
  as today; the deterministic path verifies here.

## 10. Open decisions

Resolved by the design review (autonomous defaults per the user's autonomy grant; documented for override):

- **OD1 — purpose/maker source:** section-tagged narrator clauses (D6) vs new cited research facts. **Chosen:
  section-tagged clauses** — lower honesty-gate risk + reuse; accepts buckets may be `empty` when nothing grounds.
- **OD2 — icons vs text-led chips (design review 4a):** the reviewer preferred text-led chips; the **user explicitly
  asked for individual icons**, so **icons stay** — the slop risk is mitigated instead by dropping `Sparkles`, using
  true signifiers (§4.5), the green loading ring + facts count badge (product-native), short captions + full-question
  card eyebrows, and blue/green lanes. User's explicit direction wins over the reviewer's chip preference.
- **OD3 — description + primary CTA on the dock face (review 1a/1b):** **kept on the face** — a one-line `whatItIs`
  preview under the title and the band-branded green `primaryAction` pill. The icons are the go-deeper layer, not a
  replacement for the payoff.
- **OD4 — conversation icon:** **navigates to `/conversation`** (blue lane) — the full conversation screen exists
  and is unchanged; an inline mini-chat is deferred.
- **OD5 — autoplay (review 6b):** **gated on `speakAloud` + suppressed under an active screen reader**, initial-open
  only (never on tab-switch); manual control always present. Pre-warm only the `what` clip.
- **OD6 — empty ≠ disabled, empty ≠ unavailable (review 3a/2c/7g):** `empty` is a full-ink, interactive, honest
  *answer*; a network drop before `done` is a distinct retriable `unavailable`. Four icon states, not two.
- **OD7 — "morph" mechanics (review 7b):** a single scrim-backed overlay view rising + scaling from the icon origin
  (transform+opacity, JS driver), not an expensive per-node shared-element morph; reduce-motion → cross-fade.
- **OD8 — between-bucket nav (review 4d/7d):** a labeled tab strip (Pressables), never swipe gestures (converge
  aliases gesture-handler to a throwing stub).

## 11. Review trail

### Design review (`/plan-design-review` substance + independent outside-voice subagent) — 2026-07-01

Mockups unavailable (no `OPENAI_API_KEY`); anchored on Mobbin refs (Lovi action-icon row, Moonlitt/Moonly morph
cards, CapWords progressive labels, Copilot grounded chat) + `design.md`. Codex unavailable → Claude subagent as
the outside voice. Scores (initial → after fixes):

| Pass | Dimension | Before | After |
|---|---|---|---|
| 1 | Information architecture | 5 | 9 |
| 2 | Interaction-state coverage | 4 | 9 |
| 3 | User journey & emotional arc | 6 | 9 |
| 4 | AI-slop / specificity | 5 | 8 |
| 5 | Design-system alignment | 6 | 9 |
| 6 | Responsive & accessibility | 3 | 9 |
| — | **Overall** | **6** | **9** |

Folded fixes: dock-face description one-liner + retained band-branded primary CTA (1a/1b); four icon states
(loading/active/empty/**unavailable**) with empty-as-honest-answer not a disabled ghost, and offline/stream-drop
split from empty (2c/3a/7g); green/blue two-lane (green reserved for audio+loading, active glyph full-ink; Ask Voxi
blue) (5a/5b); dropped `Sparkles`, true-signifier glyphs (4b); single green pulse ring not four auroras (4c);
labeled tab strip not swipe dots, no gesture-handler (4d/7d); performant single-node scale/rise morph (7b);
full SR state contract + `speakAloud`/screen-reader autoplay gate + `what`-clip pre-warm (6a/6b/3b); reduce-motion
morph (2d); How-sure auto-elevation preserved for low confidence + opens as its own sheet (1d/7h/7j). AI-slop pass
capped at 8 (an icon row is inherently less scannable than chips — but the **user explicitly specified icons**, so
that's an accepted, documented tradeoff, OD2).

### Engineering review (`/plan-eng-review` substance + independent outside-voice subagent) — 2026-07-01

Step 0 scope: reuses existing infra (dossier, `fact` events, `/speech`, `AudioElement`, `captureStore`, converge,
honesty gate, replay); 1 new event, 3 presentational components, additive backend — no scope reduction needed. The
outside voice (Claude subagent; Codex unavailable) returned **10 findings (3×P1, 6×P2, 2×P3)**, all verified against
code and **all folded**:

- **P1-2 [headline]** per-bucket audio had no live text source (`onNarration` pins only `what`) → tap-to-hear would
  404 for purpose/maker/facts on first-view. Fixed: capture text by **tapping `section`/`fact` events in
  `CascadeEveClient.stream()`** (§5C).
- **P1-1** the narrator prompt has **no maker clause** + fuses purpose into "what it is" → D6 is a real
  `narration.system.md` rewrite (+maker clause, clause separation, per-clause tag, golden re-baseline); maker is
  expected empty most of the time (§1 D6, §5B).
- **P1-3** loading buckets could hang → `researchComplete`/`researchError` are **unguarded store writes on all three
  termination paths**, branched on band-settled (§5D).
- **P2-1** `section.bucket` → `z.string()` (enum only on the route) for forward-compat (§5A).
- **P2-2** typed clauses `{text,bucket,evidenceRef}` — enumerated the `onNarration`/`token`/`NarrationStore`/
  `CascadeEveClient` ripple; suppress source-proof when `evidenceRef==='id'` (§5B).
- **P2-3** scope `description_upgrade` to **what-only** clauses → clean bucket partitions, no audio overlap (§5B).
- **P2-4** `reveal-rnw` is a **rewrite** (proof layer, no cheating); autoplay-blocked-at-face reconciled with
  play-on-card-open; PROBABLE nav → `conversationIcon`; +2 mandatory regressions (never-perpetual, per-bucket 503).
- **P2-5** cut dead `DossierFact.bucket`/`DossierBucket` (§5A).
- **P3-1** single shared `Animated.Value` for loading rings (§4.8). **P3-2** facts audio only after `researchComplete`
  (stable `sha256` key) (§5C).

| Section | Issues | Status |
|---|---|---|
| Architecture | 4 (honesty-gate path, forward-compat, live-audio source, termination paths) | folded |
| Code quality | 2 (typed-clause ripple, dead dossier fields) | folded |
| Tests | rewrite + 2 CRIT regressions + 5 new units | folded into §7 |
| Performance | 2 (ring driver, facts-audio cache) | folded |
| Critical gaps | 0 remaining (both would-be-silent modes now [CRIT]-tested) | closed |

### Adversarial multi-lens review (6-lens refute-by-default Workflow, each finding independently verified) — 2026-07-01

Lenses: persistence/replay · ACL/security · converge parity · metering/cost/refund · client state-race ·
honesty/persona. ~18 raw findings → **7 CONFIRMED, others REFUTED** (most because a prior review already closed
them — ACL owner-scope, glyph shim, morph measurement, enum ordering, store-reset, cost bounds, persona, narrator
throw-safety). All 7 confirmed are folded:

1. **[persistence P1] `what` AUDIO not scoped to what-only** — I'd scoped only the visual `description_upgrade`;
   `onNarration`/durable `narration`/`/speech/what` still voiced the full composite → overlap + text/audio disagree
   on revisit. Fixed: pin + persist + voice **what-only** clauses (§5B).
2. **[honesty P2] clean-partition breaks in the first-pass/no-dossier case** — first-pass streams ALL clauses as
   tokens → `whatItIs` = full composite. Fixed: **tag + scope BOTH narrate() calls**; emit purpose/maker sections
   from the first pass, superseded by the dossier upgrade (last-write-wins) (§5B).
3. **[state-race P1] `what` "active on mount" false** — band settles before tokens stream → jarring loading→active
   flip on the primary icon. Fixed: `what` active on **band-settle**, card shows a skeleton while streaming (§4.4).
4. **[converge P1] `entry.tsx` (the converge driver) never updated** — it, not `processing.tsx`, drives the store in
   the converge bundle and had no `section`/`done`/abort handling → the new E2E couldn't pass. Fixed: added to §5F/§6.
5. **[state-race P1] `unavailable` retry had no wired owner** — the stream loop is dead after a drop. Fixed: retry
   re-enters `/processing` with `?startIndex=<lastSeen>` (§4.4).
6. **[honesty P1] maker entailment overclaimed** — the prod narrator is judge-LESS, so maker safety is ref+substring
   +register, not `quote ⊨ text`. Fixed: corrected §5B + flagged enabling the judge for provenance clauses.
7. **[persistence P2] no migration for pre-change reveals** — replayed legacy reveals would falsely show purpose/maker
   `empty`. Fixed: legacy reveals (zero `section` events) **hide** purpose/maker, don't assert empty (§4.4).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean (9/10) | 6→9; ~30 findings folded (icon states, lanes, slop, a11y, morph); OD1–8 resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 10 findings (3 P1/6 P2/2 P3) all folded; 0 critical gaps |
| Adversarial | 6-lens verified Workflow | Refute-by-default hardening | 1 | clean | ~18 raw → 7 confirmed, all folded (audio-scope, first-pass tagging, active-on-settle, entry.tsx, retry, entailment, legacy migration) |

- **CROSS-MODEL:** three independent passes (design outside-voice, eng outside-voice, 6-lens adversarial) converged
  on the same spine — the converge/proof-layer risk and the empty-state/audio honesty — each closed.
- **UNRESOLVED:** none blocking. Recommended hardening (deferred, flagged): wire the `EntailmentJudge` into the
  narrator for provenance/spec clauses after measuring FP/miss-rate. AI-slop capped at 8 (user's explicit icons, OD2).
- **VERDICT:** DESIGN (9/10) + ENG + ADVERSARIAL CLEARED. Plan is implement-ready.
