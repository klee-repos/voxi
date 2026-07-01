/**
 * Defamation / disparagement gate for generated content (PLAN §6.2, §15 / RT-9).
 *
 * A negative claim about an identifiable entity may only ship if backed by ≥2 INDEPENDENT sources, where
 * "independent" = distinct registrable domains (not the same wire copy syndicated twice). Otherwise it routes
 * to human review (or is dropped, fail-closed). The claim classifier is pluggable (an LLM in prod; a heuristic
 * here) so the GATE logic is deterministically testable — the gate is the part that protects against trade-libel.
 */
export interface Source {
  url: string
}

export interface ClaimClass {
  negative: boolean
  identifiableEntity: boolean
}

export type ClaimClassifier = (text: string) => ClaimClass

export const heuristicClassifier: ClaimClassifier = (t) => ({
  negative:
    /\b(recall(ed)?|caught fire|fire hazard|fraud(ulent)?|faked?|defect(ive)?|banned|lawsuit|sued|exploded|dangerous|scandal)\b/i.test(
      t,
    ),
  // crude: a capitalized word that isn't the sentence start (a brand/company name). Errs toward MORE review.
  identifiableEntity: /\s[A-Z][a-zA-Z]{2,}/.test(t),
})

/** registrable domain ~ eTLD+1 (last two labels). Prod uses the Public Suffix List. */
export function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname
    return host.split('.').slice(-2).join('.')
  } catch {
    return ''
  }
}

export function independentSourceCount(sources: Source[]): number {
  return new Set(sources.map((s) => registrableDomain(s.url)).filter(Boolean)).size
}

export interface DefamationVerdict {
  action: 'allow' | 'human_review'
  reason: string
}

export function gateClaim(
  text: string,
  sources: Source[],
  classify: ClaimClassifier = heuristicClassifier,
): DefamationVerdict {
  const c = classify(text)
  if (!(c.negative && c.identifiableEntity)) return { action: 'allow', reason: 'not negative-about-identifiable-entity' }
  const indep = independentSourceCount(sources)
  if (indep >= 2) return { action: 'allow', reason: `${indep} independent sources` }
  return { action: 'human_review', reason: `negative claim about an identifiable entity with only ${indep} independent source(s)` }
}
