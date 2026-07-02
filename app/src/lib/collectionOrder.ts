/**
 * Collection ordering + neighbour selection — the shared, pure basis for BOTH the Collection grid's date
 * grouping (`threads.tsx`) and the reveal's swipe-paging (`reveal.tsx`), so the two surfaces can never disagree
 * on "which item is next".
 *
 * `orderThreads` is newest-first (the recency order a user sees as "recently catalogued"). `neighborsOf` runs
 * over the REVEALABLE subset only — a reveal is persisted server-side ONLY for CONFIDENT/PROBABLE items
 * (voxi-api/src/app.ts), so an UNKNOWN/refused/failed capture has no reveal to page to; paging into one would
 * dump the user into the interview form or a stuck failure screen. The CURRENT item is always kept (a
 * just-captured thread is transiently `band:null` in the `['threads']` cache until the server persists its
 * band), so a fresh capture is never filtered out of its own paging set.
 */
import type { ThreadSummary } from './apiClient'

/** Newest-first (the "recently catalogued" order). Stable sort; does not mutate the input. */
export function orderThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.createdAt - a.createdAt)
}

/** A thread is pageable iff it has a persisted reveal (CONFIDENT/PROBABLE) OR it is the item on screen now. */
function revealable(t: ThreadSummary, currentId: string | null): boolean {
  return t.threadId === currentId || t.band === 'CONFIDENT' || t.band === 'PROBABLE'
}

/** The newest-first list the reveal pages through: the revealable subset (skips UNKNOWN/failed so a page never
 *  lands in the interview form), always including the current item. This is the `data` for the paging FlatList. */
export function pageableThreads(threads: ThreadSummary[], currentId: string | null): ThreadSummary[] {
  return orderThreads(threads).filter((t) => revealable(t, currentId))
}
