/**
 * Deterministic tests for the eve identification tools (PLAN §4.2, §5, §8.3 / RT-1, eng-F3).
 *
 * These drive the REAL tool code (`identify_object`, `catalog_search`, `safety_gate`) through the REAL shared
 * arbitration and the REAL `packages/db` Catalog on in-process PGlite. Nothing is stubbed to force a verdict:
 * the FAKE VisionProvider only supplies stage candidates (exactly what Gemini/Vision/the vector match would
 * supply); the band/route is decided by the shared arbiter, and catalog hits come from real SQL + cosine.
 *
 * Asserted (the task's four scenarios + the unsupported-fields invariant):
 *   1. catalog hit + model agreement        → CONFIDENT, route=reveal
 *   2. catalog ↔ web disagreement            → PROBABLE, route=confirm, BOTH candidates surfaced
 *   3. low confidence everywhere             → UNKNOWN, route=interview
 *   4. unsupported_fields are never asserted (a missing field is reported, never guessed into the label)
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { identify_object, type VisionProvider, type VisionStages, type ImageRef } from './identify_object'
import { catalog_search } from './catalog_search'
import { safety_gate, type SafetyClassifier, type SafetyClassification } from './safety_gate'
import { Catalog } from '../../../../packages/db/catalog'
import type { Candidate } from '../../../../packages/shared/src/arbitration'

/** A FAKE VisionProvider: returns whatever stages it is seeded with. Mirrors a vendor record/replay tape. */
class FakeVision implements VisionProvider {
  constructor(private stages: VisionStages) {}
  async analyze(_image: ImageRef): Promise<VisionStages> {
    return this.stages
  }
}

const IMG: ImageRef = { uri: 'gs://voxi-photos/redacted/abc.jpg' }

// A specific, real-shaped object: "2008 Cannondale SuperSix EVO" (the PLAN's running example).
const superSix: Candidate = {
  name: '2008 Cannondale SuperSix EVO',
  make: 'Cannondale',
  model: 'SuperSix EVO',
  year: 2008,
  source: 'catalog',
  confidence: 0.95,
  cosine: 0.96, // ≥ 0.92 short-circuit bar
}

describe('identify_object — catalog hit → CONFIDENT reveal', () => {
  test('a high-cosine catalog match that agrees with the VLM short-circuits to CONFIDENT/reveal', async () => {
    const vlm: Candidate = { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.8 }
    const provider = new FakeVision({
      catalog: superSix,
      vlm,
      evidence: [{ ref: 'e1', sourceUrl: 'https://catalog.voxi/items/ss-evo', claim: '2008 Cannondale SuperSix EVO' }],
    })

    const r = await identify_object(IMG, provider)

    expect(r.confidence_band).toBe('CONFIDENT')
    expect(r.route).toBe('reveal')
    expect(r.label).toBe('2008 Cannondale SuperSix EVO')
    expect(r.granularity_level).toBe('make_model_year')
    expect(r.candidates).toHaveLength(1)
    // every identifying field IS supported by the chosen candidate → nothing unsupported.
    expect(r.unsupported_fields).toEqual([])
  })
})

describe('identify_object — catalog ↔ web disagreement → PROBABLE with both candidates', () => {
  test('a high-confidence disagreement downgrades to PROBABLE and surfaces BOTH candidates', async () => {
    // Catalog says SuperSix EVO (but below the 0.92 short-circuit bar, so it cannot win outright);
    // web says a DIFFERENT model with strong-but-not-verified confidence. Different models, both ≥ floor.
    const catalog: Candidate = { ...superSix, cosine: 0.7 }
    const web: Candidate = { name: '2009 Specialized Tarmac', make: 'Specialized', model: 'Tarmac', year: 2009, source: 'web', confidence: 0.6 }
    const provider = new FakeVision({
      catalog,
      web,
      evidence: [{ ref: 'w1', sourceUrl: 'https://example.com/tarmac', claim: 'Specialized Tarmac' }],
    })

    const r = await identify_object(IMG, provider)

    expect(r.confidence_band).toBe('PROBABLE')
    expect(r.route).toBe('confirm')
    // BOTH candidates must reach the user (the labeling signal) — never collapsed to one assertion.
    expect(r.candidates).toHaveLength(2)
    const names = r.candidates.map((c) => c.name).sort()
    expect(names).toEqual(['2008 Cannondale SuperSix EVO', '2009 Specialized Tarmac'])
    // the specific make/model/year are NOT jointly supported on a disagreement → never asserted.
    expect(r.unsupported_fields).toEqual(['make', 'model', 'year'])
  })
})

describe('identify_object — low confidence → interview route', () => {
  test('nothing clears the floor → UNKNOWN/interview, no specific label asserted', async () => {
    // A weak VLM guess and a weak catalog cosine, both below the 0.5 interview floor.
    const vlm: Candidate = { name: 'some kind of bicycle', make: 'unknown', source: 'vlm', confidence: 0.3 }
    const catalog: Candidate = { ...superSix, cosine: 0.4 }
    const provider = new FakeVision({ vlm, catalog })

    const r = await identify_object(IMG, provider)

    expect(r.confidence_band).toBe('UNKNOWN')
    expect(r.route).toBe('interview')
    expect(r.granularity_level).toBe('category')
    // UNKNOWN → no falsifiable field may be asserted at all.
    expect(r.unsupported_fields).toEqual(['make', 'model', 'year'])
  })
})

