/**
 * Real pgvector retrieval + visibility ACL on in-process Postgres (PGlite). `bun test`.
 * Proves: nearest-neighbour ranking works AND a user never retrieves another user's private entry,
 * AND the partitioned query (§11 fix) matches the naive filtered query's result set for that user.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { Catalog } from './catalog'

let cat: Catalog
const DIM = 4

beforeAll(async () => {
  cat = await Catalog.create(DIM)
  // g1 is the exact match for the query; g2 is far. pA (user A) is near; pB (user B, private) is also near
  // but must NEVER surface for user A.
  await cat.upsert({ id: 'g1', name: '2008 SuperSix EVO', ownerUserId: null, visibility: 'global', embedding: [1, 0, 0, 0] })
  await cat.upsert({ id: 'g2', name: 'Random kettle', ownerUserId: null, visibility: 'global', embedding: [0, 0, 0, 1] })
  await cat.upsert({ id: 'pA', name: "A's private bike", ownerUserId: 'A', visibility: 'private', embedding: [0.99, 0.01, 0, 0] })
  await cat.upsert({ id: 'pB', name: "B's private bike", ownerUserId: 'B', visibility: 'private', embedding: [1, 0, 0, 0] })
})

afterAll(async () => {
  await cat.close()
})

describe('catalog vector retrieval + ACL', () => {
  test('nearest-neighbour ranking returns the exact global match first', async () => {
    const hits = await cat.searchPartitioned([1, 0, 0, 0], 'A', 3)
    expect(hits[0].id).toBe('g1') // exact global match ranks first
    expect(hits.map((h) => h.id)).toContain('pA') // A's own private near-match is included
  })

  test("user A NEVER retrieves user B's private entry", async () => {
    const ids = (await cat.searchPartitioned([1, 0, 0, 0], 'A', 10)).map((h) => h.id)
    expect(ids).not.toContain('pB')
    const idsFiltered = (await cat.searchFiltered([1, 0, 0, 0], 'A', 10)).map((h) => h.id)
    expect(idsFiltered).not.toContain('pB')
  })

  test('partitioned query (§11 fix) and naive filtered query agree for the same user', async () => {
    const a = (await cat.searchPartitioned([1, 0, 0, 0], 'A', 5)).map((h) => h.id).sort()
    const b = (await cat.searchFiltered([1, 0, 0, 0], 'A', 5)).map((h) => h.id).sort()
    expect(a).toEqual(b)
  })

  test("user B sees their own private entry but not A's", async () => {
    const ids = (await cat.searchPartitioned([1, 0, 0, 0], 'B', 10)).map((h) => h.id)
    expect(ids).toContain('pB')
    expect(ids).not.toContain('pA')
  })
})
