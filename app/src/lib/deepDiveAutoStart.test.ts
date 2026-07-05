import { test, expect, describe } from 'bun:test'
import { canAutoStartDeepDive } from './deepDiveAutoStart'

const YES = { offline: false, isRevisit: false, hasThreadId: true, band: 'CONFIDENT', bandIsUnknown: false, researchComplete: false, researchError: false, hasFirstFact: false }
const no = { offline: true, isRevisit: true, hasThreadId: false, band: null, bandIsUnknown: true, researchComplete: false, researchError: true, hasFirstFact: false }

describe('canAutoStartDeepDive — the decoupled threshold gate', () => {
  test("'min' mode fires on the FIRST fact, before researchComplete", () => {
    expect(canAutoStartDeepDive({ ...YES, mode: 'min', hasFirstFact: true, researchComplete: false })).toBe(true)
  })

  test("'min' mode also fires on researchComplete when the dossier yielded zero facts (no first fact)", () => {
    expect(canAutoStartDeepDive({ ...YES, mode: 'min', hasFirstFact: false, researchComplete: true })).toBe(true)
  })

  test("'min' mode: no fact + not complete → does NOT fire (waiting for minimum data)", () => {
    expect(canAutoStartDeepDive({ ...YES, mode: 'min', hasFirstFact: false, researchComplete: false })).toBe(false)
  })

  test("'done' mode ignores the first fact — only researchComplete fires (today's behavior)", () => {
    expect(canAutoStartDeepDive({ ...YES, mode: 'done', hasFirstFact: true, researchComplete: false })).toBe(false)
    expect(canAutoStartDeepDive({ ...YES, mode: 'done', hasFirstFact: true, researchComplete: true })).toBe(true)
  })

  test('hard-blocks apply regardless of mode: offline / revisit / no-thread / no-band / UNKNOWN / researchError', () => {
    for (const mode of ['min', 'done'] as const) {
      expect(canAutoStartDeepDive({ ...YES, mode, offline: true, researchComplete: true, hasFirstFact: true })).toBe(false)
      expect(canAutoStartDeepDive({ ...YES, mode, isRevisit: true, researchComplete: true, hasFirstFact: true })).toBe(false)
      expect(canAutoStartDeepDive({ ...YES, mode, hasThreadId: false, researchComplete: true, hasFirstFact: true })).toBe(false)
      expect(canAutoStartDeepDive({ ...YES, mode, band: null, researchComplete: true, hasFirstFact: true })).toBe(false)
      expect(canAutoStartDeepDive({ ...YES, mode, bandIsUnknown: true, researchComplete: true, hasFirstFact: true })).toBe(false)
      expect(canAutoStartDeepDive({ ...YES, mode, researchError: true, researchComplete: true, hasFirstFact: true })).toBe(false)
    }
  })

  test('the no-shorthand covers every hard-block (sanity)', () => {
    // every individual hard-block trigger, alone, forces false even at the most permissive setting
    const max = { mode: 'min' as const, offline: false, isRevisit: false, hasThreadId: true, band: 'CONFIDENT', bandIsUnknown: false, researchComplete: true, researchError: false, hasFirstFact: true }
    expect(canAutoStartDeepDive({ ...max, offline: no.offline })).toBe(false)
    expect(canAutoStartDeepDive({ ...max, isRevisit: no.isRevisit })).toBe(false)
    expect(canAutoStartDeepDive({ ...max, hasThreadId: no.hasThreadId })).toBe(false)
    expect(canAutoStartDeepDive({ ...max, band: no.band })).toBe(false)
    expect(canAutoStartDeepDive({ ...max, bandIsUnknown: no.bandIsUnknown })).toBe(false)
    expect(canAutoStartDeepDive({ ...max, researchError: no.researchError })).toBe(false)
  })
})
