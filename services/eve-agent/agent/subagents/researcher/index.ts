/**
 * researcher subagent — the deep-research → durable `ResearchDossier` (PROMPT-QUALITY §3.B2). Task-mode, exactly
 * like `storyteller`: a pure `buildDossier(input, proposedDossier, opts)` runs the REAL shared honesty gate over a
 * drafted dossier and emits only VERIFIED, provably-sourced content. In prod the draft comes from a bounded AI-SDK
 * `generateText`-with-tools loop (Claude + web_search/web_crawl); in tests the draft is supplied directly so the
 * GATE + the closed provenance loop are what's exercised — no creds, no runtime.
 *
 * The load-bearing control is the CLOSED PROVENANCE LOOP (decision 3 / §2.2 / adversarial #1). A fact is admitted
 * only when ALL hold:
 *   1. verifyQuote        — the verbatim `quote` is a minimally-normalized (case+whitespace) substring of the
 *                           FETCHED text of the source it cites (the quote is real, not hallucinated);
 *   2. sourceMatchesSubject — that source's page (title/URL tokens) is actually ABOUT this subject's make/model,
 *                           so a real quote lifted from a DIFFERENT model's page is rejected (adversarial #6);
 *   3. quote ⊨ text       — the honesty gate's EntailmentJudge, fed the VERIFIED QUOTE as the evidence claim (NOT a
 *                           model paraphrase), confirms the quote actually SUPPORTS the fact text (adversarial #1);
 *   4. class-scope guard  — at 'class' scope (a hedged PROBABLE reveal), a fact naming the specific (unconfirmed)
 *                           make/model is rejected (adversarial #6/#3) — grounding proves fact↔source, never that
 *                           THIS photographed object is that subject.
 * (1) and (2) are DETERMINISTIC external anchors and the primary defense; (3) is the fallible judge, never alone.
 */
import { validateClaims, type Clause, type Evidence, type EntailmentJudge } from '../../../../../packages/shared/src/confidence'
import type { DossierFact, DossierEvidence, ResearchDossier } from '../../../../../packages/shared/src/dossier'

/** A fetched source: the URL, its page title, and the FETCHED text (markdown/plain) the quote must be found in. */
export interface FetchedSource {
  url: string
  title: string
  text: string
}

/** A drafted (unverified) fact from the research loop. */
export interface ProposedFact {
  text: string
  claimType: DossierFact['claimType']
  sourceUrl: string
  sourceTitle?: string
  quote: string
}

/** What the research loop drafts (before the gate). `overview` is OPTIONAL — the reveal's description is re-voiced
 *  by the narrator from the verified fact evidence, so the honesty-critical output of buildDossier is the FACTS. */
export interface ProposedDossier {
  overview?: Clause[]
  facts: ProposedFact[]
  sources: FetchedSource[]
}

export interface DossierInput {
  subject: string
  scope: 'item' | 'class'
  /** the confirmed subject terms a source must be about — [make, model] at item scope, [category] at class scope,
   *  [brand] in the brand lane. */
  subjectTerms: string[]
  /** at CLASS scope: the VLM's (unconfirmed) make/model tokens a class-level fact must NOT name. */
  disallowedSpecificTerms?: string[]
  /** BRAND LANE (§13.2, adversarial #5): research a DISTINCTIVE observed brand as an ENTITY (item rigor on [brand]),
   *  but facts must be about the brand itself, never asserting the photographed object is a specific edition/first-run.
   *  Selects the brand-lane extract prompt variant + widens the search query with the object type. */
  brandLane?: boolean
  /** the coarse object type (e.g. "mug") — used only to widen the brand-lane search query ("Sub Pop … mug"). */
  objectType?: string
  provenance?: { model: string; generatedAt: number; toolCalls: number }
}

export interface BuildOpts {
  /** the entailment judge (fed the verified quote). Fallible; fail-closes on low confidence. Optional in tests. */
  judge?: EntailmentJudge
}

export type DossierResult =
  | { ok: true; dossier: ResearchDossier; dropped: { fact: ProposedFact; reason: string }[] }
  | { ok: false; reason: string; dropped: { fact: ProposedFact; reason: string }[] }

// ── deterministic normalization + anchors ────────────────────────────────────────────────────────────────────
/**
 * Reduce the markdown NOISE a "verbatim" web quote strips but the raw source keeps. Firecrawl returns rich Wikipedia
 * markdown; a model copying a visible span keeps the anchor TEXT of an inline link but drops the "(url)", and omits
 * footnote markers — so the raw markdown is never a substring of the clean quote. Neutralising these on BOTH sides
 * is a no-op on plain prose (the negative-control sources), so it never loosens the off-subject / unsupported gates.
 */
