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
  /** a CORROBORATED (non-VLM) model year, threaded ONLY on the item non-brand-lane lane — a RETRIEVAL HINT that
   *  helps the search find the model's production-date page. It is NEVER displayed: the shown `made` date still must
   *  ground on an admitted fact (verbatim quote + on-subject source + entailment), never on this bare number. */
  year?: number
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

/** Leading adjectives / colours a category phrase carries that are never its head noun, so the topical anchor keys
 *  on the real noun ("Red Brick" → "brick"). Deliberately small — the head is the LAST significant token anyway. */
const CATEGORY_STOPWORDS: ReadonlySet<string> = new Set([
  'red', 'blue', 'green', 'black', 'white', 'grey', 'gray', 'brown', 'yellow', 'orange', 'pink', 'purple',
  'small', 'large', 'big', 'old', 'new', 'plain', 'generic', 'vintage', 'antique', 'modern', 'classic',
  'the', 'kind', 'type', 'object', 'item', 'thing', 'piece', 'style',
])

/**
 * (5a) The CATEGORY HEAD NOUN — the last SIGNIFICANT token of a category phrase ("Red Brick" → "brick",
 * "office chair" → "chair", "kitchen utensil" → "utensil"). At CLASS scope it anchors BOTH the source match (a
 * compound category should match its head-noun page: "Red Brick" ↦ "Brick — Wikipedia", which the strict full-phrase
 * anchor missed) and the set-level topical gate. Falls back to the LAST RAW token when no ≥3-char non-stopword token
 * survives, so a short real category ("CD", "TV") still yields a real anchor — an EMPTY head would DISABLE both gates
 * (a no-op source match + a short-circuited set anchor), MORE permissive than the pre-fix strict anchor.
 */
export function categoryHead(category: string): string {
  const raw = tokens(category)
  const significant = raw.filter((t) => t.length >= 3 && !CATEGORY_STOPWORDS.has(t))
  const pick = significant.length ? significant : raw
  return fold(pick[pick.length - 1] ?? '')
}

/** Does `text` name the category head as a WHOLE word (regular plural/possessive tolerated) — a word-boundary match,
 *  NOT a raw substring, so a head buried in an unrelated word never counts ("board" ⊄ "billboard", "pen" ⊄
 *  "Pennsylvania", "block" ⊄ "blockbuster") and a SHORT head is not over-matched into an unrelated word ("pen" ⊄
 *  "penny", "can" ⊄ "candy") — while a genuine plural still does ("brick"→"bricks", "box"→"boxes"). Irregular
 *  plurals/synonyms ("mouse"→"mice", "sofa"→"couch") are a known residual → honest-empty, never a false assertion.
 *  `head` is fold()'d to [a-z0-9] so it is safe to interpolate into the pattern. */
export function namesCategoryHead(text: string, head: string): boolean {
  return head.length > 0 && new RegExp(`\\b${head}(?:s|es|'s)?\\b`, 'i').test(text)
}

/** (5a′) The SIGNIFICANT category tokens — every content token of a category phrase ("Plywood Board" → ['plywood',
 *  'board'], "Red Brick" → ['brick'], "office chair" → ['office','chair']), dropping colour/adjective stopwords. A
 *  fact/source is topical if it matches ANY of them, because a compound category's SPECIFIC noun often precedes a
 *  GENERIC head ("Plywood Board" IS plywood): a head-only anchor on 'board' wrongly dropped every "plywood" fact AND
 *  the real "Plywood — Wikipedia" page. Falls back to the raw tokens when none is ≥3-char/non-stopword (so "CD" →
 *  ['cd'] keeps a real anchor, never an empty one that would DISABLE the gate). Each token is fold()'d to [a-z0-9]. */
export function categoryAnchors(category: string): string[] {
  const raw = tokens(category)
  const significant = raw.filter((t) => t.length >= 3 && !CATEGORY_STOPWORDS.has(t))
  return (significant.length ? significant : raw).map((t) => fold(t)).filter((t) => t.length > 0)
}

/** Retail / search-listing RESULT-COUNT SEO noise a CATEGORY web search drags in — a fact citing a store's result
 *  count ("Target lists over 8,000 results", "Amazon … 60,000+ listings") is never a fact about the object. It
 *  requires a search/listing count, so a genuine spec ("the meter displays results"), a sales figure ("350,000,000
 *  units sold"), or a retailer-ENTITY fact ("Target operates a store chain") is never matched. Applied at CLASS
 *  scope only (see admitFact) — the drift is a category-search artefact; item/brand facts stay byte-unchanged. */
