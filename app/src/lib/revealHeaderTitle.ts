/**
 * The reveal top-bar title-slot state machine (CATALOG-TOP-BAR "One bar"). Extracted pure so it is unit-testable
 * without RN rendering: `band === null` is the pre-settle "Identifying" placeholder; a settled band shows the
 * object name, falling back to a whimsical placeholder while the name is still empty (preserving the reveal's
 * prior `title || …` fallback).
 */
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'

export const IDENTIFYING_FALLBACK = 'An object of some interest'

export type TitleSlot = { kind: 'identifying' } | { kind: 'name'; text: string }

export function revealHeaderTitle(band: ConfidenceBand | null, title: string): TitleSlot {
  if (!band) return { kind: 'identifying' }
  return { kind: 'name', text: title.trim() ? title : IDENTIFYING_FALLBACK }
}
