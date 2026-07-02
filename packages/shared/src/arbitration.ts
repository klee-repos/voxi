/**
 * Confidence arbitration across the identification cascade (PLAN §5.4 / eng-F3).
 *
 * Stage 1 (VLM) + Stage 3 (catalog vector) run in parallel; Stage 2 (web) verifies. When they disagree this
 * decides what the user sees. Thresholds are SEED-VERTICAL DEFAULTS the H2 calibration overrides per category
 * (§22.4) — never hardcoded constants in spirit; passed in here so calibration is a config change.
 */
import type { ConfidenceBand } from './confidence'

export interface Candidate {
  name: string // "2008 Cannondale SuperSix EVO"
  make?: string
  model?: string
  year?: number
  source: 'catalog' | 'web' | 'vlm'
  confidence: number // 0..1 (web verified_confidence, vlm fine_confidence)
  cosine?: number // catalog vector match only
  /** concise, human-friendly display name (VLM-provided). DISPLAY ONLY — never read by arbitration. */
  displayTitle?: string
  /** alternative labels grounding this candidate (e.g. Cloud Vision webEntities) — used for corroboration, not display. */
  aka?: string[]
  /** coarse object category (e.g. "camera") — carried for class-level reveal enrichment, never for display/arbitration. */
  category?: string
  /** a brand/logo the VLM READ off the object (distilled from the clean make, corroborated by OCR) — a grounded
   *  OBSERVATION, not a guessed identity. Routes brand-entity research + is citable as an `observation` (§13.1/§13.3).
   *  Display/routing only; NEVER read by arbitration (mirrors the displayTitle/category convention). */
  observedBrand?: string
}

export interface Thresholds {
  catalogShortCircuit: number // default 0.92
  webVerified: number // default 0.75
  interviewFloor: number // default 0.5
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  catalogShortCircuit: 0.92,
  webVerified: 0.75,
  interviewFloor: 0.5,
}

export type Route = 'reveal' | 'confirm' | 'interview'

