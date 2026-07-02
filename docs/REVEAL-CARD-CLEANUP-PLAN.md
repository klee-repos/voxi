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
strip unchanged and still pinned below the scroll):

- **What / Purpose / Maker** → grounded prose body, then (if there is ≥1 real web source) a **Sources** list.
  **No inline source row under the prose.** (fixes D1)
- **Facts** → a `reveal.facts` container of `reveal.fact` rows, each just the **fact text**, separated by a
  hairline divider (no border, no fill), then a single **Sources** list built from the facts' sources, deduped.
  (fixes D2)
- **Sources list** (shared component, used by all four cards): a small `overline` "SOURCES" label + one row per
  unique source. Each row is a `Pressable` → `Linking.openURL(url)` and shows:
  1. **Title** — `sourceLabel(url, title)`: the real page title when present, else a prettified site name derived
     from the hostname. Rendered in the **blue link lane** (`accentSecondary`, per design.md "blue = links").
  2. **Quote snippet** — the verbatim evidence `quote`, muted italic `footnote`, `numberOfLines={2}` (preserves the
     honesty proof without the old toggle clutter). Omitted when empty.
  3. **Hostname** — the registrable domain, muted `footnote` (the "which site" signal). (fixes D3)

Nothing shows a bare `https://…` string anywhere. A source with an empty or `voxi:`-prefixed URL is skipped.

---

## 3. Design decisions (the load-bearing ones)

**3.1 One shared `SourceList` for all cards.** Both the prose cards' single source and the facts card's N sources
render through the same component (dedupe by URL). Removes the two divergent inline-source code paths.

**3.2 `sourceLabel(url, title)` — a pure, unit-tested helper** (new `app/src/lib/sourceLabel.ts`):
- prefer a non-empty `title` (trimmed) that is not itself a URL;
- else derive a display name from `new URL(url).hostname`: strip a leading `www.`, take the registrable-domain SLD,
  Title-case it (`en.wikipedia.org` → "Wikipedia", `canon.com` → "Canon");
- wrap `new URL()` in try/catch → fall back to the raw string only if parsing throws (never crash a render).
Also export `sourceHost(url)` for the muted hostname line (hostname minus `www.`, or `''` on parse failure). Mirror
the existing eTLD+1 logic in `packages/shared/src/moderation.ts:30-37` (`registrableDomain`) rather than reinventing
suffix handling; keep the helper app-local (display concern, not a shared contract).

**3.3 Preserve the honesty proof.** The verbatim `quote` stays visible (as the muted snippet) — we are changing how
provenance is *presented*, never weakening the server-side honesty gate (unchanged) or dropping the proof. A titled,
tappable source that also shows its quote is *stronger* provenance UX than a raw URL behind a toggle.

**3.4 Server title plumbing (Phase B, additive, separable).** Plumb the already-captured real page title into the
stream so `sourceLabel` shows a genuine title, not just a hostname:
- **Facts:** in `researcher/index.ts` `buildDossier`, when building each kept fact, look up the source's title from
  `proposed.sources` by URL and set `sourceTitle` to it (fall back to `f.sourceTitle ?? ''`). The sources already
  carry `title` (`FetchedSource.title`, `live-dossier.ts:88`, `:112`).
- **Sections:** thread the source title into `sectionFor` (`cascade.ts:157-180`). `Evidence` rows don't currently
  carry a title, so pass the dossier/research sources (URL→title map) alongside `evidence` and set
  `sourceTitle` from the matched source; default `''` when unknown. Keep the `voxi:` suppression exactly as-is.
- This is a **quality upgrade, not a correctness dependency**: `sourceLabel`'s hostname fallback means the client is
  correct even if Phase B ships later. If the eng/adversarial review judges the cascade/section test-baseline churn
  too risky for this change, Phase B can be split into a follow-up without blocking D1–D3.

**3.5 No new page fetching.** We reuse titles Firecrawl already captured. No network changes, no new provider calls.

---

## 4. Scope — files to change

**Client (the core fix, delivers D1–D3 on its own):**
- `app/src/components/RevealDock.tsx` — replace `FactChip` (bordered) with a divider `FactRow` (text only); add a
  shared `SourceList`; in `BucketCard` remove the inline source `<Pressable>` under the prose body
  (`:292-296`); render `SourceList` for both the facts branch and the prose branch. Keep the audio pill, tab strip,
  eyebrow, close, scrim, and every existing testID on its element.