const stripMarkdown = (s: string): string =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') //        images:  ![alt](url) → ∅
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') //     links:   [text](url) → text  (the killer for infobox facts)
    .replace(/\[[0-9a-z][0-9a-z ]{0,5}\]/gi, '') // footnote/citation markers: [1], [nb 3] → ∅
    .replace(/[*_`#>|]/g, '') //                    emphasis / heading / blockquote / table-cell (|) marks
/**
 * The verbatim-match key: lowercase → strip markdown noise → remove ALL whitespace. Real web markdown (infobox
 * tables, wrapped cells, inline links) reformats a copied "verbatim" span — "Units sold" arrives as "Unitssold",
 * "[Game Boy Color](url)" as "Game Boy Color" — so a byte-exact check rejects TRUE quotes (this is why deep research
 * produced 0 facts for infobox-heavy subjects). This normalization keeps the check HONEST — every character and
 * digit of the claim must still be present, in order; numbers and punctuation are preserved, so a hallucinated spec
 * can never pass — while tolerating the reformatting. It is the primary deterministic anchor; deliberately not fuzzy.
 */
const verbatimKey = (s: string): string => stripMarkdown((s ?? '').toLowerCase()).replace(/\s+/g, '')
/** Alphanumeric-only fold (drops spaces AND punctuation) so "LaCroix"≡"La Croix" and "AE-1"≡"AE1" match as
 *  substrings — authoritative pages spell brands/models inconsistently across title, URL, and body. */
const fold = (s: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
/** Alphanumeric token set for the class-scope model-name guard. Splits on non-alphanumerics AND on letter↔digit
 *  boundaries so "AE-1", "AE1" and "ae 1" all tokenize to ["ae","1"] (robust model-name matching). */
const tokens = (s: string): string[] =>
  (s ?? '')
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)

/** (1) The verbatim quote is present in the fetched source text (whitespace/citation-insensitive — see verbatimKey). */
export function verifyQuote(quote: string, sourceText: string): boolean {
  const q = verbatimKey(quote)
  return q.length > 0 && verbatimKey(sourceText).includes(q)
}

/**
 * (2) The fetched page is ABOUT the subject. Robust to how authoritative pages title themselves: the MOST-SPECIFIC
 * term (the model — the last subjectTerm) must appear in the page title/URL — a page titled "Game Boy" or
 * "La Croix Sparkling Water" IS about it even though its title omits the brand ("Nintendo") — and then EVERY subject
 * term (brand + model) must appear somewhere on the page (title/URL/body). A quote lifted from a DIFFERENT model's
 * page still fails: that page's title/URL won't contain THIS model, so the off-subject negative control holds.
 */
export function sourceMatchesSubject(source: FetchedSource, subjectTerms: string[]): boolean {
  const terms = subjectTerms.filter((t) => fold(t).length > 0)
  if (terms.length === 0) return true
  const titleUrl = fold(`${source.title} ${source.url}`)
  const whole = fold(`${source.title} ${source.url} ${source.text}`)
  // the model (most specific → the last term) anchors page identity: it must be in the title/URL, not just the body.
  const model = fold(terms[terms.length - 1]!)
  if (!titleUrl.includes(model)) return false
  // every term (brand + model) must then appear somewhere on the page.
  return terms.every((t) => whole.includes(fold(t)))
}

/** (4) At class scope: does this text/quote NAME a disallowed specific make/model token? */
export function namesDisallowedSpecific(text: string, disallowed: string[]): boolean {
  if (!disallowed.length) return false
  const hay = new Set(tokens(text))
  return disallowed.flatMap(tokens).some((t) => t.length >= 2 && hay.has(t))
}

/** The shared per-fact primitive — called identically by the live provider (inline) and buildDossier (batch). */
export function admitFact(
  fact: ProposedFact,
  sources: FetchedSource[],
  ctx: { subjectTerms: string[]; scope: 'item' | 'class'; disallowedSpecificTerms: string[]; judge?: EntailmentJudge },
): { ok: true } | { ok: false; reason: string } {
  const src = sources.find((s) => s.url === fact.sourceUrl)
  if (!src) return { ok: false, reason: 'source-not-fetched' }
  if (!verifyQuote(fact.quote, src.text)) return { ok: false, reason: 'quote-not-in-source' }
  if (!sourceMatchesSubject(src, ctx.subjectTerms)) return { ok: false, reason: 'source-off-subject' }
  if (ctx.scope === 'class' && namesDisallowedSpecific(`${fact.text} ${fact.quote}`, ctx.disallowedSpecificTerms)) {
    return { ok: false, reason: 'class-scope-names-model' }
  }
  // (3) entailment: the gate's judge sees the VERIFIED QUOTE as the evidence claim → grades quote ⊨ fact.text.
  const ev: Evidence = { ref: 'q', sourceUrl: fact.sourceUrl, claim: fact.quote }
  const clause: Clause = { text: fact.text, claimType: fact.claimType, evidenceRef: 'q' }
  const verdict = validateClaims([clause], [ev], { judge: ctx.judge, failClosed: true })
  if (!verdict.ok) return { ok: false, reason: 'quote-not-entailing-text' }
  return { ok: true }
}

/**
 * Build a verified dossier from a drafted one. Every kept fact passed the closed provenance loop; the overview's
 * falsifiable clauses are honesty-gated against the same closed evidence. Facts that fail are DROPPED (never
 * fabricated to hit a count) — the caller surfaces the survivors. Fails only when no grounded overview survives.
 */
export function buildDossier(input: DossierInput, proposed: ProposedDossier, opts: BuildOpts = {}): DossierResult {
  const ctx = {
    subjectTerms: input.subjectTerms,
    scope: input.scope,
    disallowedSpecificTerms: input.disallowedSpecificTerms ?? [],
    judge: opts.judge,
  }
  const kept: DossierFact[] = []
  const evidence: DossierEvidence[] = []
  const dropped: { fact: ProposedFact; reason: string }[] = []

  for (const f of proposed.facts) {
    const r = admitFact(f, proposed.sources, ctx)
    if (!r.ok) {
      dropped.push({ fact: f, reason: r.reason })
      continue
    }
    const ref = `fact${kept.length + 1}`
    // The closed loop: the evidence claim IS the verified quote (§2.2), so the narrator/overview gate also grades
    // against the quote, never a model paraphrase.
    evidence.push({ ref, sourceUrl: f.sourceUrl, claim: f.quote })
    // Phase B (REVEAL-CARD-CLEANUP-PLAN §3.4): surface the REAL fetched page title so the reveal's Sources list can
    // show a human title instead of a bare hostname — but ONLY when it is a genuine page title. On the credential-free
    // grounding path the source `title` is hard-coded to `input.subject` (an internal sourceMatchesSubject anchor, NOT
    // a webpage title), so adopting it would render the object's OWN name as if it were the page's title. Guard on
    // `fold(title) !== fold(subject)`; otherwise leave '' so the client derives an honest hostname/site name.
    const matchedTitle = proposed.sources.find((s) => s.url === f.sourceUrl)?.title ?? f.sourceTitle ?? ''
    const displayTitle = fold(matchedTitle) === fold(input.subject) ? '' : matchedTitle
    kept.push({
      text: f.text,
      claimType: f.claimType,
      evidenceRef: ref,
      sourceUrl: f.sourceUrl,
      sourceTitle: displayTitle,
      quote: f.quote,
      order: kept.length,
    })
  }

  // The overview's falsifiable clauses (if the draft supplied any) must cite the same closed evidence (render
  // approved-only). The reveal's description is otherwise re-voiced by the narrator from `evidence`, so an empty
  // overview is fine as long as at least one FACT survived — a dossier with neither has nothing to surface.
  const overviewVerdict = validateClaims(proposed.overview ?? [], evidence, { judge: opts.judge, failClosed: false })
  const overview = overviewVerdict.approved
  if (kept.length === 0 && overview.length === 0) {
    return { ok: false, reason: 'no verified fact or grounded overview clause survived the honesty gate', dropped }
  }

  const dossier: ResearchDossier = {
    subject: input.subject,
    scope: input.scope,
    overview,
    facts: kept,
    evidence,
    sources: proposed.sources.map((s) => ({ url: s.url, title: s.title })),
    provenance: input.provenance ?? { model: 'unknown', generatedAt: 0, toolCalls: 0 },
  }
  return { ok: true, dossier, dropped }
}

/** The declared output invariants (boot-spike + tests assert these), mirroring storyteller's OUTPUT_SCHEMA. */
export const OUTPUT_SCHEMA = {
  /** every fact carries provable provenance: a non-empty quote + a sourceUrl present in the dossier's sources. */
  everyFactHasProvenance(d: ResearchDossier): boolean {
    const srcs = new Set(d.sources.map((s) => s.url))
    return d.facts.every((f) => f.quote.trim().length > 0 && f.sourceUrl.length > 0 && srcs.has(f.sourceUrl))
  },
  /** every fact's evidenceRef resolves, and its evidence claim is the fact's own quote (the closed loop). */
  everyFactClosedLoop(d: ResearchDossier): boolean {
    const byRef = new Map(d.evidence.map((e) => [e.ref, e]))
    return d.facts.every((f) => {
      const e = byRef.get(f.evidenceRef)
      return !!e && e.sourceUrl === f.sourceUrl && e.claim === f.quote
    })
  },
  /** the reveal target: at least three verified facts (quality goal — survivors are surfaced when fewer). */
  hasEnoughFacts(d: ResearchDossier, min = 3): boolean {
    return d.facts.length >= min
  },
}
