/**
 * bulkDeleteThreads unit tests. The load-bearing assertion is EXACT-id routing (not call counts): a swapped-
 * partition bug — a FAILED id marked deleted and cleaned — must go red. Mirrors the project's `threadStream.test`
 * spy-array pattern. The deps are an injected seam (the no-fake-green guarantee — this tests real partition +
 * 404-tolerance + cleanup-gating logic, not a stub that fakes success).
 */
import { test, expect, describe } from 'bun:test'
import { bulkDeleteThreads, type BulkDeleteDeps } from './bulkDelete'
import { ApiError } from './apiClient'

/** A recording deps fake: deleteThread is programmed per-id; evict/forget calls record the EXACT id arrays. */
function spyDeps(program: Record<string, 'resolve' | { status: number } | Error>): { deps: BulkDeleteDeps; calls: { deleteCalls: string[]; evictCalls: string[]; forgetCalls: string[] } } {
  const calls = { deleteCalls: [] as string[], evictCalls: [] as string[], forgetCalls: [] as string[] }
  const deps: BulkDeleteDeps = {
    async deleteThread(id) {
      calls.deleteCalls.push(id)
      const p = program[id]
      if (p === 'resolve' || p === undefined) return
      if (p instanceof Error) throw p
      throw new ApiError(p.status, `test ${p.status}`)
    },
    evictReveal: (id) => calls.evictCalls.push(id),
    forgetDeepDive: (id) => calls.forgetCalls.push(id),
  }
  return { deps, calls }
}

describe('bulkDeleteThreads — partition + 404 tolerance', () => {
  test('all succeed → deleted = all ids, cleanup runs on each, no failures', async () => {
    const { deps, calls } = spyDeps({ a1: 'resolve', b2: 'resolve', c3: 'resolve' })
    const res = await bulkDeleteThreads(['a1', 'b2', 'c3'], deps)
    expect(res.deleted).toEqual(['a1', 'b2', 'c3'])
    expect(res.failed).toEqual([])
    expect(calls.deleteCalls).toEqual(['a1', 'b2', 'c3'])
    expect(calls.evictCalls).toEqual(['a1', 'b2', 'c3'])
    expect(calls.forgetCalls).toEqual(['a1', 'b2', 'c3'])
  })

  test('a 404 (already gone) is success-equivalent: deleted AND cleaned (mirrors the single-delete path)', async () => {
    const { deps, calls } = spyDeps({ a1: 'resolve', b2: { status: 404 } })
    const res = await bulkDeleteThreads(['a1', 'b2'], deps)
    expect(res.deleted).toEqual(['a1', 'b2'])
    expect(res.failed).toEqual([])
    expect(calls.evictCalls).toEqual(['a1', 'b2'])
    expect(calls.forgetCalls).toEqual(['a1', 'b2'])
  })

  test('a 500 lands in failed[], is NOT cleaned (its reveal + deep-dive state stays valid)', async () => {
    const { deps, calls } = spyDeps({ a1: 'resolve', c3: { status: 500 } })
    const res = await bulkDeleteThreads(['a1', 'c3'], deps)
    expect(res.deleted).toEqual(['a1'])
    expect(res.failed).toEqual([{ id: 'c3', status: 500 }])
    expect(calls.evictCalls).toEqual(['a1'])
    expect(calls.forgetCalls).toEqual(['a1'])
  })

  test('a non-ApiError throw lands in failed[] with NO status, is NOT cleaned', async () => {
    const { deps, calls } = spyDeps({ a1: new TypeError('network drop') })
    const res = await bulkDeleteThreads(['a1'], deps)
    expect(res.deleted).toEqual([])
    expect(res.failed).toEqual([{ id: 'a1', status: undefined }])
    expect(calls.evictCalls).toEqual([])
    expect(calls.forgetCalls).toEqual([])
  })

  test('[B1 no-fake-green] mixed: cleanup runs on EXACTLY the deleted set, never on a failed id', async () => {
    // a1 ok, b2 already-gone (404), c3 server error (500). A swapped-partition bug would clean c3 (wrong) —
    // the exact-array assertions catch it where a call-count assertion would pass.
    const { deps, calls } = spyDeps({ a1: 'resolve', b2: { status: 404 }, c3: { status: 500 } })
    const res = await bulkDeleteThreads(['a1', 'b2', 'c3'], deps)
    expect(res.deleted).toEqual(['a1', 'b2'])
    expect(res.failed).toEqual([{ id: 'c3', status: 500 }])
    expect(calls.evictCalls).toEqual(['a1', 'b2']) // NOT c3
    expect(calls.forgetCalls).toEqual(['a1', 'b2']) // NOT c3
  })

  test('empty input → no calls, empty partitions (safe no-op)', async () => {
    const { deps, calls } = spyDeps({})
    const res = await bulkDeleteThreads([], deps)
    expect(res.deleted).toEqual([])
    expect(res.failed).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(calls.evictCalls).toEqual([])
    expect(calls.forgetCalls).toEqual([])
  })

  test('fires the BFF calls in parallel (not serial)', async () => {
    // Each deleteThread parks for a tick; serial execution would take N ticks, parallel takes 1.
    let live = 0
    let maxLive = 0
    const deps: BulkDeleteDeps = {
      async deleteThread() { live++; maxLive = Math.max(maxLive, live); await new Promise((r) => setTimeout(r, 5)); live-- },
      evictReveal: () => {},
      forgetDeepDive: () => {},
    }
    await bulkDeleteThreads(['a1', 'b2', 'c3', 'd4'], deps)
    expect(maxLive).toBe(4) // all four in flight at once
  })
})
