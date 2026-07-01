/**
 * Regression suite for the pre-restart revisit bug (the tmux `/stream → 403`) and its full durable-revisit fix.
 *
 * FAITHFULNESS (adversarial A3): the fake eve models a REAL restart — a session's in-memory photo is evicted, so
 * a live re-stream would yield the `hard_failure` "session expired". A test that only clears the ownership map
 * would pass for the wrong reason (the fake would still re-derive a reveal) and hide the real defect. Here the
 * DURABLE stores (threads, reveals, refunds) survive the "restart" while the in-memory session state does not —
 * exactly the split between `services/voxi-api/src/server.ts`'s PGlite stores and CascadeEveClient's Maps.
 */
import { test, expect, describe } from 'bun:test'
import {
  createApp,
  type Deps,
  type EveClient,
  type ThreadStore,
  type ThreadRecord,
  type RevealStore,
  type RevealRecord,
  type RefundStore,
} from './app'
import { testVerifier } from './auth'
import { memoryStore, type Store } from './metering'

process.env.VOXI_TEST_MODE = '1'
const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })
const read = (r: Response) => r.text().then((t) => t.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))

/** A fake eve that keeps per-session photos in-memory (like CascadeEveClient) and models their loss on restart. */
function fakeEve() {
  const photos = new Map<string, string>()
  let n = 0
  const eve: EveClient & { evictPhoto: (id: string) => void } = {
    async createSession({ userId, photoUrl }) {
      const sessionId = `sess_${userId}_${(n++).toString(36)}`
      photos.set(sessionId, photoUrl)
      return { sessionId, continuationToken: 'ct' }
    },
    async *stream(sessionId, _userId, startIndex = 0) {
      const photo = photos.get(sessionId)
      if (!photo) {
        // live session/photo gone (a restart evicted it) — the designed graceful degradation, NOT a 403.
        yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'session expired — capture again' })
        yield JSON.stringify({ type: 'done', index: 1, sessionId })
        return
      }
      const events =
        photo === 'fail'
          ? [
              { type: 'error', index: 0, code: 'hard_failure', message: 'the Guide lost the thread' },
              { type: 'done', index: 1, sessionId },
            ]
          : [
              { type: 'token', index: 0, text: 'A 2008 Cannondale SuperSix EVO.' },
              { type: 'confidence_band', index: 1, band: 'CONFIDENT', title: '2008 Cannondale SuperSix EVO', candidates: [] },
              { type: 'done', index: 2, sessionId },
            ]
      for (const ev of events) {
        if (ev.index < startIndex) continue
        yield JSON.stringify(ev)
      }
    },
    async narrationText() {
      return null // in-memory narration is gone after a restart → forces the durable-reveal fallback in /speech
    },
    evictPhoto(id) {
      photos.delete(id)
    },
  }
  return eve
}

function memThreads(): ThreadStore {
  const rows = new Map<string, ThreadRecord>()
  return {
    async put(r) {
      rows.set(r.threadId, r)
    },
    async listByOwner(u) {
      return [...rows.values()].filter((r) => r.ownerUserId === u)
    },
    async get(id) {
      return rows.get(id) ?? null
    },
    async applyReveal(id, r) {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, revealTitle: r.revealTitle, band: r.band })
    },
  }
}
function memReveals(): RevealStore {
  const m = new Map<string, RevealRecord>()
  return {
    async put(rec) {
      if (m.has(rec.threadId)) return { inserted: false } // first-write-wins (pinned)
      m.set(rec.threadId, rec)
      return { inserted: true }
    },
    async get(id) {
      return m.get(id) ?? null
    },
  }
}
function memRefunds(): RefundStore {
  const s = new Set<string>()
  return {
    async markRefunded(id) {
      if (s.has(id)) return false
      s.add(id)
      return true
    },
  }
}

/** Build the BFF with DURABLE stores + a photo-losing eve. `restart()` drops only the in-memory session state. */
function build(seed?: Record<string, { scan: number; podcast: number; voiceMin: number }>) {
  const store = memoryStore(seed ?? { A: { scan: 5, podcast: 1, voiceMin: 10 }, B: { scan: 5, podcast: 1, voiceMin: 10 } })
  const eve = fakeEve()
  const sessionOwner = new Map<string, string>()
  const deps: Deps = {
    verifier: testVerifier,
    store,
    eve,
    deletion: { async cascade() { return { deleted: [] } } },
    bucket: 'voxi-photos',
    sessionOwner,
    threads: memThreads(),
    reveals: memReveals(),
    refunds: memRefunds(),
    interviews: {
      async create({ userId, threadId, visibility }) {
        return { interviewId: `iv_${userId}_${threadId}`, visibility, questions: [{ id: 'q1', prompt: 'what is it?', whyAsked: 'first witness' }] }
      },
      async answer() {
        return { done: false }
      },
    },
    speech: { tts: { async synthesize() { return new Uint8Array([0xff, 0xfb, 0x90, 0x00]) as Uint8Array<ArrayBuffer> } } },
  }
  const app = createApp(deps)
  // Simulate a process restart: the in-memory ownership map + the eve's photo cache are gone; DURABLE rows remain.
  const restart = (threadId: string) => {
    sessionOwner.clear()
    eve.evictPhoto(threadId)
  }
  return { app, deps, store, restart }
}

