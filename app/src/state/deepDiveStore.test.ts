import { test, expect, describe, beforeEach } from 'bun:test'
import { ApiError } from '../lib/apiClient'
import {
  startDeepDive,
  regenerateDeepDive,
  cancelDeepDive,
  seedReadyDeepDive,
  getDeepDiveStatus,
  deepDiveIconState,
  __resetDeepDive,
  __awaitDeepDive,
  type DeepDiveApi,
} from './deepDiveStore'

const noSleep = () => Promise.resolve()

type GenArgs = { catalogItemId: string; version: number; subject?: string }
type FakeApi = DeepDiveApi & { generateCalls: number; statusCalls: number; lastArgs?: GenArgs }

/** A fake BFF: `generatePodcast` counts calls + records the LAST args (version freshness is asserted); `podcastStatus` returns a scripted sequence. */
function fakeApi(statuses: { state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[] }[], opts?: { throwOnGenerate?: unknown }): FakeApi {
  let i = 0
  const api = {
    generateCalls: 0,
    statusCalls: 0,
    lastArgs: undefined as GenArgs | undefined,
    async generatePodcast(args: GenArgs) {
      api.generateCalls++
      api.lastArgs = args
      if (opts?.throwOnGenerate) throw opts.throwOnGenerate
      return { token: 'tok-1', replay: false }
    },
    async podcastStatus() {
      api.statusCalls++
      return statuses[Math.min(i++, statuses.length - 1)]!
    },
  }
  return api as FakeApi
}

