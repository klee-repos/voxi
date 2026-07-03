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
  categoryHead,
  categoryAnchors,
  namesCategoryHead,
  isListingJunk,
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

describe('buildDossier — Phase B display sourceTitle (REVEAL-CARD-CLEANUP §3.4)', () => {
  test('adopts a REAL page title (deep path) but drops subject-as-title (grounding fallback) to ""', () => {
    // Deep path: the fetched title is a genuine page title (≠ subject) → surfaced for the reveal Sources list.
    const r1 = build([F1], [AE1])
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.dossier.facts[0]!.sourceTitle).toBe('Canon AE-1 - Wikipedia')

    // Grounding fallback: the source title is hard-coded to the SUBJECT (a sourceMatchesSubject anchor, NOT a page
    // title) and the URL is an opaque Vertex redirect. Adopting it would render the object's OWN name as the page
    // title — so the fold-guard drops it to '' and the client derives an honest hostname/suppresses the proxy.
    const groundingSrc: FetchedSource = {
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123',
      title: ITEM_INPUT.subject,
      text: AE1.text,
    }
    const groundingFact: ProposedFact = { text: F1.text, claimType: 'spec', sourceUrl: groundingSrc.url, sourceTitle: ITEM_INPUT.subject, quote: F1.quote }
    const r2 = build([groundingFact], [groundingSrc])
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.dossier.facts[0]!.sourceTitle).toBe('')
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

// ── class-scope FACTS relevance (RCA: brick→"Red Bull" off-topic drift; the class-facts fix) ──────────────────────
describe('categoryHead — the last significant token of a category phrase', () => {
  test('strips leading colour/adjective, keeps the head noun; falls back to the raw token for a short category', () => {
    expect(categoryHead('Red Brick')).toBe('brick')
    expect(categoryHead('office chair')).toBe('chair')
    expect(categoryHead('kitchen utensil')).toBe('utensil')
    expect(categoryHead('cutting board')).toBe('board')
    expect(categoryHead('brick')).toBe('brick')
    expect(categoryHead('a plain mug')).toBe('mug')
    // a short REAL category must NOT collapse to '' (an empty head would DISABLE both topical gates — adversarial)
    expect(categoryHead('CD')).toBe('cd')
    expect(categoryHead('TV')).toBe('tv')
    expect(categoryHead('')).toBe('') // only a truly empty category degrades to no-anchor
  })
})

describe('categoryAnchors — every significant token (not just the head), so a "specific + generic head" category anchors on either', () => {
  test('keeps all content tokens; drops colour/adjective stopwords; raw-token fallback for a short category', () => {
    expect(categoryAnchors('Plywood Board')).toEqual(['plywood', 'board']) // the head-only 'board' dropped every "plywood" fact
    expect(categoryAnchors('Red Brick')).toEqual(['brick']) // 'red' is a stopword
    expect(categoryAnchors('office chair')).toEqual(['office', 'chair'])
    expect(categoryAnchors('CD')).toEqual(['cd']) // raw fallback, never empty
    expect(categoryAnchors('')).toEqual([])
  })
})

describe('namesCategoryHead — WHOLE-word match tolerant of regular plurals, immune to substring collisions', () => {
  test('matches the head and its plural; never a head buried inside an unrelated word', () => {
    expect(namesCategoryHead('Red bricks are fired clay.', 'brick')).toBe(true) // plural
    expect(namesCategoryHead('Boxes ship flat.', 'box')).toBe(true) // -es plural
    expect(namesCategoryHead("A brick's face is the show side.", 'brick')).toBe(true) // possessive
    // substring collisions the OLD `.includes()` wrongly accepted (the honesty-bypass findings)
    expect(namesCategoryHead('The billboard is on Sunset Strip.', 'board')).toBe(false)
    expect(namesCategoryHead('The blockbuster broke records.', 'block')).toBe(false)
    expect(namesCategoryHead('Pennsylvania was founded in 1681.', 'pen')).toBe(false)
    expect(namesCategoryHead('A penny is a coin.', 'pen')).toBe(false) // short head, not over-matched
    expect(namesCategoryHead('The candidate won.', 'can')).toBe(false)
  })
})

describe('isListingJunk — retail/search RESULT-COUNT noise only; genuine specs/figures spared', () => {
  test('flags a store result-COUNT; spares device specs, sales figures, prices, retailer-entity prose', () => {
    expect(isListingJunk("Target's website lists over 8,000 results for kitchen utensils and gadgets.")).toBe(true)
    expect(isListingJunk('Amazon lists over 60,000 results when searching for "office chair".')).toBe(true)
    expect(isListingJunk('The store lists over 5,000 products in that range.')).toBe(true) // verb + count + goods
    // negatives — genuine facts the OLD over-broad patterns wrongly dropped (the item/brand-regression findings)
    expect(isListingJunk('The camera displays exposure results on the top LCD.')).toBe(false) // device output, no count
    expect(isListingJunk('As of 2009, 350,000,000 units had been sold worldwide.')).toBe(false) // sales figure
    expect(isListingJunk('It became one of the best-selling products of all time.')).toBe(false)
    expect(isListingJunk('Archaeologists found gold items among the burial goods.')).toBe(false) // artifact provenance
    expect(isListingJunk('Target Corporation operates its retail store chain since 1962.')).toBe(false) // retailer ENTITY
    expect(isListingJunk('The original retailed for $199 in 1976.')).toBe(false)
  })
  test('admitFact drops listing junk at CLASS scope, but NOT at item scope (Tier A/B byte-unchanged)', () => {
    const junkSrc: FetchedSource = { url: 'https://ex/store', title: 'brick', text: 'A store lists over 12,000 results for brick.' }
    const junk: ProposedFact = { text: 'A store lists over 12,000 results for brick.', claimType: 'spec', sourceUrl: junkSrc.url, quote: 'A store lists over 12,000 results for brick.' }
    expect(admitFact(junk, [junkSrc], { subjectTerms: ['brick'], scope: 'class', disallowedSpecificTerms: [], judge: strictJudge }))
      .toEqual({ ok: false, reason: 'listing-junk' })
    // The SAME listing-shaped text at ITEM scope is NOT dropped by the listing gate (it is class-scope only).
    const itemSrc: FetchedSource = { url: 'https://ex/item', title: 'Widget 9000 - Wikipedia', text: 'The Widget 9000 lists over 12,000 results.' }
    const itemFact: ProposedFact = { text: 'The Widget 9000 lists over 12,000 results.', claimType: 'spec', sourceUrl: itemSrc.url, quote: 'The Widget 9000 lists over 12,000 results.' }
    expect(admitFact(itemFact, [itemSrc], { subjectTerms: ['Widget', '9000'], scope: 'item', disallowedSpecificTerms: [], judge: strictJudge }).ok).toBe(true)
  })
})

describe('buildDossier — class-scope source anchor keys on the category HEAD NOUN (the deep-path recall fix)', () => {
  // A compound category ("Red Brick") whose genuine source page is titled by the HEAD noun only ("Brick — Wikipedia").
  const BRICK_INPUT: DossierInput = { subject: 'Red Brick', scope: 'class', subjectTerms: ['Red Brick'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
  const BRICK_WIKI: FetchedSource = { url: 'https://en.wikipedia.org/wiki/Brick', title: 'Brick - Wikipedia', text: 'The oldest discovered bricks predate 7500 BC. Fired bricks are among the longest-lasting building materials.' }
  const brickFact: ProposedFact = { text: 'The oldest discovered bricks predate 7500 BC.', claimType: 'date', sourceUrl: BRICK_WIKI.url, quote: 'The oldest discovered bricks predate 7500 BC.' }

  test('the strict FULL-phrase anchor would reject the head-noun page — the head-noun anchor admits it', () => {
    // BEFORE: sourceMatchesSubject(page, ['Red Brick']) demands "redbrick" in the title → the "Brick" page fails.
    expect(sourceMatchesSubject(BRICK_WIKI, ['Red Brick'])).toBe(false)
    // AFTER: admitFact at class scope anchors on categoryHead('Red Brick')='brick' → the genuine page is admitted.
    expect(admitFact(brickFact, [BRICK_WIKI], { subjectTerms: ['Red Brick'], scope: 'class', disallowedSpecificTerms: [], judge: strictJudge })).toEqual({ ok: true })
    const r = buildDossier(BRICK_INPUT, { overview: [], facts: [brickFact], sources: [BRICK_WIKI] }, { judge: strictJudge })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dossier.facts.map((f) => f.text)).toEqual(['The oldest discovered bricks predate 7500 BC.'])
  })
})

describe('buildDossier — class-scope SET-LEVEL topical anchor (the off-topic-drift fix)', () => {
  // The grounding path hard-codes the source title to the SUBJECT, so per-source matching is a no-op; a wholesale
  // drift to a different entity ("Red Bull" for a "brick" query) is caught only by the set-level category anchor.
  const BRICK_INPUT: DossierInput = { subject: 'Red Brick', scope: 'class', subjectTerms: ['Red Brick'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
  const groundingSrc = (text: string, subject = 'Red Brick'): FetchedSource => ({ url: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${text.length}`, title: subject /* synthetic = subject */, text })
  const gf = (text: string, url: string): ProposedFact => ({ text, claimType: 'spec', sourceUrl: url, quote: text })

  test('an all-off-topic cluster (never names the category) is dropped WHOLE → honest-empty, not confidently wrong', () => {
    const text = 'When Red Bull was founded in 1987 it created the energy-drink category. Its logo has remained unchanged since. The concept originated from a Thai drink called Krating Daeng.'
    const src = groundingSrc(text)
    const facts = [
      gf('When Red Bull was founded in 1987 it created the energy-drink category.', src.url),
      gf('Its logo has remained unchanged since.', src.url),
      gf('The concept originated from a Thai drink called Krating Daeng.', src.url),
    ]
    const r = buildDossier(BRICK_INPUT, { overview: [], facts, sources: [src] }, { judge: strictJudge })
    expect(r.ok).toBe(false) // no fact survived + no overview → nothing to surface
    expect(r.dropped.map((d) => d.reason)).toContain('class-cluster-off-topic')
  })

  test('a genuine grounding cluster survives intact — one fact naming the category keeps its pronoun-chained siblings', () => {
    const text = 'Red bricks are a common building material. Their characteristic red colour comes from iron oxide. The manufacturing process fires the clay in a kiln.'
    const src = groundingSrc(text)
    const facts = [
      gf('Red bricks are a common building material.', src.url), // names "brick" → anchor
      gf('Their characteristic red colour comes from iron oxide.', src.url), // pronoun, no "brick"
      gf('The manufacturing process fires the clay in a kiln.', src.url), // no "brick"
    ]
    const r = buildDossier(BRICK_INPUT, { overview: [], facts, sources: [src] }, { judge: strictJudge })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dossier.facts.length).toBe(3) // the anchor fact keeps its siblings — no thinning
  })

  test('the SUBSTRING honesty bypass is closed — an all-"billboard/surfboard" cluster for "cutting board" is dropped', () => {
    // categoryHead('cutting board')='board'; the OLD fold().includes("board") wrongly matched billboard/surfboard.
    const CB: DossierInput = { subject: 'cutting board', scope: 'class', subjectTerms: ['cutting board'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
    const text = 'The billboard on Sunset Strip is prime advertising space. Surfboard sales rose sharply last year. The boardroom holds twenty executives.'
    const src = groundingSrc(text, 'cutting board')
    const facts = [
      gf('The billboard on Sunset Strip is prime advertising space.', src.url),
      gf('Surfboard sales rose sharply last year.', src.url),
      gf('The boardroom holds twenty executives.', src.url),
    ]
    const r = buildDossier(CB, { overview: [], facts, sources: [src] }, { judge: strictJudge })
    expect(r.ok).toBe(false)
    expect(r.dropped.map((d) => d.reason)).toContain('class-cluster-off-topic')
  })

  test('a short/degenerate head keeps BOTH gates armed — an off-topic "CD" cluster is still dropped (not admitted)', () => {
    // categoryHead('CD')='cd' (raw-token fallback), so the set anchor is not short-circuited and the drift is caught.
    const CD: DossierInput = { subject: 'CD', scope: 'class', subjectTerms: ['CD'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
    const text = 'Pennsylvania was founded in 1681 as a proprietary colony. It later joined the original thirteen states.'
    const src = groundingSrc(text, 'CD')
    const facts = [
      gf('Pennsylvania was founded in 1681 as a proprietary colony.', src.url),
      gf('It later joined the original thirteen states.', src.url),
    ]
    const r = buildDossier(CD, { overview: [], facts, sources: [src] }, { judge: strictJudge })
    expect(r.ok).toBe(false)
    expect(r.dropped.map((d) => d.reason)).toContain('class-cluster-off-topic')
  })

  test('a "specific noun + generic head" category ("Plywood Board") keeps its "plywood" facts (the recall-regression guard)', () => {
    // categoryHead('Plywood Board')='board', so a head-ONLY anchor drops the real "Plywood — Wikipedia" page (title
    // lacks 'board') and every fact that says "plywood" not "board" — the live 7-facts→0 regression. categoryAnchors
    // keys on EITHER token, so 'plywood' anchors both the source and the cluster.
    const PLY: DossierInput = { subject: 'Plywood Board', scope: 'class', subjectTerms: ['Plywood Board'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
    const wiki: FetchedSource = { url: 'https://en.wikipedia.org/wiki/Plywood', title: 'Plywood - Wikipedia', text: 'Plywood is an engineered wood product. It is made by gluing thin veneer layers with alternating grain.' }
    expect(sourceMatchesSubject(wiki, ['board'])).toBe(false) // the head-only anchor would REJECT the genuine page…
    const facts = [
      gf('Plywood is an engineered wood product.', wiki.url),
      gf('It is made by gluing thin veneer layers with alternating grain.', wiki.url), // pronoun; kept via the real title
    ]
    const r = buildDossier(PLY, { overview: [], facts, sources: [wiki] }, { judge: strictJudge })
    expect(r.ok).toBe(true) // …but categoryAnchors admits it on 'plywood'
    if (r.ok) expect(r.dossier.facts.length).toBe(2)
  })

  test('REAL-title (deep-path) facts are TRUSTED — a genuine deep cluster using only pronouns is NOT over-dropped', () => {
    // The deep source passed the head-noun source match (real title contains "chair"), so its facts are topical even
    // when the fact text itself uses a pronoun — the set anchor must not drop them for lacking the literal head word.
    const CHAIR: DossierInput = { subject: 'chair', scope: 'class', subjectTerms: ['chair'], disallowedSpecificTerms: [], provenance: { model: 't', generatedAt: 0, toolCalls: 0 } }
    const wiki: FetchedSource = { url: 'https://en.wikipedia.org/wiki/Chair', title: 'Chair - Wikipedia', text: 'It is a piece of furniture for one person. They usually have four legs and a back.' }
    const facts = [
      gf('It is a piece of furniture for one person.', wiki.url),
      gf('They usually have four legs and a back.', wiki.url),
    ]
    const r = buildDossier(CHAIR, { overview: [], facts, sources: [wiki] }, { judge: strictJudge })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.dossier.facts.length).toBe(2) // real-title deep facts trusted → not dropped
  })
})
