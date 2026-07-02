/**
 * Pure revisit core — the ONE action both the Collection grid (`threads.tsx`) and the camera-home recent carousel
 * (`RecentCard`) run to resume a durable capture. Kept in its OWN module (no `react`/`expo-router` imports) so it
 * is unit-testable without a component renderer or the RN runtime.
 *
 * The collection tile already carries the settled identity (band + title + photo). When it does, we paint the reveal
 * INSTANTLY from that cached summary and let the reveal stream the durable buckets in behind — skipping the
 * /processing loading screen, which otherwise made first-open sit and wait for the BFF replay to re-emit the band
 * (the in-place SWIPE has always done this; a first open now matches it). Only an UNKNOWN/unresolved thread still
 * needs /processing to settle a band before we know where to land.
 */
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'
import type { ThreadSummary } from './apiClient'

/** The injectable seams the revisit action drives (store setters + router push). `push` is narrowed to the two
 *  routes this action navigates to so the expo-router `Href` type is satisfied without a cast. */
export interface RevisitDeps {
  startCapture: (photoUri: string | null) => void
  setThread: (threadId: string) => void
  /** flag this as a revisit so the loaders show the calm "opening your entry" copy, not fresh-analysis copy. */
  markRevisit: () => void
  /** seed the settled band+title so the reveal renders READY at once (no /processing wait) on a known-identity revisit. */
  setBand: (band: ConfidenceBand, title: string, candidates: string[]) => void
  push: (href: '/processing' | '/reveal') => void
}

export function revisitThread(item: ThreadSummary, deps: RevisitDeps): void {
  deps.startCapture(item.photoUrl ?? null) // resets the store (isRevisit → false, aborts any stream); mark AFTER
  deps.markRevisit()
  deps.setThread(item.threadId)
  // Known identity → instant reveal from cache, stream the buckets in behind (reveal owns the stream, §swipe-parity).
  if (item.band === 'CONFIDENT' || item.band === 'PROBABLE') {
    deps.setBand(item.band, item.revealTitle ?? item.title, [])
    deps.push('/reveal')
    return
  }
  // Unresolved/UNKNOWN → let /processing stream + route (reveal vs interview) once the band settles.
  deps.push('/processing')
}
