/**
 * Regression tests for research-response parsing (the "Deep Dive generation failed" bug, RCA'd from the live
 * worker logs: reason "JSON Parse error: Expected '}'"). Grounded research is free-text (grounding is mutually
 * exclusive with a responseSchema), and ~15% of real responses embed UNESCAPED double-quotes inside a claim
 * value (scare-quotes like its "honest" sound) → strict JSON.parse throws → the whole render died with no retry.
 * `parseClaims` must recover the claims tolerantly; `extractJson`'s brace walk must be string-aware.
 *
 * The malformed payload below is a VERBATIM capture from a real failing grounded call for "Sony MDR-7506
 * Headphones" (note the unescaped quotes in the 7th claim) — the exact bytes the user's device choked on.
 */
import { describe, test, expect } from 'bun:test'
import { parseClaims, recoverClaims } from './providers'

const REAL_MALFORMED = `[
  { "claim": "The Sony MDR-7506 headphones were released in 1991 and have remained in production with virtually no changes since then." },
  { "claim": "These headphones were specifically designed and marketed for audio professionals, including sound engineers, producers, and broadcasters." },
  { "claim": "The MDR-7506 is known for its "honest" and "revealing" sound signature, particularly a mid-forward presence, which helps audio professionals identify flaws in recordings." },
  { "claim": "Its robust, foldable construction and relatively lightweight design contribute to its durability for professional use." }
]`

const VALID = `[
  { "claim": "A 35mm SLR camera." },
  { "claim": "Introduced in 1976." }
]`

describe('research JSON parsing — tolerant to the real failure mode', () => {
  test('strict path: valid JSON array yields every claim', () => {
    expect(parseClaims(VALID)).toEqual(['A 35mm SLR camera.', 'Introduced in 1976.'])
  })

  test('REGRESSION: a payload with unescaped inner quotes still yields ALL claims (would have crashed before)', () => {
    // Guard: the raw payload really is invalid JSON — i.e. this test would be meaningless if it happened to parse.
    expect(() => JSON.parse(REAL_MALFORMED)).toThrow()
    const claims = parseClaims(REAL_MALFORMED)
    expect(claims).toHaveLength(4)
    expect(claims[0]).toContain('released in 1991')
    // The offending claim is recovered intact, inner quotes and all.
    expect(claims[2]).toContain('honest')
    expect(claims[2]).toContain('revealing')
    expect(claims[2]).toContain('mid-forward presence')
  })

  test('recoverClaims survives a TRUNCATED tail (partial final object is dropped, complete ones kept)', () => {
    const truncated = `[
      { "claim": "Complete claim one." },
      { "claim": "Complete claim two." },
      { "claim": "This last one is cut off mid-sen`
    const claims = recoverClaims(truncated)
    expect(claims).toEqual(['Complete claim one.', 'Complete claim two.'])
  })

  test('handles a ```json fenced wrapper around the array', () => {
    const fenced = '```json\n' + VALID + '\n```'
    expect(parseClaims(fenced)).toEqual(['A 35mm SLR camera.', 'Introduced in 1976.'])
  })
})
