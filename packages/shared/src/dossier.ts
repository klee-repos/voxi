/**
 * ResearchDossier — the durable, fully-cited research artifact (PROMPT-QUALITY §3.B3). It is the single grounded
 * substrate produced ONCE by the deep-research layer and reused everywhere: the reveal (title/description/facts),
 * the podcast (storyteller), and the conversation ("tell me more"). It is a boundary contract, so it lives in
 * `packages/shared` with a Zod schema — client, BFF, and agent can never silently disagree on its shape.
 *
 * The load-bearing guarantee (decision 3 / §2.2): every fact carries PROVABLE provenance — a `sourceUrl` and the
 * verbatim `quote` from that source that supports it. A fact is only ever admitted into a dossier when the closed
 * provenance loop holds (`quote ⊆ source` + `sourceMatchesSubject` + `quote ⊨ text`); see `subagents/researcher`.
 * The `quote`+`sourceUrl` is the durable "proof if challenged" the UI surfaces per fact.
 */
import { z } from 'zod'

/** Claim types that must carry grounded evidence (mirrors packages/shared/src/confidence.ts FALSIFIABLE + flavor). */
export const DossierClaimType = z.enum(['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative', 'flavor'])

/**
 * One verified, interesting fact with its attached proof. `index`/`order` let the durable revisit replay it as a
 * `fact` stream event at the exact monotonic index reconnection depends on (§3.B4); they are assigned when the
 * dossier is streamed/persisted, so they are optional on a freshly-built dossier.
 */
export const DossierFact = z.object({
  text: z.string(),
  claimType: DossierClaimType,
  /** ref into the dossier's closed `evidence[]` — the fact's grounding. */
  evidenceRef: z.string(),
  /** provenance: the source the quote was taken from. */
  sourceUrl: z.string(),
  sourceTitle: z.string().default(''),
  /** the verbatim supporting quote — the durable "proof if challenged". */
  quote: z.string(),
  /** stream index for durable replay (assigned at stream/persist time). */
  index: z.number().int().optional(),
  /** stable display/replay order. */
  order: z.number().int().optional(),
})
export type DossierFact = z.infer<typeof DossierFact>

/** A claim-structured clause of the neutral encyclopedia-depth overview (same shape as confidence.ts Clause). */
export const DossierClause = z.object({
  text: z.string(),
  claimType: DossierClaimType,
  evidenceRef: z.string().optional(),
})
export type DossierClause = z.infer<typeof DossierClause>

/** A closed evidence item the honesty gate checks — for a fact, `claim` is set to the VERIFIED QUOTE (§2.2). */
export const DossierEvidence = z.object({
  ref: z.string(),
  sourceUrl: z.string(),
  claim: z.string(),
})
export type DossierEvidence = z.infer<typeof DossierEvidence>

export const ResearchDossier = z.object({
  /** the identity or category the research is about ("La Croix Sparkling Water" / "camera"). */
  subject: z.string(),
  /** 'item' = a confirmed make/model (CONFIDENT); 'class' = the category only (PROBABLE, never a specific model). */
  scope: z.enum(['item', 'class']),
  /** the neutral, grounded encyclopedia-depth account (claim-structured, gated). */
  overview: z.array(DossierClause),
  /** stream index for the description-upgrade replay (assigned at stream/persist time). */
  overviewIndex: z.number().int().optional(),
  /** the ≥3 verified, provably-sourced interesting facts (surface survivors if a thin source yields fewer). */
  facts: z.array(DossierFact),
  /** the closed evidence[] the honesty gate checked (each fact's grounding, keyed by ref). */
  evidence: z.array(DossierEvidence),
  /** the source URLs behind the facts (provenance + the defamation independent-source check). */
  sources: z.array(z.object({ url: z.string(), title: z.string().default('') })),
  provenance: z.object({
    model: z.string(),
    generatedAt: z.number().int(),
    toolCalls: z.number().int().default(0),
  }),
})
export type ResearchDossier = z.infer<typeof ResearchDossier>

/** Parse/validate a dossier at a boundary (throws on a malformed shape). */
export function parseDossier(raw: unknown): ResearchDossier {
  return ResearchDossier.parse(raw)
}
