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
  /** the confirmed subject terms a source must be about — [make, model] at item scope, [category] at class scope. */
  subjectTerms: string[]
  /** at CLASS scope: the VLM's (unconfirmed) make/model tokens a class-level fact must NOT name. */
  disallowedSpecificTerms?: string[]
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
/** Minimal normalization for the verbatim quote check: case + whitespace ONLY (never strip words/punctuation). */
const normQuote = (s: string): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
/** Alphanumeric token set for subject/source matching. Splits on non-alphanumerics AND on letter↔digit boundaries
 *  so "AE-1", "AE1" and "ae 1" all tokenize to ["ae","1"] (robust matching of model names across URL/title forms). */
const tokens = (s: string): string[] =>
  (s ?? '')
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)

/** (1) The verbatim quote is a minimally-normalized substring of the fetched source text. */
export function verifyQuote(quote: string, sourceText: string): boolean {
  const q = normQuote(quote)
  return q.length > 0 && normQuote(sourceText).includes(q)
}

/** (2) The fetched page (its title + URL tokens) is ABOUT the subject: every subject token appears in the page. */
export function sourceMatchesSubject(source: FetchedSource, subjectTerms: string[]): boolean {
  const need = new Set(subjectTerms.flatMap(tokens))
  if (need.size === 0) return true
  const hay = new Set(tokens(`${source.title} ${source.url}`))
  for (const t of need) if (!hay.has(t)) return false
  return true
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
    kept.push({
      text: f.text,
      claimType: f.claimType,
      evidenceRef: ref,
      sourceUrl: f.sourceUrl,
      sourceTitle: f.sourceTitle ?? '',
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
