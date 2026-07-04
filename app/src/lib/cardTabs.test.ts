import { test, expect, describe } from 'bun:test'
import { nextTab } from './cardTabs'

const TABS = ['what', 'purpose', 'maker', 'facts'] as const

describe('nextTab (swipe clamp)', () => {
  test('forward (dir=+1) advances one tab', () => {
    expect(nextTab('what', 1, TABS)).toBe('purpose')
    expect(nextTab('purpose', 1, TABS)).toBe('maker')
    expect(nextTab('maker', 1, TABS)).toBe('facts')
  })

  test('back (dir=-1) goes one tab back', () => {
    expect(nextTab('facts', -1, TABS)).toBe('maker')
    expect(nextTab('purpose', -1, TABS)).toBe('what')
  })

  test('[CRIT] clamp at the ends — a swipe past the first/last tab is a NO-OP, never wraps', () => {
    expect(nextTab('what', -1, TABS)).toBeNull()
    expect(nextTab('facts', 1, TABS)).toBeNull()
  })

  test('current not in tabs → null (defensive; the card always passes a live bucket)', () => {
    expect(nextTab('nope', 1, TABS)).toBeNull()
  })

  test('a single-tab list clamps in both directions (the common PROBABLE single-bucket card)', () => {
    expect(nextTab('only', 1, ['only'])).toBeNull()
    expect(nextTab('only', -1, ['only'])).toBeNull()
  })
})
