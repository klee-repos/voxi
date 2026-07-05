/**
 * The "Initial learnings" cycle — the LearningsBar shows ONE grounded learning at a time, rotating through the
 * facts + grounded sections that have arrived (TikTok-style cycle-up). Pure helpers, unit-pinned.
 *
 * Reuses the prior `selectRecentLearnings` ordering (facts + grounded sections, newest-last) — the cycle iterates
 * this combined arrival-ordered list. The bar advances a `cycleIndex` on a timer; before any learning arrives it
 * shows the "Researching" placeholder. (REVEAL-STREAMING-PLAN redesign / INITIAL-LEARNINGS-PLAN, B3.)
 */
import type { RevealFact, RevealSection, SectionBucket } from '../state/captureStore'

export type LearningText = {
  /** The text to show in the slot (already truncated to ~2 lines by the render layer's numberOfLines). */
  text: string
  /** The full text (for the accessibilityLabel so screen readers announce the whole fact, not the truncated tail). */
  fullText: string
  /** True for the pre-first-learning "Researching" placeholder (drives the pulsing dots). */
  placeholder: boolean
}

export type LearningsInput = {
  facts: RevealFact[]
  sections: Partial<Record<SectionBucket, RevealSection>>
}

/** The arrival-ordered list of grounded learnings (facts then grounded sections, newest-last). Pure. */
export function learningsList({ facts, sections }: LearningsInput): readonly string[] {
  const out: string[] = []
  for (const f of facts) out.push(f.text)
  for (const bucket of ['purpose', 'maker', 'made'] as const) {
    const sec = sections[bucket]
    if (sec && sec.text) out.push(sec.text)
  }
  return out
}

/**
 * The learning to show at a given cycle index. Returns the "Researching" placeholder when the list is empty.
 * `cycleIndex` wraps via modulo. Pure.
 */
export function currentLearning(input: LearningsInput, cycleIndex: number): LearningText {
  const items = learningsList(input)
  if (items.length === 0) return { text: 'Researching', fullText: 'Researching', placeholder: true }
  const idx = ((cycleIndex % items.length) + items.length) % items.length
  const text = items[idx] ?? items[0] ?? '' // idx is modulo items.length so always defined; the fallback satisfies noUncheckedIndexedAccess
  return { text, fullText: text, placeholder: false }
}
