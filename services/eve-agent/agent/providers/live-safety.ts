/**
 * LiveSafetyClassifier — the production SafetyClassifier for safety_gate (PLAN §4.6, §8.4), backed by Cloud
 * Vision SafeSearch. It maps the raw adult/violence/medical likelihoods to ONE policy category with a
 * confidence; the gate (not this) enforces the action. CSAM is NOT handled here — that is the intake
 * pipeline's perceptual-hash path (§8.4) which runs before the persona; this classifier only sees redacted,
 * hash-cleared images and so never returns 'csam'. False-positive biased on medical (§8.4 / RT-8).
 */
import type { SafetyClassifier, SafetyClassification, SafetyCategory } from '../tools/safety_gate'
import type { ImageRef } from '../tools/identify_object'
import { loadImageBytes, visionSafeSearch, type SafeSearch } from '../lib/gcp-vision'

/** Cloud Vision likelihood enum → a 0..1 confidence. */
const LIKELIHOOD: Record<string, number> = {
  VERY_LIKELY: 0.95,
  LIKELY: 0.8,
  POSSIBLE: 0.5,
  UNLIKELY: 0.2,
  VERY_UNLIKELY: 0.05,
  UNKNOWN: 0,
}
const conf = (l: string): number => LIKELIHOOD[l] ?? 0

/** Map SafeSearch to the single highest-severity policy category (§8.4). Pure — unit-testable without creds. */
export function classifySafeSearch(s: SafeSearch): SafetyClassification {
  const candidates: { category: SafetyCategory; confidence: number }[] = [
    { category: 'nsfw', confidence: Math.max(conf(s.adult), conf(s.racy) * 0.7) },
    { category: 'weapon', confidence: conf(s.violence) }, // violence is the closest SafeSearch proxy for weapons
    { category: 'pills_medical', confidence: conf(s.medical) },
  ]
  const top = candidates.sort((a, b) => b.confidence - a.confidence)[0]!
  // Below any actionable signal → safe. (The gate re-applies its own per-category thresholds too.)
  return top.confidence >= 0.3 ? top : { category: 'safe', confidence: 1 - top.confidence }
}

export class LiveSafetyClassifier implements SafetyClassifier {
  async classify(image: ImageRef): Promise<SafetyClassification> {
    const { b64 } = image.bytes ?? (await loadImageBytes(image.uri))
    return classifySafeSearch(await visionSafeSearch(b64))
  }
}