/** A minimal deferred so a test can PARK a fake's generate() mid-flight (for the identity-safe-cleanup race). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => __resetDeepDive())

describe('startDeepDive — lifecycle', () => {
  test('composing → ready, carrying audioUrl + transcript', async () => {
    const tx = [{ speaker: 'ARLO' as const, text: 'Hello.' }]
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'u.m4a', transcript: tx }])
    startDeepDive(api, { threadId: 't1', subject: 'A Thing' }, { sleep: noSleep, pollMs: 0 })
    expect(getDeepDiveStatus('t1').state).toBe('composing') // set synchronously, before any await
    expect(getDeepDiveStatus('t1').startedAt).not.toBeNull()
    await __awaitDeepDive('t1')
    const s = getDeepDiveStatus('t1')
    expect(s.state).toBe('ready')
    expect(s.audioUrl).toBe('u.m4a')
    expect(s.transcript).toEqual(tx)
    expect(s.startedAt).toBeNull()
  })

  test('IDEMPOTENT: a second start while composing does NOT fire a second generate (no double-charge)', async () => {
    const api = fakeApi([{ state: 'composing' }, { state: 'composing' }, { state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 }) // racing re-tap — must ATTACH
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    await __awaitDeepDive('t1')
    expect(api.generateCalls).toBe(1)
    expect(getDeepDiveStatus('t1').state).toBe('ready')
  })

  test('a start after ready is a no-op (durable replay, no re-generate)', async () => {
    const api = fakeApi([{ state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1').state).toBe('ready')
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    expect(api.generateCalls).toBe(1)
  })

  test('failed render → failed / render', async () => {
    const api = fakeApi([{ state: 'composing' }, { state: 'failed' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1')).toMatchObject({ state: 'failed', failReason: 'render' })
  })

  test('402 on generate → failed / limit (paywall recovery)', async () => {
    const api = fakeApi([{ state: 'composing' }], { throwOnGenerate: new ApiError(402, 'entitlement_exhausted') })
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1')).toMatchObject({ state: 'failed', failReason: 'limit' })
  })

  test('poll budget lapse → non-terminal "slow" (never a fabricated failure)', async () => {
    const api = fakeApi([{ state: 'composing' }]) // never returns ready
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0, pollMax: 3 })
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1').state).toBe('slow')
    expect(api.statusCalls).toBe(3) // bounded — no infinite loop / leak
  })

  test('survives "unmount": the poll completes to ready with NO component referencing it', async () => {
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    // (simulate the player unmounting immediately — we hold no reference; the module job runs on)
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1').state).toBe('ready')
  })

  test('per-thread isolation: two threads compose independently, no cross-contamination', async () => {
    const a = fakeApi([{ state: 'ready', audioUrl: 'A' }])
    const b = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'B' }])
    startDeepDive(a, { threadId: 'tA' }, { sleep: noSleep, pollMs: 0 })
    startDeepDive(b, { threadId: 'tB' }, { sleep: noSleep, pollMs: 0 })
    await Promise.all([__awaitDeepDive('tA'), __awaitDeepDive('tB')])
    expect(getDeepDiveStatus('tA').audioUrl).toBe('A')
    expect(getDeepDiveStatus('tB').audioUrl).toBe('B')
  })
})

describe('cancelDeepDive', () => {
  test('cancel mid-compose stops further writes', async () => {
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    cancelDeepDive('t1')
    await __awaitDeepDive('t1')
    // cancelled before ready landed → stays composing (the last write before cancel), never flips to ready
    expect(getDeepDiveStatus('t1').state).not.toBe('ready')
  })
})

describe('regenerateDeepDive', () => {
  test('fires a FRESH generate after ready, at a fresh (timestamp) version != 1 — the whole point', async () => {
    seedReadyDeepDive('t1', 'orig.m4a') // start from a durable episode
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'fresh.m4a' }])
    const FIXED = 1_800_000_123_456
    regenerateDeepDive(api, { threadId: 't1', subject: 'A Thing' }, { sleep: noSleep, pollMs: 0, now: () => FIXED })
    expect(getDeepDiveStatus('t1').state).toBe('composing') // set synchronously (vs startDeepDive's no-op on ready)
    await __awaitDeepDive('t1')
    expect(api.generateCalls).toBe(1) // regenerated despite being ready
    expect(api.lastArgs?.version).toBe(Math.floor(FIXED / 1000)) // FRESH version, not the hardcoded 1
    expect(api.lastArgs?.version).not.toBe(1)
    expect(api.lastArgs?.catalogItemId).toBe('t1')
    expect(getDeepDiveStatus('t1')).toMatchObject({ state: 'ready', audioUrl: 'fresh.m4a' })
  })

  test('a second regenerate WHILE composing is a no-op — a sub-frame double-tap never double-charges', async () => {
    seedReadyDeepDive('t1', 'orig.m4a')
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'fresh.m4a' }])
    const now = () => 1_800_000_000_000
    regenerateDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0, now }) // sets composing synchronously
    regenerateDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0, now }) // reads composing → bails
    await __awaitDeepDive('t1')
    expect(api.generateCalls).toBe(1) // the second bailed on the in-flight guard (no second credit spent)
    expect(getDeepDiveStatus('t1').audioUrl).toBe('fresh.m4a')
  })

  test('a cancelled prior job\'s cleanup is IDENTITY-safe — it does NOT orphan a job launched after it (BLOCKER-A)', async () => {
    // Job A: park it AT generate() so it is mid-flight (cancelled) when its cleanup later runs.
    const genA = deferred<{ token: string; replay: boolean }>()
    const apiA = { calls: 0, async generatePodcast() { this.calls++; return genA.promise }, async podcastStatus() { return { state: 'composing' as const } } }
    startDeepDive(apiA as unknown as DeepDiveApi, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    cancelDeepDive('t1') // A.cancelled = true, A removed from the map

    // Job B: launched after the cancel (what regenerate's launchJob does). Park B at generate() so it stays composing.
    const genB = deferred<{ token: string; replay: boolean }>()
    const apiB = { calls: 0, async generatePodcast() { this.calls++; return genB.promise }, async podcastStatus() { return { state: 'composing' as const } } }
    startDeepDive(apiB as unknown as DeepDiveApi, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 }) // B is now the live job
    expect(apiB.calls).toBe(1)

    // A resumes (its generate resolves) → sees cancelled → runs its finally. With the identity guard it must NOT delete B.
    genA.resolve({ token: 'A', replay: false })
    await new Promise((r) => setTimeout(r, 0)) // flush A's continuation + finally

    // B is still parked/composing → a racing start must ATTACH (B still in the map), not fire a SECOND generate.
    startDeepDive(apiB as unknown as DeepDiveApi, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    expect(apiB.calls).toBe(1) // WITHOUT the identity-safe finally A's cleanup orphaned B → this would be 2

    cancelDeepDive('t1') // release the parked job so the test leaks nothing
  })
})

describe('seedReadyDeepDive', () => {
  test('seeds a durable-ready episode when no job is in flight', () => {
    seedReadyDeepDive('t1', 'durable.m4a', [{ speaker: 'MAVE', text: 'Hi.' }])
    expect(getDeepDiveStatus('t1')).toMatchObject({ state: 'ready', audioUrl: 'durable.m4a' })
  })

  test('does NOT clobber an existing ready episode — a reopen probe cannot overwrite a fresher regenerated one', () => {
    seedReadyDeepDive('t1', 'fresh.m4a') // e.g. a just-regenerated episode
    seedReadyDeepDive('t1', 'stale-v1.m4a') // the reopen getThread(v1) probe
    expect(getDeepDiveStatus('t1').audioUrl).toBe('fresh.m4a') // kept the fresher one
  })
})

describe('deepDiveIconState', () => {
  test('composing / slow → generating; ready → ready; else active', () => {
    expect(deepDiveIconState({ state: 'composing', failReason: null, startedAt: 1 })).toBe('generating')
    expect(deepDiveIconState({ state: 'slow', failReason: null, startedAt: 1 })).toBe('generating')
    expect(deepDiveIconState({ state: 'ready', failReason: null, startedAt: null })).toBe('ready')
    expect(deepDiveIconState({ state: 'idle', failReason: null, startedAt: null })).toBe('active')
    expect(deepDiveIconState({ state: 'failed', failReason: 'render', startedAt: null })).toBe('active')
  })
})
