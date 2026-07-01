/**
 * researcher/buildDossier — the CLOSED PROVENANCE LOOP under test (PROMPT-QUALITY §2.2 / adversarial #1/#3/#6).
 * The draft is supplied directly (creds-free), so what's exercised is exactly the gate + the deterministic anchors
 * that decide whether a live fact is surfaced. Every adversarial negative control is a test here.
 */
import { test, expect, describe } from 'bun:test'
import {
  buildDossier,
  admitFact,
  verifyQuote,
  sourceMatchesSubject,
  namesDisallowedSpecific,
  OUTPUT_SCHEMA,
  type FetchedSource,
  type ProposedFact,
  type DossierInput,
} from './index'
import type { EntailmentJudge } from '../../../../../packages/shared/src/confidence'

// A deterministic stand-in for the entailment judge: every content word (len≥4) of the claim must appear in the
// VERIFIED QUOTE (which validateClaims passes as evidence.claim). Crude, but it distinguishes "quote supports the
// text" from "quote is real but doesn't support the text" — exactly the gap the closed loop must close.
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
const strictJudge: EntailmentJudge = (clause, ev) => words(clause.text).every((w) => norm(ev.claim).includes(w))

const AE1: FetchedSource = {
  url: 'https://en.wikipedia.org/wiki/Canon_AE-1',
  title: 'Canon AE-1 - Wikipedia',
  text: 'The Canon AE-1 is a 35 mm single lens reflex camera. It was introduced in 1976 by Canon. It sold more than five million units, one of the best selling cameras of its era.',
}
const A1: FetchedSource = {
  url: 'https://en.wikipedia.org/wiki/Canon_A-1',
  title: 'Canon A-1 - Wikipedia',
  text: 'The Canon A-1 has a top shutter speed of 1/1000 second and a program automatic mode.',
}

const F1: ProposedFact = { text: 'The Canon AE-1 is a 35 mm single lens reflex camera.', claimType: 'spec', sourceUrl: AE1.url, sourceTitle: AE1.title, quote: 'The Canon AE-1 is a 35 mm single lens reflex camera.' }
const F2: ProposedFact = { text: 'It was introduced in 1976 by Canon.', claimType: 'date', sourceUrl: AE1.url, sourceTitle: AE1.title, quote: 'It was introduced in 1976 by Canon.' }
const F3: ProposedFact = { text: 'It sold more than five million units.', claimType: 'spec', sourceUrl: AE1.url, sourceTitle: AE1.title, quote: 'It sold more than five million units, one of the best selling cameras of its era.' }

const ITEM_INPUT: DossierInput = {
  subject: 'Canon AE-1',
  scope: 'item',
  subjectTerms: ['Canon', 'AE-1'],
  provenance: { model: 'test', generatedAt: 0, toolCalls: 0 },
}
const FLAVOR_OVERVIEW = [{ text: 'A camera of quiet, unshowy competence.', claimType: 'flavor' as const }]

function build(facts: ProposedFact[], sources: FetchedSource[], input = ITEM_INPUT) {
  return buildDossier(input, { overview: FLAVOR_OVERVIEW, facts, sources }, { judge: strictJudge })
}

describe('deterministic anchors', () => {
  test('verifyQuote: verbatim quote (case/whitespace-normalized) must be in the source', () => {
    expect(verifyQuote('the CANON   ae-1 is', AE1.text)).toBe(true)
    expect(verifyQuote('the Canon AE-1 has infrared autofocus', AE1.text)).toBe(false)
    expect(verifyQuote('', AE1.text)).toBe(false)
  })
  test('sourceMatchesSubject: every subject token must appear in the page title/url', () => {
    expect(sourceMatchesSubject(AE1, ['Canon', 'AE-1'])).toBe(true)
    expect(sourceMatchesSubject(A1, ['Canon', 'AE-1'])).toBe(false) // A-1 page lacks the "ae" token
  })
  test('namesDisallowedSpecific: catches a class-level fact naming a specific model', () => {
    expect(namesDisallowedSpecific('The Canon AE-1 is popular.', ['Canon', 'AE-1'])).toBe(true)
    expect(namesDisallowedSpecific('An SLR uses a mirror.', ['Canon', 'AE-1'])).toBe(false)
  })
})

describe('buildDossier — happy path', () => {
  test('three well-grounded facts are all admitted, closed loop holds', () => {
    const r = build([F1, F2, F3], [AE1])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dossier.facts.length).toBe(3)
    expect(r.dropped.length).toBe(0)
    expect(OUTPUT_SCHEMA.everyFactHasProvenance(r.dossier)).toBe(true)
    expect(OUTPUT_SCHEMA.everyFactClosedLoop(r.dossier)).toBe(true) // evidence.claim === the fact's own quote
    expect(OUTPUT_SCHEMA.hasEnoughFacts(r.dossier)).toBe(true)
    // every kept fact carries its provenance proof
    for (const f of r.dossier.facts) expect(f.quote.length).toBeGreaterThan(0)
  })
})

