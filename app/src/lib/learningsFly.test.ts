import { test, expect, describe } from 'bun:test'
import { computeFlyPath, rectIsValid, FLY_DURATION_MS, FLY_SCALE_TO } from './learningsFly'

describe('rectIsValid — the measure-race guard', () => {
  test('null/undefined → false', () => {
    expect(rectIsValid(null)).toBe(false)
    expect(rectIsValid(undefined)).toBe(false)
  })
  test('zero size (measureInWindow pre-layout) → false', () => {
    expect(rectIsValid({ x: 0, y: 0, w: 0, h: 0 })).toBe(false)
    expect(rectIsValid({ x: 100, y: 100, w: 0, h: 50 })).toBe(false)
  })
  test('non-zero size → true', () => {
    expect(rectIsValid({ x: 10, y: 10, w: 200, h: 48 })).toBe(true)
  })
})

describe('computeFlyPath — the clone travel geometry', () => {
  test('from = bar center, to = icon center, dx/dy = end - start', () => {
    const p = computeFlyPath({ x: 40, y: 600, w: 300, h: 48 }, { x: 160, y: 780, w: 44, h: 44 })
    // bar center: (190, 624); icon center: (182, 802)
    expect(p.fromX).toBe(190)
    expect(p.fromY).toBe(624)
    expect(p.toX).toBe(182)
    expect(p.toY).toBe(802)
    expect(p.dx).toBe(-8)
    expect(p.dy).toBe(178)
  })
  test('duration + scaleTo are the constants the component animates against', () => {
    const p = computeFlyPath({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 44, h: 44 })
    expect(p.durationMs).toBe(FLY_DURATION_MS)
    expect(p.scaleTo).toBe(FLY_SCALE_TO)
    expect(p.scaleTo).toBeLessThan(0.3) // the clone clearly shrinks into the icon
  })
  test('a straight-up fly (bar directly above icon) → dx=0, dy>0', () => {
    const p = computeFlyPath({ x: 100, y: 600, w: 100, h: 48 }, { x: 100, y: 780, w: 100, h: 44 })
    expect(p.dx).toBe(0) // both centers at x=150
    expect(p.dy).toBe(178) // 802 - 624
  })
})
