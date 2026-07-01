/**
 * cron.test.ts — the BFF cron routes REALLY run the moat sweeps (PLAN §7.2/§7.4, §22.3 S1 / task #22).
 *
 * Proves POST /internal/cron/{dedup,promote} invoke the REAL runDedupSweep / runPromotionSweep
 * (services/eve-agent/agent/schedules/*) — not a stub. The DB fetch + LLM judge are injected fakes (the judge
 * needs Gemini creds in prod), but the ROUTE, the sweep, and its band/sybil policy are the real code:
 *   - the dedup judge's similarities are classified into the REAL auto_merge/queue_review bands;
 *   - the promotion sweep runs the REAL distinct-owner sybil weighting and mints a HELD 'pending_global' draft.
 * Auth is fail-closed: no cron deps → 503; wrong secret → 401.
 */
import { test, expect, describe } from 'bun:test'
import { createApp, type Deps } from './app'
import { testVerifier } from './auth'
import { memoryStore } from './metering'
import type { DedupCandidate } from '../../eve-agent/agent/schedules/dedup'
import type { PromotionCluster } from '../../eve-agent/agent/schedules/promote'
import type { OwnerSignal } from '../../../packages/shared/src/promotion'

process.env.VOXI_TEST_MODE = '1'

const CRON_SECRET = 'test-cron-secret'

/** Two near-identical bikes (should auto-merge ≥0.95) + one unrelated teapot in another category (ignored). */
const CANDIDATES: DedupCandidate[] = [
  { entryId: 'bike-a', category: 'bicycle', embedding: [1, 0, 0] },
  { entryId: 'bike-b', category: 'bicycle', embedding: [1, 0, 0] },
  { entryId: 'teapot', category: 'teapot', embedding: [0, 1, 0] },
]

/** A judge that reports the two bikes as a near-duplicate (0.97 ≥ 0.95 auto-merge band). */
const judge = async (a: DedupCandidate, b: DedupCandidate): Promise<number> =>
  a.category === 'bicycle' && b.category === 'bicycle' ? 0.97 : 0.1

/** 3 distinct, well-dispersed owners on distinct devices → passes the real sybil weighting (N=3). */
function owner(id: string): OwnerSignal {
  return { ownerId: id, accountAgeDays: 90, deviceAttested: true, geoTimeDispersed: true, deviceId: `dev-${id}` }
}

const CLUSTERS: PromotionCluster[] = [
  {
    clusterId: 'c1',
    category: 'bicycle',
    privateEntryIds: ['p1', 'p2', 'p3'],
    owners: [owner('u1'), owner('u2'), owner('u3')],
    structuredFields: { make: 'Cannondale', model: 'SuperSix EVO', year: '2008' },
  },
  {
    // only one owner → must NOT promote.
    clusterId: 'c2',
    category: 'teapot',
    privateEntryIds: ['p4'],
    owners: [owner('u4')],
    structuredFields: { make: 'Brown Betty' },
  },
]

function build(overrides?: Partial<Deps['cron']>): { app: ReturnType<typeof createApp>; applied: { dedup?: unknown; promote?: unknown } } {
  const applied: { dedup?: unknown; promote?: unknown } = {}
  const deps: Deps = {
    verifier: testVerifier,
    store: memoryStore({}),
    eve: { async createSession() { return { sessionId: 's', continuationToken: 'c' } }, async *stream() {} },
    deletion: { async cascade() { return { deleted: [] } } },
    bucket: 'b',
    sessionOwner: new Map(),
    cron: {
      secret: CRON_SECRET,
      dedup: {
        candidates: async () => CANDIDATES,
        judge,
        apply: async (d) => { applied.dedup = d },
      },
      promote: {
        clusters: async () => CLUSTERS,
        apply: async (o) => { applied.promote = o },
      },
      ...(overrides as object),
    },
  }
  return { app: createApp(deps), applied }
}

const cronHeaders = { authorization: `Bearer ${CRON_SECRET}` }

describe('BFF cron routes — real sweeps off eve scheduler (§22.3 S1)', () => {
  test('POST /internal/cron/dedup runs runDedupSweep → the two bikes auto-merge, the teapot is ignored', async () => {
    const { app, applied } = build()
    const res = await app.request('/internal/cron/dedup', { method: 'POST', headers: cronHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ran: string; candidates: number; decisions: number; autoMerges: number }
    expect(body.ran).toBe('dedup')
    expect(body.candidates).toBe(3)
    // the REAL sweep: one bike↔bike pair auto-merges (0.97 ≥ 0.95); the teapot is a different block → no pair.
    expect(body.autoMerges).toBe(1)
    expect(body.decisions).toBe(1)
    // and the decisions were actually handed to apply() — proving the route drove the real sweep output.
    expect(Array.isArray(applied.dedup)).toBe(true)
  })

  test('POST /internal/cron/promote runs runPromotionSweep → the 3-owner cluster promotes (HELD), the 1-owner does not', async () => {
    const { app, applied } = build()
    const res = await app.request('/internal/cron/promote', { method: 'POST', headers: cronHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ran: string; clusters: number; promoted: number; held: number }
    expect(body.ran).toBe('promote')
    expect(body.clusters).toBe(2)
    // REAL sybil policy: 3 distinct, dispersed owners on distinct devices promote; the lone owner does not.
    expect(body.promoted).toBe(1)
    // the promoted record is auto-HELD for moderation (pending_global), never straight-to-global (§7.4).
    expect(body.held).toBe(1)
    expect(Array.isArray(applied.promote)).toBe(true)
  })

  test('cron routes are fail-closed: wrong secret → 401, no cron deps → 503', async () => {
    const { app } = build()
    const bad = await app.request('/internal/cron/dedup', { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    expect(bad.status).toBe(401)

    // an app with no cron deps at all → 503 (the seam fails loudly, never a fake success).
    const noCron = createApp({
      verifier: testVerifier,
      store: memoryStore({}),
      eve: { async createSession() { return { sessionId: 's', continuationToken: 'c' } }, async *stream() {} },
      deletion: { async cascade() { return { deleted: [] } } },
      bucket: 'b',
      sessionOwner: new Map(),
    })
    const res = await noCron.request('/internal/cron/promote', { method: 'POST', headers: cronHeaders })
    expect(res.status).toBe(503)
  })

  test('cron routes are NOT behind the /v1 Clerk auth (a user JWT is neither required nor sufficient)', async () => {
    const { app } = build()
    // A valid USER token but NOT the cron secret must be rejected (these are Cloud Scheduler routes, not user routes).
    const asUser = await app.request('/internal/cron/dedup', { method: 'POST', headers: { authorization: 'Bearer test:alice' } })
    expect(asUser.status).toBe(401)
  })
})
