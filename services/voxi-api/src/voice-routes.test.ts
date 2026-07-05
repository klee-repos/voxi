/**
 * In-process test for the mountable voice routes (no network). Drives the real Hono sub-app via .request().
 * Covers: auth gate (401), thread-ownership ACL (403), fail-closed voiceMin metering (402), unconfigured
 * media plane (503, loud not fake), and the happy path (a real per-session LiveKit token + one minute charged).
 *
 * LiveKit edition: the happy path DECODES the minted JWT and asserts the grant binds room=threadId,
 * identity=userId, the agent-dispatch flag, and the connectId capability in metadata — a real-token
 * assertion, not a fabricated string. (Was: the pipecat SmallWebRTC `connectUrl`/`/offer?session=` shape.)
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

// Dev-parity LiveKit config (matches scripts/dev.sh); the secret is ≥32 chars as LiveKit enforces.
const LK = { livekitUrl: 'ws://localhost:7880', livekitApiKey: 'devkey', livekitApiSecret: 'voxi-livekit-dev-secret-32chars-ok' }

function build(opts?: { livekit?: boolean; voiceMinA?: number }) {
  const sessionOwner = new Map<string, string>([['thread_A', 'A'], ['thread_B', 'A']])
  const store = memoryStore({
    A: { scan: 5, podcast: 0, voiceMin: opts?.voiceMinA ?? 3 },
    B: { scan: 5, podcast: 0, voiceMin: 3 },
  })
  const reveals = memReveals([
    { threadId: 'thread_A', ownerUserId: 'A', band: 'CONFIDENT', title: 'Cannondale', candidates: [], narration: 'A 2008 Cannondale.', createdAt: 1, events: [{ type: 'fact', text: 'Made in Pennsylvania.', sourceUrl: 'https://example.com/a', index: 0 } as unknown as StreamEvent] },
    { threadId: 'thread_B', ownerUserId: 'A', band: 'CONFIDENT', title: 'Trek', candidates: [], narration: 'A Trek bike.', createdAt: 1, events: [{ type: 'fact', text: 'Made in Wisconsin.', sourceUrl: 'https://example.com/b', index: 0 } as unknown as StreamEvent] },
  ])
  // `livekit: false` omits the media-plane config → the route must fail loud (503) BEFORE charging.
  const lk = opts?.livekit === false ? { livekitUrl: '', livekitApiKey: '', livekitApiSecret: '' } : LK
  const app = createVoiceRoutes({
    verifier: testVerifier,
    store,
    sessionOwner,
    reveals,
    ...lk,
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

  test('happy path: charges one voice minute and returns a real per-session LiveKit token', async () => {
    const { app, store } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connectId: string; url: string; token: string; minutesCharged: number }
    expect(body.connectId).toBe('vc_fixed')
    expect(body.minutesCharged).toBe(1)
    expect(body.url).toBe(LK.livekitUrl) // the client's @livekit/react-native Room connects to this URL

    // The token is a REAL LiveKit JWT (3 segments); decode its grant and prove the capability binding — a
    // fabricated string can't satisfy this. room=threadId, identity=userId, agent-dispatch on, connectId in metadata.
    const parts = body.token.split('.')
    expect(parts.length).toBe(3)
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      sub: string
      metadata: string
      video: { room: string; roomJoin: boolean; agent: boolean }
    }
    expect(claims.sub).toBe('A') // identity = the verified userId
    expect(claims.video.room).toBe('thread_A') // room = the owned threadId
    expect(claims.video.roomJoin).toBe(true)
    expect(claims.video.agent).toBe(true) // triggers LiveKit to dispatch the voice-bot Worker into the room
    expect(JSON.parse(claims.metadata).connectId).toBe('vc_fixed') // the F5 capability the voice-bot reads

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
    const { app, store } = build({ livekit: false })
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