export interface Arbitration {
  band: ConfidenceBand
  route: Route
  chosen?: Candidate
  /** candidates surfaced to the user (≥2 on a real disagreement → labeling signal). */
  candidates: Candidate[]
  reason: string
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

function sameModel(a?: Candidate, b?: Candidate): boolean {
  if (!a || !b) return false
  const n = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return n(a.make) === n(b.make) && n(a.model) === n(b.model)
}

/**
 * Does `by` (e.g. the free-text web bestGuess) corroborate `of` (the structured VLM)? True when `by` shares
 * `of`'s MAKE and its BASE MODEL (the model stripped of parenthetical editions, first ~2 significant tokens).
 * This treats a coarser web label ("canon ae 1") as CONFIRMING a more specific VLM ("1976 Canon AE-1 (Montréal
 * Olympic Ed.)"), while a genuinely different model ("omega speedtimer" vs "Omega Speedmaster") does NOT
 * corroborate → the arbiter hedges to PROBABLE and surfaces both. (Fixes the live bug + the over-hedge.)
 */
function corroborates(by?: Candidate, of?: Candidate): boolean {
  if (!by || !of) return false
  // Grounding tokens = the label PLUS any `aka` (Cloud Vision webEntities) — reverse-image search usually names
  // the true make/model in the entity list even when the single headline bestGuess is generic/foreign noise.
  // WHOLE-TOKEN set (not substring): "fm" must NOT corroborate a web that only says "fm2" (a different model).
  const hay = new Set(norm([by.name, by.make, by.model, ...(by.aka ?? [])].filter(Boolean).join(' ')).split(' ').filter(Boolean))
  const makeToks = norm(of.make ?? '').split(' ').filter(Boolean)
  if (makeToks.length && !makeToks.every((t) => hay.has(t))) return false // different/absent brand → not corroborating
  // Match the PRIMARY (first) model token — the base identity ("Chopper", "Speedmaster", "Les Paul"). The VLM's
  // extra sub-variant tokens ("Mk2", "Professional 145.022", "Standard") are ADDITIVE specificity a coarser web
  // label needn't carry. A very SHORT primary (≤2 chars, e.g. "F", "AE") is ambiguous, so require the WHOLE model.
  const modelToks = norm((of.model ?? '').replace(/\(.*?\)/g, '')).split(' ').filter(Boolean)
  if (modelToks.length === 0) return makeToks.length > 0 // make matches and there's no model to conflict on
  const primary = modelToks[0]!
  return primary.length <= 2 ? modelToks.every((t) => hay.has(t)) : hay.has(primary)
}

/** A candidate is a CONCRETE identity iff it carries both a make and a model (not a vague category guess). */
const concrete = (c?: Candidate): boolean => !!c?.make && !!c?.model

/** Does `v` make a CONCRETE identity claim (make + model) that `w` does NOT corroborate? A real disagreement. */
function contradicts(w?: Candidate, v?: Candidate): boolean {
  return concrete(v) && !corroborates(w, v)
}

export function arbitrate(
  stages: { catalog?: Candidate; web?: Candidate; vlm?: Candidate },
  t: Thresholds = DEFAULT_THRESHOLDS,
): Arbitration {
  const { catalog, web, vlm } = stages
  const strongVlm = !!vlm && vlm.confidence >= 0.7
  const webVerified = !!web && web.confidence >= t.webVerified

  // 1) Catalog hit with model agreement short-circuits to a confident, free match (the moat path).
  if (catalog && catalog.cosine !== undefined && catalog.cosine >= t.catalogShortCircuit && sameModel(catalog, vlm)) {
    return { band: 'CONFIDENT', route: 'reveal', chosen: catalog, candidates: [catalog], reason: 'catalog hit + model agreement' }
  }

  // 2) Web CORROBORATES a CONCRETE VLM identity → CONFIDENT, but the identity is the STRUCTURED VLM (never the
  //    noisy free-text web label). The GROUNDING here is that the reverse-image ENTITIES name the VLM's make +
  //    model (whole-token) — that is the verification itself, so it does NOT depend on the headline bestGuess
  //    being trustworthy (the agreement-based webVerified gates step 5, where the web label IS the identity). A
  //    vague (make-only) VLM is NOT promoted here — a more specific web label may win at step 5 instead.
  if (concrete(vlm) && corroborates(web, vlm)) {
    return { band: 'CONFIDENT', route: 'reveal', chosen: vlm, candidates: [vlm!], reason: 'VLM confirmed by web entities' }
  }

  // 3) High-confidence DISAGREEMENT between catalog and web on different models → never assert; hedge and
  //    surface BOTH candidates as a user choice (doubles as a labeling signal). (eng-F3)
  if (
    catalog &&
    web &&
    (catalog.cosine ?? 0) >= t.interviewFloor &&
    web.confidence >= t.interviewFloor &&
    !sameModel(catalog, web)
  ) {
    return {
      band: 'PROBABLE',
      route: 'confirm',
      candidates: [catalog, web],
      reason: 'catalog↔web disagreement: downgrade to PROBABLE, offer both',
    }
  }

  // 4) A verified web label CONTRADICTS a concrete VLM identity (make+model that don't corroborate) → NEVER
  //    assert either, at ANY VLM confidence. This closes the "omega speedtimer" bug for a MODERATE (0.5–0.69)
  //    VLM: a specific competing VLM claim must hedge to PROBABLE + both, not be silently discarded so the noisy
  //    web label wins. The disagreement is real regardless of how confident the VLM is.
  if (webVerified && contradicts(web, vlm)) {
    return { band: 'PROBABLE', route: 'confirm', candidates: [vlm!, web!], reason: 'VLM↔web disagreement: downgrade to PROBABLE, offer both' }
  }

  // 5) Strong web with NO competing concrete VLM (weak/vague/absent VLM, catalog agrees or absent) → CONFIDENT
  //    web. Guarded by !contradicts so a specific disagreeing VLM (step 4) can never be bypassed here.
  if (webVerified && !strongVlm && !contradicts(web, vlm) && (!catalog || sameModel(catalog, web))) {
    return { band: 'CONFIDENT', route: 'reveal', chosen: web, candidates: [web!], reason: 'web verified' }
  }

  // 6) Best available signal (a lone strong VLM with no web grounding lands here → hedged PROBABLE, never
  //    CONFIDENT: an ungrounded VLM guess is never the source of truth, §5/§8.3).
  const best = [catalog && { c: catalog, s: catalog.cosine ?? catalog.confidence }, web && { c: web, s: web.confidence }, vlm && { c: vlm, s: vlm.confidence }]
    .filter(Boolean)
    .sort((a, b) => (b!.s as number) - (a!.s as number))[0] as { c: Candidate; s: number } | undefined

  // 7) Nothing clears the floor → interview (mint a new entry; "first witness").
  if (!best || best.s < t.interviewFloor) {
    return { band: 'UNKNOWN', route: 'interview', candidates: best ? [best.c] : [], reason: 'no stage cleared the floor' }
  }

  // 8) Otherwise a hedged best-guess to confirm.
  return { band: 'PROBABLE', route: 'confirm', chosen: best.c, candidates: [best.c], reason: 'best guess below confident bar' }
}
