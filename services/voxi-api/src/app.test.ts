/**
 * In-process integration test for the BFF (no network). Drives the real Hono app via app.request().
 * Covers: auth gate (401), signed-URL hardening + cross-tenant denial, scan metering, session-ownership ACL,
 * idempotent podcast gate, account deletion cascade.
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { createApp, speechBucketText, buildItemContext, buildPodcastContext, type Deps, type RevealRecord, type RevealStore, type PodcastAssetStore, type PodcastAssetRecord } from './app'
import type { StreamEvent } from '../../../packages/shared/src/events'
import type { PodcastContext } from '../../../packages/shared/src/podcast'
import { testVerifier } from './auth'
import { authorizeRead } from './signing'
import { memoryStore } from './metering'
import { memoryEntitlementStore, type AppleJwsVerifier } from './appstore'
import { buildPgStores, type PgStores } from './pg-stores'
import { PGlite } from '@electric-sql/pglite'

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

  test('podcast retry: a failed/non-ready episode RE-ENQUEUES a render; a READY episode is a true replay', async () => {
    // The reported bug: "try again" after a failed render failed INSTANTLY — the idempotent gate returned a replay
    // token but the render was never re-enqueued, so the worker 404'd the poll. The fix re-enqueues any replay
    // whose durable episode is not ready.
    const records = new Map<string, PodcastAssetRecord>()
    const kk = (i: string, v: number, u: string) => `${u}:${i}:${v}`
    const podcasts: PodcastAssetStore = {
      async upsert(rec) { records.set(kk(rec.catalogItemId, rec.version, rec.userId), rec) },
      async getByToken() { return null },
      async getByItem(i, v, u) { return records.get(kk(i, v, u)) ?? null },
    }
    const enqueued: string[] = []
    const deps: Deps = {
      verifier: testVerifier,
      store: memoryStore({ A: { scan: 1, podcast: 5, voiceMin: 10 } }),
      eve: { async createSession({ userId }) { return { sessionId: `s_${userId}`, continuationToken: 'ct' } }, async *stream() { /* unused here */ } },
      deletion: { async cascade() { return { deleted: [] } } },
      bucket: 'voxi-photos',
      sessionOwner: new Map(),
      appStore: { verify: fakeApple, entitlements: memoryEntitlementStore() },
      podcasts,
      podcastEnqueue: async (a) => { enqueued.push(a.token) },
    }
    const app2 = createApp(deps)
    const gen = () => app2.request('/v1/podcast', { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ catalogItemId: 'c1', version: 1, subject: 'Thing' }) })

    const t1 = (await (await gen()).json()).token
    expect(enqueued).toEqual([t1]) // fresh gate → one render enqueued

    // The render is still composing / failed (the durable record isn't ready) → a retry MUST re-enqueue.
    const t2 = (await (await gen()).json()).token
    expect(t2).toBe(t1) // idempotent token (no double-charge)
    expect(enqueued).toEqual([t1, t1]) // …but the render WAS re-enqueued (the fix)

    // Once the episode is READY, a replay is a TRUE replay — never re-rendered.
    const rec = records.get(kk('c1', 1, 'A'))!
    records.set(kk('c1', 1, 'A'), { ...rec, status: 'ready', audioUrl: 'g/x.m4a' })
    await gen()
    expect(enqueued).toEqual([t1, t1]) // unchanged — a ready episode is not re-rendered
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
// speechBucketText + buildItemContext — the durable per-bucket text derivation (ANALYSIS-UX §5.C/§E). Owner-scoped;
// derives each bucket from the persisted reveal events so a revisited capture is speakable + groundable.
// ---------------------------------------------------------------------------
describe('durable per-bucket text (speechBucketText + buildItemContext folds sections)', () => {
  const reveal: RevealRecord = {
    threadId: 't1', ownerUserId: 'A', band: 'CONFIDENT', title: 'Canon AE-1', candidates: [],
    narration: 'A 35mm SLR.', createdAt: 0,
    events: [
      { type: 'confidence_band', index: 0, band: 'CONFIDENT', title: 'Canon AE-1', candidates: [] },
      { type: 'section', index: 1, bucket: 'purpose', text: 'For enthusiast photographers.', sourceUrl: '', sourceTitle: '', quote: '' },
      { type: 'section', index: 2, bucket: 'maker', text: '', sourceUrl: '', sourceTitle: '', quote: '' }, // empty-marker
      { type: 'section', index: 3, bucket: 'made', text: 'Produced from 1976 to 1984.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', sourceTitle: 'Canon AE-1', quote: 'produced from 1976 to 1984' },
      { type: 'fact', index: 4, text: 'It sold over a million units.', sourceUrl: 'https://ex/1', sourceTitle: 'ex', quote: 'over a million' },
      { type: 'done', index: 5, sessionId: 't1' },
    ],
  }
  test('speechBucketText resolves what/purpose/facts, and returns null for an empty-marker maker + a non-owner', () => {
    expect(speechBucketText(reveal, 'A', 'what')).toBe('A 35mm SLR.')
    expect(speechBucketText(reveal, 'A', 'purpose')).toBe('For enthusiast photographers.')
    expect(speechBucketText(reveal, 'A', 'facts')).toContain('a million units')
    expect(speechBucketText(reveal, 'A', 'maker')).toBeNull() // empty-marker section → nothing to voice
    expect(speechBucketText(reveal, 'B', 'what')).toBeNull() // non-owner
    expect(speechBucketText(null, 'A', 'what')).toBeNull()
  })
  test('buildItemContext folds the purpose + made sections (and omits an empty maker) into the grounded chat context', () => {
    const ctx = buildItemContext(reveal)
    expect(ctx).toContain("WHAT IT'S FOR: For enthusiast photographers.")
    expect(ctx).not.toContain('WHO MADE IT:') // empty-marker maker is not surfaced
    expect(ctx).toContain('WHEN MADE: Produced from 1976 to 1984.') // the grounded date reaches the voice conversation too
    expect(ctx).toContain('It sold over a million units.')
  })
  test('buildPodcastContext projects the made section as whenMade + its provenance (parallel to maker)', () => {
    const pc = buildPodcastContext(reveal, 'A')!
    expect(pc.whenMade).toBe('Produced from 1976 to 1984.')
    expect(pc.whenMadeSourceUrl).toBe('https://en.wikipedia.org/wiki/Canon_AE-1')
    // a reveal with no `made` section omits both fields (back-compat with old persisted reveals)
    const noMade: RevealRecord = { ...reveal, events: reveal.events.filter((e) => !(e.type === 'section' && e.bucket === 'made')) }
    expect(buildPodcastContext(noMade, 'A')!.whenMade).toBeUndefined()
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
  // ── /speech/:bucket — the per-bucket audio route (ANALYSIS-UX §5.C). The bucket is an enum ROUTE PARAM (never
  //    client text); `/speech` == `/speech/what` (back-compat). ──
  const postBucket = (app: ReturnType<typeof createApp>, bucket: string, u?: string) =>
    app.request(`/v1/threads/${SID}/speech/${bucket}`, { method: 'POST', headers: u ? auth(u) : {} })
  test('/speech/what is accepted (back-compat with the no-bucket route)', async () => {
    expect((await postBucket(buildSpeech().app, 'what', 'A')).status).toBe(200)
  })
  test('400 on an unknown bucket — the route never voices an unrecognized segment', async () => {
    const res = await postBucket(buildSpeech().app, 'wharrgarbl', 'A')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_bucket')
  })
  test('403 owner ACL applies to a bucket route too (no per-bucket leak)', async () => {
    expect((await postBucket(buildSpeech().app, 'facts', 'B')).status).toBe(403)
  })
  test('400 on /speech/made — `made` streams as a section but is deliberately NOT voiceable (not in AUDIO_BUCKETS)', async () => {
    const res = await postBucket(buildSpeech().app, 'made', 'A')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_bucket')
  })
})

// ---------------------------------------------------------------------------
// DELETE /v1/threads/:id + POST /v1/threads/:id/regenerate — the item lifecycle. Wired against REAL pg-stores (an
// in-memory PGlite) so the cascade + first-write-wins reveal semantics are exercised for real, with a controllable
// fake eve that (a) streams a CONFIDENT reveal so it PERSISTS, (b) counts stream() calls so we can prove regenerate
// RE-RUNS the cascade vs a revisit that REPLAYS, and (c) can be flipped to a pre-band hard_failure to prove the free
// re-run never CREDITS a scan. Corrections from the adversarial review are encoded as assertions: same-process
// non-owner is 403 (not 404); a failed free regenerate must not credit; regenerate re-pins fresh, observable content.
// ---------------------------------------------------------------------------
describe('BFF — delete + regenerate a cataloged item', () => {
  async function buildLifecycle() {
    const db = await PGlite.create() // ephemeral in-memory DB per test
    const durable: PgStores = await buildPgStores(db)
    let streamCalls = 0
    let titleN = 0
    let failMode = false
    const purged: string[] = []
    const primed: string[] = []
    const eve = {
      async createSession({ userId }: { userId: string }) { return { sessionId: `sess_${userId}_1`, continuationToken: 'ct' } },
      async *stream(sessionId: string): AsyncIterable<string> {
        streamCalls++
        if (failMode) {
          yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'boom' })
          yield JSON.stringify({ type: 'done', index: 1, sessionId })
          return
        }
        titleN++
        yield JSON.stringify({ type: 'token', index: 0, text: 'A bicycle.' })
        yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'CONFIDENT', title: `Cannondale v${titleN}`, candidates: [] })
        yield JSON.stringify({ type: 'done', index: 2, sessionId })
      },
      purgeSession(sid: string) { purged.push(sid) },
      primeSession(sid: string) { primed.push(sid) },
    }
    const deps: Deps = {
      verifier: testVerifier,
      store: durable.store,
      eve,
      deletion: { async cascade() { return { deleted: [] } } },
      bucket: 'voxi-photos',
      sessionOwner: new Map<string, string>(),
      threads: durable.threads,
      photos: durable.photos,
      reveals: durable.reveals,
      podcasts: durable.podcasts,
      messages: durable.messages,
      refunds: durable.refunds,
    }
    return {
      app: createApp(deps),
      durable,
      close: () => db.close(),
      streamCalls: () => streamCalls,
      setFail: (v: boolean) => { failMode = v },
      purged,
      primed,
    }
  }
  const create = async (app: ReturnType<typeof createApp>, u: string) => {
    const r = await app.request('/v1/threads', { method: 'POST', headers: { ...auth(u), 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: 'data:image/jpeg;base64,AAAA' }) })
    return (await r.json()).threadId as string
  }
  const drain = (app: ReturnType<typeof createApp>, id: string, u: string) => app.request(`/v1/threads/${id}/stream`, { headers: auth(u) }).then((r) => r.text())
  const scanRemaining = async (app: ReturnType<typeof createApp>, u: string) => (await (await app.request('/v1/me', { headers: auth(u) })).json()).remaining.scan as number

  test('delete: owner → 204 with item + children gone; non-owner same-process → 403; repeat delete → 404', async () => {
    const h = await buildLifecycle()
    const id = await create(h.app, 'A')
    await drain(h.app, id, 'A') // pins the durable reveal
    await h.app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: { ...auth('A'), 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', text: 'hi' }) })
    expect((await h.durable.messages.listByThread(id)).length).toBe(1)
    expect((await h.app.request(`/v1/threads/${id}`, { headers: auth('A') })).status).toBe(200)

    // Adversarial correction: a same-process non-owner is 403 (sessionOwner map knows A), NOT 404.
    expect((await h.app.request(`/v1/threads/${id}`, { method: 'DELETE', headers: auth('B') })).status).toBe(403)

    // Owner delete → 204, and every per-item trace is gone.
    expect((await h.app.request(`/v1/threads/${id}`, { method: 'DELETE', headers: auth('A') })).status).toBe(204)
    expect((await h.app.request(`/v1/threads/${id}`, { headers: auth('A') })).status).toBe(404) // detail gone
    const list = await (await h.app.request('/v1/threads', { headers: auth('A') })).json()
    expect(list.threads.find((t: { threadId: string }) => t.threadId === id)).toBeUndefined() // list excludes it
    expect(await h.durable.reveals.get(id)).toBeNull() // reveal cleared
    expect(await h.durable.photos.get(id)).toBeNull() // photo bytes gone
    expect((await h.durable.messages.listByThread(id)).length).toBe(0) // conversation gone
    expect(h.purged).toContain(id) // eve in-process photo + narration purged

    // Idempotent: deleting again is a 404 (thread row + ownership map entry are gone).
    expect((await h.app.request(`/v1/threads/${id}`, { method: 'DELETE', headers: auth('A') })).status).toBe(404)
    await h.close()
  })

  test('delete: an unknown id → 404 (never leaks / never-existed)', async () => {
    const h = await buildLifecycle()
    expect((await h.app.request('/v1/threads/sess_A_nope/', { method: 'DELETE', headers: auth('A') })).status).toBe(404)
    expect((await h.app.request('/v1/threads/sess_A_nope', { method: 'DELETE', headers: auth('A') })).status).toBe(404)
    await h.close()
  })

  test('regenerate: owner → 200 clears the reveal so the next /stream RE-RUNS (not replay) + re-pins fresh; non-owner → 403', async () => {
    const h = await buildLifecycle()
    const id = await create(h.app, 'A')
    await drain(h.app, id, 'A')
    expect(h.streamCalls()).toBe(1) // first drain ran the cascade + pinned "Cannondale v1"
    await drain(h.app, id, 'A')
    expect(h.streamCalls()).toBe(1) // a plain revisit REPLAYS the durable reveal — eve.stream NOT called again

    expect((await h.app.request(`/v1/threads/${id}/regenerate`, { method: 'POST', headers: auth('B') })).status).toBe(403) // non-owner
    expect((await h.app.request(`/v1/threads/${id}/regenerate`, { method: 'POST', headers: auth('A') })).status).toBe(200)
    expect(await h.durable.reveals.get(id)).toBeNull() // durable reveal cleared (first-write-wins unblocked)
    expect(h.primed).toContain(id) // photo re-seeded + narration pin cleared

    await drain(h.app, id, 'A')
    expect(h.streamCalls()).toBe(2) // the reveal was gone → eve.stream RE-RAN the live cascade (not a replay)
    const fresh = await h.durable.reveals.get(id)
    expect(fresh?.title).toBe('Cannondale v2') // a genuinely fresh reveal was re-pinned (observable delta)
    await h.close()
  })

  test('regenerate is FREE: the scan meter is not decremented (locks D5)', async () => {
    const h = await buildLifecycle()
    const id = await create(h.app, 'A')
    await drain(h.app, id, 'A')
    const before = await scanRemaining(h.app, 'A')
    expect((await h.app.request(`/v1/threads/${id}/regenerate`, { method: 'POST', headers: auth('A') })).status).toBe(200)
    expect(await scanRemaining(h.app, 'A')).toBe(before) // no charge
    await h.close()
  })

  test('regenerate that hard-fails does NOT credit a scan (refund latch pre-consumed — the free-money bug)', async () => {
    const h = await buildLifecycle()
    const id = await create(h.app, 'A')
    await drain(h.app, id, 'A') // original scan succeeded → its refund slot was never consumed
    const before = await scanRemaining(h.app, 'A')
    await h.app.request(`/v1/threads/${id}/regenerate`, { method: 'POST', headers: auth('A') }) // latches the refund guard
    h.setFail(true) // the re-run will emit a pre-band hard_failure
    await drain(h.app, id, 'A') // the /stream refund tap would credit +1 here WITHOUT the latch
    expect(await scanRemaining(h.app, 'A')).toBe(before) // meter unchanged — neither charged nor spuriously credited
    await h.close()
  })
})

