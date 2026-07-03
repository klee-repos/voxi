/**
 * Session cache of a thread's FULLY-loaded reveal content (LOADING-EXPERIENCE-PLAN — "no loading when you go back
 * and forth"). The collection summary only carries photo + title + band, so revisiting an item otherwise RE-FETCHES
 * its buckets (what/purpose/maker/facts) and shows spinners for a second — a loading state on something already
 * seen. When the reveal finishes loading an item we cache its content here; a revisit HYDRATES from it and skips the
 * stream entirely, so the dock paints complete + instant. In-memory only (per session) — the durable copy lives
 * server-side; this is purely a "don't re-load what I just looked at" shortcut.
 */
import type { CachedReveal } from '../state/captureStore'

const cache = new Map<string, CachedReveal>()

/** Cache a thread's completed reveal content (called by the reveal once research has settled). */
export function cacheReveal(threadId: string, data: CachedReveal): void {
  cache.set(threadId, data)
}

/** The cached content for a thread, if it was fully loaded this session (else undefined → the caller streams). */
export function getCachedReveal(threadId: string): CachedReveal | undefined {
  return cache.get(threadId)
}

/** Drop a thread's cached content so a subsequent revisit re-streams instead of painting stale content. Called on
 *  delete (the item is gone) and on regenerate (the content is being replaced) — without this a later swipe-back
 *  would `hydrate()` the pre-regenerate reveal and silently mask the fresh result. */
export function evictReveal(threadId: string): void {
  cache.delete(threadId)
}
