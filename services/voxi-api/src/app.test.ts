/**
 * In-process integration test for the BFF (no network). Drives the real Hono app via app.request().
 * Covers: auth gate (401), signed-URL hardening + cross-tenant denial, scan metering, session-ownership ACL,
 * idempotent podcast gate, account deletion cascade.
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { createApp, type Deps } from './app'
import { testVerifier } from './auth'
import { authorizeRead } from './signing'
import { memoryStore } from './metering'
import { memoryEntitlementStore, type AppleJwsVerifier } from './appstore'

process.env.VOXI_TEST_MODE = '1'

// A fake Apple JWS verifier for the BFF route tests: the "jws" is its JSON payload (the real one verifies x5c).
const fakeApple: AppleJwsVerifier = async (jws) => {
  try {
    return JSON.parse(jws)
  } catch {
    return null
  }
}

function build(): { app: ReturnType<typeof createApp>; deps: Deps } {
  const deps: Deps = {
    verifier: testVerifier,
    store: memoryStore({ A: { scan: 1, podcast: 1, voiceMin: 10 }, B: { scan: 5, podcast: 0, voiceMin: 0 } }),
    eve: {
      async createSession({ userId }) {
        return { sessionId: `sess_${userId}_1`, continuationToken: 'ct' }
      },
      async *stream(sessionId) {
        yield JSON.stringify({ type: 'token', text: 'A 2008 Cannondale…' })
        yield JSON.stringify({ type: 'done', sessionId })
      },
    },
    deletion: { async cascade(userId) { return { deleted: [`photos:${userId}`, `embeddings:${userId}`, `sessions:${userId}`] } } },
    bucket: 'voxi-photos',
    sessionOwner: new Map(),
    appStore: { verify: fakeApple, entitlements: memoryEntitlementStore() },
  }
  return { app: createApp(deps), deps }
}

const auth = (u: string) => ({ authorization: `Bearer test:${u}` })

describe('BFF', () => {
  let app: ReturnType<typeof createApp>
  beforeEach(() => {
    app = build().app
  })

  test('rejects requests with no/invalid token (401)', async () => {
    expect((await app.request('/v1/uploads/sign', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/v1/uploads/sign', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401)
  })

  test('signs a short-TTL, user-bound, non-enumerable URL; cross-tenant read denied', async () => {
    const res = await app.request('/v1/uploads/sign', { method: 'POST', headers: auth('A') })
    expect(res.status).toBe(200)
    const { url, objectKey, expiresAt } = await res.json()
    expect(objectKey).toMatch(/^u\/A\/[0-9a-f-]{36}$/) // per-user prefix + UUID (non-enumerable)
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(120_000)
    expect(authorizeRead(url, 'A').ok).toBe(true)
    expect(authorizeRead(url, 'B').reason).toBe('cross_tenant_denied') // user B cannot read A's private object
    expect(authorizeRead(url, 'A', expiresAt + 1).reason).toBe('expired')
  })

  test('thread create charges a scan and enforces the free cap', async () => {
    const ok = await app.request('/v1/threads', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: 'x' }) })
    expect(ok.status).toBe(200)
    const capped = await app.request('/v1/threads', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: 'x' }) })
    expect(capped.status).toBe(402) // scan cap reached
  })

  test('session-ownership ACL: user B cannot stream user A\'s thread', async () => {
    const created = await app.request('/v1/threads', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: 'x' }) })
    const { threadId } = await created.json()
    const asA = await app.request(`/v1/threads/${threadId}/stream`, { headers: auth('A') })
    expect(asA.status).toBe(200)
    const asB = await app.request(`/v1/threads/${threadId}/stream`, { headers: auth('B') })
    expect(asB.status).toBe(403)
  })

  test('podcast gate: 200+token, idempotent replay, then 402 when out of entitlement', async () => {
    const first = await app.request('/v1/podcast', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ catalogItemId: 'c1', version: 1 }) })
    expect(first.status).toBe(200)
    const t1 = (await first.json()).token
    const replay = await app.request('/v1/podcast', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ catalogItemId: 'c1', version: 1 }) })
    expect((await replay.json()).token).toBe(t1) // idempotent
    // B has 0 podcast entitlement
    const denied = await app.request('/v1/podcast', { method: 'POST', headers: { ...auth('B'), 'content-type': 'application/json' }, body: JSON.stringify({ catalogItemId: 'c9', version: 1 }) })
    expect(denied.status).toBe(402)
  })

  test('account deletion cascades', async () => {
    const res = await app.request('/v1/account', { method: 'DELETE', headers: auth('A') })
    const { deleted } = await res.json()
    expect(deleted).toContain('embeddings:A')
    expect(deleted).toContain('sessions:A')
  })

  // ---- Direct StoreKit 2 subscriptions (no RevenueCat) ----
  const jwsTx = (o: Record<string, unknown>) => JSON.stringify(o)

  test('POST /v1/purchases/verify verifies a signed transaction and /v1/me reflects the server-verified plan', async () => {
    const tx = jwsTx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't1', appAccountToken: 'A', expiresDate: 9_999_999_999_999 })
    const res = await app.request('/v1/purchases/verify', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: tx }) })
    expect(res.status).toBe(200)
    expect((await res.json()).plan).toBe('voyager')
    // /v1/me is authoritative and now reflects the verified plan.
    const me = await (await app.request('/v1/me', { headers: auth('A') })).json()
    expect(me.plan).toBe('voyager')
  })

  test('purchase verify requires auth and rejects a transaction stamped for ANOTHER user (anti-replay)', async () => {
    expect((await app.request('/v1/purchases/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    const foreign = jwsTx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't1', appAccountToken: 'B' })
    const res = await app.request('/v1/purchases/verify', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: foreign }) })
    expect(res.status).toBe(400) // A cannot claim B's transaction
    expect((await (await app.request('/v1/me', { headers: auth('A') })).json()).plan).toBe('free')
  })

  test('App Store notification webhook needs NO Clerk auth (Apple-signed) and a REFUND downgrades to free', async () => {
    // First grant voyager to A.
    await app.request('/v1/purchases/verify', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: jwsTx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't1', appAccountToken: 'A', expiresDate: 9_999_999_999_999 }) }) })
    expect((await (await app.request('/v1/me', { headers: auth('A') })).json()).plan).toBe('voyager')
    // Apple posts a REFUND — no Authorization header at all.
    const signedPayload = jwsTx({ notificationType: 'REFUND', data: { signedTransactionInfo: jwsTx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't1', appAccountToken: 'A' }) } })
    const wh = await app.request('/appstore/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedPayload }) })
    expect(wh.status).toBe(200)
    expect((await (await app.request('/v1/me', { headers: auth('A') })).json()).plan).toBe('free') // downgraded
  })

  test('a webhook with an invalid signature is rejected 400 (fail-closed, no entitlement change)', async () => {
    const res = await app.request('/appstore/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedPayload: 'not-a-valid-jws' }) })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/threads/:id/speech — the spoken reveal (ANALYSIS-VOICE-PLAN B).
// The narration text is SERVER-OWNED (read from eve.narrationText), never client-supplied. Fail-closed order:
// auth → ownership ACL → speech configured? → server-owned narration present? → cache-or-synth → audio/mpeg.
// ---------------------------------------------------------------------------
describe('BFF — spoken reveal /v1/threads/:id/speech', () => {
  const SID = 'sess_A_1'
  function buildSpeech(opts?: { withSpeech?: boolean; narration?: string | null }) {
    const narrations = new Map<string, string>()
    if (opts?.narration !== null) narrations.set(SID, opts?.narration ?? 'A 1976 Canon AE-1, a 35mm SLR.')
    let synthCalls = 0
    const store = new Map<string, Uint8Array<ArrayBuffer>>()
    const cache = {
      async get(k: string) { return store.get(k) ?? null },
      async put(k: string, b: Uint8Array<ArrayBuffer>) { store.set(k, b) },
    }
    const tts = {
      async synthesize(_t: string) { synthCalls++; return new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]) as Uint8Array<ArrayBuffer> },
    }
    const deps: Deps = {
      verifier: testVerifier,
      store: memoryStore({ A: { scan: 5, podcast: 0, voiceMin: 0 }, B: { scan: 5, podcast: 0, voiceMin: 0 } }),
      eve: {
        async createSession({ userId }) { return { sessionId: `sess_${userId}_1`, continuationToken: 'ct' } },
        async *stream(s) { yield JSON.stringify({ type: 'done', sessionId: s }) },
        async narrationText(sessionId, userId) {
          if (!sessionId.startsWith(`sess_${userId}_`)) return null
          return narrations.get(sessionId) ?? null
        },
      },
      deletion: { async cascade() { return { deleted: [] } } },
      bucket: 'voxi-photos',
      sessionOwner: new Map<string, string>([[SID, 'A']]),
      ...(opts?.withSpeech === false ? {} : { speech: { tts, cache } }),
    }
    return { app: createApp(deps), synth: () => synthCalls }
  }
  const post = (app: ReturnType<typeof createApp>, u?: string) =>
    app.request(`/v1/threads/${SID}/speech`, { method: 'POST', headers: u ? auth(u) : {} })

  test('401 without a valid principal', async () => {
    expect((await post(buildSpeech().app)).status).toBe(401)
  })
  test('403 when the caller does not own the thread (no audio leaks)', async () => {
    expect((await post(buildSpeech().app, 'B')).status).toBe(403)
  })
  test('503 (loud) when speech is unconfigured — never a fake success', async () => {
    const res = await post(buildSpeech({ withSpeech: false }).app, 'A')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('speech_unconfigured')
  })
  test('404 when no server-owned narration was captured for the session', async () => {
    const res = await post(buildSpeech({ narration: null }).app, 'A')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('no_narration')
  })
  test('happy path: returns real audio/mpeg bytes from the TTS provider', async () => {
    const res = await post(buildSpeech().app, 'A')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })
  test('cache: two plays of the SAME narration synthesize exactly ONCE (bounds paid-vendor cost, A10)', async () => {
    const { app, synth } = buildSpeech()
    expect((await post(app, 'A')).status).toBe(200)
    expect((await post(app, 'A')).status).toBe(200)
    expect(synth()).toBe(1) // second play served from the content-hash cache — no second vendor call
  })
})
