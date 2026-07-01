/**
 * Deterministic coverage for the SafeSearch→policy-category mapping (PLAN §8.4). The LIVE Cloud Vision call is
 * exercised by the live spikes; here we pin the PURE mapping (`classifySafeSearch`) so its policy logic —
 * highest-severity-wins, medical false-positive bias, safe floor — is verified with no creds.
 */
import { test, expect, describe } from 'bun:test'
import { classifySafeSearch } from './live-safety'

const base = { adult: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY' }

describe('classifySafeSearch', () => {
  test('all clear → safe', () => {
    expect(classifySafeSearch(base).category).toBe('safe')
  })

  test('adult VERY_LIKELY → nsfw with high confidence', () => {
    const r = classifySafeSearch({ ...base, adult: 'VERY_LIKELY' })
    expect(r.category).toBe('nsfw')
    expect(r.confidence).toBeGreaterThanOrEqual(0.9)
  })

  test('medical POSSIBLE → pills_medical (false-positive biased: a weak signal still flags)', () => {
    const r = classifySafeSearch({ ...base, medical: 'POSSIBLE' })
    expect(r.category).toBe('pills_medical')
    expect(r.confidence).toBe(0.5)
  })

  test('violence LIKELY → weapon (closest SafeSearch proxy)', () => {
    expect(classifySafeSearch({ ...base, violence: 'LIKELY' }).category).toBe('weapon')
  })

  test('highest-severity category wins when several fire', () => {
    // adult VERY_LIKELY (0.95) beats medical POSSIBLE (0.5) → nsfw.
    expect(classifySafeSearch({ ...base, adult: 'VERY_LIKELY', medical: 'POSSIBLE' }).category).toBe('nsfw')
  })

  test('a racy-only image is dampened (racy is weighted below adult) and can fall back to safe', () => {
    // racy UNLIKELY (0.2 * 0.7 = 0.14) is below the 0.3 actionable floor → safe.
    expect(classifySafeSearch({ ...base, racy: 'UNLIKELY' }).category).toBe('safe')
  })
})
