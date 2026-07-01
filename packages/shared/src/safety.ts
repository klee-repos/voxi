/**
 * Deterministic safety pre-classifier `safety_classify` + redaction plan (PLAN §8.4 / §4.6, RT-2/8/13).
 *
 * This runs BEFORE the persona ever generates a word. It answers one question: given a category signal for
 * an image, what is Voxi *allowed* to do with it? It is the gate that makes the honesty/safety policy
 * structural rather than a prompt suggestion — the persona literally never receives an identifiable make/model
 * for a pill, a model/caliber for a weapon, or anything at all for nsfw/csam.
 *
 * Division of labour (no overlap with services/voxi-api/src/intake-pipeline.ts):
 *   - intake-pipeline.ts = the BYTES path: CSAM hash-match → SafeSearch → irreversible face/plate redaction,
 *     fail-closed, in a legally load-bearing order. It decides whether the file may be stored/embedded.
 *   - safety.ts (here)   = the SEMANTIC path: which content CATEGORY the image is, and therefore which
 *     generation/follow-up the persona may perform. It decides what Voxi may *say*.
 * Both fail-closed. A pipeline emits an intake outcome AND a safety category; the strictest wins.
 *
 * False-positive bias (§8.4): for `pill_medical` and `weapon` the classifier is deliberately tuned to
 * OVER-trigger. A low suspicion score is enough to drop into the restricted category — we would rather refuse
 * a harmless vitamin bottle or a toy than name a real controlled substance or a real firearm's model/caliber.
 * The thresholds live here as named, calibratable constants (never magic numbers buried in a branch).
 */

export type SafetyCategory =
  | 'object' // a normal human-made object — the happy path
  | 'person' // a face/person dominates the frame
  | 'pill_medical' // pills, blister packs, prescription bottles, medical devices (RT-8)
  | 'weapon' // firearms, knives presented as weapons, ammunition (RT-13)
  | 'nsfw' // sexual content
  | 'csam' // child sexual abuse material — routed out of band by intake; never reaches the persona

export type SafetyAction =
  | 'allow' // full identification + persona generation permitted
  | 'refuse_people' // objects, never people — fixed non-identifying refusal, no face ID ever
  | 'refuse_medical' // fixed non-identifying refusal; make/model/spec generation SUPPRESSED entirely (RT-8)
  | 'weapon_category_only' // category-level naming only; no model/caliber/acquisition/mod — incl. follow-ups (RT-13)
  | 'block' // do not surface to the persona at all (RT-4 / §15)

/**
 * Per-category suspicion scores in [0,1] produced upstream (Gemini safety signal, Cloud Vision SafeSearch,
 * a pill-imprint detector, a weapon detector, a face-area fraction). The classifier here is the deterministic
 * POLICY over those scores — pluggable scorers feed it, but the routing is testable without any vendor.
 */
export interface SafetySignals {
  /** P(image is/contains a weapon). */
  weapon?: number
  /** P(image is a pill / medical item). */
  pillMedical?: number
  /** P(image is sexual content). */
  nsfw?: number
  /** hard CSAM hash-match from the intake pipeline (PhotoDNA / CSAI). Not a soft score. */
  csamHashMatch?: boolean
  /** fraction of the frame occupied by detected face(s), 0..1 — "face-dominant" when high. */
  faceAreaFraction?: number
}

/**
 * Calibratable thresholds. The `pill_medical` and `weapon` bars are LOW on purpose (false-positive bias).
 * Production overrides these per the §14 curated negative sets; defaults are deliberately conservative.
 */
export interface SafetyThresholds {
  /** weapon suspicion ≥ this → weapon. Low: a plausible weapon is enough. */
  weapon: number
  /** pill/medical suspicion ≥ this → pill_medical. Low: a plausible pill is enough. */
  pillMedical: number
  /** nsfw suspicion ≥ this → nsfw. Higher bar (a normal bar would over-block legitimate objects). */
  nsfw: number
  /** face area ≥ this fraction → person (face-dominant). */
  faceDominant: number
}

export const DEFAULT_THRESHOLDS: SafetyThresholds = {
  weapon: 0.3, // false-positive biased (RT-13): over-refuse rather than name a real firearm
  pillMedical: 0.3, // false-positive biased (RT-8): over-refuse rather than name a real drug
  nsfw: 0.6,
  faceDominant: 0.4,
}

