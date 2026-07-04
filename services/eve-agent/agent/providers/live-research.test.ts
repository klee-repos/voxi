/**
 * Deterministic tests for the reveal ENRICHMENT mapping (ANALYSIS-VOICE-PLAN A1/A6–A9) — no GLM, no Firecrawl, no creds.
 *
 * The live Firecrawl→GLM grounded call is proven by a spike; here we test the pure, load-bearing pieces: extracted
 * facts become citable evidence paired with their source URL, facts missing a quote/source are DROPPED (never citable),
 * and the per-scope subject exposes only the honesty-safe keys (item vs class).
 */
import { test, expect, describe } from 'bun:test'
import { factsToEvidence, researchSubject, type ResearchInput } from './live-research'

describe('factsToEvidence — extracted facts become citable evidence; missing quote/source dropped', () => {
  test('each fact with a quote + sourceUrl becomes sequential citable evidence', () => {
    const facts = factsToEvidence([
      { quote: 'The Canon AE-1 is a 35mm SLR introduced in 1976.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1' },
      { quote: 'It was among the first cameras with a microprocessor.', sourceUrl: 'https://camerapedia.org/ae1' },
    ])
    expect(facts).toHaveLength(2)
    expect(facts[0]).toEqual({ ref: 'fact1', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', claim: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' })
    expect(facts[1]!.sourceUrl).toBe('https://camerapedia.org/ae1')
    // refs are sequential over the KEPT facts
    expect(facts.map((f) => f.ref)).toEqual(['fact1', 'fact2'])
  })

  test('a fact missing a quote or a sourceUrl is dropped — never citable', () => {
    const facts = factsToEvidence([
      { quote: 'grounded', sourceUrl: 'https://x' },
      { quote: 'no source', sourceUrl: '' },
      { quote: '', sourceUrl: 'https://y' },
      {},
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]!.sourceUrl).toBe('https://x')
  })

  test('duplicate claims are deduped and the cap is honored', () => {
    const facts = factsToEvidence(
      Array.from({ length: 8 }, (_, i) => ({ quote: i < 2 ? 'same fact' : `fact number ${i}`, sourceUrl: 'https://x' })),
      5,
    )
    expect(facts.length).toBeLessThanOrEqual(5)
    expect(facts.filter((f) => f.claim === 'same fact')).toHaveLength(1) // deduped
  })

  test('empty input → empty evidence (not a throw)', () => {
    expect(factsToEvidence([])).toEqual([])
  })
})

describe('researchSubject — scope exposes only the honesty-safe identity', () => {
  const base: ResearchInput = { scope: 'item', label: '1976 Canon AE-1', make: 'Canon', model: 'AE-1', year: 1976, category: 'camera' }

  test('item scope names the specific make/model', () => {
    expect(researchSubject(base)).toBe('Canon AE-1')
  })

  test('class scope names ONLY the category — never a specific make/model', () => {
    expect(researchSubject({ scope: 'class', label: 'a confident maybe', category: 'camera' })).toBe('camera')
  })
})