const LISTING_JUNK_PATTERNS: readonly RegExp[] = [
  /\b\d[\d,]{2,}\+?\s*(?:results?|listings?)\b/i, //                              "8,000 results", "60,000+ listings"
  /\b(?:lists?|listed|listing)\b[^.]{0,20}\b\d[\d,]{1,}\+?\s*(?:results?|listings?|items?|products?)\b/i, // "lists over 8,000 items"
]
/** (5b) Is this fact retail / search-listing RESULT-COUNT SEO noise rather than a fact about the object? */
export function isListingJunk(text: string): boolean {
  return LISTING_JUNK_PATTERNS.some((re) => re.test(text))
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
  // Source-subject match. ITEM/brand scope keeps the strict [make, model] anchor (a quote lifted from a DIFFERENT
  // model's page must fail). CLASS scope accepts a source about ANY significant category token, so a compound category
  // ("Red Brick" → "Brick — Wikipedia", "Plywood Board" → "Plywood — Wikipedia") still matches: the strict full-phrase
  // anchor over-rejected genuine category sources, starving the deep path into the drift-prone grounding fallback.
  const classAnchors = ctx.scope === 'class' ? categoryAnchors(ctx.subjectTerms[0] ?? '') : []
  const subjectOk =
    ctx.scope === 'class'
      ? classAnchors.length === 0 || classAnchors.some((a) => sourceMatchesSubject(src, [a]))
      : sourceMatchesSubject(src, ctx.subjectTerms)
  if (!subjectOk) return { ok: false, reason: 'source-off-subject' }
  if (ctx.scope === 'class' && namesDisallowedSpecific(`${fact.text} ${fact.quote}`, ctx.disallowedSpecificTerms)) {
    return { ok: false, reason: 'class-scope-names-model' }
  }
  // Retail / search-listing RESULT-COUNT SEO noise — CLASS scope only. It is a category-search artefact; an item/brand
  // fact (a sales figure "350,000,000 units sold", a spec that says "results") must stay byte-unchanged (Tier A/B).
  if (ctx.scope === 'class' && isListingJunk(`${fact.text} ${fact.quote}`)) return { ok: false, reason: 'listing-junk' }
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

  // Set-level topical anchor (CLASS scope) — the last defence against WHOLESALE off-topic drift on the credential-free
  // grounding path, whose SYNTHETIC source title (= the subject) makes the per-fact source match a no-op (RCA: a
  // "brick" query returned an all-"Red Bull" cluster every per-fact gate admitted). A fact is topically anchored when
  // EITHER its source is a REAL page (deep path — its title already passed the head-noun source match, so it IS about
  // the category even if the fact itself uses a pronoun) OR it names the category head as a whole word. If NOTHING in
  // the cluster is anchored, it is off-topic drift → drop it whole (honest-empty beats confidently off-topic).
  // Two residuals are deliberately accepted because both degrade to honest-empty / over-keep, NEVER to a new false
  // assertion: a purely grounding cluster that only ever uses a SYNONYM/irregular plural ("couch" for a "sofa" query)
  // is dropped to empty; and a single genuine anchor keeps the rest of ITS cluster, so a rare grounding drift that
  // leads on-topic then wanders is not thinned.
  if (input.scope === 'class' && kept.length > 0) {
    const anchors = categoryAnchors(input.subjectTerms[0] ?? input.subject)
    const anchored = kept.some((f) => {
      const src = proposed.sources.find((s) => s.url === f.sourceUrl)
      const title = src?.title ?? ''
      const realTitle = title.trim().length > 0 && fold(title) !== fold(input.subject)
      // A REAL-titled source anchors the cluster only if its title names a category head as a WHOLE WORD. The per-fact
      // gate uses a raw substring anchor, so without this word-boundary check a compound-noun drift cluster (Cardboard /
      // Skateboard / Motherboard pages returned for a "board" query) would pass per-fact and the all-drift safety net
      // would be gone now that the synthetic-title path is — re-armed here, NOT by re-tightening the tuned per-fact gate.
      return (realTitle && anchors.some((a) => namesCategoryHead(title, a))) || anchors.some((a) => namesCategoryHead(`${f.text} ${f.quote}`, a))
    })
    if (anchors.length > 0 && !anchored) {
      for (const f of kept) dropped.push({ fact: { text: f.text, claimType: f.claimType, sourceUrl: f.sourceUrl, quote: f.quote }, reason: 'class-cluster-off-topic' })
      kept.length = 0
      evidence.length = 0
    }
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
