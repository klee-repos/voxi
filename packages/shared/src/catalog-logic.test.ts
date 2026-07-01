/** Tests for the defamation gate (RT-9), sybil-resistant promotion (RT-6), dedup-on-create (eng-F10). */
import { test, expect, describe } from 'bun:test'
import { gateClaim } from './moderation'
import { shouldPromote, type OwnerSignal } from './promotion'
import { bucketKey, CreateGuard } from './dedup'

describe('defamation gate (RT-9)', () => {
  const neg = 'The Acme Roadster was recalled after several caught fire.'
  test('negative claim about an entity with <2 independent sources → human review', () => {
    expect(gateClaim(neg, [{ url: 'https://blog.example.com/a' }]).action).toBe('human_review')
    // two URLs but same domain (syndicated) is NOT independent
    expect(gateClaim(neg, [{ url: 'https://news.site.com/a' }, { url: 'https://news.site.com/b' }]).action).toBe('human_review')
  })
  test('negative claim with ≥2 independent (distinct-domain) sources → allow', () => {
    expect(gateClaim(neg, [{ url: 'https://nhtsa.gov/x' }, { url: 'https://reuters.com/y' }]).action).toBe('allow')
  })
  test('non-negative flavor about an entity → allow without sources', () => {
    expect(gateClaim('The Acme Roadster is a joy on a sunny day.', []).action).toBe('allow')
  })
})

describe('sybil-resistant promotion (RT-6)', () => {
  const trusted = (id: string, dev: string): OwnerSignal => ({ ownerId: id, accountAgeDays: 30, deviceAttested: true, geoTimeDispersed: true, deviceId: dev })
  const fresh = (id: string, dev: string): OwnerSignal => ({ ownerId: id, accountAgeDays: 0, deviceAttested: false, geoTimeDispersed: false, deviceId: dev })

  test('3 trusted, distinct-device owners → promote', () => {
    const r = shouldPromote([trusted('a', 'd1'), trusted('b', 'd2'), trusted('c', 'd3')], 3)
    expect(r.promote).toBe(true)
  })
  test('3 fresh same-day unattested owners → do not promote', () => {
    const r = shouldPromote([fresh('a', 'd1'), fresh('b', 'd2'), fresh('c', 'd3')], 3)
    expect(r.promote).toBe(false)
  })
  test('many accounts on ONE device → blocked by device-diversity guard', () => {
    const r = shouldPromote([trusted('a', 'same'), trusted('b', 'same'), trusted('c', 'same')], 3)
    expect(r.promote).toBe(false)
    expect(r.reason).toMatch(/device-diversity/)
  })
})

describe('dedup-on-create (eng-F10)', () => {
  test('concurrent creates of the same object converge to one entry', () => {
    const g = new CreateGuard()
    const e1 = [0.99, 0.01, 0, 0]
    const e2 = [1.0, 0.0, 0, 0] // near-identical
    const k1 = bucketKey(e1, 'road-bicycle')
    const k2 = bucketKey(e2, 'road-bicycle')
    expect(k1).toBe(k2) // same coarse bucket
    const a = g.claim(k1, 'entry-A')
    const b = g.claim(k2, 'entry-B')
    expect(a.result).toBe('created')
    expect(b.result).toBe('merged')
    expect(b.entryId).toBe('entry-A') // second create merges into the first
  })
  test('different categories do not collide', () => {
    const g = new CreateGuard()
    const emb = [1, 0, 0, 0]
    expect(g.claim(bucketKey(emb, 'bicycle'), 'x').result).toBe('created')
    expect(g.claim(bucketKey(emb, 'camera'), 'y').result).toBe('created')
  })
})
