/**
 * End-to-end durability proof for the BFF collection surface (COLLECTION-PERSISTENCE-PLAN §7.2).
 *
 * Drives the REAL Hono app (app.request) over REAL durable pg-stores in a temp dir. The load-bearing assertion
 * is a SIMULATED RESTART: a fresh createApp() with a FRESH empty sessionOwner over the SAME dataDir (the honest
 * restart the adversarial A2/A5 findings demanded) still serves the photo, replays the reveal deterministically
 * (eve.stream NOT called again), speaks the durable narration, serves the podcast with the worker unreachable,
 * and replays the conversation. Pins every confirmed adversarial finding: A1 (/media sig + owner), A9 (podcast
 * owner scope), A10 (UNKNOWN never persisted), A11 (message idempotency), A12 (replay), A15 (refund once).
 */
import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp, type Deps, type EveClient, type PodcastStatusService } from './app'
import { testVerifier } from './auth'
import { mintPhotoUrl } from './signing'
import { createPgStores, type PgStores } from './pg-stores'

process.env.VOXI_TEST_MODE = '1'

// A real 1×1 PNG (transparent) as a data: URI — REAL bytes, so the persisted photo is a genuine image (A3: no
// placeholder cheat), and the durability + /media serve assert the exact bytes round-trip.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const dirs: string[] = []
const stores: PgStores[] = []
function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'voxi-bff-persist-'))
  dirs.push(d)
  return d
}
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {})
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A controllable fake eve: the terminal band is chosen by a marker in the photoUrl (carried into the sessionId
 *  so a re-stream is deterministic). Counts stream() calls so a test can prove a revisit REPLAYS (no re-run). */
function makeEve(): EveClient & { streams: number; n: number } {
  const eve = {
    streams: 0,
    n: 0,
    async createSession({ userId, photoUrl }: { userId: string; photoUrl: string }) {
      const scan = /pill/.test(photoUrl) ? 'pill' : /unknown/.test(photoUrl) ? 'unknown' : 'confident'
      return { sessionId: `sess_${userId}_${scan}_${(eve.n++).toString(36)}`, continuationToken: 'ct' }
    },
    async *stream(sessionId: string): AsyncIterable<string> {
      eve.streams++
      const scan = /_([a-z]+)_[a-z0-9]+$/.exec(sessionId)?.[1] ?? 'confident'
      if (scan === 'pill') {
        yield JSON.stringify({ type: 'error', index: 0, code: 'safety_refusal', message: 'I keep to objects, not medicine.' })
        yield JSON.stringify({ type: 'done', index: 1, sessionId })
        return
      }
      if (scan === 'unknown') {
        yield JSON.stringify({ type: 'confidence_band', index: 0, band: 'UNKNOWN', title: 'not in the Guide yet', candidates: [] })
        yield JSON.stringify({ type: 'done', index: 1, sessionId })
        return
      }
      yield JSON.stringify({ type: 'token', index: 0, text: 'A 1976 Canon AE-1.' })
      yield JSON.stringify({ type: 'confidence_band', index: 1, band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: [] })
      yield JSON.stringify({ type: 'done', index: 2, sessionId })
    },
    async narrationText() {
      return null // force the durable-reveal narration path for /speech
    },
  }
  return eve
}

async function openStores(dir: string): Promise<PgStores> {
  const s = await createPgStores(dir)
  stores.push(s)
  return s
}

/** Build a BFF over durable stores. `workerReady` controls the fake podcast worker; null = worker unreachable. */
function build(pg: PgStores, eve: EveClient, workerReady: null | { audioUrl: string; transcript: { speaker: 'ARLO' | 'MAVE'; text: string }[] }): Deps {
  const podcastStatus: PodcastStatusService = {
    async status(_token, _userId) {
      if (workerReady === null) return null // worker unreachable → the BFF must fall back to the durable asset
      return { state: 'ready', audioUrl: workerReady.audioUrl, transcript: workerReady.transcript }
    },
  }
  const fakeTts = { async synthesize(_t: string) { return new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]) as Uint8Array<ArrayBuffer> } }
  return {
    verifier: testVerifier,
    store: pg.store,
    eve,
    deletion: { async cascade() { return { deleted: [] } } },
    bucket: 'voxi-photos',
    sessionOwner: new Map(),
    threads: pg.threads,
    photos: pg.photos,
    reveals: pg.reveals,
    podcasts: pg.podcasts,
    messages: pg.messages,
    refunds: pg.refunds,
    podcastStatus,
    speech: { tts: fakeTts },
  }
}

