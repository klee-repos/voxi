import { test, expect, describe } from 'bun:test'
import { shouldCapture } from './policy'

describe('client capture policy', () => {
  test('captures genuine anomalies', () => {
    expect(shouldCapture(undefined)).toBe(true) // an uncaught throw
    expect(shouldCapture('render')).toBe(true)
    expect(shouldCapture('network')).toBe(true)
    expect(shouldCapture(500)).toBe(true)
    expect(shouldCapture(503)).toBe(true)
  })
  test('skips expected business outcomes (would burn the free quota + double-report)', () => {
    expect(shouldCapture('payment_required')).toBe(false)
    expect(shouldCapture('safety_refusal')).toBe(false)
    expect(shouldCapture('hard_failure')).toBe(false)
    expect(shouldCapture(402)).toBe(false)
    expect(shouldCapture(404)).toBe(false)
  })
})
