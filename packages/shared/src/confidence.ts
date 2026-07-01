/**
 * Claim-structured honesty gate (PLAN §8.3 / D10 / §22.1, RT-1).
 *
 * The core trust control: Voxi's prose may not assert a falsifiable claim without a grounded source. The gate
 * works on CLAUSES, not on free text or regex over numbers — a fluent narrator cannot charm around it by
 * phrasing a fabricated provenance without digits. A deterministic renderer stitches only APPROVED clauses.
 *
 * Two layers, both here:
 *  1. validateClaims()      — hard-reject any falsifiable clause lacking a valid evidence ref (+ optional
 *                             entailment judge so a citation must actually support the clause, not just exist).
 *  2. auditClaimTypes()     — independent re-classification (RT-1 §22.1): the generator self-labels claim_type,
 *                             so a separate auditor flags any `flavor` clause that smuggles a named entity /
 *                             date / place / factual predicate. Fail-closed on disagreement.
 *
 * Honest naming: the accept/reject decision is "fail-closed, judge-gated" (the entailment step is a fallible
 * model). Only the renderer is deterministic. The §14 golden-set measures the judge's miss-rate.
 */

export type ConfidenceBand = 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN'

export type ClaimType =
  | 'spec' // weight, dimensions, price, displacement…
  | 'provenance' // who made/designed/owned it, origin story
  | 'date' // year, era
  | 'causal' // "which is why it never sold"
  | 'superlative' // "the lightest of its era"
  | 'comparative' // "lighter than the X"
  | 'flavor' // asserts nothing falsifiable (rhetorical/aesthetic)

/** Claim types that MUST carry a grounded evidence ref. `flavor` is the only free type. */
export const FALSIFIABLE: ReadonlySet<ClaimType> = new Set([
  'spec',
  'provenance',
  'date',
  'causal',
  'superlative',
  'comparative',
])

export interface Clause {
  text: string
  claimType: ClaimType
  /** index/key into the closed evidence[] array; required for falsifiable types. */
  evidenceRef?: string
}

export interface Evidence {
  ref: string
  sourceUrl: string
  /** the fact this evidence supports (for entailment checking). */
  claim: string
}

/** Pluggable entailment judge (NLI / cheap LLM). Returns true iff `evidence.claim` supports `clause.text`. */
export type EntailmentJudge = (clause: Clause, evidence: Evidence) => boolean

/** Detects whether a `flavor` clause is actually smuggling a falsifiable assertion (independent auditor). */
export type NamedClaimDetector = (text: string) => boolean

export interface ValidateResult {
  ok: boolean
  approved: Clause[]
  rejected: { clause: Clause; reason: string }[]
  /** deterministic prose from approved clauses only (undefined if !ok and you chose fail-closed). */
  rendered?: string
}

export interface ValidateOpts {
  /** if provided, a cited clause is also checked for entailment (citation must actually support it). */
  judge?: EntailmentJudge
  /** independent auditor: a flavor clause that trips this is reclassified as a violation. */
  detectNamedClaim?: NamedClaimDetector
  /** podcast/audio path must fail-closed (drop or fail). description path may render approved-only. */
  failClosed?: boolean
}

export function validateClaims(
  clauses: Clause[],
  evidence: Evidence[],
  opts: ValidateOpts = {},
): ValidateResult {
  const byRef = new Map(evidence.map((e) => [e.ref, e]))
  const approved: Clause[] = []
  const rejected: { clause: Clause; reason: string }[] = []

  for (const c of clauses) {
    // Independent claim_type audit: a "flavor" clause that contains a falsifiable assertion is a violation,
    // regardless of the generator's self-label (closes the self-labeling escape hatch, §22.1).
    if (c.claimType === 'flavor' && opts.detectNamedClaim?.(c.text)) {
      rejected.push({ clause: c, reason: 'flavor clause smuggles a falsifiable claim (auditor)' })
      continue
    }

    if (!FALSIFIABLE.has(c.claimType)) {
      approved.push(c)
      continue
    }

    if (!c.evidenceRef) {
      rejected.push({ clause: c, reason: `${c.claimType} clause has no evidence ref` })
      continue
    }
    const ev = byRef.get(c.evidenceRef)
    if (!ev) {
      rejected.push({ clause: c, reason: `evidence ref "${c.evidenceRef}" not in closed evidence[]` })
      continue
    }
    if (opts.judge && !opts.judge(c, ev)) {
      rejected.push({ clause: c, reason: 'cited evidence does not entail the claim (citation laundering)' })
      continue
    }
    approved.push(c)
  }

  const ok = rejected.length === 0
  // Fail-closed (audio path): if anything was rejected, do not render — caller drops the segment / fails.
  const rendered = !ok && opts.failClosed ? undefined : approved.map((c) => c.text).join(' ')
  return { ok, approved, rejected, rendered }
}

/**
 * Map a confidence band to the linguistic register Voxi is allowed to use (PLAN §8.3).
 * The band is the source of truth; the persona dresses it.
 */
export function registerFor(band: ConfidenceBand): {
  mayAssertSpecificModel: boolean
  hedge: boolean
  chipLabel: string
} {
  switch (band) {
    case 'CONFIDENT':
      return { mayAssertSpecificModel: true, hedge: false, chipLabel: 'identified' }
    case 'PROBABLE':
      return { mayAssertSpecificModel: false, hedge: true, chipLabel: 'a confident maybe' }
    case 'UNKNOWN':
      return { mayAssertSpecificModel: false, hedge: true, chipLabel: 'not in the Guide yet' }
  }
}
