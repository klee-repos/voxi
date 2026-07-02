/**
 * P4 — the grounded conversation context ("tell me more"). `buildItemContext` reconstructs the SERVER-OWNED chat
 * grounding from the durable reveal (title + narration + cited facts), and `GET /v1/threads/:id/context` serves it
 * OWNER-SCOPED (never client-supplied). Proves the dossier's facts + provenance carry into the conversation.
 */
import { test, expect, describe } from 'bun:test'
import { createApp, buildItemContext, type Deps, type RevealStore, type RevealRecord } from './app'
import { testVerifier } from './auth'
import { memoryStore } from './metering'
import type { StreamEvent } from '../../../packages/shared/src/events'

process.env.VOXI_TEST_MODE = '1' // enable the test verifier (`Bearer test:<userId>`)

const FACTS: StreamEvent[] = [
  { type: 'fact', index: 2, text: 'The Canon AE-1 was the first microprocessor-equipped SLR.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', sourceTitle: 'Canon AE-1', quote: 'the first microprocessor-equipped SLR' },
  { type: 'fact', index: 3, text: 'Canon sold over five million units.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', sourceTitle: 'Canon AE-1', quote: 'sold over five million units' },
]
const REVEAL: RevealRecord = {
  threadId: 'sess_A_1',
  ownerUserId: 'A',
  band: 'CONFIDENT',
  title: 'Canon AE-1',
  candidates: [],
  events: [{ type: 'confidence_band', index: 1, band: 'CONFIDENT', title: 'Canon AE-1', candidates: [] }, ...FACTS],
  narration: 'A 1976 Canon AE-1 — a 35mm SLR that put automation in reach.',
  createdAt: 0,
}

describe('buildItemContext (pure)', () => {
  test('grounds the chat on the subject, narration, and the CITED facts (each with its source)', () => {
    const ctx = buildItemContext(REVEAL)
    expect(ctx).toContain('OBJECT: Canon AE-1 (confidence: CONFIDENT)')
    expect(ctx).toContain('35mm SLR')
    // each fact is surfaced with its source attached (the "fact — sourceUrl" line).
    expect(ctx).toContain('first microprocessor-equipped SLR')
    expect(ctx).toContain('— https://en.wikipedia.org/wiki/Canon_AE-1')
    expect(ctx).toContain('five million units')
    expect(ctx.toLowerCase()).toContain('web_search') // the live-lookup + grounding rule is present
    expect(ctx.toLowerCase()).toContain('confidence band still rules')
  })
})

function build(reveals: RevealStore): ReturnType<typeof createApp> {
  const deps: Deps = {
    verifier: testVerifier,
    store: memoryStore({ A: { scan: 1, podcast: 1, voiceMin: 10 }, B: { scan: 1, podcast: 1, voiceMin: 10 } }),
    eve: {
      async createSession({ userId }) {
        return { sessionId: `sess_${userId}_1`, continuationToken: 'ct' }
      },
      async *stream(sessionId) {
        yield JSON.stringify({ type: 'done', sessionId })
      },
    },
    deletion: { async cascade(userId) { return { deleted: [`sessions:${userId}`] } } },
    bucket: 'voxi-photos',
    sessionOwner: new Map(),
    reveals,
  }
  return createApp(deps)
}

function revealStore(rec: RevealRecord | null): RevealStore {
  return { async put() { return { inserted: true } }, async get(id) { return rec && rec.threadId === id ? rec : null } }
}

const auth = (u: string) => ({ authorization: `Bearer test:${u}` })

describe('GET /v1/threads/:id/context — owner-scoped grounded chat context', () => {
  test('the owner gets the grounded context reconstructed from the durable reveal', async () => {
    const app = build(revealStore(REVEAL))
    const res = await app.request('/v1/threads/sess_A_1/context', { headers: auth('A') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subject: string; band: string; itemContext: string; facts: { text: string; sourceUrl: string }[] }
    expect(body.subject).toBe('Canon AE-1')
    expect(body.band).toBe('CONFIDENT')
    expect(body.facts).toHaveLength(2)
    expect(body.facts[0]!.sourceUrl).toContain('wikipedia')
    expect(body.itemContext).toContain('GROUNDED FACTS')
  })

  test('a NON-owner is denied (the durable reveal belongs to A, not B)', async () => {
    const app = build(revealStore(REVEAL))
    const res = await app.request('/v1/threads/sess_A_1/context', { headers: auth('B') })
    expect(res.status).toBe(404) // reveal.ownerUserId !== B → no context leaked cross-tenant
  })

  test('no persisted reveal → 404 (nothing to ground on)', async () => {
    const app = build(revealStore(null))
    const res = await app.request('/v1/threads/sess_A_1/context', { headers: auth('A') })
    expect(res.status).toBe(404)
  })
})
