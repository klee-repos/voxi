# REVEAL-CARD-CLEANUP-PLAN

Clean up the reveal BucketCard UX (the panel that opens when you tap a research-bucket icon — What / Purpose /
Maker / Facts). Three concrete user-reported defects, one Mobbin-grounded redesign. Builds on
[[project-analysis-ux-icon-dock]] and [[project-reveal-content-quality]].

Status: DRAFT (pre-review). Review trail appended at the bottom as `/plan-eng-review`, `/plan-design-review`, and
the adversarial pass run.

---

## 1. The three defects (code-cited)

**D1 — "confusing link below Purpose".** Tapping the Purpose bucket shows the grounded prose, then a raw external
URL rendered underneath. Root cause: sections hardcode `sourceTitle: ''` (`services/eve-agent/agent/cascade.ts:179`,
in `sectionFor`), so the client falls back to the bare URL string. The Purpose section *does* carry a real external
web URL whenever a purpose clause cites a grounded research fact (`cascade.ts:296-302`, `:333-339`; URL from Gemini
grounding / dossier evidence). It is **not** a leaked `voxi:*` ref — those are correctly suppressed to `''`
(`cascade.ts:172-173`). The client renders it at `app/src/components/RevealDock.tsx:292-296` as
`quote ? "…quote…" — {sourceTitle||sourceUrl} : sourceTitle||sourceUrl` → a raw URL. **This inline source row must
go, on every prose card (what/purpose/maker), not just purpose.**

**D2 — "Facts looks horrible with 3 cards".** Each fact renders as its own bordered, padded `FactChip`
(`RevealDock.tsx:184-206`, styled `styles.factChip` `:352` — `borderWidth:1`, `radius.md`, `padding:md`), stacked
with `gap: space.sm` (`:283-288`). Three facts ⇒ three heavy boxes ⇒ visually noisy. Plus each chip has its own
inline **"Source" / "Hide source"** toggle (`:191-201`) that expands to a verbatim quote + a raw-URL link.

**D3 — "source: only show the url in a list; show the webpage title, not the literal URL".** Sources today are (a)
the raw inline row under prose (D1) and (b) the per-fact toggle (D2), both showing `sourceTitle || sourceUrl` — and
`sourceTitle` is **empty in the common case** (`cascade.ts:179` for sections; the deep-research extract schema has
no title field, `live-dossier.ts:45-63`, so facts default to `''` at `researcher/index.ts:193`; only the Gemini
fallback path sets `sourceTitle = subject`, `live-dossier.ts:117`), so the user sees a literal URL.

**Key opportunity (provenance investigation):** the real webpage `<title>` **is already captured** — Firecrawl
returns it (`tools/web_research.ts`), it flows into `dossier.sources[].title`
(`services/eve-agent/agent/subagents/researcher/index.ts:214`) — but it is used only for gate verification and is
**never plumbed into the `fact`/`section` `sourceTitle`**. We can plumb it, so real titles reach the client.

---

## 2. Target UX (Mobbin-grounded)

References pulled and reviewed on Mobbin (iOS):
- **Facts list → IMDb "Trivia":** each fact is a plain text block separated by a **hairline divider**, no card
  border/box. Airy, readable, scales past 3.
- **Sources → Perplexity / ChatGPT "Citations" / Grok "Sources":** a labelled **"Sources"** list; each row shows the
  **page title** (primary, tappable) + the **hostname/site** (muted secondary), never a raw URL. Deduped.

Redesigned BucketCard (inside the existing scrim-backed morph sheet, top-rounded, `maxHeight 80%`, audio pill + tab
strip unchanged and still pinned below the scroll). **The verbatim `quote` stays with the FACT it grounds (per-fact
proof), never in the deduped Sources list** — this is the load-bearing correction from the adversarial pass (dedup by
URL would otherwise silently drop the proof of every fact after the first when facts share a source, which is the
common case and the actual E2E fixture: 3 facts, 1 URL, 3 distinct quotes).

