import { test, expect, describe } from 'bun:test'
import { estimateProgress, formatElapsed, formatClock, PROGRESS_CAP, seekTargetSeconds } from './composeProgress'

describe('estimateProgress — honest, eased, capped', () => {
  test('non-positive / invalid elapsed → 0', () => {
    expect(estimateProgress(0, 120_000)).toBe(0)
    expect(estimateProgress(-1, 120_000)).toBe(0)
    expect(estimateProgress(NaN, 120_000)).toBe(0)
    expect(estimateProgress(Infinity, 120_000)).toBe(0) // invalid input guarded → 0 (never NaN/>1)
  })

  test('monotonic increasing in elapsed', () => {
    let prev = -1
    for (let t = 0; t <= 600_000; t += 10_000) {
      const p = estimateProgress(t, 120_000)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })

  test('never reaches 1.0 — asymptotes below the cap (no fake "done")', () => {
    expect(estimateProgress(60_000, 120_000)).toBeLessThan(PROGRESS_CAP + 0.0001)
    expect(estimateProgress(10_000_000, 120_000)).toBe(PROGRESS_CAP)
    expect(estimateProgress(10_000_000, 120_000)).toBeLessThan(1)
  })

  test('~2min typical → ~63% at 1 min (τ = typical/3 = 40s → 1-e^-1.5 ≈ 0.777)', () => {
    // elapsed 60s, τ=40s → 1 - e^(-60/40) = 1 - e^-1.5 ≈ 0.7769
    expect(estimateProgress(60_000, 120_000)).toBeCloseTo(0.7769, 2)
  })

  test('invalid typical falls back to a sane default (no NaN/Infinity)', () => {
    const p = estimateProgress(30_000, 0)
    expect(Number.isFinite(p)).toBe(true)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThanOrEqual(PROGRESS_CAP)
  })
})

describe('formatClock / formatElapsed', () => {
  test('m:ss under an hour', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(62)).toBe('1:02')
    expect(formatClock(599)).toBe('9:59')
  })
  test('h:mm:ss at/over an hour (matches the Spotify -1:03:18 form)', () => {
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(3798)).toBe('1:03:18')
  })
  test('negative / NaN / Infinity → 0:00 (unloaded duration renders cleanly)', () => {
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(NaN)).toBe('0:00')
    expect(formatClock(Infinity)).toBe('0:00')
  })
  test('formatElapsed takes ms', () => {
    expect(formatElapsed(62_000)).toBe('1:02')
    expect(formatElapsed(-1)).toBe('0:00')
  })
})

describe('seekTargetSeconds — the scrubber tap/drag → seconds math (the on-device seek)', () => {
  test('maps x across the track width to a proportional second in [0, duration]', () => {
    expect(seekTargetSeconds(0, 200, 30)).toBe(0) // far left → start
    expect(seekTargetSeconds(200, 200, 30)).toBe(30) // far right → end
    expect(seekTargetSeconds(100, 200, 30)).toBe(15) // middle → half
    expect(seekTargetSeconds(140, 200, 30)).toBeCloseTo(21, 5) // 70% → 0.7 * 30
  })

  test('clamps out-of-range x to [0, duration] (a drag past either edge)', () => {
    expect(seekTargetSeconds(-50, 200, 30)).toBe(0)
    expect(seekTargetSeconds(9999, 200, 30)).toBe(30)
  })

  test('returns null (no-op, never a NaN seek) when not yet seekable', () => {
    expect(seekTargetSeconds(100, 0, 30)).toBeNull() // width not measured
    expect(seekTargetSeconds(100, 200, 0)).toBeNull() // duration unknown
    expect(seekTargetSeconds(Number.NaN, 200, 30)).toBeNull() // no locationX
    expect(seekTargetSeconds(100, 200, Number.POSITIVE_INFINITY)).toBeNull()
  })
})
