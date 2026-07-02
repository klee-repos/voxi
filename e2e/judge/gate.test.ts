/**
 * The deterministic reveal-quality gate + its NEGATIVE CONTROLS (PROMPT-QUALITY §3.D3). These run in `bun test`
 * (creds-free) and are the CI teeth: a good reveal passes, and each deliberately-broken variant turns the gate RED
 * for exactly its own assertion — proving the gate isn't shape-theater.
 */
import { test, expect, describe } from 'bun:test'
import { gate, checkTitle, checkDescription, checkFacts, type RevealContent, type FixtureExpect } from './gate'

const EXP: FixtureExpect = {
  titleTokens: ['cannondale', 'supersix'],
  maxTitleWords: 6,
  requiredDescriptionTokens: ['carbon', 'road'],
  minDescriptionWords: 15,
  minFacts: 3,
}

const GOOD: RevealContent = {
  title: '2008 Cannondale SuperSix EVO',
  description: "A 2008 Cannondale SuperSix EVO — the marque's flagship carbon road racer, built light for the climbs and named for its evolution of the SuperSix platform.",
  facts: [
    { text: 'The frame is carbon fibre.', sourceUrl: 'https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO', quote: 'the frame is carbon fibre' },
    { text: 'It is a flagship road racing frame.', sourceUrl: 'https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO', quote: 'flagship road racing frame' },
    { text: 'The EVO evolution debuted in 2011.', sourceUrl: 'https://en.wikipedia.org/wiki/Cannondale_SuperSix_EVO', quote: 'the EVO evolution debuted in 2011' },
  ],
}

test('a good reveal passes the whole gate', () => {
  const r = gate(GOOD, EXP)
  expect(r.failures).toEqual([])
  expect(r.ok).toBe(true)
})

describe('negative controls — each broken property turns exactly its own check RED', () => {
  test('a bare-category title fails', () => {
    expect(checkTitle('a beverage can', EXP).length).toBeGreaterThan(0)
  })
  test('an over-long title (spec dump) fails', () => {
    expect(checkTitle('2008 Cannondale SuperSix EVO Hi-Mod Carbon Road Racing Bicycle Frameset', EXP).some((f) => /words/.test(f))).toBe(true)
  })
  test('a title that names the wrong/absent object fails the whole-token check', () => {
    expect(checkTitle('Trek Émonda', EXP).some((f) => /missing expected token/.test(f))).toBe(true)
  })
  test('a thin description fails the word-count check', () => {
    expect(checkDescription('A bike.', EXP).some((f) => /words/.test(f))).toBe(true)
  })
  test('a description with none of the required specifics fails', () => {
    expect(checkDescription('A very nice and interesting object that many people enjoy owning and using every single day.', EXP).some((f) => /required specifics/.test(f))).toBe(true)
  })
  test('fewer than 3 facts fails', () => {
    expect(checkFacts(GOOD.facts.slice(0, 2), GOOD.description, EXP).some((f) => /fact\(s\)/.test(f))).toBe(true)
  })
  test('a fact with NO provenance (missing quote / source) fails — the "proof if challenged" is mandatory', () => {
    const noQuote = [...GOOD.facts.slice(0, 2), { text: 'It floats.', sourceUrl: 'https://x/y', quote: '' }]
    expect(checkFacts(noQuote, GOOD.description, EXP).some((f) => /no verbatim quote/.test(f))).toBe(true)
    const noSource = [...GOOD.facts.slice(0, 2), { text: 'It floats.', sourceUrl: '', quote: 'it floats' }]
    expect(checkFacts(noSource, GOOD.description, EXP).some((f) => /no real source/.test(f))).toBe(true)
  })
  test('non-distinct facts fail', () => {
    const dup = [GOOD.facts[0]!, GOOD.facts[0]!, GOOD.facts[1]!]
    expect(checkFacts(dup, GOOD.description, EXP).some((f) => /distinct/.test(f))).toBe(true)
  })
  test('the full gate reports ok:false when ANY property is broken', () => {
    expect(gate({ ...GOOD, title: 'an object' }, EXP).ok).toBe(false)
    expect(gate({ ...GOOD, facts: GOOD.facts.slice(0, 1) }, EXP).ok).toBe(false)
  })
})
