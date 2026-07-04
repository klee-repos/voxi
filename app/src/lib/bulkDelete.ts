/**
 * bulkDeleteThreads — the client-side bulk-delete orchestrator for the collection grid. There is no server-side
 * batch endpoint (the BFF DELETE /v1/threads/:id cascade is owner-scoped + idempotent + safe to fan out in
 * parallel — distinct rows/keys, no shared mutable state), so the client owns the loop, the 404-tolerance, and
 * the per-id session-cache cleanup.
 *
 * Mirrors the SINGLE-delete cleanup sequence (reveal.tsx onConfirmDelete): per deleted id → evictReveal +
 * forgetDeepDive (the revealCache entry + the deepDive store entry + any in-flight poll). FAILED ids are NOT
 * cleaned (their reveal + deep-dive state stays valid — they weren't deleted). A 404 (already gone) is
 * success-equivalent, exactly as in the single-delete path. The caller does the ONE optimistic setQueryData
 * (filter all deleted) + ONE invalidateQueries AFTER this returns — batched, the proven pattern.
 *
 * Extracted as a pure, dependency-injected helper so the partition + 404-tolerance + cleanup-gating logic is
 * unit-pinned (the no-fake-green guarantee: a swapped-partition bug — a failed id marked deleted and cleaned —
 * goes red, because the test asserts EXACT-id routing, not call counts).
 */
import { ApiError } from './apiClient'

export interface BulkDeleteDeps {
  /** api.deleteThread — DELETE /v1/threads/:id; 204 → void, 404 → ApiError (treated as already-gone). */
  deleteThread: (id: string) => Promise<void>
  /** Drop the per-thread revealCache entry so a future visit re-streams (revealCache.evictReveal). */
  evictReveal: (id: string) => void
  /** Cancel any in-flight Deep Dive poll AND drop the byThread store entry (deepDiveStore.forgetDeepDive). */
  forgetDeepDive: (id: string) => void
}

export interface BulkDeleteResult {
  /** ids actually removed (including 404-already-gone). These are the ids the caller filters from the cache. */
  deleted: string[]
  /** ids whose delete threw a non-404 error. The caller keeps these selected + surfaced for retry. */
  failed: { id: string; status?: number }[]
}

/**
 * Delete every id in `ids`, running the BFF calls in parallel. For each DELETED id (resolved OR 404), run the
 * per-id session-cache cleanup. Never rejects — partial failure is reported via `failed[]`. Tolerant of an empty
 * input (no calls; both partitions empty).
 */
export async function bulkDeleteThreads(ids: readonly string[], deps: BulkDeleteDeps): Promise<BulkDeleteResult> {
  const settled = await Promise.allSettled(ids.map((id) => deps.deleteThread(id)))
  const deleted: string[] = []
  const failed: BulkDeleteResult['failed'] = []
  // Walk the results in INPUT order (not settlement order) so the deleted/failed partition is deterministic and
  // a test can assert exact-id arrays without depending on which request settled first.
  settled.forEach((res, i) => {
    const id = ids[i]!
    if (res.status === 'fulfilled') {
      deleted.push(id)
      deps.evictReveal(id)
      deps.forgetDeepDive(id)
      return
    }
    // A 404 means the thread is already gone (repeat delete, or a concurrent delete) — treat as deleted.
    const reason = res.reason
    if (reason instanceof ApiError && reason.status === 404) {
      deleted.push(id)
      deps.evictReveal(id)
      deps.forgetDeepDive(id)
      return
    }
    failed.push({ id, status: reason instanceof ApiError ? reason.status : undefined })
  })
  return { deleted, failed }
}
