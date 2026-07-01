/**
 * Executable unit suite for the highest-risk backend logic. Runs with `bun test` — no creds, no browser,
 * no Xcode. These assert the invariants the adversarial review flagged as critical.
 */
import { test, expect, describe } from 'bun:test'
import {
  validateClaims,
  registerFor,
  type Clause,
  type Evidence,
} from '../../../packages/shared/src/confidence'
import { arbitrate, type Candidate } from '../../../packages/shared/src/arbitration'
import { gatePodcastGeneration, charge, memoryStore } from './metering'
import { canRead, visibleTo, scanPrivateAcrossUsers, ElevatedContext, type CatalogRow } from './visibility'

// ---------------- Honesty gate (RT-1 / §8.3) ----------------
describe('honesty gate', () => {
  const evidence: Evidence[] = [
    { ref: 'e1', sourceUrl: 'https://cannondale.com/2008', claim: 'The 2008 SuperSix EVO frame is carbon.' },
  ]

  test('allows a grounded spec clause and pure flavor', () => {
    const clauses: Clause[] = [
      { text: 'A 2008 Cannondale SuperSix EVO.', claimType: 'date', evidenceRef: 'e1' },
      { text: 'Carbon, and obsessively light.', claimType: 'spec', evidenceRef: 'e1' },
      { text: 'It goes up hills faster than is strictly dignified.', claimType: 'flavor' },
    ]
    const r = validateClaims(clauses, evidence)
    expect(r.ok).toBe(true)
    expect(r.rendered).toContain('obsessively light')
  })

  test('rejects an ungrounded provenance clause (no digits — regex gate would have missed it)', () => {
    const clauses: Clause[] = [
      { text: 'Designed by an ex-Lotus engineer who hated compromise.', claimType: 'provenance' },
    ]
    const r = validateClaims(clauses, evidence)
    expect(r.ok).toBe(false)
    expect(r.rejected[0].reason).toMatch(/no evidence ref/)
  })

  test('independent auditor catches a falsifiable claim mislabeled as flavor', () => {
    const clauses: Clause[] = [
      { text: 'It was a favourite of the reclusive collector Henry Vane in 1991.', claimType: 'flavor' },
    ]
    // crude detector stand-in: capitalized multi-word name or a 4-digit year => falsifiable
    const detectNamedClaim = (t: string) => /\b\d{4}\b/.test(t) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t)
    const r = validateClaims(clauses, evidence, { detectNamedClaim })
    expect(r.ok).toBe(false)
    expect(r.rejected[0].reason).toMatch(/auditor/)
  })

  test('entailment judge catches citation laundering', () => {
    const clauses: Clause[] = [
      { text: 'It weighs exactly 6.8kg.', claimType: 'spec', evidenceRef: 'e1' }, // e1 says nothing about weight
    ]
    const judge = (c: Clause, e: Evidence) => e.claim.toLowerCase().includes('weigh')
    const r = validateClaims(clauses, evidence, { judge })
    expect(r.ok).toBe(false)
    expect(r.rejected[0].reason).toMatch(/does not entail/)
  })

  test('fail-closed path renders nothing when anything is rejected (podcast audio)', () => {
    const clauses: Clause[] = [{ text: 'Recalled for catching fire.', claimType: 'causal' }]
    const r = validateClaims(clauses, evidence, { failClosed: true })
    expect(r.ok).toBe(false)
    expect(r.rendered).toBeUndefined()
  })

  test('band → register mapping', () => {
    expect(registerFor('CONFIDENT').mayAssertSpecificModel).toBe(true)
    expect(registerFor('PROBABLE').mayAssertSpecificModel).toBe(false)
    expect(registerFor('PROBABLE').chipLabel).toMatch(/confident maybe/)
  })
})

