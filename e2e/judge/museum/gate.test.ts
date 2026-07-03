/**
 * Unit tests for the museum ID gate (§F4 / D3). These pin the false-green traps the adversarial review found:
 * generic-token match, honest-empty-as-ID, and an expected-known object landing UNKNOWN being silently excluded.
 */
import { test, expect, describe } from 'bun:test'
import {
  identificationResult,
  bandSanityFail,
  unexpectedSuppression,
  isHonestEmpty,
  isFabricatedMaker,
  type Captured,
  type MuseumFixture,
} from './gate'

const fx = (over: Partial<MuseumFixture>): MuseumFixture => ({
  id: 't', file: 't.jpg', museum: 'M', title: 'T', maker: 'Maker', year: '1', category: 'c', medium: 'm',
  expected_facts: [], difficulty: 'medium', image_type: 'flat-reproduction', source_url: '', license: '',
  sha1: '', expected_id_tokens: ['kouros'], expected_band: null, ...over,
})
const cap = (over: Partial<Captured>): Captured => ({
  band: 'CONFIDENT', title: '', what: '', purpose: '', maker: '', facts: [], suppressed: null, ...over,
})

describe('identificationResult — distinctive-token match', () => {
  test('a distinctive token present in title is a HIT', () => {
    expect(identificationResult(cap({ title: 'Marble Kouros', band: 'CONFIDENT' }), fx({ expected_id_tokens: ['kouros'] }))).toBe('hit')
  })

  test('a generic-token-only hedge is NOT a hit (the false-green trap)', () => {
    // The reveal says only "a Greek marble statue" — token 'kouros' is absent → MISS, even though the ground-truth
    // maker string ("Greek, Attic") shares the word "greek".
    expect(identificationResult(cap({ title: 'a Greek marble statue', what: 'a classical sculpture' }), fx({ expected_id_tokens: ['kouros'] }))).toBe('miss')
  })

  test('a stopword-only expected token set can never HIT (curation guard)', () => {
    expect(identificationResult(cap({ title: 'ancient greek thing', maker: 'greek' }), fx({ expected_id_tokens: ['greek', 'ancient'] }))).toBe('miss')
  })

  test('honest-empty maker containing the token does NOT count — the token must appear in title/what', () => {
    // maker = "unknown" (honest-empty) and expected token 'unknown'-adjacent would false-green; here the token
    // only appears inside the honest-empty maker, so it must NOT count.
    const c = cap({ title: 'a sculpture', what: 'a statue', maker: 'unknown', band: 'PROBABLE' })
    expect(identificationResult(c, fx({ expected_id_tokens: ['unknown'] }))).toBe('miss')
  })

  test('all curated tokens must be present (AND, not OR)', () => {
    expect(identificationResult(cap({ title: 'Washington crossing a river' }), fx({ expected_id_tokens: ['crossing the delaware'] }))).toBe('miss')
    expect(identificationResult(cap({ title: 'Washington Crossing the Delaware' }), fx({ expected_id_tokens: ['crossing the delaware'] }))).toBe('hit')
  })

  test('a suppressed reveal is neither hit nor miss', () => {
    expect(identificationResult(cap({ suppressed: 'safety_refusal' }), fx({}))).toBe('suppressed')
  })
})

describe('bandSanityFail — an expected-known object must not land UNKNOWN', () => {
  test('expected PROBABLE but UNKNOWN → FAIL (a coverage regression, not a silent exclusion)', () => {
    expect(bandSanityFail(cap({ band: 'UNKNOWN' }), fx({ expected_band: 'PROBABLE' }))).toBe(true)
  })
  test('expected PROBABLE and CONFIDENT → pass', () => {
    expect(bandSanityFail(cap({ band: 'CONFIDENT' }), fx({ expected_band: 'PROBABLE' }))).toBe(false)
  })
  test('no expected_band → never a band failure', () => {
    expect(bandSanityFail(cap({ band: 'UNKNOWN' }), fx({ expected_band: null }))).toBe(false)
  })
  test('expected-known but safety-suppressed unexpectedly → FAIL', () => {
    expect(bandSanityFail(cap({ suppressed: 'safety_refusal' }), fx({ expected_band: 'PROBABLE', safety_expected: false }))).toBe(true)
  })
})

describe('suppression honesty (the kouros carve-out)', () => {
  test('an unexpected safety refusal on a benign object → FAIL', () => {
    expect(unexpectedSuppression(cap({ suppressed: 'safety_refusal' }), fx({ safety_expected: false }))).toBe(true)
  })
  test('a safety_expected item being suppressed is EXPECTED, not a failure', () => {
    expect(unexpectedSuppression(cap({ suppressed: 'safety_refusal' }), fx({ safety_expected: true }))).toBe(false)
  })
})

describe('honest-empty vs fabricated maker', () => {
  test('honest-empty phrasings are detected', () => {
    for (const m of ['', 'unknown', 'The maker keeps their counsel', 'anonymous', "nothing I can prove"]) {
      expect(isHonestEmpty(m)).toBe(true)
      expect(isFabricatedMaker(m)).toBe(false)
    }
  })
  test('a confident named maker is fabricated (asserted, not honest-empty)', () => {
    expect(isFabricatedMaker('Vincent van Gogh')).toBe(true)
  })
})