export interface SafetyClassification {
  category: SafetyCategory
  action: SafetyAction
  /** confidence in the CHOSEN category/action (the driving score, or 1 for a hard hash match). */
  confidence: number
  reason: string
}

/** The category→action contract. Each restricted category pins exactly one action. */
export const ACTION_FOR: Readonly<Record<SafetyCategory, SafetyAction>> = {
  object: 'allow',
  person: 'refuse_people',
  pill_medical: 'refuse_medical',
  weapon: 'weapon_category_only',
  nsfw: 'block',
  csam: 'block',
}

/**
 * `safety_classify` (§4.6). Deterministic, fail-closed precedence:
 *   csam  >  nsfw  >  weapon  >  pill_medical  >  person  >  object
 * The most-restrictive credible signal wins, so a frame that is both a pill bottle and a face refuses on the
 * stricter of the two. Restricted categories are evaluated against their (low, FP-biased) bars first.
 */
export function safetyClassify(
  signals: SafetySignals,
  t: SafetyThresholds = DEFAULT_THRESHOLDS,
): SafetyClassification {
  const s = {
    weapon: signals.weapon ?? 0,
    pillMedical: signals.pillMedical ?? 0,
    nsfw: signals.nsfw ?? 0,
    faceAreaFraction: signals.faceAreaFraction ?? 0,
  }

  // 1. CSAM — hard hash match, never a soft score. Routed out of band by intake; here we pin block.
  if (signals.csamHashMatch === true) {
    return { category: 'csam', action: 'block', confidence: 1, reason: 'csam hash match (block before persona)' }
  }

  // 2. NSFW — block before the persona.
  if (s.nsfw >= t.nsfw) {
    return { category: 'nsfw', action: 'block', confidence: s.nsfw, reason: `nsfw ${s.nsfw} ≥ ${t.nsfw}` }
  }

  // 3. Weapon — FALSE-POSITIVE BIASED low bar. Category-only naming, follow-ups included.
  if (s.weapon >= t.weapon) {
    return {
      category: 'weapon',
      action: 'weapon_category_only',
      confidence: s.weapon,
      reason: `weapon ${s.weapon} ≥ ${t.weapon} (fp-biased): category-only, no model/caliber`,
    }
  }

  // 4. Pill/medical — FALSE-POSITIVE BIASED low bar. Suppress make/model/spec generation entirely.
  if (s.pillMedical >= t.pillMedical) {
    return {
      category: 'pill_medical',
      action: 'refuse_medical',
      confidence: s.pillMedical,
      reason: `pillMedical ${s.pillMedical} ≥ ${t.pillMedical} (fp-biased): suppress identification`,
    }
  }

  // 5. Face-dominant → refuse_people (objects, never people).
  if (s.faceAreaFraction >= t.faceDominant) {
    return {
      category: 'person',
      action: 'refuse_people',
      confidence: s.faceAreaFraction,
      reason: `face area ${s.faceAreaFraction} ≥ ${t.faceDominant}: objects not people`,
    }
  }

  // 6. Default: an allowable object.
  const conf = 1 - Math.max(s.weapon, s.pillMedical, s.nsfw, s.faceAreaFraction)
  return { category: 'object', action: 'allow', confidence: conf, reason: 'no restricted signal cleared its bar' }
}

/**
 * What the persona is allowed to generate, derived ONLY from the safety action. Both the description generator
 * and the voice/text follow-up loop read this — there is no path that re-grants a suppressed field downstream.
 * This is the structural enforcement: `mayGenerate` controls whether the persona ever *sees* an identifiable
 * label, so it cannot leak a make/model it was never handed.
 */
export interface GenerationConstraints {
  /** may produce a specific make/model/year at all. False ⇒ no identification, ever, for this image. */
  mayIdentifyMakeModel: boolean
  /** may produce numeric specs (caliber, displacement, dosage…). */
  mayGenerateSpecs: boolean
  /** the broadest naming permitted: 'full' specific ID, 'category' only ('a revolver'), or 'none'. */
  namingGranularity: 'full' | 'category' | 'none'
  /** the SAME constraint applies to every follow-up turn (voice + keyboard), not just the first reveal. */
  appliesToFollowUp: true
  /** if true the persona must emit a fixed non-identifying refusal and generate nothing identifiable. */
  fixedRefusal: boolean
  /** if true the image must never reach the persona at all. */
  blockedBeforePersona: boolean
}

