/**
 * PodcastContext — the server-owned reveal context threaded into a Deep Dive render (a boundary contract).
 *
 * Built ONCE by the BFF from the DURABLE reveal (never client-supplied) and carried BFF → podcast bridge →
 * worker, so the two-voice interview is written from everything the reveal already learned about the object —
 * its identity, the what/purpose/maker, and the grounded facts — IN ADDITION to the worker's own deep-dive
 * research. It lives here in `packages/shared` (not per-worker) so the BFF, the bridge, and the worker can never
 * silently disagree on its shape and drop a field in transit (the wire is JSON; a hand-copied type would drift).
 *
 * Honesty note: `priorFacts` and the purpose/maker `*SourceUrl` fields carry REAL provenance from the reveal, so
 * the worker can fold them into the closed facts[] the interview cites and the deterministic honesty gate resolves
 * against them. `whatItIs`/`band` and any source-less section stay ORIENTATION only — the worker never lets a
 * host assert a falsifiable claim from prose that carries no citeable source.
 */

/** One grounded fact carried over from the reveal (a `fact` stream event) — already provably sourced. */
export interface PriorFact {
  text: string
  /** the real source URL the fact was grounded on (provenance). */
  sourceUrl: string
  sourceTitle?: string
  quote?: string
}

export interface PodcastContext {
  /** the server-owned object title (reveal.title) — the render subject, never the client's string. */
  subject?: string
  /** identification confidence — the interview honors the hedge (never narrates a PROBABLE id as certain). */
  band?: 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN'
  /** the reveal's "what it is" narration — orientation for the stage-setting intro (not citeable). */
  whatItIs?: string
  /** the reveal's "what it's for" section text — orientation (citeable only via `purposeSourceUrl`). */
  purpose?: string
  /** provenance for the purpose section if the reveal grounded it (else absent); folded into facts[] only when set. */
  purposeSourceUrl?: string
  /** the reveal's "who made it" section text — orientation (citeable only via `makerSourceUrl`). */
  maker?: string
  /** provenance for the maker section if grounded (else absent); folded into facts[] only when set. */
  makerSourceUrl?: string
  /** the reveal's "when it was made" section text — the grounded date/era (citeable only via `whenMadeSourceUrl`). */
  whenMade?: string
  /** provenance for the made section if grounded (else absent); folded into facts[] only when set. */
  whenMadeSourceUrl?: string
  /** the reveal's grounded facts — folded into the closed facts[] the interview may cite. */
  priorFacts?: PriorFact[]
}