async function createThread(app: ReturnType<typeof createApp>, u: string, photoUrl = 'confident'): Promise<string> {
  const r = await app.request('/v1/threads', { method: 'POST', headers: auth(u), body: JSON.stringify({ photoUrl }) })
  expect(r.status).toBe(200)
  return (await r.json()).threadId
}

describe('durable revisit — the pre-restart /stream 403 fix', () => {
  test('CORE: revisiting after a restart replays the reveal instead of a 403 or a hard_failure loop', async () => {
    const { app, restart } = build()
    const id = await createThread(app, 'A')

    // First (live) drain settles CONFIDENT and pins the reveal to the durable store.
    const live = await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') })
    expect(live.status).toBe(200)
    const liveEvents = await read(live)
    expect(liveEvents.find((e) => e.type === 'confidence_band')?.band).toBe('CONFIDENT')

    // A restart evicts the in-memory session/photo. The OLD strict ACL returned 403 here; the durable-owner ACL
    // must let the owner through, and the persisted reveal must REPLAY (not the eve's "session expired" hard_fail).
    restart(id)
    const revisit = await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') })
    expect(revisit.status).toBe(200) // NOT 403 — the bug
    const events = await read(revisit)
    expect(events.find((e) => e.type === 'confidence_band')?.band).toBe('CONFIDENT') // the object, not a failure
    expect(events.some((e) => e.type === 'error')).toBe(false) // no hard_failure retry loop
    expect(events.find((e) => e.type === 'token')?.text).toContain('Cannondale')
  })

  test('a non-owner is denied (404) on revisit after a restart — no cross-tenant replay', async () => {
    const { app, restart } = build()
    const id = await createThread(app, 'A')
    await read(await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') }))
    restart(id)
    const asB = await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('B') })
    expect(asB.status).toBe(404) // durable owner check denies; never leaks existence as 403 vs 200
  })

  test('same-process cross-tenant is still forbidden (403) via the in-memory map', async () => {
    const { app } = build()
    const id = await createThread(app, 'A')
    const asB = await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('B') })
    expect(asB.status).toBe(403) // map KNOWS owner A → early authoritative deny
  })

  test('reconnect replay honours ?startIndex= against the persisted events', async () => {
    const { app, restart } = build()
    const id = await createThread(app, 'A')
    await read(await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') }))
    restart(id)
    const events = await read(await app.request(`/v1/threads/${id}/stream?startIndex=2`, { headers: auth('A') }))
    expect(events.every((e) => e.index >= 2)).toBe(true) // token(0)/band(1) skipped; only done(2) replays
    expect(events.some((e) => e.type === 'token')).toBe(false)
  })
})

describe('durable /speech narration survives a restart', () => {
  test('POST /speech replays the pinned narration (200 audio/mpeg) after a restart, not a 404', async () => {
    const { app, restart } = build()
    const id = await createThread(app, 'A')
    await read(await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') })) // pins narration
    restart(id)
    const speech = await app.request(`/v1/threads/${id}/speech`, { method: 'POST', headers: auth('A') })
    expect(speech.status).toBe(200)
    expect(speech.headers.get('content-type')).toBe('audio/mpeg')
  })
})

describe('durable refund guard is once-ever across a restart (adversarial #4)', () => {
  test('a hard_failure refunds exactly one scan even when re-streamed after a restart', async () => {
    const { app, store, restart } = build({ A: { scan: 3, podcast: 0, voiceMin: 0 } })
    const id = await createThread(app, 'A', 'fail') // charges 1 → remaining 2
    expect(await store.remaining('A', 'scan')).toBe(2)
    await read(await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') })) // hard_failure → +1 → 3
    expect(await store.remaining('A', 'scan')).toBe(3)
    restart(id) // refunds store survives; a farmer re-streams to try to refund again
    await read(await app.request(`/v1/threads/${id}/stream?startIndex=0`, { headers: auth('A') })) // hard_failure again
    expect(await store.remaining('A', 'scan')).toBe(3) // NOT 4 — markRefunded returns false the second time
  })
})

describe('/interview owner ACL is fail-CLOSED after a restart (adversarial #7)', () => {
  test('the owner may open an interview post-restart; a non-owner is denied (never fail-open)', async () => {
    const { app, restart } = build()
    const id = await createThread(app, 'A', 'unknown')
    restart(id)
    const asOwner = await app.request('/v1/interview', { method: 'POST', headers: auth('A'), body: JSON.stringify({ threadId: id }) })
    expect(asOwner.status).toBe(200) // durable owner check lets the legitimate owner through
    const asOther = await app.request('/v1/interview', { method: 'POST', headers: auth('B'), body: JSON.stringify({ threadId: id }) })
    expect(asOther.status).toBe(404) // soft-only check would have fail-OPEN'd here (map empty after restart)
  })
})