export function generationConstraintsFor(action: SafetyAction): GenerationConstraints {
  switch (action) {
    case 'allow':
      return {
        mayIdentifyMakeModel: true,
        mayGenerateSpecs: true,
        namingGranularity: 'full',
        appliesToFollowUp: true,
        fixedRefusal: false,
        blockedBeforePersona: false,
      }
    case 'weapon_category_only':
      // Category-level naming only; no model/caliber/acquisition/modification — and this binds the follow-up
      // loop too (a user cannot coax the model/caliber out across turns). (RT-13)
      return {
        mayIdentifyMakeModel: false,
        mayGenerateSpecs: false,
        namingGranularity: 'category',
        appliesToFollowUp: true,
        fixedRefusal: false,
        blockedBeforePersona: false,
      }
    case 'refuse_medical':
      // Suppress make/model/spec generation entirely; the persona never sees it as identifiable. (RT-8)
      return {
        mayIdentifyMakeModel: false,
        mayGenerateSpecs: false,
        namingGranularity: 'none',
        appliesToFollowUp: true,
        fixedRefusal: true,
        blockedBeforePersona: false,
      }
    case 'refuse_people':
      return {
        mayIdentifyMakeModel: false,
        mayGenerateSpecs: false,
        namingGranularity: 'none',
        appliesToFollowUp: true,
        fixedRefusal: true,
        blockedBeforePersona: false,
      }
    case 'block':
      // nsfw/csam: nothing reaches the persona.
      return {
        mayIdentifyMakeModel: false,
        mayGenerateSpecs: false,
        namingGranularity: 'none',
        appliesToFollowUp: true,
        fixedRefusal: false,
        blockedBeforePersona: true,
      }
  }
}

// ---------------------------------------------------------------------------------------------------------
// RedactionPlan + fail-closed redact-or-reject helper (§8.4 / RT-2)
// ---------------------------------------------------------------------------------------------------------

/**
 * A RedactionPlan is the structured instruction set the redactor executes before any embed/store. It lists the
 * regions that MUST be irreversibly obscured (faces, plates). It is the contract between detection and the
 * redactor; the redactor must cover every required region or the upload is rejected (fail-closed).
 */
export type RedactionRegionKind = 'face' | 'license_plate'

export interface RedactionRegion {
  kind: RedactionRegionKind
  /** normalized bounding box in [0,1]: [x, y, w, h]. */
  bbox: [number, number, number, number]
  /** detector confidence for this region. */
  confidence: number
}

export interface RedactionPlan {
  /** every region that must be obscured before the image may be embedded/stored. */
  regions: RedactionRegion[]
  /** true if there is at least one PII region requiring redaction. */
  requiresRedaction: boolean
}

export function buildRedactionPlan(regions: RedactionRegion[]): RedactionPlan {
  return { regions, requiresRedaction: regions.length > 0 }
}

/** The actual redactor (pluggable). Returns the redacted object key, or null/throws on ANY failure. */
export type Redactor = (
  plan: RedactionPlan,
) => Promise<{ redactedObjectKey: string; coveredRegions: number } | null>

export type RedactOrRejectResult =
  | { kind: 'no_redaction_needed' }
  | { kind: 'redacted'; redactedObjectKey: string }
  | { kind: 'rejected'; reason: string }

/**
 * Fail-closed redact-or-reject. The ONLY way an image with PII proceeds is a redactor that returns a key AND
 * reports covering every required region. Any null, any throw, or a short-coverage result → REJECT. We never
 * store or embed an image we could not fully redact.
 */
export async function redactOrReject(
  plan: RedactionPlan,
  redact: Redactor,
): Promise<RedactOrRejectResult> {
  if (!plan.requiresRedaction) return { kind: 'no_redaction_needed' }

  let out: { redactedObjectKey: string; coveredRegions: number } | null
  try {
    out = await redact(plan)
  } catch (e) {
    // Fail-closed on exception (no-cheating rule 3): an error is a rejection, never a silent pass-through.
    return { kind: 'rejected', reason: `redactor threw: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (!out || !out.redactedObjectKey) {
    return { kind: 'rejected', reason: 'redactor returned no redacted artifact (fail-closed)' }
  }
  if (out.coveredRegions < plan.regions.length) {
    return {
      kind: 'rejected',
      reason: `redactor covered ${out.coveredRegions}/${plan.regions.length} regions (incomplete → fail-closed)`,
    }
  }
  return { kind: 'redacted', redactedObjectKey: out.redactedObjectKey }
}
