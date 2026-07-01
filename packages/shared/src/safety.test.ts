/**
 * Tests for the deterministic safety pre-classifier + redaction plan (PLAN §8.4 / §4.6, TEST-PLAN safe-01..04).
 *
 * These assert the REAL policy invariants that protect the product legally:
 *  - pill/medical → refuse_medical + make/model/spec generation SUPPRESSED entirely (RT-8, safe-01)
 *  - weapon → category-only naming, applied to the FOLLOW-UP loop too (RT-13, safe-02)
 *  - face-dominant → refuse_people (objects, never people)
 *  - nsfw/csam → block BEFORE the persona (safe-03)
 *  - false-positive bias: a low pill/weapon suspicion is enough to refuse (over-refuse, never under-refuse)
 *  - redactOrReject is fail-closed on null / throw / incomplete coverage (safe-04 plumbing)
 */
import { test, expect, describe } from 'bun:test'
import {
  safetyClassify,
  generationConstraintsFor,
  buildRedactionPlan,
  redactOrReject,
  ACTION_FOR,
  DEFAULT_THRESHOLDS,
  type RedactionRegion,
} from './safety'

describe('safetyClassify — category & action routing', () => {
  test('a normal object is allowed', () => {
    const c = safetyClassify({ weapon: 0.01, pillMedical: 0.02, nsfw: 0.0, faceAreaFraction: 0.05 })
    expect(c.category).toBe('object')
    expect(c.action).toBe('allow')
  })

  test('safe-01: pill/medical → refuse_medical, and SUPPRESSES make/model + spec generation', () => {
    const c = safetyClassify({ pillMedical: 0.55 })
    expect(c.category).toBe('pill_medical')
    expect(c.action).toBe('refuse_medical')

    const g = generationConstraintsFor(c.action)
    expect(g.mayIdentifyMakeModel).toBe(false) // the persona never sees it as identifiable
    expect(g.mayGenerateSpecs).toBe(false) // no dosage/strength
    expect(g.namingGranularity).toBe('none')
    expect(g.fixedRefusal).toBe(true)
  })

  test('safe-02: weapon → weapon_category_only; category naming only; binds the FOLLOW-UP loop too', () => {
    const c = safetyClassify({ weapon: 0.5 })
    expect(c.category).toBe('weapon')
    expect(c.action).toBe('weapon_category_only')

    const g = generationConstraintsFor(c.action)
    expect(g.mayIdentifyMakeModel).toBe(false) // no model
    expect(g.mayGenerateSpecs).toBe(false) // no caliber
    expect(g.namingGranularity).toBe('category') // "a revolver", not "a S&W Model 686 .357"
    expect(g.appliesToFollowUp).toBe(true) // the voice/text follow-up loop is bound by the same constraint
  })

  test('face-dominant → refuse_people (objects, never people)', () => {
    const c = safetyClassify({ faceAreaFraction: 0.6 })
    expect(c.category).toBe('person')
    expect(c.action).toBe('refuse_people')
    expect(generationConstraintsFor(c.action).mayIdentifyMakeModel).toBe(false)
  })

  test('safe-03: nsfw → block BEFORE persona', () => {
    const c = safetyClassify({ nsfw: 0.9 })
    expect(c.category).toBe('nsfw')
    expect(c.action).toBe('block')
    expect(generationConstraintsFor(c.action).blockedBeforePersona).toBe(true)
  })

  test('csam hash match → block before persona, hard confidence', () => {
    const c = safetyClassify({ csamHashMatch: true })
    expect(c.category).toBe('csam')
    expect(c.action).toBe('block')
    expect(c.confidence).toBe(1)
    expect(generationConstraintsFor(c.action).blockedBeforePersona).toBe(true)
  })
})

describe('false-positive bias (§8.4): over-refuse pill/weapon, never under-refuse', () => {
  test('a LOW pill suspicion still refuses (a harmless vitamin bottle is acceptable collateral)', () => {
    // just over the low FP-biased bar
    const c = safetyClassify({ pillMedical: DEFAULT_THRESHOLDS.pillMedical })
    expect(c.category).toBe('pill_medical')
    expect(c.action).toBe('refuse_medical')
  })

  test('a LOW weapon suspicion still refuses identification (a toy is acceptable collateral)', () => {
    const c = safetyClassify({ weapon: DEFAULT_THRESHOLDS.weapon })
    expect(c.category).toBe('weapon')
    expect(c.action).toBe('weapon_category_only')
  })

  test('the pill/weapon bars are LOWER than the nsfw bar (more aggressive on purpose)', () => {
    expect(DEFAULT_THRESHOLDS.pillMedical).toBeLessThan(DEFAULT_THRESHOLDS.nsfw)
    expect(DEFAULT_THRESHOLDS.weapon).toBeLessThan(DEFAULT_THRESHOLDS.nsfw)
  })
})