- **What** → grounded prose body ONLY, **no Sources list**. `whatItIs` comes solely from `token`/`description_upgrade`
  events, which carry no URL (`what` is never a `section`), so What can never produce a real web source. `cardBody`
  returns `sources: []` for What. (was implicitly wrong in v1; fixed per adversarial data-correctness #2)
- **Purpose / Maker** → grounded prose body, then (only when the section carries a truthy `sourceUrl`) a single-row
  **Sources** list. Its verbatim `quote` renders as a muted 1–2-line snippet on that one source row (single source →
  no dedup, no proof loss). **No inline `"quote" — url` row under the prose.** (fixes D1)
- **Facts** → a `reveal.facts` container of `reveal.fact` rows. Each row = the **fact text** (primary) **plus its own
  verbatim `quote`** as a muted italic snippet directly beneath (no border, no fill, no toggle — keeps the
  IMDb-trivia divider look AND preserves per-fact proof). Below the rows: a single **deduped Sources citation list**
  built from the facts' sources. (fixes D2)
- **Sources list** (shared component): a subordinate block set off by a **top hairline rule** + a muted `overline`
  label ("Source"/"Sources", pluralized by count), then one row per **unique** source. Each row is a `Pressable` →
  `Linking.openURL(url)` and shows:
  1. **Citation index** — a small muted number (`1`, `2`, `3`) leading the row (ChatGPT/Perplexity model — an
     *intentional* signifier, not a decorative dot). Not a bordered card.
  2. **Title** — `sourceLabel(url, title)`: the real page title when present, else a prettified site name from the
     hostname. Blue link lane (`surface.accentSecondary`), `subhead`, `numberOfLines={1}`.
  3. **Hostname** — `sourceHost(url)`, muted `footnote` (the "which site" signal). (fixes D3)
  The Sources list carries **NO quote** (the quote lives on the fact/prose row it grounds).

Nothing shows a bare `https://…` string anywhere. `dedupeSources` drops any source whose URL is falsy (`undefined`
or `''`), `voxi:`-prefixed, **or an opaque grounding-redirect** (Vertex `vertexaisearch.cloud.google.com` /
`…/grounding-api-redirect/…` — the creds-free default's fact URLs; see §3.6).

### 2a. Design spec (calibrated to `design.md`, dark-glass surface)
The card renders under the **dark** `SurfaceProvider` (Liquid-Glass over the photo), so tokens are the `dark` set:
- **Hierarchy (IA):** content is primary (fact rows / prose body, `surface.text`), the Sources block is *secondary*
  provenance (top `surface.border` hairline + muted `overline` label), and the green **"Hear it" audio pill stays
  the single primary action**, pinned below the scroll. Sources scroll *with* the content (inside the ScrollView),
  above the pinned pill + tab strip.
- **Facts list:** each fact = text (`typeStyles.body`, `surface.text`) + its quote (`typeStyles.footnote` italic,
  `surface.textMuted`, `numberOfLines={2}`), separated between facts by a **1px `surface.border` hairline**
  (`aria-hidden`), no fill/border box (kills the stacked-card AI-slop pattern).
- **Tokens:** hairline/divider = `surface.border`; source title link = `surface.accentSecondary` (blue); citation
  index + hostname + fact quote = `surface.textMuted`; "Sources" label = `typeStyles.overline` in `surface.textMuted`.
- **Scroll chain (adversarial design-regression #1):** set `styles.cardScroll` `flexShrink: 1` (NOT `flex: 1` — the
  card is `maxHeight:'80%'` with no explicit height, so `flex:1`/`flexBasis:0` would collapse the ScrollView to ~0
  and hide content). RN's default `flexShrink` is 0, so today an unconstrained ScrollView expands to full content
  height and, on the bottom-anchored card, pushes the pinned audio pill + tab strip *below the screen edge* with no
  way to scroll to them. `flexShrink:1` keeps `flexBasis:auto` (short content lays out fully) and lets only the
  ScrollView shrink+scroll when content exceeds 80%. This also fixes the same latent overflow already shipping.
- **Progressive:** fact rows + the Sources list derive from the streamed facts, growing in lockstep (no new loading
  state; the dock's existing loading ring covers "still researching").
- **Truncation:** source title 1 line; fact/prose quote up to 2 lines (proof should not clip mid-sentence); a long
  fact wraps normally.
- **A11y:** each source row `accessibilityRole="link"`, `minHeight: hit.min` (44px), label
  `Source: <title> (<hostname>), opens in browser`; dividers `aria-hidden`. The **blue source title clears AA on the
  card material** — the card always sits over `CARD_SCRIM` (`rgba(20,18,14,0.55)`, `RevealDock.tsx:270`) under
  `glass.tintStrong`, whose composite ≈ `dark.bg`, giving blue `#3D89F5` ≈ **4.60:1** (AA-pass), guarded by a new
  `theme.test.ts` case (§4). The muted index/hostname are supplementary meta (`theme.ts:219-241` posture). RN has no
  `:visited` — acceptable (opens externally). No new motion.

---

## 3. Design decisions (the load-bearing ones)

**3.1 One shared `SourceList` for all cards.** Both the prose cards' single source and the facts card's N sources
render through the same component (dedupe by URL). Removes the two divergent inline-source code paths.

**3.2 `sourceLabel(url, title)` — a pure, unit-tested helper** (new `app/src/lib/sourceLabel.ts`):
- prefer a non-empty `title` (trimmed) that is not itself a URL;
- else derive a display name from the hostname: strip a leading `www.`, take the registrable-domain SLD,
  Title-case it (`en.wikipedia.org` → "Wikipedia", `canon.com` → "Canon");
- never crash a render: on any unparseable input, fall back to the raw string.
Also export `sourceHost(url)` for the muted hostname line (hostname minus `www.`, or `''` when not derivable /
suppressed), and a pure `dedupeSources(sources)` that collapses by URL and **drops any source whose URL is falsy
(`undefined` OR `''`), `voxi:`-prefixed, or a grounding-redirect** (§3.6). Guard order is `!url ||
url.startsWith('voxi:') || isRedirectHost(url)` (truthy check first, so `undefined.startsWith` is unreachable —
`sourceUrl` is typed `string | undefined` and What always yields `undefined`). Extracted as a helper so it is
unit-tested, not buried in JSX.

**Input shape (adversarial scope-consistency):** define `type RevealSource = { sourceUrl: string; sourceTitle?: string
}` — a subset of `RevealFact`. `SourceList`/`dedupeSources` take `RevealSource[]` and call `sourceLabel(s.sourceUrl,
s.sourceTitle)` / `sourceHost(s.sourceUrl)`. `cardBody` feeds ONE shape: facts bucket → pass `facts` raw (RevealFact
already satisfies RevealSource); purpose/maker → `sec?.sourceUrl ? [{ sourceUrl: sec.sourceUrl, sourceTitle:
sec.sourceTitle }] : []`; what → `[]`. Reusing RevealFact's field names means the (larger) facts feed needs no
adapter, and strict-TS + the typecheck gate catch any drift.

**Native-safety (eng-review [Layer 3] catch):** extract the hostname with a small **regex**
(`/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i` → strip any `user@`/`:port`), **not** `new URL()`. The app ships to RN
(Hermes) and has **no `react-native-url-polyfill`** installed (verified), where `new URL().hostname` is unreliable.
The existing `registrableDomain` in `packages/shared/src/moderation.ts:30-37` uses `new URL()` and is **server-only
(Node)** — do NOT reuse it in the app; the app helper stays local and regex-based. (The naive "last-two-labels"
registrable-domain heuristic is fine for a *display* name; multi-part suffixes like `.co.uk` are not worth eTLD-list
weight here.)

**3.3 Preserve the honesty proof, per fact.** The verbatim `quote` is the *per-fact* "proof if challenged"
(`events.ts:26-27`; the closed loop binds `evidence.claim === fact.quote`, `researcher/index.ts:187`). It stays on
the fact/prose row it grounds — **never** relocated into the URL-deduped Sources list, which would silently drop the
proof of every fact after the first when facts share a source (the common case; the deep extractor pulls ≤6 docs for
3–6 facts). We change how provenance is *presented*, never weakening the server honesty gate (unchanged) and never
dropping a proof. The tappable, titled source (opens the real page) is the *citation*; the on-row quote is the
*evidence*. (Adversarial honesty-product/data-correctness #1 — CONFIRMED blocker.)

**3.4 Server title plumbing (Phase B — FACTS ONLY, additive, separable).** Plumb the already-captured real page
title into the fact stream so `sourceLabel` shows a genuine page title, not just a hostname — **guarded so it never
surfaces a fabricated title**:
- **Facts:** in `researcher/index.ts` `buildDossier`, for each kept fact look up the matched source in
  `proposed.sources` by URL and adopt its `title` as the display `sourceTitle` **only when it is a REAL page title,
  i.e. `fold(title) !== fold(input.subject)`** (reuse the existing `fold`, `researcher/index.ts:98`); on equality
  leave `sourceTitle: ''` so the client derives an honest hostname instead. This matters because the title is a
  genuine page title only on the **Firecrawl deep path** (`d.title`, `live-dossier.ts:88`); on the **creds-free
  grounding fallback** the source `title` is hard-coded to `input.subject` — the object's OWN name, an internal
  anchor for `sourceMatchesSubject`, NOT a webpage title (`live-dossier.ts:112,117`). Without the guard, a photo of
  a "Canon AE-1" would render "Canon AE-1" as if it were the page's title. The guard keeps this a one-lookup,
  facts-only, gate-untouching, golden-untouching change. (Adversarial honesty-product #3 — CONFIRMED.)
- **Sections: DEFERRED** (eng-review scope cut). Threading a title into `sectionFor` (`cascade.ts:157-180`) is only
  partially possible (`Evidence` rows carry no title; the fast first pass has no dossier), for real churn in
  `cascade.ts` + `cascade.test.ts`. Sections stay `sourceTitle: ''` (`cascade.ts:179`) → the client hostname fallback
  renders them as a site name. NOT in scope (§7).
- **Correctness, not dependency:** `sourceLabel`'s hostname fallback keeps the client correct with or without Phase
  B. Separable commit.

**3.5 No new page fetching.** We reuse titles Firecrawl already captured. No network changes, no new provider calls.

**3.6 Grounding-redirect host suppression (adversarial honesty-product #2 — CONFIRMED).** In the creds-free default
(`dossierProviderFromEnv`, no `FIRECRAWL_API_KEY` → grounding-only, `live-dossier.ts:166-170`) — and in any
deployment's per-subject fallback — every fact `sourceUrl` is the raw Vertex grounding chunk URI
(`live-research.ts:59`), an opaque `https://vertexaisearch.cloud.google.com/grounding-api-redirect/…` proxy. A naive
hostname derivation would show "vertexaisearch.cloud.google.com" (or Title-cased "Google") — a false "which site".
So `sourceHost`/`sourceLabel` treat a host matching `vertexaisearch.cloud.google.com` or a URL containing
`grounding-api-redirect` as **non-displayable**: `sourceHost` → `''`, and `sourceLabel` returns the plumbed real
title if present (non-URL), else `''` — so `dedupeSources` drops the row rather than render a proxy name. Never render
the raw `vertexaisearch…` string; never Title-case it to "Google". Unit-tested. (Threading the grounding chunk's real
`web.title` through `factsFromGrounding` → `GeminiGroundingDraft` so those facts CAN show a genuine site title is a
larger follow-up touching `live-research.ts` + `gcp-vision` typing — deferred, §7.)

---

## 4. Scope — files to change

**Client (the core fix, delivers D1–D3 on its own):**
- `app/src/components/RevealDock.tsx` — replace bordered `FactChip` with a divider `FactRow` (**fact text + its own
  muted quote snippet**, no box/toggle); add a shared `SourceList` (deduped citation rows, **no quote**); in
  `BucketCard` remove the inline source `<Pressable>` under the prose body (`:292-296`); render `SourceList` for the
  facts branch and (source-bearing) prose branch; add `flexShrink: 1` to `styles.cardScroll` (`:349`) so the pinned
  audio pill can't overflow off-screen. Keep the audio pill, tab strip, eyebrow, close, scrim, and every existing
  testID on its element.
- `app/src/lib/sourceLabel.ts` (new) + `app/src/lib/sourceLabel.test.ts` (new) — pure helpers (`sourceLabel`,
  `sourceHost`, `dedupeSources`, `isRedirectHost`) + Bun tests: title-preferred (but a URL-looking title rejected),
  hostname fallback, `www.` strip, wikipedia/canon Title-case, malformed/relative → no crash, dedupe by URL,
  `voxi:`/empty/**`undefined`** URL dropped, **`vertexaisearch…/grounding-api-redirect/…` → `sourceHost`=''` and row
  dropped (never "Google")**.
- `app/src/lib/theme.test.ts` — add a `glass material` case guarding the blue source title
  (`dark.accentSecondary`) over the card's real backdrop (`CARD_SCRIM` under `glass.tintStrong` composited on white)
  ≥ AA (4.5); it passes at ~4.60. Also assert the scrim-less form (~3.43) is the failing case, documenting that the
  card's AA depends on `CARD_SCRIM` behind it. (Adversarial design-regression #2 — the claim was *untested*, not
  false.)
- `e2e/framework/testids.ts` — add `reveal.sources` (the Sources list container). Keep `reveal.factSource` as the id
  on each source **row** (re-pointed, not removed). Registry is the source of truth; `lint:selectors` enforces it.
- `app/app/reveal.tsx` — `cardBody()` (`:214-219`) yields `{ body, sources }`: `what` → `sources: []`; `purpose`/
  `maker` → `sec?.sourceUrl ? [{ sourceUrl, sourceTitle }] : []`; facts branch passes `facts` (RevealFact ⊇
  RevealSource) plus each fact's quote onto its FactRow. One `RevealSource[]` input shape (§3.2).

**Server (Phase B, additive quality upgrade — facts only, guarded):**
- `services/eve-agent/agent/subagents/researcher/index.ts` — adopt the matched `proposed.sources[].title` as a fact's
  display `sourceTitle` **only when `fold(title) !== fold(input.subject)`** (else `''`); reuse `fold` (`:98`). No
  gate/golden impact.
- researcher unit test — a grounding-shaped source (`title === input.subject`) yields an EMPTY display `sourceTitle`
  (client falls to hostname/suppression); a deep-shaped source (`title !== subject`) carries the real title.

**Deterministic E2E stream (exercise every branch the way prod actually behaves):**
- `e2e/web/server.ts` `confident` — keep facts 1–2 on the Wikipedia `src` with the real title; point **fact 3 at a
  DISTINCT URL with an empty title** (e.g. `https://www.cannondale.com/road/supersix-evo`, `sourceTitle: ''`) so
  `dedupeSources` yields **two** rows: a real-title row ("Cannondale SuperSix EVO") and a hostname-fallback row
  ("Cannondale"). Set the **purpose/maker SECTION events title-less with a real URL** (`sourceTitle: ''`,
  `sourceUrl: src`) so the prose Sources row mirrors production's hostname-fallback path (`cascade.ts:179`), not a
  fabricated title. `server.ts:128` (empty text+URL maker marker) stays as the honest no-source case. Redirect-host
  suppression is covered by `sourceLabel.test.ts` (kept OUT of the deterministic stream to avoid perturbing the
  fact-count assertions the converge/agentic/judge runners all share).

**Tests to update (re-point to the new observable, do not weaken):**
- `e2e/web/converge/reveal-rnw.web.ts:182-199` — the toggle is gone. Re-point to: open Facts → assert ≥3
  `reveal.fact` rows, **each showing its own quote snippet** (visible quote count == fact count → per-fact proof
  preserved) → assert a `reveal.sources` list whose `reveal.factSource` row count == the number of **unique** fact
  source URLs. Read a row's `innerText` and assert it **`includes('Cannondale SuperSix EVO')`** (the real title,
  **unconditional** — `e2e/web/server.ts` hardcodes it, independent of Phase B) AND that a second row shows the
  hostname-fallback name **"Cannondale"**, AND `!rowText.includes('http')` (**substring**, not `startsWith` — the
  citation index leads the row, so `startsWith('http')` is tautologically false and proves nothing).
- `e2e/web/converge/reveal-agentic.web.ts` — Goal 2 pins ≥3 `reveal.fact`; unaffected (fact rows keep the id). Verify
  the planner still perceives/opens Facts.
- `e2e/judge/run-reveal-judge.web.ts:56-74` — **MUST re-point (adversarial catch).** It asserts `nSources >= nFacts`
  (one `factSource` affordance *per fact*, `:67-68`) and taps one expecting **"Hide source"** + a quote (`:71-74`).
  The consolidated deduped Sources list breaks both (3 facts sharing 1 URL → 1 source row; no toggle). Re-point to the
  new invariant: Facts card shows ≥3 `reveal.fact` rows **and** a `reveal.sources` list whose row count equals the
  number of **unique** fact source URLs (no provenance silently dropped), each row showing a title/hostname (no raw
  `https://`), and a known deterministic title renders. Stronger and honest, not weaker.
- `services/eve-agent/agent/cascade.test.ts` — **unchanged** (section-title plumbing is deferred, §3.4/§7), so its
  `sectionFor` `sourceTitle: ''` + `voxi:` suppression assertions stay green as-is. This is the payoff of the scope
  cut: no cascade/golden re-baselining in this change.

**Non-goals:** no change to the honesty gate, the dock icons/states, `deriveBucketStatus`, the audio pipeline, the
`section`/`fact` event *schema* (fields already exist), or podcast/conversation.

## 4a. What already exists (reuse, don't rebuild)
- `RevealDock.tsx` `FactChip` + the inline prose-source `<Pressable>` — we **replace** these in place, not add a
  parallel path. The old per-fact `open/setOpen` toggle state is deleted (simplification).
- `packages/shared/src/moderation.ts:30-37` `registrableDomain` — an eTLD+1 extractor, but `new URL()`-based and
  **server-only**; the app helper cannot reuse it on native (§3.2). Same idea, native-safe reimplementation.
- `app/app/reveal.tsx` `cardBody()` (`:214-219`) already forwards `{body,sourceUrl,sourceTitle,quote}` — adapt to
  `{ body, sources: RevealSource[] }` (§3.2) rather than inventing a new plumbing path.
- Deterministic fact/section content already exists in `e2e/web/server.ts` — enrich it (distinct-URL empty-title fact
  for the hostname branch; title-less sections to mirror prod; a redirect-URL fixture), don't author a new fixture.
- Firecrawl-captured `dossier.sources[].title` already exists (`researcher/index.ts:214`) — Phase B just reads it
  (guarded against subject-as-title, §3.4).

---

## 5. Validation plan (the "loop until verified" gate)

Run, in order, and loop on any red:
1. `bun run typecheck`
2. `bun test app` (new `sourceLabel.test.ts` + existing app units) and `bun test packages/shared`
3. `bun test services/eve-agent` (cascade + researcher + prompts golden — confirm no unintended golden drift)
4. `bun run lint:selectors` (the new `reveal.sources` id must be registered)
5. `bun e2e/web/converge/reveal-rnw.web.ts` (deterministic real-click proof, re-pointed source assertion)
6. `bun run e2e:web:agentic:reveal` (agent navigates the real dock; ≥3 `reveal.fact`, open cards)
7. `bun run judge:reveal` (content-quality flow still resolves `whatItIs`/`fact`/`factSource`)
8. **Visual QA:** a throwaway Playwright script over `standUp('client.tsx', SEED)`, `?scan=confident`, open
   What → Purpose → Facts, `page.screenshot(...)` each at **both `390×844` and `375×667` (iPhone SE)**; eyeball: no
   raw URLs, facts as a divider list each with its quote, a clean Sources list with titles, and on the small viewport
   the **audio pill + tab strip stay on-screen** (the `flexShrink` scroll-chain fix, adversarial design-regression
   #1). (No codified runner exists — documented manual convention.)

Done = 1–8 green **and** the screenshots visually confirm the three defects are gone AND the pinned controls survive
the small viewport.

---

## 6. Risks / watch-items
- **R1 (assertion re-point):** `reveal-rnw` "Hide source" text assertion is now stale — must re-point to the new
  Sources-list observable, not deleted. (§4)
- **R2 (cascade test baseline):** RESOLVED by the scope cut — section-title plumbing deferred (§3.4/§7), so
  `cascade.test.ts` is untouched. Phase B (facts only) touches only the researcher, which has no golden.
- **R6 (native URL parsing):** `new URL()` is unreliable on RN Hermes (no `react-native-url-polyfill` installed).
  The app helper uses regex host extraction; `registrableDomain` (shared, `new URL()`) stays server-only. (§3.2)
- **R3 (dedupe correctness + proof):** facts sharing a URL collapse to one Sources row, but **each fact keeps its own
  quote on its own row** (no proof dropped, §3.3); a fact with a falsy/`voxi:`/redirect URL creates no dead row.
  Covered by `dedupeSources` unit tests + the re-pointed reveal-rnw/judge quote-per-fact assertions.
- **R4 (contrast over glass):** the blue source title clears AA (~4.60:1) **because the card sits over `CARD_SCRIM`**
  under `glass.tintStrong` — now guarded by a `theme.test.ts` case (§4). The muted index/hostname are supplementary
  meta (`theme.ts:219-241`). Removing the scrim behind the card would re-open this (the guard documents it).
- **R5 (empty states):** a prose card with no real source, or a facts card whose facts all lack a usable web URL,
  renders **no** Sources list (not an empty header). Honest-empty maker copy (`RevealDock.tsx:300-302`) stays.
- **R7 (scroll overflow):** an unconstrained ScrollView (RN `flexShrink:0` default) can push the pinned audio pill +
  tabs below the screen edge. Fixed with `styles.cardScroll` `flexShrink:1` (NOT `flex:1`) + a small-viewport
  screenshot. Pre-existing latent bug this change fixes. (§2a)
- **R8 (subject-as-title honesty):** on the grounding path the source `title` is the object's own name; Phase B
  guards `fold(title)!==fold(subject)` so it's never rendered as a page title. (§3.4)
- **R9 (grounding-redirect host):** creds-free fact URLs are opaque Vertex redirects; `sourceHost`/`sourceLabel`
  suppress them (no "Google", no raw URL). (§3.6)

---

## 7. NOT in scope (considered, deferred)
- **Section-title plumbing** (`sectionFor` real page titles): partial availability + cascade/golden churn for
  marginal gain; hostname fallback covers purpose/maker. (§3.4)
- **Favicons in source rows:** the Perplexity/Grok look uses site favicons; RN needs a favicon fetch/cache and the
  converge lucide glyphs are blank stubs. A leading dot/letter suffices; favicons are a follow-up.
- **Per-fact inline citation markers** (Perplexity's superscript ¹² binding a fact row to its Sources index): nice,
  but the per-fact quote already sits on the fact row, so the binding adds little now; deferred.
- **Grounding-path `web.title` server plumbing** (thread the real publisher title from `factsFromGrounding` →
  `GeminiGroundingDraft`): would let creds-free grounding facts show a genuine site title instead of a suppressed
  host, but touches `live-research.ts` + `gcp-vision` typing — beyond facts-only Phase B. (§3.6)
- **Server page-title backfill for durable pre-existing reveals:** old threads keep their stored `sourceTitle`; no
  migration. New scans get titles via Phase B.
- **eTLD-accurate registrable domain** (public-suffix list): overkill for a display name.

## 8. Test coverage diagram
```
CODE PATHS                                              USER FLOWS
[+] app/src/lib/sourceLabel.ts                          [+] Open Facts card (?scan=confident)
  ├── sourceLabel(url,title)                              ├── [★★★] ≥3 fact rows, divider list — reveal-rnw
  │   ├── [★★★] real title wins                           ├── [★★★] each fact row shows its OWN quote — reveal-rnw
  │   ├── [★★★] url-looking title rejected                ├── [★★★] Sources rows == unique URLs — reveal-rnw
  │   ├── [★★★] empty title → Title-cased host            ├── [★★★] row incl. real title 'Cannondale SuperSix EVO' — reveal-rnw
  │   ├── [★★★] www. stripped                             ├── [★★★] hostname-fallback row 'Cannondale' — reveal-rnw
  │   └── [★★★] malformed/relative → no crash             ├── [★★★] no row text includes 'http' (substring) — reveal-rnw
  ├── sourceHost(url)                                     └── [★★★] agent perceives+opens Facts — reveal-agentic Goal2
  │   ├── [★★★] host minus www.                          [+] Open Purpose card
  │   ├── [★★★] unparseable → ''                           ├── [★★★] prose renders, NO raw-URL row — reveal-rnw (assert absent)
  │   └── [★★★] redirect host → '' (no 'Google')           └── [★★★] section source = hostname-fallback (title-less fixture) — reveal-rnw
  └── dedupeSources(sources)                             [+] Open What card
      ├── [★★★] collapse by URL                            └── [★★] whatItIs body, NO Sources list — judge:reveal
      ├── [★★★] drop falsy/undefined/voxi/redirect        [+] Small viewport (375×667)
      └── [★★★] preserve order                             └── [★★] audio pill + tabs stay on-screen (flexShrink) — visual QA
[+] app/src/components/RevealDock.tsx                    [+] Empty states
  ├── FactRow (text + quote + hairline)                    ├── [★★] maker honest-empty copy — existing
  │   └── [★★★] reveal.fact + its quote per fact — reveal-rnw     └── [★★] no Sources list when 0 usable sources — unit + visual
  ├── SourceList (index+title+host, NO quote)
  │   ├── [★★★] rows = deduped sources — unit + reveal-rnw   LLM: [→EVAL] none — no prompt/gate change
  │   └── [★★★] tap → Linking.openURL — (native)
  ├── cardScroll flexShrink:1 → pinned pill survives      COVERAGE: every new path has a unit or E2E owner.
  └── BucketCard prose branch: no inline source Pressable — reveal-rnw
[+] app/src/lib/theme.test.ts
  └── [★★★] blue title AA over CARD_SCRIM+tintStrong (~4.60) — theme.test
[+] services/eve-agent/.../researcher/index.ts
  └── [★★★] fact title only when title≠subject (else '') — researcher unit
```
Regression guard: `reveal-rnw`/`reveal-agentic` already pin ≥3 `reveal.fact` and the audio round-trip — those
assertions stay, proving the redesign didn't drop the fact count or per-bucket audio. The quote line count is
`numberOfLines={2}` everywhere (§2a) — the earlier "1 line" was superseded when the quote moved onto the fact row.

## 9. Failure modes (prod)
| Codepath | Realistic failure | Test? | Error handling | User sees |
|---|---|---|---|---|
| `sourceHost` regex | relative/`data:`/`voxi:` URL | yes (unit) | returns `''`, row dropped by dedupe | clean list, no dead row |
| `sourceHost`/`sourceLabel` | Vertex grounding-redirect URL (creds-free default) | yes (unit) | host suppressed → '' → row dropped | no "Google"/proxy, no raw URL |
| Phase B title lookup | grounding source title == subject | yes (researcher unit) | `fold` guard → `''` → hostname | honest site name, not object name |
| `Linking.openURL` | no handler / bad URL on native | n/a (platform) | `.catch(()=>{})` (existing) | tap no-ops, no crash |
| Card ScrollView overflow | many sources / small viewport | yes (visual 375×667) | `flexShrink:1` bounds+scrolls | audio pill + tabs stay reachable |
| `SourceList` render | all sources falsy/`voxi:`/redirect | yes (unit + visual) | renders nothing | no empty "Sources" header |
No failure mode is both untested and silent → no critical gaps.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score 6→9/10, 8 decisions |
| Adversarial | `/adversarial` (5-lens workflow) | Independent challenge + verify | 1 | CLEAR | 19 raised → 15 verified → 15 folded |

Eng-review findings folded (scope challenge + architecture + tests + failure modes):
1. **[P1] Native URL footgun** — `new URL()` is unreliable on RN Hermes (no `react-native-url-polyfill`); app
   helper switched to regex host extraction, `registrableDomain` kept server-only. (§3.2, §6 R6)
2. **[P2] Scope cut** — Phase B reduced to **facts-only**; section-title plumbing deferred → `cascade.ts` +
   `cascade.test.ts` out of scope, no golden re-baseline. (§3.4, §7)
3. **[P2] DRY / testability** — dedupe + `voxi:`/empty-URL skip extracted to a pure `dedupeSources()` helper, unit
   tested rather than buried in JSX. (§3.2, §4)
4. **[P2] Coverage completeness** — added the coverage diagram (§8) + failure-mode table (§9); every new path has a
   unit or E2E owner; regression guard = the existing ≥3-`reveal.fact` + audio round-trip assertions stay.

Design-review findings folded (7-dimension pass, 6→9/10; calibrated to `design.md`, §2a):
1. **IA (6→9)** — content is primary; Sources is a subordinate block (top hairline + muted overline); green audio
   pill stays the one primary action; Sources scroll with content above the pinned pill.
2. **AI-slop (7→9)** — the redesign removes the stacked-card pattern (hard-reject #7); source rows are plain rows
   (no bordered cards), led by an intentional **citation index** (1,2,3) not a decorative dot.
3. **States (6→9)** — Sources list is progressive (grows as facts stream); source title truncates to 1 line;
   empty → no Sources block (not an empty header).
4. **Design-system (7→9)** — pinned exact dark-glass tokens (`surface.border` hairline, `surface.accentSecondary`
   title link, `surface.textMuted` meta, `typeStyles.overline` label).
5. **Responsive/A11y (6→9)** — 44px source rows, `accessibilityRole="link"` + descriptive label, dividers
   aria-hidden, title clears AA on glass (muted meta supplementary), `:visited` N/A on RN noted.
6. **Unresolved → resolved** — quote visibility: preserved as a muted snippet, no toggle (line count finalized to
   2 by the adversarial pass once the quote moved onto the fact row).

Adversarial findings folded (5 hostile lenses, 19 raised → 15 verified against real code → all folded; 4 refuted
were stale "judge:reveal breaks" claims already handled):
1. **[BLOCKER ×2] Per-fact proof loss** — dedup-by-URL would silently drop the verbatim quote of every fact after
   the first when facts share a source (real fixture: 3 facts, 1 URL, 3 quotes). → quote moves onto each fact row;
   Sources list is a pure deduped citation list (no quote). (§2, §3.3)
2. **[MAJOR] Vertex redirect hosts** — creds-free default fact URLs are opaque `vertexaisearch…/grounding-api-
   redirect/…`; hostname fallback would show "Google". → `isRedirectHost` suppression. (§3.6)
3. **[MAJOR] subject-as-title** — grounding path sets `sourceTitle=input.subject` (object's own name). → server
   `fold(title)!==fold(subject)` guard. (§3.4)
4. **[MAJOR] tautological test** — citation index leads the row, so `startsWith('http')` never fires. → `includes`
   substring + unconditional real-title assert + a hostname-fallback assert. (§4)
5. **[MAJOR] ScrollView overflow** — RN `flexShrink:0` default pushes the pinned audio pill off-screen. →
   `cardScroll flexShrink:1` + 375×667 screenshot. (§2a, R7)
6. **[MAJOR] AA untested** — blue title is 4.60:1 over `CARD_SCRIM`+glass (passes) but unguarded. → new
   `theme.test.ts` guard + precise wording. (§4, R4)
7. **[minor] What is source-less / falsy-URL dedupe / distinct-URL fixture / input-shape typing / line-count
   contradiction** — all folded (§2, §3.2, §4, §8).

- **UNRESOLVED:** none.
- **CROSS-MODEL:** eng + design + a 24-agent adversarial workflow converged; no open tensions.
- **VERDICT:** ENG + DESIGN + ADVERSARIAL CLEARED — plan is implementation-ready.
