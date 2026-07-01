/**
 * Companion to the durable-revisit fix (adversarial #7): POST /v1/voice/session must be fail-CLOSED across a
 * restart. The old soft-only map check fell OPEN once a restart emptied the in-memory ownership map — anyone could
 * open (and get billed for) a voice session bound to another user's threadId. The shared `threadOwnerVerdict`
 * defers to the durable thread row on a map miss, so a legit owner still gets through and a stranger is denied.
 */
import { test, expect, describe } from 'bun:test'
import { createVoiceRoutes } from './voice-routes'
import { testVerifier } from './auth'
import { memoryStore } from './metering'
import type { ThreadStore, ThreadRecord } from './app'

process.env.VOXI_TEST_MODE = '1'
const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })

function memThreads(seed: ThreadRecord[]): ThreadStore {
  const rows = new Map(seed.map((r) => [r.threadId, r]))
  return {
    async put(r) { rows.set(r.threadId, r) },
    async listByOwner(u) { return [...rows.values()].filter((r) => r.ownerUserId === u) },
    async get(id) { return rows.get(id) ?? null },
  }
}

function build() {
  const sessionOwner = new Map<string, string>([['t1', 'A']]) // same-process: the map knows A owns t1
  const threads = memThreads([
    { threadId: 't1', ownerUserId: 'A', title: 'cap', createdAt: 1, continuationToken: 'ct' }, // durable row survives a restart
  ])
  const store = memoryStore({ A: { scan: 0, podcast: 0, voiceMin: 10 }, B: { scan: 0, podcast: 0, voiceMin: 10 } })
  const app = createVoiceRoutes({ verifier: testVerifier, store, sessionOwner, threads, voiceServerBaseUrl: 'http://voice.test' })
  const open = (u: string, threadId: string) =>
    app.request('/v1/voice/session', { method: 'POST', headers: auth(u), body: JSON.stringify({ threadId }) })
  const restart = () => sessionOwner.clear() // in-memory map gone; durable threads remain
  return { open, restart }
}

describe('POST /v1/voice/session owner ACL (fail-closed across a restart)', () => {
  test('same-process: owner opens a session; a non-owner is 403', async () => {
    const { open } = build()
    expect((await open('A', 't1')).status).toBe(200)
    expect((await open('B', 't1')).status).toBe(403)
  })

  test('after a restart: the legit owner still gets through via the durable row', async () => {
    const { open, restart } = build()
    restart()
    expect((await open('A', 't1')).status).toBe(200) // map empty, but threads.get(t1).owner === A
  })

  test('after a restart: a stranger is DENIED (404) and never gets a connect URL or a voiceMin charge', async () => {
    const { open, restart } = build()
    restart()
    const res = await open('B', 't1')
    expect(res.status).toBe(404) // was fail-OPEN (would mint a URL + charge) before the fix
    const body = await res.json()
    expect(body.connectUrl).toBeUndefined()
  })
})
