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
  | 'observation' // "it bears the Sub Pop mark" — restates ONLY what is physically read off the object (§13.1)
  | 'flavor' // asserts nothing falsifiable (rhetorical/aesthetic)

/** Claim types that MUST carry a grounded evidence ref. `flavor` and `observation` are the free-of-web types
 *  (`observation` is instead gated deterministically against its observed evidence — see validateClaims). */
export const FALSIFIABLE: ReadonlySet<ClaimType> = new Set([
  'spec',
  'provenance',
  'date',
  'causal',
  'superlative',
  'comparative',
])

/**
 * The reveal's on-object OBSERVATION channel (§13.1, adversarial #4/#7/#12/#13/#18). Reading a brand/logo/mark off
 * the object is a real observation Voxi may state at ANY band — but ONLY as a bare restatement of the mark, never as
 * a springboard for provenance/date/edition claims the mark does not support. Because production runs the narrator
 * with NO EntailmentJudge, this guarantee must be DETERMINISTIC, not delegated to a judge or the prompt:
 *   - an `observation` clause may ground ONLY on `voxi:observed` evidence, must RESTATE that evidence's mark, and
 *     must not smuggle any other falsifiable content; and
 *   - a `voxi:observed` ref may ground ONLY an `observation` clause — never a spec/provenance/date/… claim.
 * So "it bears the Sub Pop mark" is admissible; "made by Sub Pop in 1988" (citing the same mark) is rejected. The
 * maker/history/why story must instead cite a web/dossier fact ref (admitFact-verified). */
export const OBSERVED_SOURCE_PREFIX = 'voxi:observed'
const isObservedEvidence = (e?: Evidence): boolean => !!e && e.sourceUrl.startsWith(OBSERVED_SOURCE_PREFIX)

const foldTokens = (s: string): string[] => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** The observation clause must actually RESTATE the observed mark: every significant token of the observed span is
 *  present in the clause (so "bears the Sub Pop mark" restates observed "Sub Pop"; unrelated prose does not). */
export function restatesObservation(clauseText: string, observedClaim: string): boolean {
  const marks = foldTokens(observedClaim)
  if (marks.length === 0) return false
  const hay = new Set(foldTokens(clauseText))
  return marks.every((m) => hay.has(m))
}

/** An observation must add NOTHING falsifiable beyond the mark itself. Strip the observed tokens, then reject any
 *  residual year, manufacture/provenance verb, superlative, causal/comparative, or a SECOND proper-noun run (a name
 *  other than the brand) — the deterministic block on "it reads Sub Pop" → "…founded in 1988 by Bruce Pavitt". */
export function observationOverreaches(clauseText: string, observedClaim: string): boolean {
  const observed = new Set(foldTokens(observedClaim))
  const residual = clauseText
    .split(/\s+/)
    .filter((w) => !observed.has(w.toLowerCase().replace(/[^a-z0-9]+/g, '')))
    .join(' ')
  if (/\b(1[89]\d\d|20\d\d)\b/.test(residual)) return true // a year
  if (/\b(made|manufactured|produced|founded|established|designed|invented|created|built|released|signed)\b/i.test(residual)) return true // provenance/manufacture verbs
  if (/\b(first|only|last|fastest|slowest|largest|smallest|lightest|heaviest|oldest|newest|rarest|finest|best|the most|the least)\b/i.test(residual)) return true // superlative
  if (/\b(because|which is why|due to|thanks to|so that|more than|less than|faster than|lighter than|compared to)\b/i.test(residual)) return true // causal / comparative
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(residual)) return true // a second proper-noun run (a name beyond the brand)
  return false
}

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

    // OBSERVATION (§13.1): a bare restatement of an on-object mark. Deterministically gated (no judge needed): it
    // must cite an observed ref, restate that mark, and add nothing falsifiable beyond it. This is the ONLY clause
    // an observed ref may ground.
    if (c.claimType === 'observation') {
      const ev = c.evidenceRef ? byRef.get(c.evidenceRef) : undefined
      if (!ev || !isObservedEvidence(ev)) {
        rejected.push({ clause: c, reason: 'observation clause must cite an observed (voxi:observed) evidence ref' })
        continue
      }
      if (!restatesObservation(c.text, ev.claim)) {
        rejected.push({ clause: c, reason: 'observation clause does not restate the observed mark' })
        continue
      }
      if (observationOverreaches(c.text, ev.claim)) {
        rejected.push({ clause: c, reason: 'observation clause asserts more than the observed mark (overreach)' })
        continue
      }
      approved.push(c)
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
    // An OBSERVED ref (voxi:observed) may ground ONLY an `observation` clause — never a falsifiable one (§13.1). This
    // is the deterministic block on "made by Sub Pop in 1988" citing the bare "SUB POP" mark, in a prod path that
    // wires no EntailmentJudge. The maker/history must cite a web/dossier fact ref (admitFact-verified) instead.
    if (isObservedEvidence(ev)) {
      rejected.push({ clause: c, reason: 'observed evidence cannot ground a falsifiable claim (only an observation)' })
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
