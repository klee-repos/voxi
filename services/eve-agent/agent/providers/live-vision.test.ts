/**
 * Deterministic coverage for the pure helpers in the live vision provider (PLAN §5, §8.3). The live Gemini/Vision
 * calls are exercised by the spikes; here we pin the honesty-critical pure logic — never assert a year from a
 * RANGE, and web verified_confidence reflects bestGuess↔entity AGREEMENT, not a raw unbounded relevance score.
 */
import { test, expect, describe } from 'bun:test'
import { parseYear, webConfidence } from './live-vision'
import type { WebDetect } from '../lib/gcp-vision'

describe('parseYear — a concrete year ONLY from a single unambiguous token', () => {
  test('a single year is asserted', () => {
    expect(parseYear('1976')).toBe(1976)
    expect(parseYear('circa 1965')).toBe(1965)
  })
  test('a RANGE never asserts a year (the schema field is year_or_range)', () => {
    expect(parseYear('1998-2004')).toBeUndefined()
    expect(parseYear('1959-1974')).toBeUndefined()
    expect(parseYear('1968–1974')).toBeUndefined() // en-dash
    expect(parseYear('between 1989 and 1995')).toBeUndefined()
  })
  test('no year → undefined', () => {
    expect(parseYear('Modern production')).toBeUndefined()
    expect(parseYear('')).toBeUndefined()
  })
})

describe('webConfidence — agreement-driven, not a raw entity score', () => {
  const wd = (bestGuess: string, entities: { description: string; score: number }[]): WebDetect => ({ bestGuess, entities, pages: [] })

  test('bestGuess NAMED by the entities → high confidence', () => {
    const c = webConfidence(wd('canon ae-1', [{ description: 'Canon AE-1', score: 0.9 }, { description: 'Canon', score: 0.7 }]))
    expect(c).toBeGreaterThanOrEqual(0.75)
  })

  test('a GENERIC bestGuess the entities do NOT name is NOT verified, even with a huge (>1) top entity score', () => {
    // entity relevance scores are unbounded; a 1.5 must not alone clear the webVerified bar for a bestGuess the
    // entities never mention.
    const c = webConfidence(wd('vintage chronograph', [{ description: 'Watch', score: 1.5 }, { description: 'Clock', score: 1.2 }]))
    expect(c).toBeLessThan(0.75)
  })

  test('confidence is always within 0..1 (the Candidate.confidence contract)', () => {
    const c = webConfidence(wd('rolex submariner', [{ description: 'Rolex Submariner', score: 3.2 }]))
    expect(c).toBeGreaterThanOrEqual(0)
    expect(c).toBeLessThanOrEqual(1)
  })
})
