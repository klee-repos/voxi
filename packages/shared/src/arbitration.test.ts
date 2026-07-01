/**
 * Honesty regression tests for arbitrate() (PLAN §5.4 / eng-F3) — locking in the fixes an adversarial review of
 * the live tier surfaced. The load-bearing invariant: a NOISY/wrong web label can NEVER be asserted as CONFIDENT
 * over a competing structured VLM, at ANY VLM confidence; the chosen identity is always the STRUCTURED candidate.
 */
import { test, expect, describe } from 'bun:test'
import { arbitrate, type Candidate } from './arbitration'

const vlm = (make: string, model: string, confidence = 0.6): Candidate => ({ name: `${make} ${model}`, make, model, source: 'vlm', confidence })
const web = (name: string, confidence: number, aka: string[] = []): Candidate => ({ name, source: 'web', confidence, aka })

describe('arbitrate — a MODERATE contradicting VLM still hedges (the Omega-speedtimer bug, 0.5–0.69 band)', () => {
  test('vlm Omega Speedmaster @0.6 vs verified web "omega speedtimer" → PROBABLE + both, NOT CONFIDENT web', () => {
    const r = arbitrate({ vlm: vlm('Omega', 'Speedmaster', 0.6), web: web('omega speedtimer', 0.95, ['Omega', 'Speedtimer watch']) })
    expect(r.band).toBe('PROBABLE')
    expect(r.route).toBe('confirm')
    expect(r.candidates).toHaveLength(2)
    // the wrong free-text web label must NEVER be the confidently-chosen identity
    expect(r.chosen?.name).not.toBe('omega speedtimer')
    expect(r.band).not.toBe('CONFIDENT')
  })
})

describe('arbitrate — corroboration is WHOLE-TOKEN (no substring "fm" ⊂ "fm2")', () => {
  test('vlm "Nikon FM" vs web "nikon fm2" (a DIFFERENT model) → contradiction → PROBABLE, never a confident "Nikon FM"', () => {
    const r = arbitrate({ vlm: vlm('Nikon', 'FM', 0.85), web: web('nikon fm2', 0.9, ['Nikon', 'Nikon FM2']) })
    expect(r.band).toBe('PROBABLE')
    expect(r.candidates.map((c) => c.name)).toContain('Nikon FM')
    expect(r.candidates.map((c) => c.name)).toContain('nikon fm2')
  })

  test('a short base model ("F") IS corroborated when the entities carry it as a whole token → CONFIDENT, chosen=VLM', () => {
    const r = arbitrate({ vlm: vlm('Nikon', 'F', 0.85), web: web('nikon f', 0.9, ['Nikon F', 'Nikon', '35mm camera']) })
    expect(r.band).toBe('CONFIDENT')
    expect(r.chosen?.source).toBe('vlm') // the STRUCTURED VLM is the identity, not the free-text web label
    expect(r.chosen?.name).toBe('Nikon F')
  })
})

describe('arbitrate — web corroborates via its entity aka[] even when the headline bestGuess is noisy', () => {
  test('generic/low-confidence bestGuess but entities NAME the make+model → CONFIDENT chosen=VLM (entities are the grounding)', () => {
    // web.confidence is LOW (0.4, a generic bestGuess) — corroboration comes from the ENTITIES, not the bestGuess,
    // so the VLM is still confidently confirmed. (This is the step-2/step-5 decoupling: entity corroboration
    // verifies a VLM identity independent of whether the web's OWN headline label is trustworthy.)
    const r = arbitrate({
      vlm: vlm('Leica', 'M3', 0.8),
      web: web('vintage rangefinder', 0.4, ['Leica M3', 'Leica', 'Rangefinder camera']),
    })
    expect(r.band).toBe('CONFIDENT')
    expect(r.chosen?.name).toBe('Leica M3')
    expect(r.chosen?.source).toBe('vlm')
  })
})

describe('arbitrate — an UNGROUNDED lone VLM never reaches CONFIDENT', () => {
  test('a strong VLM (0.9) with no web/catalog grounding → PROBABLE, not CONFIDENT', () => {
    const r = arbitrate({ vlm: vlm('Acme', 'Widget', 0.9) })
    expect(r.band).toBe('PROBABLE')
    expect(r.band).not.toBe('CONFIDENT')
  })
})

describe('arbitrate — a vague VLM does NOT block a verified web (only a CONCRETE contradiction hedges)', () => {
  test('web verified + vlm with no model → web may still be confident (no real disagreement)', () => {
    const r = arbitrate({ vlm: { name: 'a camera', make: 'Nikon', source: 'vlm', confidence: 0.4 }, web: web('Nikon F', 0.9, ['Nikon F', 'Nikon']) })
    expect(r.band).toBe('CONFIDENT')
    expect(r.chosen?.name).toBe('Nikon F')
  })
})
