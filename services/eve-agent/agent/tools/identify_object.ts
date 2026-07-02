/**
 * identify_object — the identification cascade as an eve TOOL (PLAN §4.2, §4.6, §5, §8.3).
 *
 * Contract (PLAN §4.6 / §8.3): returns
 *   { label, granularity_level, confidence_band, evidence[], unsupported_fields[] }
 * This is what the persona reads BEFORE it writes a word, and `confidence_band` is the source of truth.
 *
 * Pluggable so it runs with NO creds: a `VisionProvider` (Gemini 3 in prod, a fake in tests) supplies the
 * Stage-1 VLM hypothesis, optional Stage-2 web grounding, and the Stage-3 catalog candidate (already vector-
 * matched via catalog_search by the host, or by the provider). This tool's job is to take those stage outputs
 * and route them through the SHARED arbitration (`packages/shared/arbitration`) — it does not re-implement
 * confidence logic, and it never surfaces raw Stage-1 output.
 *
 * Honesty invariants enforced here:
 *  - `unsupported_fields[]` lists fields NO stage could verify; the persona must never assert them (§8.3).
 *    We compute it from the chosen candidate: any of {make, model, year} that is absent on the candidate the
 *    arbiter selected is "unsupported" and is reported, never guessed.
 *  - On a PROBABLE catalog↔web disagreement, BOTH candidates are returned (a labeling signal), and the label
 *    stays at the LEAST specific level the candidates agree on, not the more specific guess.
 *  - On UNKNOWN, we route to the interview ("first witness") rather than emit a specific label.
 */
import {
  arbitrate,
  type Candidate,
  type Arbitration,
  type Thresholds,
  DEFAULT_THRESHOLDS,
} from '../../../../packages/shared/src/arbitration'
import type { ConfidenceBand } from '../../../../packages/shared/src/confidence'

/** A reference to an already-redacted, stored image (the tool never holds raw bytes). */
export interface ImageRef {
  uri: string
  /** OPTIONAL pre-fetched bytes so the cascade fetches the image ONCE and both live stages reuse it. */
  bytes?: { b64: string; mime: string }
  /**
   * OPTIONAL requesting user — the single ACL key. Threaded so a catalog-backed provider can run the Stage-3
   * vector search scoped to this user's view (global OR their private entries). Additive: fakes ignore it and
   * the field is absent in every existing test, so behaviour is unchanged when no catalog is wired.
   */
  userId?: string
}

/** How specific the label is — drives the §10 reveal card and the §8.3 register. */
export type GranularityLevel = 'category' | 'make' | 'make_model' | 'make_model_year'

/** One piece of grounded evidence backing the ID (mirrors the closed evidence[] the honesty gate checks). */
export interface IdEvidence {
  ref: string
  sourceUrl: string
  claim: string
}

/** The structured ID object the persona consumes (PLAN §4.6 / §8.3). */
export interface IdentifyResult {
  label: string
  /** concise, human-friendly title for the reveal card (VLM-provided; set on the chosen candidate). Display only —
   *  the cascade prefers this over `label` for a CONFIDENT reveal; never used for arbitration or honesty. */
  displayTitle?: string
  granularity_level: GranularityLevel
  confidence_band: ConfidenceBand
  evidence: IdEvidence[]
  /** fields the cascade could NOT verify — the persona must never assert these. */
  unsupported_fields: string[]
  /** routing for the BFF/persona: reveal | confirm (two candidates) | interview. */
  route: Arbitration['route']
  /** the candidates surfaced to the user (≥2 on a real disagreement). */
  candidates: Candidate[]
  /** coarse VLM category (e.g. "camera") — the ONLY safe key for class-level enrichment on a hedged reveal. */
  category?: string
  /** why the arbiter landed here (audit/debug; not user-facing copy). */
  reason: string
}

/** The stages a VisionProvider can supply for one image. Any may be absent (e.g. no catalog hit). */
export interface VisionStages {
  vlm?: Candidate
  web?: Candidate
  catalog?: Candidate
  /** grounded evidence the web/catalog stages produced; the closed array the honesty gate later checks. */
  evidence?: IdEvidence[]
}

