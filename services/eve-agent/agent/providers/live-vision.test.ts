/**
 * Deterministic coverage for the pure helpers in the live vision provider (PLAN §5, §8.3). The live Gemini/Vision
 * calls are exercised by the spikes; here we pin the honesty-critical pure logic — never assert a year from a
 * RANGE, and web verified_confidence reflects bestGuess↔entity AGREEMENT, not a raw unbounded relevance score.
 */
import { test, expect, describe } from 'bun:test'
import { parseYear, webConfidence, cleanDisplayTitle, cleanField, observedBrandFrom, cleanIdentityField, isGenreLabel } from './live-vision'
import type { WebDetect } from '../lib/gcp-vision'

describe('cleanIdentityField — strips a trailing " or <alt>" the VLM smuggles into a make/model FIELD (F4)', () => {
  test('a trailing alternation is dropped (the Xbox bug: "Xbox Wireless Controller or wood")', () => {
    expect(cleanIdentityField('Xbox Wireless Controller or wood')).toBe('Xbox Wireless Controller')
    expect(cleanIdentityField('Microsoft or Sony')).toBe('Microsoft')
  })
  test('a real name that legitimately contains " or " earlier, or parentheses, is UNCHANGED (conservative)', () => {
    expect(cleanIdentityField('Guns N Roses')).toBe('Guns N Roses')
    expect(cleanIdentityField('AE-1 (Montréal Olympic Ed.)')).toBe('AE-1 (Montréal Olympic Ed.)') // parens preserved (an edition)
    expect(cleanIdentityField('Canon')).toBe('Canon')
    expect(cleanIdentityField(undefined)).toBeUndefined()
  })
  test('never blanks a field — if stripping nukes it, keep the original', () => {
    expect(cleanIdentityField('X or Y')).toBe('X or Y') // "X" is <2 chars after strip → keep original
  })
})

describe('isGenreLabel — a photo GENRE/medium label matched WHOLE-LABEL (never a substring) (F4)', () => {
  test('photo-technique labels are junk (they dragged the Xbox to a bogus PROBABLE)', () => {
    expect(isGenreLabel('still life photography')).toBe(true)
    expect(isGenreLabel('Still Life')).toBe(true)
    expect(isGenreLabel('photograph')).toBe(true)
    expect(isGenreLabel('product photography')).toBe(true)
    expect(isGenreLabel('close-up')).toBe(true)
  })
  test('a legit object whose name CONTAINS a genre word is NOT junk (whole-label match, not substring)', () => {
    expect(isGenreLabel('portrait lens')).toBe(false) // contains "portrait" but is a real object
    expect(isGenreLabel('Polaroid')).toBe(false)
    expect(isGenreLabel('Xbox Wireless Controller')).toBe(false)
    expect(isGenreLabel('macro lens')).toBe(false)
    expect(isGenreLabel(undefined)).toBe(false)
    expect(isGenreLabel('')).toBe(false)
  })
})

describe('cleanField — nulls a WHOLLY-filler identity field, never mangles a real name (D-6 / §13.3)', () => {
  test('a value that IS the non-answer becomes undefined (so it never pollutes label/subject/catalog-id)', () => {
    expect(cleanField('unbranded')).toBeUndefined()
    expect(cleanField('unspecified')).toBeUndefined()
    expect(cleanField('N/A')).toBeUndefined()
    expect(cleanField('')).toBeUndefined()
    expect(cleanField(undefined)).toBeUndefined()
  })
  test('a REAL brand containing a filler token survives UNCHANGED (adversarial #9 — the over-strip bug)', () => {
    expect(cleanField('Unknown Mortal Orchestra')).toBe('Unknown Mortal Orchestra')
    expect(cleanField('Various Artists')).toBe('Various Artists')
    expect(cleanField('Sub Pop')).toBe('Sub Pop')
    expect(cleanField('Canon')).toBe('Canon')
  })
})

describe('observedBrandFrom — a clean, corroborated, PII-safe brand read off the CHOSEN object (§13.3)', () => {
  test('derives the brand from the clean make when it is actually read off the object', () => {
    // the real Sub Pop capture: OCR is single letters, but distinguishing_features + display carry the contiguous mark
    expect(observedBrandFrom('Sub Pop', "S U B P O P Stylized text 'SUB POP' Sub Pop Logo")).toBe('Sub Pop')
    expect(observedBrandFrom('Canon', 'Canon EOS printed on the body')).toBe('Canon')
  })
  test('NOT corroborated on the object → no observed brand (binds to the primary object, not a background logo)', () => {
    expect(observedBrandFrom('Sub Pop', 'a plain white ceramic mug with tea')).toBeUndefined()
  })
  test('a wholly-filler make yields no observed brand', () => {
    expect(observedBrandFrom('unbranded', 'a plain mug')).toBeUndefined()
    expect(observedBrandFrom(undefined, 'anything')).toBeUndefined()
  })
  test('a PII/junk span never becomes citable observed evidence (adversarial #8)', () => {
    expect(observedBrandFrom('555 1234', '555 1234 printed here')).toBeUndefined() // digit run
    expect(observedBrandFrom('a@b.com', 'a@b.com on the label')).toBeUndefined() // email
    expect(observedBrandFrom('®', '®')).toBeUndefined() // mark only
  })
})

describe('cleanDisplayTitle — strips filler / non-answer words from the reveal title', () => {
  test('a hedge prefix is removed, the real object survives', () => {
    expect(cleanDisplayTitle('Unspecified Parliament Blue')).toBe('Parliament Blue')
    expect(cleanDisplayTitle('Generic Office Chair')).toBe('Office Chair')
    expect(cleanDisplayTitle('Assorted Ceramic Mug')).toBe('Ceramic Mug')
    expect(cleanDisplayTitle('Unbranded Plywood Board')).toBe('Plywood Board')
  })
  test('a clean title passes through unchanged', () => {
    expect(cleanDisplayTitle('Canon AE-1')).toBe('Canon AE-1')
    expect(cleanDisplayTitle('La Croix Sparkling Water')).toBe('La Croix Sparkling Water')
  })
  test('an all-filler / empty value → undefined (caller falls back to the arbitrated label)', () => {
    expect(cleanDisplayTitle('Unspecified')).toBeUndefined()
    expect(cleanDisplayTitle('Unknown / N/A')).toBeUndefined()
    expect(cleanDisplayTitle('')).toBeUndefined()
    expect(cleanDisplayTitle(undefined)).toBeUndefined()
  })
})

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
