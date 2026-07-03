import { test, expect, describe, beforeEach } from 'bun:test'
import { ApiError } from '../lib/apiClient'
import {
  startDeepDive,
  cancelDeepDive,
  seedReadyDeepDive,
  getDeepDiveStatus,
  deepDiveIconState,
  __resetDeepDive,
  __awaitDeepDive,
  type DeepDiveApi,
} from './deepDiveStore'

const noSleep = () => Promise.resolve()

/** A fake BFF: `generatePodcast` counts calls; `podcastStatus` returns a scripted sequence. */
function fakeApi(statuses: { state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[] }[], opts?: { throwOnGenerate?: unknown }): DeepDiveApi & { generateCalls: number; statusCalls: number } {
  let i = 0
  const api = {
    generateCalls: 0,
    statusCalls: 0,
    async generatePodcast() {
      api.generateCalls++
      if (opts?.throwOnGenerate) throw opts.throwOnGenerate
      return { token: 'tok-1', replay: false }
    },
    async podcastStatus() {
      api.statusCalls++
      return statuses[Math.min(i++, statuses.length - 1)]!
    },
  }
  return api as DeepDiveApi & { generateCalls: number; statusCalls: number }
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

describe('seedReadyDeepDive', () => {
  test('seeds a durable-ready episode when no job is in flight', () => {
    seedReadyDeepDive('t1', 'durable.m4a', [{ speaker: 'MAVE', text: 'Hi.' }])
    expect(getDeepDiveStatus('t1')).toMatchObject({ state: 'ready', audioUrl: 'durable.m4a' })
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
