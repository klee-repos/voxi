/**
 * In-process test for the mountable voice routes (no network). Drives the real Hono sub-app via .request().
 * Covers: auth gate (401), thread-ownership ACL (403), fail-closed voiceMin metering (402), unconfigured
 * media plane (503, loud not fake), and the happy path (a per-session connect URL + one minute charged).
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { createVoiceRoutes } from './voice-routes'
import { testVerifier } from './auth'
import { memoryStore } from './metering'
import type { RevealStore, RevealRecord } from './app'
import type { StreamEvent } from '../../../packages/shared/src/events'

process.env.VOXI_TEST_MODE = '1'

/** Minimal in-memory RevealStore seeding the F5 context fetch (the owner-scoped grounded reveal). */
function memReveals(seed: RevealRecord[]): RevealStore {
  const rows = new Map(seed.map((r) => [r.threadId, r]))
  return {
    async put(r) { if (rows.has(r.threadId)) return { inserted: false }; rows.set(r.threadId, r); return { inserted: true } },
    async get(id) { return rows.get(id) ?? null },
    async delete(id) { rows.delete(id) },
  }
}

function build(opts?: { base?: string; voiceMinA?: number }) {
  const sessionOwner = new Map<string, string>([['thread_A', 'A'], ['thread_B', 'A']])
  const store = memoryStore({
    A: { scan: 5, podcast: 0, voiceMin: opts?.voiceMinA ?? 3 },
    B: { scan: 5, podcast: 0, voiceMin: 3 },
  })
  const reveals = memReveals([
    { threadId: 'thread_A', ownerUserId: 'A', band: 'CONFIDENT', title: 'Cannondale', candidates: [], narration: 'A 2008 Cannondale.', createdAt: 1, events: [{ type: 'fact', text: 'Made in Pennsylvania.', sourceUrl: 'https://example.com/a', index: 0 } as unknown as StreamEvent] },
    { threadId: 'thread_B', ownerUserId: 'A', band: 'CONFIDENT', title: 'Trek', candidates: [], narration: 'A Trek bike.', createdAt: 1, events: [{ type: 'fact', text: 'Made in Wisconsin.', sourceUrl: 'https://example.com/b', index: 0 } as unknown as StreamEvent] },
  ])
  const app = createVoiceRoutes({
    verifier: testVerifier,
    store,
    sessionOwner,
    reveals,
    voiceServerBaseUrl: opts?.base ?? 'http://192.168.1.193:7071',
    mintConnectId: () => 'vc_fixed',
    now: () => 1000,
  })
  return { app, store }
}

const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })

describe('POST /v1/voice/session', () => {
  test('401 without a valid principal', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when threadId is missing', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', { method: 'POST', headers: auth('A'), body: '{}' })
    expect(res.status).toBe(400)
  })

  test('403 when the caller does not own the thread', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('B'), // B does not own thread_A
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(403)
  })

  test('happy path: charges one voice minute and returns a per-session connect URL', async () => {
    const { app, store } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connectUrl: string; minutesCharged: number; connectId: string }
    expect(body.connectId).toBe('vc_fixed')
    expect(body.minutesCharged).toBe(1)
    expect(body.connectUrl).toContain('/offer?session=vc_fixed')
    expect(body.connectUrl).toContain('thread=thread_A')
    // The voice minute was actually decremented (fail-closed metering, not fabricated).
    expect(await store.remaining('A', 'voiceMin')).toBe(2)
  })

  test('402 fail-closed when the caller has no voice minutes (no connect URL leaks)', async () => {
    const { app } = build({ voiceMinA: 0 })
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('voice_limit_reached')
  })

  test('503 loud (not a fake success) when the media plane is unconfigured', async () => {
    const { app, store } = build({ base: '' })
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('voice_server_unconfigured')
    // ASK-SEC-4: the config check runs BEFORE the charge, so a guaranteed-fail config never bills a minute.
    // Pin voiceMin unchanged so a future reorder (charge-before-config) is caught here, not in production.
    expect(await store.remaining('A', 'voiceMin')).toBe(3)
  })

  test('refund: credits back a minute when the client never connected; idempotent + payer-only', async () => {
    const { app, store } = build()
    await app.request('/v1/voice/session', { method: 'POST', headers: auth('A'), body: JSON.stringify({ threadId: 'thread_A' }) })
    expect(await store.remaining('A', 'voiceMin')).toBe(2) // charged 1 on /session
    // A non-owner cannot refund A's connectId (404, never leaks existence).
    expect((await app.request('/v1/voice/session/vc_fixed/refund', { method: 'POST', headers: auth('B') })).status).toBe(404)
    // A refunds → the minute is credited back (2 → 3).
    const r1 = await app.request('/v1/voice/session/vc_fixed/refund', { method: 'POST', headers: auth('A') })
    expect(r1.status).toBe(200)
    expect((await r1.json()).refunded).toBe(true)
    expect(await store.remaining('A', 'voiceMin')).toBe(3)
    // A second refund is a once-ever noop (no double-credit — a late /offer confirm can't game it).
    const r2 = await app.request('/v1/voice/session/vc_fixed/refund', { method: 'POST', headers: auth('A') })
    expect(r2.status).toBe(200)
    expect((await r2.json()).replay).toBe(true)
    expect(await store.remaining('A', 'voiceMin')).toBe(3)
  })
})

describe('GET /v1/voice/session/:connectId/context (F5 grounded context)', () => {
  test('returns the server-owned item context for a minted capability — NO bearer (capability-auth)', async () => {
    const { app } = build()
    await app.request('/v1/voice/session', { method: 'POST', headers: auth('A'), body: JSON.stringify({ threadId: 'thread_A' }) })
    const res = await app.request('/v1/voice/session/vc_fixed/context') // no Authorization header
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subject).toBe('Cannondale')
    expect(body.itemContext).toContain('Pennsylvania') // the grounded fact reaches the voice-bot
  })

  test('unknown/expired connectId → 404 (never leaks existence)', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session/nope/context')
    expect(res.status).toBe(404)
  })

  test('F5-CAP-THREAD: a client ?thread= swap is IGNORED — the threadId resolves from the capability', async () => {
    const { app } = build()
    // Mint for thread_A → the capability binds (A, thread_A).
    await app.request('/v1/voice/session', { method: 'POST', headers: auth('A'), body: JSON.stringify({ threadId: 'thread_A' }) })
    // A malicious client swaps ?thread=thread_B in the URL the voice-bot would send.
    const res = await app.request('/v1/voice/session/vc_fixed/context?thread=thread_B')
    expect(res.status).toBe(200)
    const body = await res.json()
    // The context is thread_A's (the capability's thread), NOT the swapped thread_B's.
    expect(body.subject).toBe('Cannondale')
    expect(body.itemContext).toContain('Pennsylvania')
    expect(body.itemContext).not.toContain('Wisconsin')
  })
})
