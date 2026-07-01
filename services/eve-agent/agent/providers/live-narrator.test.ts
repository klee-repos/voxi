/**
 * Deterministic coverage for the narrator's honesty wiring (PLAN §6/§8.3) — no Gemini. We feed drafted clauses
 * straight into the pure `gateNarration` (the same REAL shared honesty gate the live path uses) and assert:
 *   - the BAND is the source of truth: CONFIDENT lets the model be asserted (cites "id"); PROBABLE/UNKNOWN drop
 *     any model-asserting clause because the "id" evidence does not exist → the persona is FORCED to hedge;
 *   - falsifiable claims without a valid web evidence ref are dropped;
 *   - a `flavor` clause smuggling a year/spec is caught by the independent auditor.
 */
import { test, expect, describe } from 'bun:test'
import { gateNarration, narrationEvidence, smugglesFalsifiable, type NarrationInput } from './live-narrator'
import type { Clause } from '../../../../packages/shared/src/confidence'

const webEv = [{ ref: 'w1', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', claim: 'The Canon AE-1 is a 35mm SLR film camera introduced in 1976.' }]
const base: NarrationInput = { label: '1976 Canon AE-1', band: 'CONFIDENT', evidence: webEv, unsupportedFields: [], candidates: ['1976 Canon AE-1'] }

describe('narrationEvidence — the band-as-evidence rule', () => {
  test('CONFIDENT exposes a citable "id" ref for the confirmed identity', () => {
    expect(narrationEvidence(base).some((e) => e.ref === 'id')).toBe(true)
  })
  test('PROBABLE / UNKNOWN do NOT expose the "id" ref (identity not confirmed)', () => {
    expect(narrationEvidence({ ...base, band: 'PROBABLE' }).some((e) => e.ref === 'id')).toBe(false)
    expect(narrationEvidence({ ...base, band: 'UNKNOWN' }).some((e) => e.ref === 'id')).toBe(false)
  })
})

describe('gateNarration — CONFIDENT may assert the model, PROBABLE is forced to hedge', () => {
  const identityClause: Clause = { text: "It's a 1976 Canon AE-1.", claimType: 'date', evidenceRef: 'id' }
  const flavor: Clause = { text: 'A handsome, workmanlike thing.', claimType: 'flavor' }

  test('CONFIDENT: the identity clause citing "id" is approved', () => {
    const r = gateNarration(base, [identityClause, flavor])
    expect(r.clauses).toContain("It's a 1976 Canon AE-1.")
    expect(r.dropped).toBe(0)
  })

  test('PROBABLE: the SAME model-asserting clause is DROPPED (no "id" evidence → hedge enforced)', () => {
    const r = gateNarration({ ...base, band: 'PROBABLE' }, [identityClause, flavor])
    expect(r.clauses).not.toContain("It's a 1976 Canon AE-1.")
    expect(r.clauses).toContain('A handsome, workmanlike thing.') // flavor survives
    expect(r.dropped).toBe(1)
  })
})

describe('gateNarration — falsifiable claims need real grounding; auditor catches smuggling', () => {
  test('a spec clause with NO evidence ref is dropped', () => {
    const r = gateNarration(base, [{ text: 'It weighs exactly 590 grams.', claimType: 'spec' }])
    expect(r.clauses).toHaveLength(0)
    expect(r.dropped).toBe(1)
  })

  test('a provenance clause citing a REAL web ref is approved', () => {
    const r = gateNarration(base, [{ text: 'It is a 35mm SLR film camera.', claimType: 'provenance', evidenceRef: 'w1' }])
    expect(r.clauses).toHaveLength(1)
  })

  test('a flavor clause smuggling a YEAR is rejected by the independent auditor', () => {
    const r = gateNarration(base, [{ text: 'Everyone owned one back in 1981.', claimType: 'flavor' }])
    expect(r.clauses).toHaveLength(0)
    expect(r.dropped).toBe(1)
  })

  test('citing a ref that is NOT in the closed evidence[] is rejected (no phantom refs)', () => {
    const r = gateNarration(base, [{ text: 'Designed by a committee of geniuses.', claimType: 'provenance', evidenceRef: 'nope' }])
    expect(r.clauses).toHaveLength(0)
  })
})

describe('gateNarration — a GROUNDED year reaches the user as a cited date clause (A6)', () => {
  const grounded = { ref: 'fact1', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', claim: 'The Canon AE-1 was introduced in 1976.' }
  const withFact: NarrationInput = { ...base, unsupportedFields: ['year'], evidence: [...webEv, grounded] }

  test('a date clause citing a grounded research fact is APPROVED even when year is an unsupported field', () => {
    const r = gateNarration(withFact, [{ text: 'It was introduced in 1976.', claimType: 'date', evidenceRef: 'fact1' }])
    expect(r.clauses).toContain('It was introduced in 1976.')
    expect(r.dropped).toBe(0)
  })

  test('the SAME year clause with NO grounded ref is still dropped (the gate is unchanged)', () => {
    const r = gateNarration(withFact, [{ text: 'It was introduced in 1976.', claimType: 'date' }])
    expect(r.clauses).toHaveLength(0)
    expect(r.dropped).toBe(1)
  })
})

describe('smugglesFalsifiable — the flavor auditor (broadened, A7)', () => {
  test('flags a year and a measured spec, passes pure flavor', () => {
    expect(smugglesFalsifiable('a classic of 1976')).toBe(true)
    expect(smugglesFalsifiable('a svelte 590 g body')).toBe(true)
    expect(smugglesFalsifiable('a handsome, unpretentious thing')).toBe(false)
  })

  test('flags NON-numeric smuggled falsifiables: named provenance, superlatives, causal/comparative', () => {
    expect(smugglesFalsifiable('designed by Canon Engineers')).toBe(true) // proper-noun run (provenance)
    expect(smugglesFalsifiable('the first SLR of its kind')).toBe(true) // superlative
    expect(smugglesFalsifiable('which is why it outsold its rivals')).toBe(true) // causal
    expect(smugglesFalsifiable('lighter than most of its peers')).toBe(true) // comparative
    // pure, non-falsifiable flavor still passes (no false-positive drop of legitimate wit)
    expect(smugglesFalsifiable('a handsome, workmanlike thing')).toBe(false)
    expect(smugglesFalsifiable('an object of quiet, unshowy competence')).toBe(false)
  })
})