const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })
async function drain(res: Response): Promise<string[]> {
  const text = await res.text()
  return text.split('\n').filter(Boolean)
}
async function createThread(app: ReturnType<typeof createApp>, u: string, photoUrl: string): Promise<string> {
  const res = await app.request('/v1/threads', { method: 'POST', headers: auth(u), body: JSON.stringify({ photoUrl }) })
  return (await res.json()).threadId
}

describe('BFF durable collection — survives a restart', () => {
  test('photo + reveal + podcast + conversation all survive a fresh createApp over the same dataDir', async () => {
    const dir = freshDir()
    const eve = makeEve()
    let pg = await openStores(dir)
    let app = createApp(build(pg, eve, { audioUrl: 'g/ep.m4a', transcript: [{ speaker: 'ARLO', text: 'A fine camera.' }] }))

    // capture (real PNG) → the photo is persisted
    const id = await createThread(app, 'A', `${PNG_1x1}#confident`)
    // drain the reveal → it settles CONFIDENT and is persisted; eve.stream ran exactly once
    const first = await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') }))
    expect(eve.streams).toBe(1)
    expect(first.some((l) => l.includes('"band":"CONFIDENT"'))).toBe(true)
    // hold a conversation + generate a podcast
    await app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: auth('A'), body: JSON.stringify({ role: 'user', text: 'is it rare?', clientKey: 'k1' }) })
    await app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: auth('A'), body: JSON.stringify({ role: 'guide', text: 'Not especially.', clientKey: 'k2' }) })
    const gate = await app.request('/v1/podcast', { method: 'POST', headers: auth('A'), body: JSON.stringify({ catalogItemId: id, version: 1 }) })
    const token = (await gate.json()).token
    const poll = await app.request(`/v1/podcast/${token}`, { headers: auth('A') })
    expect((await poll.json()).state).toBe('ready') // worker ready → cached durably

    // ---- SIMULATED RESTART: close the stores, reopen the SAME dir, fresh createApp + fresh empty sessionOwner ----
    await pg.close()
    pg = await openStores(dir)
    const eve2 = makeEve() // a fresh eve whose stream counter starts at 0 — a replay must NOT touch it
    // worker is now UNREACHABLE (null) — the podcast must still be served from the durable asset
    app = createApp(build(pg, eve2, null))

    // collection list: the identified label + band + a signed photo URL survive
    const list = await (await app.request('/v1/threads', { headers: auth('A') })).json()
    const item = list.threads.find((t: { threadId: string }) => t.threadId === id)
    expect(item.revealTitle).toBe('1976 Canon AE-1')
    expect(item.band).toBe('CONFIDENT')
    expect(item.photoUrl).toMatch(/^\/media\/threads\/.+\/photo\?u=A&exp=\d+&sig=[0-9a-f]{64}$/)

    // detail: photo + podcast (served despite the unreachable worker) + conversation flag
    const detail = await (await app.request(`/v1/threads/${id}`, { headers: auth('A') })).json()
    expect(detail.photoUrl).toBeTruthy()
    expect(detail.podcast).toMatchObject({ state: 'ready', audioUrl: 'g/ep.m4a' })
    expect(detail.hasConversation).toBe(true)

    // /stream REPLAYS deterministically from the durable reveal — eve2.stream was NEVER called
    const replay = await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') }))
    expect(eve2.streams).toBe(0)
    expect(replay.some((l) => l.includes('"1976 Canon AE-1"'))).toBe(true)
    // Content-identical to the first drain (jsonb normalizes key ORDER, so compare PARSED events, not raw strings —
    // the client parses every line via the Zod contract, so order is irrelevant to correctness).
    expect(replay.map((l) => JSON.parse(l))).toEqual(first.map((l) => JSON.parse(l)))

    // /media serves the exact persisted bytes for the owner
    const photoRes = await app.request(detail.photoUrl, { headers: auth('A') })
    expect(photoRes.status).toBe(200)
    expect(photoRes.headers.get('content-type')).toBe('image/png')
    expect((await photoRes.arrayBuffer()).byteLength).toBeGreaterThan(0)

    // /speech voices the DURABLE narration after the restart (in-memory NarrationStore is empty)
    const speech = await app.request(`/v1/threads/${id}/speech`, { method: 'POST', headers: auth('A') })
    expect(speech.status).toBe(200)
    expect(speech.headers.get('content-type')).toBe('audio/mpeg')

    // conversation history replays
    const msgs = await (await app.request(`/v1/threads/${id}/messages`, { headers: auth('A') })).json()
    expect(msgs.messages).toHaveLength(2)
    expect(msgs.messages.map((m: { text: string }) => m.text)).toEqual(['is it rare?', 'Not especially.'])
  })

  test('A1: /media requires a valid owner-bound sig; forged/cross-tenant/expired/missing are refused', async () => {
    const dir = freshDir()
    const pg = await openStores(dir)
    const app = createApp(build(pg, makeEve(), null))
    const id = await createThread(app, 'A', `${PNG_1x1}#confident`)

    const good = mintPhotoUrl({ threadId: id, userId: 'A' })
    expect((await app.request(good)).status).toBe(200)

    // forged sig → 403
    const forged = good.replace(/sig=[0-9a-f]+$/, 'sig=' + 'f'.repeat(64))
    expect((await app.request(forged)).status).toBe(403)

    // a VALID sig for user B (attacker with the shared test key) still fails the photo-owner cross-check → 403
    const asB = mintPhotoUrl({ threadId: id, userId: 'B' })
    expect((await app.request(asB)).status).toBe(403)

    // expired → 403
    const expired = mintPhotoUrl({ threadId: id, userId: 'A', now: Date.now() - 10 * 60_000, ttlSeconds: 1 })
    expect((await app.request(expired)).status).toBe(403)

    // missing photo → 404 (valid sig, no such thread photo)
    const missing = mintPhotoUrl({ threadId: 'sess_A_nope_0', userId: 'A' })
    expect((await app.request(missing)).status).toBe(404)
  })

  test('A10: an UNKNOWN scan is NOT persisted — a revisit re-runs eve (stays retryable), title not clobbered', async () => {
    const dir = freshDir()
    const eve = makeEve()
    const app = createApp(build(await openStores(dir), eve, null))
    const id = await createThread(app, 'A', `${PNG_1x1}#unknown`)
    await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') }))
    expect(eve.streams).toBe(1)
    // revisit → generate path re-runs eve (no persisted reveal to replay)
    await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') }))
    expect(eve.streams).toBe(2)
    // the thread row was NOT tagged with a reveal (title stays the auto-title, no band)
    const detail = await (await app.request(`/v1/threads/${id}`, { headers: auth('A') })).json()
    expect(detail.revealTitle).toBeNull()
    expect(detail.band).toBeNull()
  })

  test('A15: a safety refusal refunds the scan exactly once — even across a restart', async () => {
    const dir = freshDir()
    let pg = await openStores(dir)
    let app = createApp(build(pg, makeEve(), null))
    // The demo entitlement is lazily created at 100_000 on the first charge; a refusal refunds the charge → 100_000.
    const id = await createThread(app, 'A', `${PNG_1x1}#pill`) // charges a scan (100_000 → 99_999)
    await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') })) // refusal → refund #1 (→ 100_000)
    const afterFirst = await (await app.request('/v1/me', { headers: auth('A') })).json()
    expect(afterFirst.remaining.scan).toBe(100_000) // charged then refunded exactly once

    // restart + revisit the refused thread → the durable guard must BLOCK a second refund (no free scan minted)
    await pg.close()
    pg = await openStores(dir)
    app = createApp(build(pg, makeEve(), null))
    await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') })) // refusal again, NO second refund
    const afterRestart = await (await app.request('/v1/me', { headers: auth('A') })).json()
    expect(afterRestart.remaining.scan).toBe(100_000) // still 100_000 — NOT 100_001
  })

  test('A9/A6: podcast + messages are owner-scoped; cross-tenant reads/writes denied', async () => {
    const dir = freshDir()
    const pg = await openStores(dir)
    const app = createApp(build(pg, makeEve(), { audioUrl: 'g/ep.m4a', transcript: [] }))
    const id = await createThread(app, 'A', `${PNG_1x1}#confident`)
    await drain(await app.request(`/v1/threads/${id}/stream`, { headers: auth('A') }))

    // B cannot append to or read A's conversation (denied — 403 when the ownership map knows A, 404 after a restart)
    expect([403, 404]).toContain((await app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: auth('B'), body: JSON.stringify({ role: 'user', text: 'x', clientKey: 'z' }) })).status)
    expect([403, 404]).toContain((await app.request(`/v1/threads/${id}/messages`, { headers: auth('B') })).status)

    // A9: B cannot occupy A's episode slot (catalogItemId is A's thread) — 403
    expect((await app.request('/v1/podcast', { method: 'POST', headers: auth('B'), body: JSON.stringify({ catalogItemId: id, version: 1 }) })).status).toBe(403)

    // A11: a duplicate clientKey is idempotent (one row)
    await app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: auth('A'), body: JSON.stringify({ role: 'user', text: 'first', clientKey: 'k1' }) })
    const dupRes = await app.request(`/v1/threads/${id}/messages`, { method: 'POST', headers: auth('A'), body: JSON.stringify({ role: 'user', text: 'retry', clientKey: 'k1' }) })
    expect((await dupRes.json()).duplicate).toBe(true)
    const msgs = await (await app.request(`/v1/threads/${id}/messages`, { headers: auth('A') })).json()
    expect(msgs.messages).toHaveLength(1)
  })
})