/**
 * Pluggable vision provider. In prod: Gemini 3 Flash/Pro (Vertex) + Cloud Vision web detection + the catalog
 * vector match. In tests: a deterministic fake. It returns STAGE candidates; it does NOT decide the band —
 * arbitration does. This keeps the over-confident VLM from ever being the source of truth.
 */
export interface VisionProvider {
  analyze(image: ImageRef): Promise<VisionStages>
}

/** Granularity of a single candidate, from which fields it actually carries. */
function granularityOf(c: Candidate | undefined): GranularityLevel {
  if (!c) return 'category'
  if (c.year !== undefined && c.model && c.make) return 'make_model_year'
  if (c.model && c.make) return 'make_model'
  if (c.make) return 'make'
  return 'category'
}

const ORDER: GranularityLevel[] = ['category', 'make', 'make_model', 'make_model_year']
const leastSpecific = (a: GranularityLevel, b: GranularityLevel): GranularityLevel =>
  ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b

/** Which of {make, model, year} are NOT present on the chosen candidate → unsupported (never asserted). */
function unsupportedFields(c: Candidate | undefined): string[] {
  const missing: string[] = []
  if (!c?.make) missing.push('make')
  if (!c?.model) missing.push('model')
  if (c?.year === undefined) missing.push('year')
  return missing
}

export async function identify_object(
  image: ImageRef,
  provider: VisionProvider,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<IdentifyResult> {
  const stages = await provider.analyze(image)
  const evidence = stages.evidence ?? []
  // Coarse class from the VLM — used ONLY to key class-level enrichment on a hedged (PROBABLE) reveal.
  const category = stages.vlm?.category
  // The clean, single human name of the PRIMARY object (VLM-provided). The reveal shows THIS in every band that
  // renders a card — CONFIDENT and PROBABLE — so a hedged reveal still shows ONE tidy title, with the uncertainty
  // carried by the confidence chip + the candidate list, never by cramming "X or Y" into the title.
  const vlmDisplayTitle = stages.vlm?.displayTitle

  // The single source of truth for band/route/candidates is the SHARED arbiter.
  const a = arbitrate({ catalog: stages.catalog, web: stages.web, vlm: stages.vlm }, thresholds)

  // INTERVIEW route (UNKNOWN): never emit a specific label; hand off to "first witness".
  if (a.route === 'interview') {
    return {
      label: a.candidates[0]?.name ?? 'an uncatalogued object',
      granularity_level: 'category',
      confidence_band: 'UNKNOWN',
      evidence: [],
      // nothing is confirmed → every identifying field is unsupported.
      unsupported_fields: ['make', 'model', 'year'],
      route: 'interview',
      candidates: a.candidates,
      category,
      reason: a.reason,
    }
  }

  // CONFIRM route (PROBABLE, real disagreement): surface BOTH candidates, and keep the label at the LEAST
  // specific level the two candidates agree on — never assert the more specific guess.
  if (a.route === 'confirm' && a.candidates.length >= 2) {
    const granularity = a.candidates
      .map(granularityOf)
      .reduce((acc, g) => leastSpecific(acc, g))
    // On a genuine disagreement, the specific make/model/year fields are NOT jointly supported.
    const unsupported = ['make', 'model', 'year']
    return {
      label: `${a.candidates[0]!.name} or ${a.candidates[1]!.name}`,
      // The reveal card shows this single clean name; the "X or Y" disagreement lives in the candidate list.
      displayTitle: vlmDisplayTitle,
      granularity_level: granularity,
      confidence_band: 'PROBABLE',
      evidence,
      unsupported_fields: unsupported,
      route: 'confirm',
      candidates: a.candidates,
      category,
      reason: a.reason,
    }
  }

  // REVEAL (CONFIDENT) or a hedged single-candidate CONFIRM (PROBABLE).
  const chosen = a.chosen ?? a.candidates[0]
  return {
    label: chosen?.name ?? 'an object',
    // The clean human title: prefer the chosen candidate's, else the VLM's clean name of the primary object; the
    // cascade shows it over `label` on any reveal card, falling back to `label` only when neither is present.
    displayTitle: chosen?.displayTitle ?? vlmDisplayTitle,
    granularity_level: granularityOf(chosen),
    confidence_band: a.band,
    evidence,
    unsupported_fields: unsupportedFields(chosen),
    route: a.route,
    candidates: a.candidates,
    category,
    reason: a.reason,
  }
}
