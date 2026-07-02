# Reveal content quality — fix generic/incoherent what · purpose · maker · facts (and the dropped-item bug) — PLAN

Status: **DRAFT** (pending `/plan-eng-review` + adversarial review). Author: Claude. Date: 2026-07-02.

Builds on [[project-analysis-ux-icon-dock]] (the bucket UX — already shipped) and
[[project-prompt-quality-research-layer]] (the research layer). Those delivered the *containers* (four buckets,
per-bucket audio, cited facts, the honesty gate). **This plan fixes what goes INSIDE them** — today the text is
generic, category-level, and for brand-primary objects (a Sub Pop mug, a band poster, a book, a tote) it is
effectively divorced from the actual object. The user's report: "the information shown right now is basically
incoherent … it should tell me about Sub Pop and why they made a mug … there even may be a bug where the item is
not being passed to the prompt."

## 0. Intent

Make the four reveal buckets **specific to THIS exact photographed object** — its brand, its design, what it
commemorates, who made it and why — while preserving the honesty spine (Voxi never fabricates; every falsifiable
claim is grounded or dropped). The current output for a clearly-branded object is a category truism ("a mug is a
vessel for hot drinks") because the object's real identity is thrown away before it reaches the generation prompts.

## 1. Evidence — captured live (the "before" baseline)

The user photographed a mug stamped with the **Sub Pop** logo (Sub Pop = the Seattle record label that signed
Nirvana, Soundgarden, Mudhoney). Expected: "This is Sub Pop merch — Sub Pop is the grunge label that…, and labels
sell mugs because…". Actual: generic filler as if the object were anonymous.

A live capture against the REAL pipeline (Gemini + Firecrawl; `docs/reveal-quality-baseline-before.txt`) reproduces
it exactly on the **Sub Pop logo**:

```
RAW VLM: make="Sub Pop", display_title="Sub Pop Logo", fine_confidence=1,
         ocr_text=["S","U","B","P","O","P"], distinguishing_features=["Stylized text 'SUB POP'", …]
BAND: PROBABLE   TITLE: "Sub Pop Logo"
WHAT:    "A logo, generally speaking, is a graphic mark, emblem, or symbol used to promote public identification…"
PURPOSE: "Its primary purpose, much like any effective logo, is to identify a business, product, or service."
MAKER:   (empty)
FACTS:   1. "The first logo to be officially trademarked was the Bass red triangle in 1876."
         2. "…the term 'logo' dates back to 1937… a shortened form of 'logogram'."
         3. hot-metal-typesetting definition of 'logotype' …
         4. "Some logo makers offer access to a library containing over 428,000 logos…"   ← SEO spam
```

**The VLM read "Sub Pop" with confidence 1.0** — the make, the OCR, and a distinguishing feature all say so — **and
the reveal is entirely about "what a logo is," the etymology of the word "logo," and the Bass red triangle.** Not one
word about Sub Pop the record label. Maker empty. The facts are generic logo trivia (one is SEO spam from a
logo-maker site). This is the incoherence, reproduced, with the mechanism visible: the read brand is in
`ocr_text`/`make` and thrown away; research ran on the generic category "logo" and was *forbidden* to name Sub Pop.
The same harness re-run post-change is the "after" proof (§6).

## 2. Root cause (code-cited) — five defects, one theme

**Theme: the object's most specific, *observed* identity is discarded between identification and generation.**

**D‑1 — Observed on-object signals are dropped on the floor.** `geminiIdentify` returns `ocr_text[]` and
`distinguishing_features[]` (`services/eve-agent/agent/lib/gcp-vision.ts:66-67,79-80,82`) — literally the "SUB POP"
text the VLM read off the mug. But `LiveVisionProvider.analyze()` maps ONLY
`category/make/model/year/display_title/confidence` into the `Candidate`
(`services/eve-agent/agent/providers/live-vision.ts:123-132`) and **never reads `ocr_text`/`distinguishing_features`.**
They exist in the schema, get populated by the model, and are then discarded. The single richest identity signal —
what is printed on the object — is invisible to every downstream prompt. *This is the "item not being passed to the
prompt" bug.*

**D‑2 — The narrator is fed `label`, not the specific `displayTitle`, and an empty name slips through.**
`NarrationInput.label = result.label` (`cascade.ts:246-252`). `result.label = chosen?.name ?? 'an object'`
(`identify_object.ts:173`), and `chosen.name = [year, make, model].join(' ')`
(`live-vision.ts:124`). For a model‑less branded object the concat is the bare brand or **`''`** (empty string, which
`??` does NOT replace → `label === ''`). Meanwhile the good `displayTitle` ("Sub Pop Mug") that the reveal card shows
(`cascade.ts:217-218`) is **never passed to the narrator or the sync `LiveResearcher`.** So the generation prompts
receive a vague or empty subject while the card title looks right — the prose and the title disagree.

**D‑3 — Brand-primary objects fall to PROBABLE, where the observed brand is actively *suppressed*.** Arbitration's
CONFIDENT lanes require `concrete(vlm)` = make AND model (`arbitration.ts:82,107`). Merch/media/homeware/packaged
goods have **no "model"** → never concrete → best case PROBABLE (`arbitration.ts:154`). At PROBABLE,
`buildDossierInput`/`buildResearchInput` switch to **class scope** and pass the VLM's make/model as
`disallowedSpecificTerms` (`cascade.ts:87-90,108-114`) — so research is forced onto the generic category ("mug") and
**forbidden from naming the very brand printed on the object.** The honesty gate is right to distrust a *guessed*
make/model; it is wrong to suppress a brand the VLM *read off the object*. Observation ≠ guess — the pipeline
conflates them.

**D‑4 — Research is too literal and not bucket-decomposed.** The dossier subject is the object's surface name
("Sub Pop Mug"); Firecrawl returns thin merch-listing pages, not the story of the label
(`live-dossier.ts:72-83`). The extract prompt **forbids "what it is / purpose" facts entirely**
(`research-extract.system.md:3`), and the `purpose`/`maker` buckets are sourced ONLY from the narrator's thin
first-pass ID evidence (`cascade.ts:260-266`) — so they read generic or come back empty even when a rich, citable
story exists. Research never asks the four bucket questions about the **maker entity** ("who is Sub Pop", "why does a
label sell mugs").

**D‑5 — The narrator prompt has no observed-brand handle.** `narration.system.md` pushes make/model specificity but,
at PROBABLE, forbids naming make/model at all and offers no way to anchor on what is *observably printed* — so it
falls back to category truisms.

**D‑6 — Non-answer filler leaks into make/model (found in the capture).** The plain-mug run returned
`make="unbranded", model="unspecified"` and the logo run returned `model="N/A"`. `cleanDisplayTitle` strips these
from the *display title* only (`live-vision.ts:22-39`); `make`/`model` are passed through raw (`live-vision.ts:126-127`).
So filler pollutes `label` ("Sub Pop N/A"), `name`, `disallowedSpecificTerms`, and the catalog id — and a genuinely
unbranded object gets a junk interview label ("mugs made"). Apply the same filler strip to `make`/`model`.

## 3. Locked decisions (honesty-preserving)

- **P‑1 — Observation is grounded; guessing is not.** Text/logos/marks the VLM *reads off the object* are direct
  observations, as citable as a spec label. Voxi MAY state them at ANY band (cite an `obs` evidence ref). Voxi may
  NOT assert a make/model/year/edition the arbiter did not confirm. The narrator prompt must draw this line
  explicitly. This preserves the honesty spine (no fabrication) while unblocking brand-primary objects.
- **P‑2 — The specific identity flows to every generation prompt.** `displayTitle` + observed brand + category are
  passed to the narrator, the sync researcher, and the dossier — never a bare make/model concat, never `''`.
- **P‑3 — No CI regression, LLM never gates.** The deterministic converge gate + `gate.ts` remain pass/fail; the LLM
  judge only *measures* (report-only, per repo rule). Every new grounded path still goes through the existing
  `validateClaims` / `admitFact` closed loops — we ADD a grounded evidence source, we do not loosen a gate.
- **P‑4 — Forward-compatible contract.** No new required stream fields. `ocr_text`/`distinguishing_features` are
  already optional on the VLM schema. Any new evidence ref rides the existing `evidence[]` / `section` plumbing.
- **P‑5 — Backstop unchanged.** UNKNOWN still hands off to the interview (no reveal). A brand-primary object with a
  clear OCR brand should land at least PROBABLE (§4.3), not UNKNOWN — but if it is UNKNOWN, nothing changes.

## 4. The fix — workstream by workstream

### A. Thread observed on-object signals into closed evidence (fixes D‑1)  — `services/eve-agent`

- `live-vision.ts`: capture the VLM's `ocr_text[]` + `distinguishing_features[]` (already returned by
  `geminiIdentify`) and emit them as `IdEvidence` with `ref: 'obs1'…`, `sourceUrl: 'voxi:observed'`, `claim` = the
  read span / feature. Also carry the VLM `display_title` and a distilled **observed brand** onto the `Candidate`
  (new optional fields `observedText?: string[]`, `observedBrand?: string`) so arbitration/cascade can route on them
  without re-calling the VLM. Purely additive — fakes and existing tests set none of it → unchanged behaviour.
- `cascade.ts` / `identify_object.ts`: `observed` evidence is included in `result.evidence` for BOTH bands. The
  narrator receives it and MAY cite it (P‑1). Source-proof rows for an `obs` ref render as "Seen on the object"
  (no external URL), analogous to the `id`-ref suppression already in `sectionFor` (`cascade.ts:126-146`).

### B. Pass the specific identity to every generation prompt (fixes D‑2, D‑6)  — `services/eve-agent`

- `live-vision.ts`: apply the `TITLE_FILLER` strip to `make`/`model` too (a shared `cleanField` helper), so
  "unbranded"/"unspecified"/"N/A" never survive as identity fields (fixes D‑6). Guard: a field that reduces to empty
  becomes `undefined`.
- `identify_object.ts:173`: fix the empty-name fallback — `label = firstNonEmpty(chosen?.name, displayTitle, 'an
  object')` (guard `''`, not just null/undefined). Keep `displayTitle` as the card title (unchanged).
- `cascade.ts`: build a `subject` for narration/research that PREFERS `displayTitle` (+ observed brand), and thread
  it into `NarrationInput` (new field `subject`/`displayTitle`) and into `buildResearchInput`/`buildDossierInput`.
  `narration.user.md` shows the specific subject, not the bare `label`.
- `live-research.ts` `researchPrompt`: subject prefers `displayTitle`/observed brand over the make/model concat.

### C. Brand-primary identity lane (fixes D‑3)  — `services/eve-agent`

- New helper `brandSubject(result)`: when the object has an **observed brand** (from OCR/`distinguishing_features`)
  and is model-less, the research subject = the **brand entity + object type** ("Sub Pop record label mug / Sub Pop
  merchandise"), NOT the generic category, and the observed brand is **removed from `disallowedSpecificTerms`** (it
  is observed, not guessed). `disallowedSpecificTerms` continues to suppress GUESSED make/models only.
- Honesty invariant preserved: we research + narrate the **brand entity** ("Sub Pop is a Seattle record label")
  which is legitimately grounded; we never assert "this is a specific edition/first-run mug". At PROBABLE the
  narrator still may not claim a make/model — but it MAY state the observed brand (P‑1) and the grounded facts about
  that brand entity.
- Arbitration nuance (minimal, guarded): a lone strong VLM with a **clear observed brand** may stay PROBABLE (today's
  behaviour) — we do NOT force CONFIDENT (that would over-claim). The win comes from B+C making PROBABLE *rich*, not
  from re-banding. (An optional, separately-measured tweak to let OCR corroborate a brand is noted in §8, not in
  scope for the first cut.)

### D. Bucket-decomposed, maker-aware research (fixes D‑4)  — `services/eve-agent`

- `research-extract.system.md` rewrite: keep the ban on **generic-category definitions**, but explicitly ASK for
  cited facts across the four buckets — (1) what THIS specific object is (specific, not "a mug is…"), (2) its
  particular purpose / what it commemorates, (3) the **maker/brand entity** (who they are, why they exist, why they
  made this), (4) curious facts. Each still carries a verbatim quote (the closed provenance loop is unchanged).
- `live-dossier.ts`: research query includes the maker/brand entity (a second search pass keyed on the observed
  brand when present), so sources about the *label* — not just the merch listing — are fetched. `buildDossier` gate
  unchanged.
- `cascade.ts`: `purpose`/`maker` sections prefer the dossier's cited facts (specific + provable) and fall back to
  the narrator's clauses — so buckets populate from the richer source. `sourceMatchesSubject` for the maker path
  keys on the brand entity.

### E. Narrator + extract prompt rewrites (fixes D‑5)  — `services/eve-agent`

- `narration.system.md`: add the **observation-vs-guess** rule (P‑1); add an explicit "state the observed brand/marks
  and, when cited, who the maker is and why they made it" instruction; keep per-bucket separation + specificity.
  Re-baseline `prompts.test.ts` golden (byte-exact).
- `narration.user.md`: render the specific `subject` + an `OBSERVED:` block (the read brand/marks) the narrator may
  cite. Re-baseline its golden.

### F. Proof + tests (§6) — `e2e/`

## 5. File-by-file

**eve-agent:** `providers/live-vision.ts` (capture `ocr_text`/`distinguishing_features` → `obs` evidence +
`observedBrand`/`observedText` on the candidate; guarded/additive); `tools/identify_object.ts` (empty-name fallback;
carry observed fields + evidence through `IdentifyResult`); `cascade.ts` (`subject`/observed threading;
brand-subject helper; purpose/maker prefer dossier facts); `providers/live-narrator.ts` (`NarrationInput` gains
`subject` + `observed`); `providers/live-research.ts` (subject prefers displayTitle/brand);
`providers/live-dossier.ts` (maker-entity search pass); `prompts/narration.system.md` + `narration.user.md`
(rewrite; observation rule); `prompts/research-extract.system.md` (bucket-decomposed, maker-aware). Tests:
`live-vision.test.ts`, `identify_object`/arbitration untouched-contract tests, `cascade.test.ts`,
`live-narrator.test.ts`, `live-dossier.test.ts`, `prompts.test.ts` (goldens re-baselined).

**shared:** `arbitration.ts` `Candidate` gains optional `observedBrand?`/`observedText?` (display/routing only,
never read by `arbitrate` — mirrors the existing `displayTitle`/`category` convention). No stream contract change.

**e2e/judge:** extend `judge.ts` with `purpose` + `maker` rubrics; add a branded-object fixture set
(`fixtures.ts`: Sub Pop mug + a band poster + a paperback + a branded tote); a reusable **bucket capture + judge**
harness `reveal-buckets.web.ts` (the before/after proof); keep `gate.ts` deterministic.

## 6. Test + proof-of-improvement plan

**No-regression (deterministic, CI — LLM never gates):**
- `bun test` whole TS suite green (goldens re-baselined; the additive candidate/evidence fields keep every existing
  cascade/arbitration/narrator/persistence test green).
- `bun run typecheck`, `bun run lint:selectors`, `python3 -m pytest services/voice-bot -q`.
- All converge runners green (the bucket UX is unchanged; content plumbing is server-side). `bun run judge:reveal`
  (deterministic structural gate over the real reveal) green.

**Proof of improvement (LLM judge + agentic, report-only — the user's requirement):**
- `e2e/judge/reveal-buckets.web.ts` (`--live`): runs the REAL cascade over the branded fixtures, captures all four
  buckets, and scores each with the **independent Claude judge** (`ANTHROPIC_API_KEY` is funded). Prints per-bucket
  score + reasons + a delta vs a committed `baseline-buckets.json` (the BEFORE, captured pre-change).
- **Agentic E2E:** an `Agent`+`Planner` drives the real reveal dock (open What → Purpose → Maker → Facts), and the
  captured bucket text is fed to the judge. The agent NAVIGATES; the judge SCORES; neither decides CI pass/fail
  (repo rule) — the deterministic gate does.
- **Acceptance:** every bucket's post-change score materially exceeds the baseline for the Sub Pop mug (target:
  purpose & maker cross 0.7 where the baseline was ~0.2–0.3, and each names Sub Pop / the label story), with a
  negative control (a genuinely anonymous object still yields honest-empty maker, never a fabricated one).

## 7. Failure modes

| Failure | Handled | User sees | Silent? |
|---|---|---|---|
| VLM returns no OCR/brand | no `obs` evidence; existing path | today's behaviour (no worse) | no |
| observed brand but thin sources | facts drop via closed loop; maker may stay honest-empty | honest empty maker, specific What | no |
| brand research finds the wrong entity | `sourceMatchesSubject` on the brand rejects it | fact dropped, not shown | no |
| model tempted to assert an edition from OCR | narration prompt P‑1 line + gate register | hedged; observed brand only | no |

## 8. Out of scope / follow-ups (measured separately)
- Letting a clear OCR brand corroborate the VLM to promote PROBABLE→CONFIDENT (measure FP first).
- Per-category calibration of the brand lane. Cross-check OCR against the image pixels.

## 9. Eng-review resolutions (folded)

- **[VERIFIED] The gate is band-agnostic — no honesty change needed.** `validateClaims` (`confidence.ts:77-119`)
  only requires a falsifiable clause to carry a *resolving* `evidenceRef`; `registerFor` is used by the PROMPT, not
  the gate. So a `provenance` clause citing an `obs` ref survives at PROBABLE the moment observed evidence is in
  `result.evidence`. The plan adds a grounded evidence SOURCE + a prompt clause; it does not touch the gate. New
  test locks this in (a PROBABLE clause citing `obs1` is APPROVED) so a future gate change can't silently regress it.
- **Brand research runs at ITEM rigor on the BRAND ENTITY, not mangled class scope.** When there's an observed
  brand and no confirmed model, the dossier subject = the brand entity ("Sub Pop record label"), `scope: 'item'`,
  `subjectTerms: [brand]`, no `disallowedSpecificTerms`. `sourceMatchesSubject([brand])` keeps facts on the label;
  the object stays PROBABLE and the narrator still may not assert an edition. This is cleaner than loosening class
  scope and reuses `admitFact` unchanged.
- **Observed source-proof renders "Seen on the object", not a dead link.** `sectionFor` (`cascade.ts:126-146`)
  already suppresses the `id` ref; generalize to suppress ANY `sourceUrl` starting `voxi:` (covers `voxi:cascade`
  and the new `voxi:observed`). The client `BucketCard`/`FactChip` render an observed proof as a plain "Seen on the
  object" line (no external link). Converge assertion added.
- **One research round-trip, not two (perf).** When an observed brand is present, the dossier issues ONE search
  whose query names both the object type and the brand entity (e.g. `"Sub Pop record label mug merchandise"`), not
  two Firecrawl calls. Still async/off the reveal path; best-effort; no added reveal latency.
- **`observed` evidence never enters `admitFact`.** It is narrator-only evidence (`IdEvidence` in `result.evidence`);
  the dossier fact path (`admitFact` quote⊆source loop) is unchanged and never sees `voxi:observed` (which has no
  fetched source text). Test asserts a `voxi:observed` ref is never admitted as a dossier fact.

## 10. Test coverage (eng-review diagram)

```
[+] live-vision: ocr_text/features → obs evidence; filler stripped from make/model; observedBrand derived   [ADD] unit
[+] identify_object: empty-name('' )→displayTitle fallback; obs evidence flows to result.evidence both bands  [ADD] unit
[+] confidence(REGRESSION-GUARD): a PROBABLE provenance clause citing obs1 is APPROVED (band-agnostic gate)    [ADD] unit [CRIT]
[+] live-narrator: NarrationInput.subject+observed rendered; obs-cited clause survives; obs source-proof hidden [ADD] unit
[+] cascade: subject prefers displayTitle; obs evidence → narrator; brand-subject research (item/[brand]/no-dis);
      purpose/maker prefer dossier facts; obs never admitted as a dossier fact                                 [ADD] units [CRIT]
[+] live-dossier: single search query names object+brand; subjectTerms=[brand]; maker-entity facts kept        [ADD] unit
[+] prompts.test.ts: narration.system/user + research-extract goldens RE-BASELINED byte-exact                  [CHG] golden
[+] judge.ts: purpose + maker rubrics                                                                          [ADD] unit
[→EVAL] reveal-buckets.web.ts --live: 4 buckets over branded fixtures, independent Claude judge, delta vs
      baseline-buckets.json (report-only; the user's proof-of-improvement)                                     [ADD] eval
[→E2E] converge: unchanged bucket UX still green; an observed-source card shows "Seen on the object"           [CHG] converge
[+] no-regression: bun test / typecheck / lint:selectors / pytest / all converge / judge:reveal GREEN
```
**IRON RULE:** goldens re-baselined (prompts rewritten) are a deliberate proof-layer change, not a weakened
assertion. Every existing cascade/arbitration/narrator/persistence test stays green (new fields are additive/optional).

## 11. Parallelization
Mostly sequential: workstreams A→B→C→D→E all touch `services/eve-agent/agent/` (`cascade.ts`/`live-vision.ts` are
shared hubs) → one lane. The judge/fixtures/harness (`e2e/judge/`) is an independent lane (Lane B) that can be built
in parallel and only reads the providers. `packages/shared/arbitration.ts` (optional `observed*` fields) is a tiny
leaf touched once. Recommendation: implement A→B→C→D→E in order in one worktree; author the `e2e/judge` harness
alongside.

## 12. NOT in scope
- Re-banding PROBABLE→CONFIDENT on OCR corroboration (measure FP first — §8).
- Any change to the bucket UX, `section` contract, per-bucket audio, or converge dock (this is a content-plumbing
  change; the UI is unchanged).
- The voice-bot / conversation grounding beyond folding the new section texts into `buildItemContext` (already
  plumbed).
- Non-branded specificity (cameras/bikes already work per the existing judge baseline); this plan targets the
  brand-primary class that was broken.

## 13. Adversarial review: HARDENED design (folds 22 verified findings — SUPERSEDES the loose parts of §4/§9)

A 6-lens adversarial workflow (33 raw → 22 survived) found the loose plan would **open honesty holes**, not just
fix quality. The corrected design below is authoritative; where it conflicts with §4/§9, §13 wins.

### 13.1 THE headline correction — `obs` must NOT be a universal grounding token (findings #4,#7,#12,#13,#18; 6 lenses)

Production wires `new LiveNarrator()` with **no `EntailmentJudge`** (`cascade-eve-client.ts:30`), so `validateClaims`
is **existence-only**: a falsifiable clause is approved the instant its `evidenceRef` merely *resolves*
(`confidence.ts:99-113`, the entailment branch at :108 is dead in prod). My §9 test ("obs-cited provenance APPROVED
at PROBABLE") therefore **locks in a fabrication**: a `provenance`/`date` clause citing `obs1` (claim `"SUB POP"`)
passes even though the OCR entails nothing about the maker/edition. **This defeats the non-negotiable spine.**

**Fix — a deterministic, judge-free gate restriction in `confidence.ts`:**
- Add a claim type **`observation`** — NOT in `FALSIFIABLE`, but the gate enforces it deterministically: it MUST
  cite a `voxi:observed` ref AND the clause text must *restate* the observed span (normalized substring of
  `ev.claim`) AND must not smuggle any other falsifiable content (an `observation`-auditor rejects a year /
  superlative / causal / comparative / provenance verb / proper-noun run beyond the observed brand token).
- A **`voxi:observed` ref may ONLY ground an `observation` clause.** Any `spec|provenance|date|causal|superlative|
  comparative` clause whose resolving evidence is `voxi:observed` → **REJECTED** (deterministic, no judge needed).
- So `obs` grounds only *"bears the Sub Pop mark"*; the maker/history/why story must cite a **web/dossier fact ref**
  (`admitFact`-verified). **Invert the §9/§10 test:** an obs-cited `observation` clause is APPROVED; an obs-cited
  `provenance`/`date` clause is **REJECTED**. Wiring a real `EntailmentJudge` into prod `LiveNarrator` is added as
  defense-in-depth (not the primary control, since prod has never had one).

### 13.2 Brand ≠ maker; brand-lane facts must be entity-scoped (findings #5,#14,#16)

- **The maker bucket must not claim manufacture.** A printed brand is not the factory (Sub Pop *branded* the mug; a
  mug factory *made* it). `narration.system.md`: the maker clause may assert only the grounded RELATIONSHIP the
  evidence supports — **"Branded by / Merch from / Released by / Sold by <brand>"** — and reserve "made/manufactured
  by" for a grounded actual manufacturer. Research bucket-3 (§4.D) reframes from "why they made this" → **"who the
  brand is and why a <label/brand> of this kind produces or sells this sort of object."**
- **Brand-lane facts are about the ENTITY, not the specimen.** Item-rigor research on the brand disables the
  class-scope model guard and `fact` events bypass the narrator's band register — so an edition fact ("the Singles
  Club mug shipped only to 1988 subscribers") could be shown as a fact about *this* mug. Fix: a **brand-lane extract
  prompt variant** that FORBIDS any fact asserting the photographed object is a specific edition/first-run/variant —
  facts must be about the brand entity in general. (Judge-free; no contract change.)

### 13.3 Only a clean, distinctive, PII-scrubbed, primary-object brand enters the lane (findings #8,#9,#15,#17,#19,#20,#22)

- **observedBrand from the clean structured `make`/`display_title`, NOT reconstructed from raw OCR** (finding #19:
  the real capture is `["S","U","B","P","O","P"]` → a naive join is `"S U B P O P"`). OCR only *corroborates*. Emit at
  most ONE distilled brand `obs` ref (+ ≤4 corroborating meaningful spans, mirroring `factsFromGrounding`'s cap of 5),
  never one ref per raw token, never a single-letter/punctuation/`©`/`®` claim.
- **Exclude `distinguishing_features[]` from evidence** (finding #17 — they carry inferences like "appears
  hand-thrown"). They may ride `narration.user.md` as a **non-citable** phrasing hint only.
- **PII/offensive scrub** (finding #8): before any span becomes `obs`, drop emails, phone numbers, dates/DOB,
  card/SSN/ID/passport-like number runs, street addresses, and a profanity/slur denylist. A `narration.system.md`
  rule: personal data read off an object is NEVER voiced or cited; the observation license covers brand/logo/model
  marks only. Source-proof shows a generic "Seen on the object" label, never the raw span.
- **Primary-object binding** (finding #22): derive observedBrand only from a span that matches/co-occurs with the VLM
  `make`/`display_title`, so a Kodak box behind a Canon never becomes the Canon's "observed" brand. Add an `ocr_text`
  schema `description` ("text physically on the chosen subject only").
- **Distinctive-brand gate** (finding #15): enable item-rigor brand research (`subjectTerms:[brand]`, no `disallowed`)
  ONLY when the brand is distinctive — multi-token OR not a common dictionary word (a small stoplist: dove, shell,
  apple, galaxy, delta, puma, …). Non-distinctive → fall back to today's class-scope suppression (**honest-empty
  maker**, never wrong-entity facts). Also require the fetched maker source to mention the object category somewhere
  in the body.
- **`cleanField` only nulls a WHOLLY-filler field** (finding #9): `stripped.length ? original.trim() : undefined` —
  never strip a filler token embedded in a real name ("Unknown Mortal Orchestra", "No Name", "Various Artists" stay
  intact). Apply the same narrowing to `cleanDisplayTitle` (it over-strips today).
- **Model-less scope honesty** (finding #20): §12's "cameras/bikes untouched" is only true for the *concrete*
  (make+model) subset. A model-less make ("Leica", model unresolved) DOES enter the brand lane — that's a deliberate,
  honesty-preserving improvement (naming an *observed* brand), but the proof set must include a model-less camera to
  confirm neutral-or-better.

### 13.4 The client source-proof contradiction (finding #6) — pick option (b)

`voxi:observed` must never reach `Linking.openURL`. Resolve the §4.A-vs-§9-vs-§12 contradiction by **suppressing any
`voxi:*` sourceUrl to `''` in `sectionFor`** (covers `voxi:cascade` too) → no dead link, **zero client change**
(honors §12). The observation lives in the section BODY text (the narrator's "bears the Sub Pop mark" clause), which
already renders. Add a regression guard that no `section`/`fact` ever ships a `voxi:*` sourceUrl. (Drop the "Seen on
the object" source-row promise from §4.A/§9.)

### 13.5 The proof harness must drive the REAL cascade (findings #1,#2,#3,#11,#21 — the user's proof requirement)

The existing `run-reveal-judge.web.ts` template hardcodes `band:'CONFIDENT'` and hand-feeds the subject to
`narrate()` — so mirroring it would make the proof **circular** (rich buckets regardless of whether the fix works).
The new `e2e/judge/reveal-buckets.web.ts` MUST:
1. Drive **`runIdentificationCascade`** end-to-end over a **real image** per fixture (the Sub Pop logo Wikimedia
   image already arbitrates to PROBABLE with the read OCR — proven in the baseline), full `CascadeDeps`.
2. **Assert `band === 'PROBABLE'`** for the branded fixtures (a CONFIDENT one would silently skip the fix).
3. Capture the four buckets **from the emitted events** (`token`+`description_upgrade`→what, `section`→purpose/maker,
   `fact`→facts) — never from a reconstructed `narrate({band:'CONFIDENT'})`.
4. **Freeze the baseline**: commit `baseline-buckets.json` (captured on OLD code, judge-stamped); write only behind an
   explicit `--write-baseline` flag (never self-overwrite).
5. **Pin the judge**: record `by` per score; **hard-fail the acceptance if it falls back to Gemini** or if
   before/after `by` differ (no Gemini-judges-Gemini, no cross-judge delta). Score each bucket **N=3×**, report
   mean±spread.
6. Run the **anonymous negative control** through the same cascade path.
7. Add **purpose + maker rubrics** to `judge.ts`; the maker rubric penalizes an unsupported manufacture claim.
Report-only (never gates CI — repo rule); the deterministic gate + the new unit tests are the pass/fail.

### 13.6 Deterministic negative control in `bun test` (finding #11)

Add a cascade/narrator unit test: an anonymous object (no OCR/brand → no `voxi:observed` evidence) + a narrator that
attempts an ungrounded maker clause → assert (a) no obs evidence emitted, (b) the maker clause is dropped →
maker section is the empty-marker (`text:''`). The symmetric negative of the obs-observation-APPROVED test.

### 13.7 Reconcile acceptance §6 with honest-empty §7 (finding #23)

Maker/purpose PASS when they EITHER materially exceed baseline AND name the brand/label story, OR resolve to
**honest-empty** (never fabricated/category-truism). The flagship "why a Sub Pop mug" answer is delivered primarily
via the **maker** bucket (who Sub Pop is) + the observed-brand **what**, not necessarily **purpose** (which may
honest-empty). Drop the unconditional "purpose & maker cross 0.7".

---
## Review trail
- **`/plan-eng-review` (2026-07-02):** Step-0 → **full plan** + **observed-brand-is-citable** (user-confirmed).
  Verified the gate is band-agnostic. Folded into §9–§12.
- **Adversarial 6-lens review (2026-07-02):** 33 raw → **22 verified** (11 refuted). The central catch: prod has no
  `EntailmentJudge`, so obs would be a universal grounding token — my §9 regression test locked in a fabrication.
  All 22 folded into **§13 (hardened, authoritative)**: obs grounds only a deterministic `observation` claim; brand≠
  maker; entity-scoped facts; clean/distinctive/PII-scrubbed/primary-object brand; `voxi:*` never a client link;
  real-cascade non-circular proof harness with frozen baseline + pinned judge; deterministic negative control.
  No unresolved decisions — the skeptic verdicts supplied the sharpened fixes.

## 14. Proof of improvement — MEASURED (independent Claude judge, identical image)

Ran `bun e2e/judge/reveal-buckets.ts` over the REAL cascade on the SAME Sub Pop logo image, before (old code, frozen
in `e2e/judge/baseline-buckets.json` + `docs/reveal-quality-baseline-before.txt`) and after. Full transcript:
`docs/reveal-quality-proof-after.txt`. Judge = independent Claude (`claude-opus-4-8`, no Gemini fallback). Every
bucket materially improved; none regressed; the honesty negative control held.

| bucket  | BEFORE | AFTER | Δ | AFTER text (grounded, cited) |
|---------|--------|-------|-----|------|
| what    | 0.20   | 0.85  | **+0.65** | "'SUB' stacked above 'POP'… introduced in 1986, refined from an earlier design" (2–3 sentences) |
| purpose | 0.50   | 0.97  | **+0.47** | "banner for the 'Sub Pop USA' column (1983)… branded the label's debut record 'Sub Pop 100'… merch outsold the records" |
| maker   | 0.50   | 0.85  | **+0.35** | "Sub Pop is an American independent record label, co-founded by Bruce Pavitt, known for early grunge releases" (WHO the label is, not a fabricated manufacturer) |
| facts   | 0.00   | 0.90  | **+0.90** | 8 grounded Sub Pop facts (Warner Bros. stake, the Postal Service's $3k album, the grunge-slang hoax, the Alaska Air jet) — 0 before |

Two follow-up iterations (loop) after the first pass: (a) each grounded bucket now gets 2–3 sentences, not a bare
one-liner (`narration.system.md` length rule); (b) the maker bucket now describes WHO the brand/label IS (entity +
relationship), not merely dates the object — which lifted maker from a thin one-liner to a grounded entity blurb.

- BEFORE: the read brand "Sub Pop" NEVER surfaced in what/maker; the reveal talked about "what a logo is". AFTER: the
  observed brand grounds the What (as an `observation`), the brand-lane research grounds specific maker/purpose/facts.
- Honesty control: an anonymous mug → maker honest-empty, never fabricated (both runs).
- One iteration was needed (loop): the first AFTER run regressed maker (−0.25) because the brand-lane query surfaced
  the merch store; leading the query with the entity's history recovered it to +0.35. Measured, not asserted.
- No regressions: whole TS suite 391/0, `lint:selectors`, pytest, and the authoritative `reveal-rnw` converge proof
  all GREEN. (The legacy `run-reveal-judge.web.ts` deterministic gate asserts `factSource` on the reveal FACE, but the
  icon-dock redesign moved facts BEHIND a bucket-card tap — a pre-existing staleness in that runner, not this change;
  `reveal-rnw.web.ts` is the redesign's authoritative proof and is green.)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | scope→full; gate verified band-agnostic; 5 refinements folded (§9–§12) |
| Adversarial | 6-lens workflow | Independent hole-hunting, each finding verified | 1 | ISSUES_FOLDED | 33 raw → 22 verified → all folded into §13 (hardened) |

- **UNRESOLVED:** 0.
- **VERDICT:** ENG CLEARED — plan hardened through both gates; §13 is authoritative. Ready to implement.
