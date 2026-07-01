/**
 * Deterministic tests for the reveal ENRICHMENT mapping (ANALYSIS-VOICE-PLAN A1/A6–A9) — no Gemini, no creds.
 *
 * The live grounded call is proven by a spike; here we test the pure, load-bearing pieces: grounded segments
 * become citable evidence paired with their source URL, ungrounded segments are DROPPED (never citable), and the
 * per-scope prompt only exposes the honesty-safe keys (item vs class).
 */
import { test, expect, describe } from 'bun:test'
import { factsFromGrounding, researchPrompt, type ResearchInput } from './live-research'
import type { GroundingMetadata } from '../lib/gcp-vision'

describe('factsFromGrounding — grounded segments become citable evidence, ungrounded are dropped', () => {
  const grounding: GroundingMetadata = {
    groundingChunks: [
      { web: { uri: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1' } },
      { web: { uri: 'https://camerapedia.org/ae1', title: 'Camerapedia' } },
      { web: {} }, // a chunk with no uri
    ],
    groundingSupports: [
      { segment: { text: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' }, groundingChunkIndices: [0] },
      { segment: { text: 'It was among the first cameras with a microprocessor.' }, groundingChunkIndices: [1] },
      { segment: { text: 'An ungrounded aside with no source.' }, groundingChunkIndices: [] }, // dropped
      { segment: { text: 'Points only at a uri-less chunk.' }, groundingChunkIndices: [2] }, // dropped
      { segment: { text: '' }, groundingChunkIndices: [0] }, // empty → dropped
    ],
  }

  test('each grounded fact is paired with the URL of the chunk that grounds it', () => {
    const facts = factsFromGrounding(grounding)
    expect(facts).toHaveLength(2)
    expect(facts[0]).toEqual({ ref: 'fact1', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', claim: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' })
    expect(facts[1]!.sourceUrl).toBe('https://camerapedia.org/ae1')
    // refs are sequential over the KEPT facts (not the raw support index)
    expect(facts.map((f) => f.ref)).toEqual(['fact1', 'fact2'])
  })

  test('a segment with no grounding chunk (or a uri-less chunk, or empty text) is dropped — never citable', () => {
    const claims = factsFromGrounding(grounding).map((f) => f.claim)
    expect(claims).not.toContain('An ungrounded aside with no source.')
    expect(claims).not.toContain('Points only at a uri-less chunk.')
  })

  test('empty/absent grounding metadata → no facts (not a throw)', () => {
    expect(factsFromGrounding({})).toEqual([])
    expect(factsFromGrounding({ groundingSupports: [] })).toEqual([])
  })

  test('duplicate claims are deduped and the cap is honored', () => {
    const dup: GroundingMetadata = {
      groundingChunks: [{ web: { uri: 'https://x' } }],
      groundingSupports: Array.from({ length: 8 }, (_, i) => ({ segment: { text: i < 2 ? 'same fact' : `fact number ${i}` }, groundingChunkIndices: [0] })),
    }
    const facts = factsFromGrounding(dup, 5)
    expect(facts.length).toBeLessThanOrEqual(5)
    expect(facts.filter((f) => f.claim === 'same fact')).toHaveLength(1) // deduped
  })
})

describe('researchPrompt — scope exposes only the honesty-safe keys', () => {
  const base: ResearchInput = { scope: 'item', label: '1976 Canon AE-1', make: 'Canon', model: 'AE-1', year: 1976, category: 'camera' }

  test('item scope names the specific make/model in the subject', () => {
    const { system, user } = researchPrompt(base)
    expect(user).toContain('Canon AE-1')
    expect(system).toContain('THIS specific make/model')
  })

  test('class scope names ONLY the category — never a specific make/model', () => {
    const { system, user } = researchPrompt({ scope: 'class', label: 'a confident maybe', category: 'camera' })
    expect(user.toLowerCase()).toContain('camera')
    expect(user).not.toContain('Canon')
    expect(user).not.toContain('AE-1')
    expect(system).toContain('CATEGORY/CLASS only')
  })
})
