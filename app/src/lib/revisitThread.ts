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
import type { CachedReveal } from '../state/captureStore'
import { getCachedReveal } from './revealCache'
import type { ThreadSummary } from './apiClient'

/** The injectable seams the revisit action drives (store setters + router push). `push` is narrowed to the two
 *  routes this action navigates to so the expo-router `Href` type is satisfied without a cast. */
export interface RevisitDeps {
  startCapture: (photoUri: string | null) => void
  setThread: (threadId: string) => void
  /** flag this as a revisit so the loaders show the calm "opening your entry" copy, not fresh-analysis copy. */
  markRevisit: () => void
  /** paint the FULLY-loaded content at once from the session cache (band + title + buckets) — no bucket re-fetch. */
  hydrate: (cached: CachedReveal) => void
  /** seed the settled band+title so the reveal renders READY at once (no /processing wait) on a known-identity revisit. */
  setBand: (band: ConfidenceBand, title: string, candidates: string[]) => void
  push: (href: '/processing' | '/reveal') => void
  /** True when `threadId` is the thread whose cascade is ALREADY streaming in the background (the keepAlive survivor
   *  pump kept it alive across a navigation away). When true, revisit ATTACHES to that survivor (just navigates)
   *  instead of `startCapture`-ing — which would `abortThreadStream()` the survivor + wipe `researchComplete`,
   *  forcing a full cascade re-run and showing loading buckets for an item the user watched nearly finish (the
   *  "closed it, came back, broken" state). Optional (default never short-circuits) so the pure unit tests stay simple. */
  isStreamingThread?: (threadId: string) => boolean
}

export function revisitThread(item: ThreadSummary, deps: RevisitDeps): void {
  // ATTACH-TO-SURVIVOR: if this thread's cascade is ALREADY running in the background (the reveal's keepAlive
  // survivor pump kept it alive across the user's navigation to collections + back), DON'T startCapture.
  // startCapture calls abortThreadStream() — killing the very survivor we want to preserve — AND resets
  // researchComplete, so the reveal re-opens with band+title but empty/loading buckets and re-runs the whole
  // cascade (~60s on the real BFF). Instead, just navigate: /reveal mounts, useThreadStreamRun sees
  // isThreadStreaming(), ATTACHES, and reads the in-flight store state the survivor keeps filling.
  if (deps.isStreamingThread?.(item.threadId)) {
    deps.push('/reveal')
    return
  }
  deps.startCapture(item.photoUrl ?? null) // resets the store (isRevisit → false, aborts any stream); mark AFTER
  deps.markRevisit()
  deps.setThread(item.threadId)
  // Fully loaded THIS session → hydrate the complete content (band + title + buckets) so the reveal paints
  // instantly with NO bucket re-fetch/loading — the "no loading when you go back and forth" fix.
  const cached = getCachedReveal(item.threadId)
  if (cached) {
    deps.hydrate(cached)
    deps.push('/reveal')
    return
  }
  // Known identity (from the collection summary) → instant reveal from cache, stream the buckets in behind.
  if (item.band === 'CONFIDENT' || item.band === 'PROBABLE') {
    deps.setBand(item.band, item.revealTitle ?? item.title, [])
    deps.push('/reveal')
    return
  }
  // Unresolved/UNKNOWN → let /processing stream + route (reveal vs interview) once the band settles.
  deps.push('/processing')
}