describe('precedence: the most-restrictive credible signal wins', () => {
  test('csam beats every soft signal', () => {
    const c = safetyClassify({ csamHashMatch: true, weapon: 0.9, pillMedical: 0.9, nsfw: 0.9 })
    expect(c.category).toBe('csam')
  })

  test('nsfw beats weapon/pill/person', () => {
    const c = safetyClassify({ nsfw: 0.9, weapon: 0.9, pillMedical: 0.9, faceAreaFraction: 0.9 })
    expect(c.category).toBe('nsfw')
  })

  test('weapon beats pill and person', () => {
    const c = safetyClassify({ weapon: 0.5, pillMedical: 0.9, faceAreaFraction: 0.9 })
    expect(c.category).toBe('weapon')
  })

  test('pill beats a co-occurring face (a pill bottle held near a face still refuses on medical)', () => {
    const c = safetyClassify({ pillMedical: 0.5, faceAreaFraction: 0.9 })
    expect(c.category).toBe('pill_medical')
  })
})

describe('ACTION_FOR contract is exhaustive and pinned', () => {
  test('every category maps to exactly one action', () => {
    expect(ACTION_FOR).toEqual({
      object: 'allow',
      person: 'refuse_people',
      pill_medical: 'refuse_medical',
      weapon: 'weapon_category_only',
      nsfw: 'block',
      csam: 'block',
    })
  })

  test('classify always returns the contract action for its category', () => {
    const cases = [
      { sig: { pillMedical: 0.5 }, cat: 'pill_medical' as const },
      { sig: { weapon: 0.5 }, cat: 'weapon' as const },
      { sig: { nsfw: 0.9 }, cat: 'nsfw' as const },
      { sig: { faceAreaFraction: 0.9 }, cat: 'person' as const },
      { sig: {}, cat: 'object' as const },
    ]
    for (const { sig, cat } of cases) {
      const c = safetyClassify(sig)
      expect(c.category).toBe(cat)
      expect(c.action).toBe(ACTION_FOR[cat])
    }
  })
})

describe('redactOrReject — fail-closed redact-or-reject (§8.4 / RT-2)', () => {
  const faces: RedactionRegion[] = [
    { kind: 'face', bbox: [0.1, 0.1, 0.2, 0.2], confidence: 0.99 },
    { kind: 'license_plate', bbox: [0.5, 0.5, 0.3, 0.1], confidence: 0.95 },
  ]

  test('no PII → no_redaction_needed', async () => {
    const plan = buildRedactionPlan([])
    expect(plan.requiresRedaction).toBe(false)
    const r = await redactOrReject(plan, async () => {
      throw new Error('should not be called')
    })
    expect(r.kind).toBe('no_redaction_needed')
  })

  test('full coverage → redacted', async () => {
    const plan = buildRedactionPlan(faces)
    expect(plan.requiresRedaction).toBe(true)
    const r = await redactOrReject(plan, async (p) => ({
      redactedObjectKey: 'redacted/k',
      coveredRegions: p.regions.length,
    }))
    expect(r.kind).toBe('redacted')
    if (r.kind === 'redacted') expect(r.redactedObjectKey).toBe('redacted/k')
  })

  test('redactor returns null → rejected (never store unredacted)', async () => {
    const plan = buildRedactionPlan(faces)
    const r = await redactOrReject(plan, async () => null)
    expect(r.kind).toBe('rejected')
  })

  test('redactor throws → rejected (fail-closed on exception)', async () => {
    const plan = buildRedactionPlan(faces)
    const r = await redactOrReject(plan, async () => {
      throw new Error('redactor timeout')
    })
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') expect(r.reason).toMatch(/threw/)
  })

  test('incomplete coverage → rejected (covered < required)', async () => {
    const plan = buildRedactionPlan(faces) // 2 regions
    const r = await redactOrReject(plan, async () => ({ redactedObjectKey: 'redacted/k', coveredRegions: 1 }))
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') expect(r.reason).toMatch(/1\/2/)
  })
})