- `app/src/lib/sourceLabel.ts` (new) + `app/src/lib/sourceLabel.test.ts` (new) — the pure helper + Bun tests
  (title-preferred, hostname fallback, `www.` strip, wikipedia/canon cases, malformed URL, `voxi:` → skip signal).
- `e2e/framework/testids.ts` — add `reveal.sources` (the Sources list container), analogous to `reveal.facts`.
  Keep `reveal.factSource` as the id on each source **row** (re-pointed, not removed). Registry is the source of
  truth; `lint:selectors` enforces it.
- `app/app/reveal.tsx` — `cardBody()` already returns `{body, sourceUrl, sourceTitle, quote}` (`:214-219`); adapt it
  to hand `BucketCard` a normalized `sources` array (a single-element list for prose buckets, `facts` for the facts
  bucket) so `SourceList` has one input shape. No behavioural change to the dock/dossier flow.

**Server (Phase B, additive quality upgrade):**
- `services/eve-agent/agent/subagents/researcher/index.ts` — set fact `sourceTitle` from the matched source title.
- `services/eve-agent/agent/cascade.ts` — thread a URL→title lookup into `sectionFor`; set section `sourceTitle`.

**Deterministic E2E stream (so the new UI is exercised with realistic data):**
- `e2e/web/server.ts:101-106,122-128` — give some deterministic facts/sections a real `sourceTitle` and leave one
  with an empty title, so the converge proof covers **both** the real-title and hostname-fallback branches.

**Tests to update (re-point, do not weaken):**
- `e2e/web/converge/reveal-rnw.web.ts:182-199` — the facts assertion currently clicks the first `reveal.factSource`
  and asserts the body contains **"Hide source"**. The toggle is gone; re-point to: open Facts → assert ≥3
  `reveal.fact` rows → assert a `reveal.sources` list exists with ≥1 `reveal.factSource` row → assert the row's
  visible text shows a **title/hostname, not a `https://` string** (e.g. text does not start with `http`), and (if
  Phase B lands) that a known deterministic title renders. This is a *stronger* assertion than "Hide source".
- `e2e/web/converge/reveal-agentic.web.ts` — Goal 2 pins ≥3 `reveal.fact`; unaffected (fact rows keep the id). Verify
  the planner still perceives/opens Facts.
- `e2e/judge/run-reveal-judge.web.ts:50-74` — content-quality flow reads `whatItIs`/`fact`/`factSource`; verify the
  selectors still resolve to the new elements (fact rows + source rows).
- `services/eve-agent/agent/cascade.test.ts` — the `sectionFor` shape/`voxi:` suppression tests (e.g. `:431-433`)
  may assert `sourceTitle: ''`; update to the plumbed title where Phase B changes it, keeping the `voxi:`
  suppression assertion intact.

**Non-goals:** no change to the honesty gate, the dock icons/states, `deriveBucketStatus`, the audio pipeline, the
`section`/`fact` event *schema* (fields already exist), or podcast/conversation.

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
8. **Visual QA:** a throwaway Playwright script over `standUp('client.tsx', SEED)` at `390×844`, `?scan=confident`,
   open What → Purpose → Facts, `page.screenshot(...)` each; eyeball: no raw URLs, facts as a divider list, a clean
   Sources list with titles. (No codified 390px runner exists — this is the documented manual convention.)

Done = 1–8 green **and** the screenshots visually confirm the three defects are gone.

---

## 6. Risks / watch-items
- **R1 (assertion re-point):** `reveal-rnw` "Hide source" text assertion is now stale — must re-point to the new
  Sources-list observable, not deleted. (§4)
- **R2 (cascade test baseline):** Phase B changes section `sourceTitle`; `cascade.test.ts` may need re-baselining.
  Mitigated by Phase B being separable (§3.4).
- **R3 (dedupe correctness):** facts sharing a URL must collapse to one Sources row; a fact with an empty/`voxi:`
  URL must not create a dead row. Covered by `SourceList` dedupe + skip logic and a unit test.
- **R4 (contrast over glass):** the morph card is dark Liquid Glass; the muted quote/hostname `footnote` sits on it.
  Keep the title in the AA-cleared link color and treat the muted lines as supplementary (the title is the real
  signifier), consistent with the existing dock caption a11y note (`theme.ts:219-241`).
- **R5 (empty states):** a prose card with no real source, or a facts card whose facts all lack a web URL, renders
  **no** Sources list (not an empty "Sources" header). Honest-empty maker copy (`RevealDock.tsx:300-302`) stays.