// ---------------- Confidence arbitration (eng-F3 / §5.4) ----------------
describe('arbitration', () => {
  const catalog = (cosine: number, model = 'SuperSix EVO', year = 2008): Candidate => ({
    name: `${year} Cannondale ${model}`, make: 'Cannondale', model, year, source: 'catalog', confidence: cosine, cosine,
  })
  const web = (confidence: number, model = 'SuperSix EVO', year = 2008): Candidate => ({
    name: `${year} Cannondale ${model}`, make: 'Cannondale', model, year, source: 'web', confidence,
  })
  const vlm = (model = 'SuperSix EVO'): Candidate => ({ name: `Cannondale ${model}`, make: 'Cannondale', model, source: 'vlm', confidence: 0.6 })

  test('catalog hit + model agreement → CONFIDENT reveal', () => {
    const r = arbitrate({ catalog: catalog(0.95), vlm: vlm() })
    expect(r.band).toBe('CONFIDENT')
    expect(r.route).toBe('reveal')
  })

  test('strong web verification → CONFIDENT', () => {
    const r = arbitrate({ web: web(0.85), vlm: vlm() })
    expect(r.band).toBe('CONFIDENT')
  })

  test('catalog↔web disagreement → PROBABLE with BOTH candidates (never assert)', () => {
    const r = arbitrate({ catalog: catalog(0.8, 'SuperSix EVO', 2008), web: web(0.78, 'CAAD10', 2010), vlm: vlm() })
    expect(r.band).toBe('PROBABLE')
    expect(r.route).toBe('confirm')
    expect(r.candidates.length).toBeGreaterThanOrEqual(2)
  })

  test('nothing clears the floor → interview', () => {
    const r = arbitrate({ vlm: { ...vlm(), confidence: 0.3 } })
    expect(r.band).toBe('UNKNOWN')
    expect(r.route).toBe('interview')
  })
})

// ---------------- Metering (eng-F6, F8 / §6.4) ----------------
describe('metering', () => {
  test('idempotent podcast gate: one decrement, same token on replay', async () => {
    const store = memoryStore({ u1: { scan: 5, podcast: 1, voiceMin: 10 } })
    const mint = () => 'tok-123'
    const a = await gatePodcastGeneration(store, { userId: 'u1', catalogItemId: 'c1', version: 1, mintToken: mint })
    const b = await gatePodcastGeneration(store, { userId: 'u1', catalogItemId: 'c1', version: 1, mintToken: () => 'tok-999' })
    expect(a.ok).toBe(true)
    expect(b.token).toBe(a.token) // replay returns the SAME token
    expect(b.reason).toBe('idempotent_replay')
    expect(await store.remaining('u1', 'podcast')).toBe(0) // decremented exactly once
  })

  test('insufficient entitlement → no token, no decrement past zero', async () => {
    const store = memoryStore({ u1: { scan: 0, podcast: 0, voiceMin: 0 } })
    const r = await gatePodcastGeneration(store, { userId: 'u1', catalogItemId: 'c2', version: 1, mintToken: () => 't' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('insufficient_entitlement')
  })

  test('scan charge stops at the free cap', async () => {
    const store = memoryStore({ u1: { scan: 1, podcast: 0, voiceMin: 0 } })
    expect(await charge(store, 'u1', 'scan')).toBe(true)
    expect(await charge(store, 'u1', 'scan')).toBe(false)
  })
})

// ---------------- Visibility ACL (eng-F4 / infra-04 / §7.4) ----------------
describe('visibility ACL', () => {
  const rows: CatalogRow[] = [
    { id: 'g1', ownerUserId: null, visibility: 'global' },
    { id: 'pA', ownerUserId: 'A', visibility: 'private' },
    { id: 'pB', ownerUserId: 'B', visibility: 'private' },
  ]

  test('user A sees global + own private, never B\'s private', () => {
    const v = visibleTo(rows, 'A').map((r) => r.id)
    expect(v).toContain('g1')
    expect(v).toContain('pA')
    expect(v).not.toContain('pB')
  })

  test('canRead predicate matches the SQL invariant', () => {
    expect(canRead(rows[2], 'A')).toBe(false)
    expect(canRead(rows[0], 'A')).toBe(true)
  })

  test('cross-user private scan requires an ElevatedContext', () => {
    expect(() => scanPrivateAcrossUsers(rows, {} as ElevatedContext)).toThrow(/ElevatedContext/)
    const ok = scanPrivateAcrossUsers(rows, ElevatedContext.forPromotion())
    expect(ok.length).toBe(2) // promotion job can see both private entries to count distinct owners
  })
})