describe('buildDossier — adversarial negative controls (each drops the offending fact, keeps the rest)', () => {
  const bad = (extra: ProposedFact, reason: string, sources = [AE1], input = ITEM_INPUT) => {
    const r = buildDossier(input, { overview: FLAVOR_OVERVIEW, facts: [F1, F2, F3, extra], sources }, { judge: strictJudge })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dossier.facts.length).toBe(3) // survivors kept, the bad one dropped — never fabricated to a count
    expect(r.dropped.map((d) => d.reason)).toContain(reason)
  }

  test('(a) source not fetched → dropped', () =>
    bad({ text: 'x', claimType: 'spec', sourceUrl: 'https://nope.example/x', quote: 'anything' }, 'source-not-fetched'))

  test('(b) quote is not a substring of its cited source → dropped', () =>
    bad({ text: 'The AE-1 had voice control.', claimType: 'spec', sourceUrl: AE1.url, quote: 'It shipped with a built-in voice assistant.' }, 'quote-not-in-source'))

  test('(c) quote is real but on a DIFFERENT model\'s page (off-subject) → dropped', () =>
    bad(
      { text: 'The AE-1 tops out at 1/1000 s.', claimType: 'spec', sourceUrl: A1.url, quote: 'The Canon A-1 has a top shutter speed of 1/1000 second' },
      'source-off-subject',
      [AE1, A1],
    ))

  test('(d) quote is in the right source but does NOT support the text → dropped', () =>
    bad(
      { text: 'The Canon AE-1 was the first camera with an electronic brain.', claimType: 'provenance', sourceUrl: AE1.url, quote: 'It sold more than five million units, one of the best selling cameras of its era.' },
      'quote-not-entailing-text',
    ))
})

describe('buildDossier — class scope (PROBABLE) rejects model-specific facts', () => {
  const CLASS_INPUT: DossierInput = {
    subject: 'camera',
    scope: 'class',
    subjectTerms: ['camera'],
    disallowedSpecificTerms: ['Canon', 'AE-1'],
    provenance: { model: 'test', generatedAt: 0, toolCalls: 0 },
  }
  const CAM: FetchedSource = { url: 'https://en.wikipedia.org/wiki/Single-lens_reflex_camera', title: 'Single-lens reflex camera - Wikipedia', text: 'A single lens reflex camera uses a mirror and prism. The Canon AE-1 is one famous example that sold millions.' }
  const classFact: ProposedFact = { text: 'A single lens reflex camera uses a mirror and prism.', claimType: 'spec', sourceUrl: CAM.url, quote: 'A single lens reflex camera uses a mirror and prism.' }
  const modelFact: ProposedFact = { text: 'The Canon AE-1 sold millions.', claimType: 'spec', sourceUrl: CAM.url, quote: 'The Canon AE-1 is one famous example that sold millions.' }

  test('a grounded, verbatim-quoted fact that NAMES the specific model is dropped at class scope', () => {
    const r = buildDossier(CLASS_INPUT, { overview: FLAVOR_OVERVIEW, facts: [classFact, modelFact], sources: [CAM] }, { judge: strictJudge })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dossier.facts.map((f) => f.text)).toEqual(['A single lens reflex camera uses a mirror and prism.'])
    expect(r.dropped.map((d) => d.reason)).toContain('class-scope-names-model')
  })
})

describe('buildDossier — survivors + failure', () => {
  test('fewer than 3 grounded facts → surface survivors, never fabricate', () => {
    const r = build([F1], [AE1])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dossier.facts.length).toBe(1)
    expect(OUTPUT_SCHEMA.hasEnoughFacts(r.dossier)).toBe(false) // honest: quality goal unmet, but never faked
  })
  test('no grounded overview clause survives → ok:false (cannot describe)', () => {
    // overview cites a ref that does not exist in the (empty) evidence → dropped → no overview → fail
    const r = buildDossier(ITEM_INPUT, { overview: [{ text: 'It weighs 590 g.', claimType: 'spec', evidenceRef: 'nope' }], facts: [], sources: [AE1] }, { judge: strictJudge })
    expect(r.ok).toBe(false)
  })
})

describe('admitFact is the shared primitive (same decision the live provider streams on)', () => {
  test('admits a good fact, rejects each failure mode with a reason', () => {
    const ctx = { subjectTerms: ['Canon', 'AE-1'], scope: 'item' as const, disallowedSpecificTerms: [], judge: strictJudge }
    expect(admitFact(F1, [AE1], ctx)).toEqual({ ok: true })
    expect(admitFact({ ...F1, sourceUrl: 'https://x' }, [AE1], ctx)).toEqual({ ok: false, reason: 'source-not-fetched' })
  })
})
