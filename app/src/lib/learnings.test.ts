import { test, expect, describe } from 'bun:test'
import { currentLearning, learningsList } from './learnings'
import type { RevealFact, RevealSection } from '../state/captureStore'

const fact = (i: number) => ({ text: `fact ${i}`, sourceUrl: `https://s${i}.com`, sourceTitle: `S${i}`, quote: '' })
const sec = (text: string) => ({ text, sourceUrl: 'https://m.com', sourceTitle: 'M', quote: '' })

describe('learningsList — arrival-ordered grounded learnings', () => {
  test('facts then grounded sections, newest-last', () => {
    const out = learningsList({ facts: [fact(1), fact(2)], sections: { purpose: sec('P'), maker: sec('Ma') } })
    expect(out).toEqual(['fact 1', 'fact 2', 'P', 'Ma'])
  })
  test('empty-marker section (text="") is skipped', () => {
    expect(learningsList({ facts: [], sections: { purpose: sec('') } })).toEqual([])
  })
  test('made (when-made) is included as a learning', () => {
    expect(learningsList({ facts: [], sections: { made: sec('2008') } })).toEqual(['2008'])
  })
})

describe('currentLearning — the cycle', () => {
  test('no learnings → the Researching placeholder (drives the dots)', () => {
    const c = currentLearning({ facts: [], sections: {} }, 0)
    expect(c.placeholder).toBe(true)
    expect(c.text).toBe('Researching')
  })
  test('cycle index 0 → the first learning', () => {
    const c = currentLearning({ facts: [fact(1), fact(2)], sections: {} }, 0)
    expect(c.placeholder).toBe(false)
    expect(c.text).toBe('fact 1')
  })
  test('cycle index wraps via modulo', () => {
    const items = currentLearning({ facts: [fact(1), fact(2), fact(3)], sections: {} }, 7)
    expect(items.text).toBe('fact 2') // 7 % 3 = 1
  })
  test('negative index wraps (defensive)', () => {
    expect(currentLearning({ facts: [fact(1), fact(2)], sections: {} }, -1).text).toBe('fact 2') // -1 % 2 = 1
  })
  test('fullText equals text (for the accessibilityLabel)', () => {
    const c = currentLearning({ facts: [fact(1)], sections: {} }, 0)
    expect(c.fullText).toBe(c.text)
  })
  test('as new facts arrive, the list grows + the cycle re-wraps (a new fact enters the rotation)', () => {
    const one = learningsList({ facts: [fact(1)], sections: {} })
    const two = learningsList({ facts: [fact(1), fact(2)], sections: {} })
    expect(one).toHaveLength(1)
    expect(two).toHaveLength(2)
    expect(currentLearning({ facts: [fact(1), fact(2)], sections: {} }, 1).text).toBe('fact 2')
  })
})