// The Deep Dive is built from the SERVER-OWNED reveal — the subject is the reveal's title (never the client's) and
// the identity + what/purpose/maker + grounded facts are threaded to the worker. Owner-scoped defence in depth.
describe('BFF /v1/podcast — reveal CONTEXT threading (DEEPDIVE context completeness)', () => {
  const revealA: RevealRecord = {
    threadId: 'c1', ownerUserId: 'A', band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: [],
    events: [
      { type: 'fact', index: 2, text: 'Launched in 1976.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', sourceTitle: 'Canon AE-1', quote: 'launched in 1976' } as StreamEvent,
      { type: 'section', index: 4, bucket: 'purpose', text: 'For making photographs on 35mm film.', sourceUrl: '', sourceTitle: '', quote: '' } as StreamEvent,
      { type: 'section', index: 5, bucket: 'maker', text: 'Made by Canon of Japan.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_Inc', sourceTitle: 'Canon', quote: 'Canon' } as StreamEvent,
    ],
    narration: 'A 35mm SLR that put automation in reach.', createdAt: 0,
  }
  const revealStore = (rec: RevealRecord | null): RevealStore => ({ async put() { return { inserted: true } }, async get(id) { return rec && rec.threadId === id ? rec : null } })

  function podcastDeps(reveals: RevealStore | undefined, threads?: Deps['threads']) {
    const enqueued: Array<{ subject: string; context?: PodcastContext }> = []
    const deps: Deps = {
      verifier: testVerifier,
      store: memoryStore({ A: { scan: 1, podcast: 5, voiceMin: 10 }, B: { scan: 1, podcast: 5, voiceMin: 10 } }),
      eve: { async createSession({ userId }) { return { sessionId: `s_${userId}`, continuationToken: 'ct' } }, async *stream() {} },
      deletion: { async cascade() { return { deleted: [] } } },
      bucket: 'voxi-photos', sessionOwner: new Map(),
      reveals, threads,
      podcastEnqueue: async (a) => { enqueued.push({ subject: a.subject, context: a.context }) },
    }
    return { app: createApp(deps), enqueued }
  }
  const gen = (app: ReturnType<typeof createApp>, u: string, body: Record<string, unknown>) =>
    app.request('/v1/podcast', { method: 'POST', headers: { ...auth(u), 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('buildPodcastContext (pure): projects identity + sourced/sourceless sections + priorFacts; owner-scoped', () => {
    const ctx = buildPodcastContext(revealA, 'A')!
    expect(ctx.subject).toBe('1976 Canon AE-1')
    expect(ctx.band).toBe('CONFIDENT')
    expect(ctx.whatItIs).toContain('automation')
    expect(ctx.maker).toBe('Made by Canon of Japan.')
    expect(ctx.makerSourceUrl).toBe('https://en.wikipedia.org/wiki/Canon_Inc') // sourced → carried
    expect(ctx.purpose).toBe('For making photographs on 35mm film.')
    expect(ctx.purposeSourceUrl).toBeUndefined() // sourceless section carries no url (never a citeable ref)
    expect(ctx.priorFacts?.[0]?.text).toBe('Launched in 1976.')
    expect(buildPodcastContext(revealA, 'B')).toBeNull() // owner mismatch → null
    expect(buildPodcastContext(null, 'A')).toBeNull()
  })

  test('the owner: enqueued subject is the reveal TITLE (client subject ignored) and context is threaded', async () => {
    const { app, enqueued } = podcastDeps(revealStore(revealA))
    const res = await gen(app, 'A', { catalogItemId: 'c1', version: 1, subject: 'CLIENT-SUPPLIED-WRONG' })
    expect(res.status).toBe(200)
    expect(enqueued).toHaveLength(1)
    const e = enqueued[0]!
    expect(e.subject).toBe('1976 Canon AE-1') // server-owned, NOT the client string
    expect(e.context?.subject).toBe('1976 Canon AE-1')
    expect(e.context?.priorFacts?.[0]?.text).toBe('Launched in 1976.')
    expect(e.context?.makerSourceUrl).toBe('https://en.wikipedia.org/wiki/Canon_Inc')
  })

  test('P6 owner-guard: reveals wired but NO threads store — caller B cannot pull A\'s reveal into an episode', async () => {
    // B posts A's threadId as catalogItemId; with no threads store the asThread ownership check is a no-op, so the
    // buildPodcastContext owner guard is the one that must refuse. B gets NO context and falls back to the client subject.
    const { app, enqueued } = podcastDeps(revealStore(revealA))
    const res = await gen(app, 'B', { catalogItemId: 'c1', version: 1, subject: 'B-CLIENT' })
    expect(res.status).toBe(200)
    expect(enqueued[0]!.context).toBeUndefined() // A's reveal NOT leaked into B's episode
    expect(enqueued[0]!.subject).toBe('B-CLIENT') // graceful fallback
  })

  test('fallback: no durable reveal → client subject, no context (older / global-catalog items)', async () => {
    const { app, enqueued } = podcastDeps(revealStore(null))
    const res = await gen(app, 'A', { catalogItemId: 'global-xyz', version: 1, subject: 'Some Object' })
    expect(res.status).toBe(200)
    expect(enqueued[0]!.subject).toBe('Some Object')
    expect(enqueued[0]!.context).toBeUndefined()
  })
})
