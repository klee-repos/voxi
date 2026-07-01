/**
 * safety_gate — the deterministic pre-classifier that runs BEFORE the persona ever sees an image
 * (PLAN §4.6, §8.4, §22.2 / RT-8, RT-13, RT-2, RT-4).
 *
 * This is a TOOL wrapper around a pluggable `SafetyClassifier` (a model in prod; a fake in tests), so the
 * eve agent can run with no creds. The wrapper does not classify — it enforces the *policy* on top of a
 * classification: which categories suppress identification entirely, and with which action. The persona
 * never gets to override this. Fail-closed: an error or an unknown category is treated as "suppress".
 *
 * Category × action mapping (the load-bearing part — must match §8.4 exactly):
 *   - pills_medical → REFUSE_NON_IDENTIFYING, suppress make/model/spec entirely (false-positive biased).
 *   - weapon        → CATEGORY_NAME_ONLY, suppress model/caliber/acquisition/modification, in text AND voice.
 *   - nsfw          → BLOCK (never reaches the persona).
 *   - csam          → BLOCK (the intake pipeline routes the original to the 2258A path; the persona is dark).
 *   - safe          → ALLOW (identification proceeds).
 */

export type SafetyCategory = 'safe' | 'pills_medical' | 'weapon' | 'nsfw' | 'csam'

export type SafetyAction =
  | 'allow' // identification may proceed normally
  | 'refuse_non_identifying' // fixed refusal; NO make/model/spec generation at all (pills/medical)
  | 'category_name_only' // may name the category only; no model/spec/acquisition (weapons)
  | 'block' // never reaches the persona (nsfw/csam)

/** Raw output of the pluggable classifier (a Cloud Vision / Gemini call in prod). */
export interface SafetyClassification {
  category: SafetyCategory
  confidence: number // 0..1
}

/** Pluggable classifier so the gate runs deterministically with no creds. */
export interface SafetyClassifier {
  classify(image: ImageRef): Promise<SafetyClassification>
}

/** A reference to an already-stored (redacted) image; the gate never holds raw bytes. */
export interface ImageRef {
  uri: string
}

export interface SafetyVerdict {
  category: SafetyCategory
  action: SafetyAction
  confidence: number
  /** true iff identification (make/model/spec) is allowed to run at all. */
  identificationAllowed: boolean
  /** fields the persona must NEVER assert for this category (e.g. caliber for a weapon). */
  suppressedFields: string[]
  /**
   * true when the gate fail-closed because it could NOT classify (classifier threw / unknown category) — a
   * TECHNICAL fault, not a content judgement. Identification is still blocked (fail-closed), but the caller must
   * surface a retryable "technical" error, NEVER a content refusal that implies the user's photo was unsafe.
   */
  fault?: boolean
  reason: string
}

/**
 * Per-category thresholds. pills_medical is intentionally LOW (false-positive biased per RT-8): we would
 * rather wrongly refuse a vitamin than wrongly identify a prescription drug.
 */
export interface SafetyThresholds {
  pillsMedical: number // default 0.30 — fire on weak signal
  weapon: number // default 0.50
  nsfw: number // default 0.50
  csam: number // default 0.50
}

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = {
  pillsMedical: 0.3,
  weapon: 0.5,
  nsfw: 0.5,
  csam: 0.5,
}

const SUPPRESSED_FIELDS: Record<SafetyCategory, string[]> = {
  safe: [],
  pills_medical: ['make', 'model', 'spec', 'dosage', 'imprint'],
  weapon: ['model', 'caliber', 'acquisition', 'modification'],
  nsfw: ['*'],
  csam: ['*'],
}

function actionFor(c: SafetyCategory): SafetyAction {
  switch (c) {
    case 'safe':
      return 'allow'
    case 'pills_medical':
      return 'refuse_non_identifying'
    case 'weapon':
      return 'category_name_only'
    case 'nsfw':
    case 'csam':
      return 'block'
  }
}

/** Did the classification clear the per-category threshold (so the restrictive action applies)? */
function clears(c: SafetyClassification, t: SafetyThresholds): boolean {
  switch (c.category) {
    case 'safe':
      return true
    case 'pills_medical':
      return c.confidence >= t.pillsMedical
    case 'weapon':
      return c.confidence >= t.weapon
    case 'nsfw':
      return c.confidence >= t.nsfw
    case 'csam':
      return c.confidence >= t.csam
  }
}

/**
 * safety_gate tool: classify, then enforce policy. Fail-closed — any thrown error from the classifier is
 * treated as a BLOCK, never as "allow".
 */
export async function safety_gate(
  image: ImageRef,
  classifier: SafetyClassifier,
  thresholds: SafetyThresholds = DEFAULT_SAFETY_THRESHOLDS,
): Promise<SafetyVerdict> {
  let c: SafetyClassification
  try {
    c = await classifier.classify(image)
  } catch (err) {
    // Fail-closed: we could not classify → suppress identification. But this is a FAULT (infra), not a content
    // judgement — flag it so the caller surfaces a retryable technical error, not a "your photo is unsafe" refusal.
    return {
      category: 'csam',
      action: 'block',
      confidence: 1,
      identificationAllowed: false,
      suppressedFields: ['*'],
      fault: true,
      reason: `classifier error → fail-closed (technical fault): ${(err as Error).message}`,
    }
  }

  // An unknown category (model drift / bad data) is also fail-closed — and also a fault, not a content verdict.
  if (!(c.category in SUPPRESSED_FIELDS)) {
    return {
      category: 'csam',
      action: 'block',
      confidence: 1,
      identificationAllowed: false,
      suppressedFields: ['*'],
      fault: true,
      reason: `unknown category "${c.category}" → fail-closed (technical fault)`,
    }
  }

  // A flagged category that does NOT clear its threshold falls back to safe (e.g. a 0.1 weapon score).
  // Exception: we never downgrade csam below the threshold to "safe" silently — but the classifier owns
  // that calibration; here we apply the documented threshold uniformly.
  if (c.category !== 'safe' && !clears(c, thresholds)) {
    return {
      category: 'safe',
      action: 'allow',
      confidence: c.confidence,
      identificationAllowed: true,
      suppressedFields: [],
      reason: `${c.category} below threshold (${c.confidence}) → treated as safe`,
    }
  }

  const action = actionFor(c.category)
  return {
    category: c.category,
    action,
    confidence: c.confidence,
    identificationAllowed: action === 'allow',
    suppressedFields: SUPPRESSED_FIELDS[c.category],
    reason: `category=${c.category} action=${action}`,
  }
}
