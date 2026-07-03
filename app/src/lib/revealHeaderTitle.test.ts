import { test, expect, describe } from 'bun:test'
import { revealHeaderTitle, IDENTIFYING_FALLBACK } from './revealHeaderTitle'

describe('revealHeaderTitle — the one-bar title slot', () => {
  test('null band → the Identifying placeholder (pre-settle), regardless of any title', () => {
    expect(revealHeaderTitle(null, '')).toEqual({ kind: 'identifying' })
    // band gates the slot, not the title — a stale title with no band is still "Identifying".
    expect(revealHeaderTitle(null, 'Eames Lounge Chair')).toEqual({ kind: 'identifying' })
  })

  test('a settled band → the object name, for every band', () => {
    for (const band of ['CONFIDENT', 'PROBABLE', 'UNKNOWN'] as const) {
      expect(revealHeaderTitle(band, 'Eames Lounge Chair')).toEqual({ kind: 'name', text: 'Eames Lounge Chair' })
    }
  })

  test('a settled band with an empty / whitespace name → the whimsical fallback (preserves prior title||… behavior)', () => {
    expect(revealHeaderTitle('CONFIDENT', '')).toEqual({ kind: 'name', text: IDENTIFYING_FALLBACK })
    expect(revealHeaderTitle('PROBABLE', '   ')).toEqual({ kind: 'name', text: IDENTIFYING_FALLBACK })
  })

  test('a long name is returned verbatim (the bar truncates visually via numberOfLines; the value is intact)', () => {
    const long = 'Isamu Noguchi Akari 1A Light Sculpture'
    expect(revealHeaderTitle('CONFIDENT', long)).toEqual({ kind: 'name', text: long })
  })
})
