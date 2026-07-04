import { test, expect, describe, beforeEach } from 'bun:test'
import { ApiError } from '../lib/apiClient'
import {
  startDeepDive,
  regenerateDeepDive,
  cancelDeepDive,
  forgetDeepDive,
  seedReadyDeepDive,
  reconcileDeepDive,
  getDeepDiveStatus,
  deepDiveIconState,
  useDeepDiveStore,
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

describe('forgetDeepDive (bulk-delete cleanup)', () => {
  test('cancels an in-flight job AND removes the byThread key (no session leak)', async () => {
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    expect(getDeepDiveStatus('t1').state).toBe('composing')
    expect('t1' in useDeepDiveStore.getState().byThread).toBe(true)
    forgetDeepDive('t1')
    await __awaitDeepDive('t1')
    // The cancelled job never flips to ready, AND the store key is GONE (not just reset to IDLE).
    expect(getDeepDiveStatus('t1').state).not.toBe('ready')
    expect('t1' in useDeepDiveStore.getState().byThread).toBe(false)
  })

  test('drops a stale ready entry a player will never reconcile (the bulk-delete leak case)', () => {
    seedReadyDeepDive('t1', 'u.m4a')
    expect('t1' in useDeepDiveStore.getState().byThread).toBe(true)
    forgetDeepDive('t1')
    expect('t1' in useDeepDiveStore.getState().byThread).toBe(false)
  })

  test('REGRESSION GUARD: cancelDeepDive leaves the key (only forgetDeepDive removes it)', async () => {
    // The contrast that makes forgetDeepDive necessary: cancelDeepDive stops the job but the byThread entry dangles.
    const api = fakeApi([{ state: 'composing' }, { state: 'ready', audioUrl: 'u' }])
    startDeepDive(api, { threadId: 't1' }, { sleep: noSleep, pollMs: 0 })
    cancelDeepDive('t1')
    await __awaitDeepDive('t1')
    expect(getDeepDiveStatus('t1').state).not.toBe('ready')
    expect('t1' in useDeepDiveStore.getState().byThread).toBe(true) // still present — the leak forgetDeepDive fixes
  })

  test('no-op on an unknown thread (safe for partial-failure retry)', () => {
    expect(() => forgetDeepDive('never-existed')).not.toThrow()
    expect('never-existed' in useDeepDiveStore.getState().byThread).toBe(false)
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

// F3 — the player's mount probe reconciles the store with the server's podcast truth. The reported bug: a stale
// `ready` cached earlier in the session (a pre-fix episode whose worker-relative audio URL 404s after the GCS
// rework) kept the player attached to a DEAD episode until a force-quit. Reconcile clears it so Generate shows.
describe('reconcileDeepDive — server-truth reconciliation on player mount', () => {
  test('server has a SERVABLE ready → seeds it into an idle store', () => {
    reconcileDeepDive('t1', { state: 'ready', audioUrl: 'https://storage.googleapis.com/b/podcasts/t1/v1/ep.m4a' })
    expect(getDeepDiveStatus('t1').state).toBe('ready')
    expect(getDeepDiveStatus('t1').audioUrl).toBe('https://storage.googleapis.com/b/podcasts/t1/v1/ep.m4a')
  })

  test('server ready with a FRESH url OVERWRITES a stale cached ready (seedReadyDeepDive would no-op here)', () => {
    seedReadyDeepDive('t1', 'https://voxi-podcast-worker-x.a.run.app/audio/t1/v1/ep.m4a') // stale dead url cached
    expect(getDeepDiveStatus('t1').audioUrl).toBe('https://voxi-podcast-worker-x.a.run.app/audio/t1/v1/ep.m4a')
    reconcileDeepDive('t1', { state: 'ready', audioUrl: 'https://storage.googleapis.com/b/podcasts/t1/v1/ep.m4a' })
    expect(getDeepDiveStatus('t1').audioUrl).toBe('https://storage.googleapis.com/b/podcasts/t1/v1/ep.m4a') // overwritten
  })

  test('server has NO episode (F1 deleted the row → getThread podcast=null) → a stale ready is CLEARED to idle', () => {
    seedReadyDeepDive('t1', 'https://voxi-podcast-worker-x.a.run.app/audio/t1/v1/ep.m4a') // stale ready cached this session
    expect(getDeepDiveStatus('t1').state).toBe('ready')
    reconcileDeepDive('t1', null) // server truth: no episode
    expect(getDeepDiveStatus('t1').state).toBe('idle') // cleared → player shows Generate (startDeepDive proceeds)
    expect(getDeepDiveStatus('t1').audioUrl).toBeUndefined()
  })

  test('server ready but the BFF WITHHELD the url (F2 stale-URL guard) → stale ready is CLEARED to idle', () => {
    seedReadyDeepDive('t1', 'https://voxi-podcast-worker-x.a.run.app/audio/t1/v1/ep.m4a')
    reconcileDeepDive('t1', { state: 'ready' /* audioUrl withheld: undefined */ })
    expect(getDeepDiveStatus('t1').state).toBe('idle')
    expect(getDeepDiveStatus('t1').audioUrl).toBeUndefined()
  })

  test('a stale SLOW (budget-lapsed) episode is also cleared when the server has no servable ready', () => {
    // prime a slow state by running a poll that exhausts its budget
    const api = fakeApi([{ state: 'composing' }], {}) // never resolves ready → budget lapses to slow
    startDeepDive(api, { threadId: 't1', subject: 'X' }, { sleep: noSleep, pollMs: 0, pollMax: 1 })
    return __awaitDeepDive('t1').then(() => {
      expect(getDeepDiveStatus('t1').state).toBe('slow')
      reconcileDeepDive('t1', null)
      expect(getDeepDiveStatus('t1').state).toBe('idle')
    })
  })

  test('no-op while a poll job is in flight (the live poller owns the terminal write)', async () => {
    const d = deferred<void>()
    const api = fakeApi([], {})
    // park a generate mid-flight so jobs.has('t1') stays true
    const realApi: DeepDiveApi = {
      async generatePodcast() { api.generateCalls++; await d.promise; return { token: 'tok', replay: false } },
      async podcastStatus() { api.statusCalls++; return { state: 'composing' as const } },
    }
    startDeepDive(realApi, { threadId: 't1', subject: 'X' }, { sleep: noSleep })
    reconcileDeepDive('t1', { state: 'ready', audioUrl: 'https://storage.googleapis.com/b/x.m4a' }) // must not clobber the in-flight composing
    expect(getDeepDiveStatus('t1').state).toBe('composing')
    d.resolve()
    await __awaitDeepDive('t1')
  })
})
