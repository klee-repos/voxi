import { test, expect, describe } from 'bun:test'
import { splitWords, computeWordTimings, activeWordIndex } from './karaokeTiming'

const T = (arlo: string, mave: string) => [
  { speaker: 'ARLO', text: arlo },
  { speaker: 'MAVE', text: mave },
]

describe('splitWords', () => {
  test('whitespace-splits and drops empties', () => {
    expect(splitWords('  hello   world ')).toEqual(['hello', 'world'])
    expect(splitWords('')).toEqual([])
    expect(splitWords('one')).toEqual(['one'])
  })
})

describe('computeWordTimings', () => {
  test('empty transcript → no timings', () => {
    expect(computeWordTimings([], 60)).toEqual([])
    expect(computeWordTimings([{ speaker: 'ARLO', text: '   ' }], 60)).toEqual([])
  })

  test('intervals are contiguous, monotonic, and span exactly [0, duration]', () => {
    const t = computeWordTimings(T('the quick brown fox', 'jumps over'), 30)
    expect(t.length).toBe(6)
    expect(t[0]!.start).toBe(0)
    expect(t[t.length - 1]!.end).toBeCloseTo(30, 5)
    for (let i = 1; i < t.length; i++) {
      expect(t[i]!.start).toBeCloseTo(t[i - 1]!.end, 6) // contiguous
      expect(t[i]!.start).toBeGreaterThan(t[i - 1]!.start) // strictly increasing
    }
  })

  test('longer words get proportionally more time (char-weighted)', () => {
    const t = computeWordTimings([{ speaker: 'ARLO', text: 'a elephant' }], 12)
    const aDur = t[0]!.end - t[0]!.start // "a" = weight 2
    const eDur = t[1]!.end - t[1]!.start // "elephant" = weight 9
    expect(eDur).toBeGreaterThan(aDur)
  })

  test('carries the line + wordInLine mapping across speakers', () => {
    const t = computeWordTimings(T('one two', 'three'), 9)
    expect(t.map((w) => [w.line, w.wordInLine])).toEqual([
      [0, 0], [0, 1], [1, 0],
    ])
  })

  test('invalid duration (0 / NaN / Infinity) → all-zero intervals (no highlight until real duration)', () => {
    for (const d of [0, -5, NaN, Infinity]) {
      const t = computeWordTimings(T('the quick brown', 'fox'), d)
      expect(t.every((w) => w.start === 0 && w.end === 0)).toBe(true)
    }
  })
})

describe('activeWordIndex', () => {
  const t = computeWordTimings(T('the quick brown fox', 'jumps over'), 60) // 6 words over 60s

  test('empty timings → -1', () => {
    expect(activeWordIndex(5, [])).toBe(-1)
  })

  test('zero-span timings (unloaded duration) → -1', () => {
    const z = computeWordTimings(T('the quick', 'fox'), NaN)
    expect(activeWordIndex(1, z)).toBe(-1)
  })

  test('pos 0 → first word', () => {
    expect(activeWordIndex(0, t)).toBe(0)
  })

  test('advances monotonically as the playhead moves', () => {
    let prev = -1
    for (let p = 0; p <= 60; p += 5) {
      const idx = activeWordIndex(p, t)
      expect(idx).toBeGreaterThanOrEqual(prev) // non-decreasing
      prev = idx
    }
  })

  test('mid-playback lands on the containing word', () => {
    // 6 words, equal-ish weights; at ~55% of 60s we should be past the first half.
    const idx = activeWordIndex(33, t)
    expect(idx).toBeGreaterThanOrEqual(3)
    expect(idx).toBeLessThanOrEqual(5)
  })

  test('past the end stays on the last word (clean finish, no flicker to -1)', () => {
    expect(activeWordIndex(120, t)).toBe(t.length - 1)
  })

  test('a seek forward strictly increases the active index', () => {
    const early = activeWordIndex(2, t)
    const late = activeWordIndex(50, t)
    expect(late).toBeGreaterThan(early)
  })
})

describe('computeWordTimings — REAL per-clause timing (endSec) is accurate + drift-bounded', () => {
  const TX = [
    { speaker: 'ARLO', text: 'one two', endSec: 4 }, // clause 0 ends at 4s
    { speaker: 'MAVE', text: 'three four five', endSec: 10 }, // clause 1 ends at 10s
  ]

  test('syncs to clause endSec boundaries, SCALED to the real audio duration', () => {
    const t = computeWordTimings(TX, 20) // real duration 20s; lastEnd 10 → scale ×2 → clause ends 8, 20
    expect(t.length).toBe(5)
    expect(t[0]!.start).toBe(0)
    const c0 = t.filter((w) => w.line === 0)
    const c1 = t.filter((w) => w.line === 1)
    expect(c0[c0.length - 1]!.end).toBeCloseTo(8, 5) // clause 0 ends at its scaled real time
    expect(c1[0]!.start).toBeCloseTo(8, 5) // clause 1 begins exactly there
    expect(c1[c1.length - 1]!.end).toBeCloseTo(20, 5) // and ends at the real duration
  })

  test('drift is bounded WITHIN a clause — a later clause always starts at its real time', () => {
    const t = computeWordTimings(TX, 10) // lastEnd 10 == dur 10 → no scaling
    const c1 = t.filter((w) => w.line === 1)
    expect(c1[0]!.start).toBeCloseTo(4, 5) // clause 1 pinned to clause 0's real end (no accumulated drift)
  })

  test('the active word advances monotonically over the real timeline', () => {
    const t = computeWordTimings(TX, 10)
    let prev = -1
    for (let p = 0; p <= 10; p += 1) {
      const idx = activeWordIndex(p, t)
      expect(idx).toBeGreaterThanOrEqual(prev)
      prev = idx
    }
  })

  test('falls back to the estimate when only SOME clauses carry endSec (mixed / legacy)', () => {
    const partial = [
      { speaker: 'ARLO', text: 'one two', endSec: 4 },
      { speaker: 'MAVE', text: 'three four' }, // no endSec → not fully-timed → estimate path
    ]
    const t = computeWordTimings(partial, 30)
    expect(t[t.length - 1]!.end).toBeCloseTo(30, 5) // estimate spans the full real duration
  })
})
