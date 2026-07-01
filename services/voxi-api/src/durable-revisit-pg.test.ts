/**
 * End-to-end proof of the durable-revisit fix against the REAL persistence layer the assembled server wires
 * (services/voxi-api/src/server.ts): createApp + file-backed PGlite stores, across an ACTUAL restart (close the
 * DB, reopen the SAME dataDir, fresh in-memory ownership + a fresh eve whose photo cache is empty). This is the
 * exact tmux scenario — a BFF restart, then the user revisits a past capture. The persisted reveal must replay.
 */
import { test, expect, describe, afterAll } from 'bun:test'
import { createApp, type Deps, type EveClient } from './app'
import { createPgStores, type PgStores } from './pg-stores'
import { testVerifier } from './auth'
import { memoryStore } from './metering'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.VOXI_TEST_MODE = '1'
const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })

/** A fresh eve per boot — a restart starts with an EMPTY photo cache (the live session state is gone). */
function bootEve(): EveClient {
  const photos = new Map<string, string>()
  let n = 0
  return {
    async createSession({ userId, photoUrl }) {
      const sessionId = `sess_${userId}_${(n++).toString(36)}`
      photos.set(sessionId, photoUrl)
      return { sessionId, continuationToken: 'ct' }
    },
    async *stream(sessionId, _userId, startIndex = 0) {
      if (!photos.get(sessionId)) {
        yield JSON.stringify({ type: 'error', index: 0, code: 'hard_failure', message: 'session expired — capture again' })
        yield JSON.stringify({ type: 'done', index: 1, sessionId })
        return
      }
      const evs = [
        { type: 'token', index: 0, text: 'A 2008 Cannondale SuperSix EVO.' },
        { type: 'confidence_band', index: 1, band: 'CONFIDENT', title: '2008 Cannondale SuperSix EVO', candidates: [] },
        { type: 'done', index: 2, sessionId },
      ]
      for (const e of evs) {
        if (e.index < startIndex) continue
        yield JSON.stringify(e)
      }
    },
    async narrationText() {
      return null
    },
  }
}

function boot(durable: PgStores, sessionOwner: Map<string, string>) {
  const deps: Deps = {
    verifier: testVerifier,
    store: memoryStore({ A: { scan: 5, podcast: 1, voiceMin: 10 } }),
    eve: bootEve(),
    deletion: { async cascade() { return { deleted: [] } } },
    bucket: 'voxi-photos',
    sessionOwner,
    threads: durable.threads,
    reveals: durable.reveals,
    refunds: durable.refunds,
  }
  return createApp(deps)
}

const dir = mkdtempSync(join(tmpdir(), 'voxi-pg-revisit-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('durable revisit across a REAL PGlite restart (validates the assembled server wiring)', () => {
  test('capture, restart, revisit → the reveal replays from disk (200 CONFIDENT), not a 403 or hard_failure', async () => {
    // ---- boot #1: capture + settle + persist to PGlite ----
    let durable = await createPgStores(dir)
    let app = boot(durable, new Map())
    const created = await app.request('/v1/threads', { method: 'POST', headers: auth('A'), body: JSON.stringify({ photoUrl: 'confident' }) })
    const { threadId } = await created.json()
    const live = await app.request(`/v1/threads/${threadId}/stream?startIndex=0`, { headers: auth('A') })
    expect(live.status).toBe(200)
    const liveText = await live.text() // drain fully so the route's persist to PGlite completes
    expect(liveText).toContain('CONFIDENT')
    await durable.close() // flush to disk

    // ---- boot #2: a REAL restart — reopen the SAME dataDir, empty ownership map, fresh (photo-less) eve ----
    durable = await createPgStores(dir)
    app = boot(durable, new Map())

    const revisit = await app.request(`/v1/threads/${threadId}/stream?startIndex=0`, { headers: auth('A') })
    expect(revisit.status).toBe(200) // the tmux bug returned 403 here (in-memory ownership was gone after restart)
    const events = (await revisit.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(events.find((e) => e.type === 'confidence_band')?.band).toBe('CONFIDENT') // the object, replayed from disk
    expect(events.some((e) => e.type === 'error')).toBe(false) // NOT the "session expired" hard_failure

    // a non-owner is still denied after the restart (durable owner check; no cross-tenant replay)
    const asB = await app.request(`/v1/threads/${threadId}/stream?startIndex=0`, { headers: auth('B') })
    expect(asB.status).toBe(404)
    await durable.close()
  })
})