describe('identify_object — unsupported_fields are never asserted', () => {
  test('a make-only confident hit reports model+year as unsupported and keeps them out of the label', async () => {
    // Web verified at the make level only (no model, no year). It clears webVerified (≥0.75) → CONFIDENT.
    const web: Candidate = { name: 'Cannondale road bicycle', make: 'Cannondale', source: 'web', confidence: 0.8 }
    const provider = new FakeVision({
      web,
      evidence: [{ ref: 'w2', sourceUrl: 'https://cannondale.com', claim: 'a Cannondale road bicycle' }],
    })

    const r = await identify_object(IMG, provider)

    expect(r.confidence_band).toBe('CONFIDENT')
    expect(r.granularity_level).toBe('make')
    // model & year were never verified → reported as unsupported, and absent from the label.
    expect(r.unsupported_fields).toContain('model')
    expect(r.unsupported_fields).toContain('year')
    expect(r.unsupported_fields).not.toContain('make')
    expect(r.label).toBe('Cannondale road bicycle')
    expect(r.label).not.toMatch(/200\d/) // no fabricated year smuggled into the label
  })
})

describe('catalog_search — wraps the real Catalog with the visibility ACL', () => {
  let catalog: Catalog
  const ME = 'user-me'
  const OTHER = 'user-other'

  beforeAll(async () => {
    catalog = await Catalog.create(4)
    // a global entry (visible to everyone) that IS the SuperSix EVO
    await catalog.upsert({ id: 'ss-evo', name: '2008 Cannondale SuperSix EVO', ownerUserId: null, visibility: 'global', embedding: [1, 0, 0, 0] })
    // ME's own private entry
    await catalog.upsert({ id: 'mine', name: 'my prototype frame', ownerUserId: ME, visibility: 'private', embedding: [0, 1, 0, 0] })
    // ANOTHER user's private entry — must NEVER appear for ME
    await catalog.upsert({ id: 'theirs', name: 'their secret object', ownerUserId: OTHER, visibility: 'private', embedding: [1, 0, 0, 0] })
  })
  afterAll(async () => {
    await catalog.close()
  })

  test('a query near the global SuperSix vector returns it as the best hit, as a similarity in [0,1]', async () => {
    const r = await catalog_search({ embedding: [0.98, 0.02, 0, 0], userId: ME, k: 5 }, catalog)
    expect(r.best?.entryId).toBe('ss-evo')
    expect(r.best!.cosine).toBeGreaterThan(0.9)
    expect(r.best!.cosine).toBeLessThanOrEqual(1)
  })

  test('the ACL holds: ME never sees ANOTHER user’s private entry even on an exact vector match', async () => {
    // [1,0,0,0] is an exact match for BOTH the global ss-evo AND the other user's private "theirs".
    const r = await catalog_search({ embedding: [1, 0, 0, 0], userId: ME, k: 10 }, catalog)
    const ids = r.hits.map((h) => h.entryId)
    expect(ids).toContain('ss-evo') // global is visible
    expect(ids).toContain('mine') // my own private is visible
    expect(ids).not.toContain('theirs') // the other user's private is NOT — enforced in SQL
  })
})

describe('safety_gate — suppresses identification on hard categories (fail-closed)', () => {
  const fixed = (c: SafetyClassification): SafetyClassifier => ({ async classify() { return c } })

  test('a safe image allows identification', async () => {
    const v = await safety_gate(IMG, fixed({ category: 'safe', confidence: 0.99 }))
    expect(v.action).toBe('allow')
    expect(v.identificationAllowed).toBe(true)
    expect(v.suppressedFields).toEqual([])
  })

  test('pills/medical (false-positive biased) refuses and suppresses make/model/spec entirely', async () => {
    const v = await safety_gate(IMG, fixed({ category: 'pills_medical', confidence: 0.35 }))
    expect(v.action).toBe('refuse_non_identifying')
    expect(v.identificationAllowed).toBe(false)
    expect(v.suppressedFields).toEqual(expect.arrayContaining(['make', 'model', 'spec']))
  })

  test('a weapon gets category-name-only: model/caliber/acquisition/modification suppressed', async () => {
    const v = await safety_gate(IMG, fixed({ category: 'weapon', confidence: 0.9 }))
    expect(v.action).toBe('category_name_only')
    expect(v.identificationAllowed).toBe(false)
    expect(v.suppressedFields).toEqual(expect.arrayContaining(['model', 'caliber', 'acquisition', 'modification']))
  })

  test('a classifier error fails CLOSED (blocked), never open', async () => {
    const throwing: SafetyClassifier = { async classify() { throw new Error('vendor timeout') } }
    const v = await safety_gate(IMG, throwing)
    expect(v.action).toBe('block')
    expect(v.identificationAllowed).toBe(false)
  })
})
