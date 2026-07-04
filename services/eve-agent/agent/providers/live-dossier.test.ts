/**
 * LiveDossierProvider — the async provider drives buildDossier over a draft and STREAMS each verified fact, then
 * the terminal dossier. A draft whose facts fail the provenance loop yields nothing (never a fake); an empty
 * primary falls back to the secondary source. The draft is faked here so the STREAMING + FALLBACK are exercised
 * without a live model/crawl (the closed provenance loop itself is tested in subagents/researcher/index.test.ts).
 */
import { test, expect, describe, afterEach } from 'bun:test'
import { LiveDossierProvider, FirecrawlGeminiDraft, brandLaneQuery, groundingSubject, type DossierDraftSource, type ResearchEvent } from './live-dossier'
import type { ProposedDossier, FetchedSource, DossierInput } from '../subagents/researcher'
import type { WebResearchProvider } from '../tools/web_research'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.OPENAI_API_KEY
})

/** A deterministic Firecrawl stand-in (same shape as grounded-research.test.ts): returns fixed docs — a sanctioned
 *  seam, never a stub that fakes success. */
function fakeWeb(docs: { url: string; title: string; markdown: string }[]): WebResearchProvider {
  return {
    async search() {
      return docs
    },
    async scrape(url) {
      return docs.find((d) => d.url === url) ?? null
    },
  }
}

/** Signal-aware never-resolve (see openai.test.ts). Required for the timeout case — a signal-blind mock hangs the test. */
function neverResolvingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
}

/** A per-call OpenAI fetch mock: `responses[callN]` is returned for the Nth OpenAI POST (1-indexed). Each entry is either
 *  {ok:true, content} (200 + content) or {ok:false, status} (a vendor error → chat throws at openai.ts:53). */
function sequencedFetch(responses: Array<{ ok: true; content: string } | { ok: false; status: number }>): {
  fetch: typeof fetch
  getCalls: () => number
} {
  let calls = 0
  const fn = (async () => {
    const r = responses[Math.min(calls, responses.length - 1)]!
    calls++
    if (r.ok) return new Response(JSON.stringify({ choices: [{ message: { content: r.content } }] }), { status: 200 })
    return new Response(JSON.stringify({ error: 'openai down' }), { status: r.status })
  }) as typeof fetch
  return { fetch: fn, getCalls: () => calls }
}

// ── The brand/maker-lane query strings (F2) — the ONLY deterministic pin on the shipped wording. The load-bearing
//    invariant (§13.2/§13.5): the query LEADS with the entity's identity + history, and NEVER leads with the object
//    type / storefront (which measurably starved the maker). The noun is generalized to fit a hardware maker too. ──
describe('brandLaneQuery / groundingSubject — history-first lead, maker-agnostic noun, object-type NEVER first (F2)', () => {
  const label = (i: DossierInput): DossierInput => i
  const subpop = label({ subject: 'Sub Pop', scope: 'item', subjectTerms: ['Sub Pop'], brandLane: true, objectType: 'mug' })
  const xbox = label({ subject: 'Xbox', scope: 'item', subjectTerms: ['Xbox'], brandLane: true, objectType: 'video game controller' })
  const plain = label({ subject: 'Canon AE-1', scope: 'item', subjectTerms: ['Canon', 'AE-1'] })

  test('brandLaneQuery leads with the entity + history, then the object type as trailing context', () => {
    expect(brandLaneQuery(subpop)).toBe('Sub Pop — company, brand, maker or label: history, founding, what they are best known for, and its mug')
    expect(brandLaneQuery(xbox)).toBe('Xbox — company, brand, maker or label: history, founding, what they are best known for, and its video game controller')
    // the object type is at the TAIL, never the head (the storefront-starvation regression)
    expect(brandLaneQuery(subpop).startsWith('Sub Pop')).toBe(true)
    expect(brandLaneQuery(subpop).indexOf('mug')).toBeGreaterThan(brandLaneQuery(subpop).indexOf('history'))
  })
  test('groundingSubject leads with the maker ENTITY (never the object type / storefront), generalized noun', () => {
    expect(groundingSubject(xbox)).toBe('the maker "Xbox" — the company, brand, maker or label behind this video game controller (who they are, their history, what they are best known for, and why they make things like this)')
    expect(groundingSubject(xbox).startsWith('the maker "Xbox"')).toBe(true) // the ENTITY leads, not the object type
  })
  test('a non-brand-lane ITEM input LEADS with the subject, then appends a when-it-was-made angle (fills the `made` bucket)', () => {
    expect(brandLaneQuery(plain)).toBe('Canon AE-1 — history and key facts, including when it was made: its production years, model years, or release date')
    expect(brandLaneQuery(plain).startsWith('Canon AE-1')).toBe(true) // subject still LEADS retrieval
    expect(groundingSubject(plain)).toBe('the Canon AE-1, including when it was made — its production years or release date')
  })
  test('the corroborated year threads into the item query as a HINT (never displayed downstream)', () => {
    const withYear = label({ subject: 'Canon AE-1', scope: 'item', subjectTerms: ['Canon', 'AE-1'], year: 1976 })
    expect(brandLaneQuery(withYear)).toBe('Canon AE-1 1976 — history and key facts, including when it was made: its production years, model years, or release date')
    expect(groundingSubject(withYear)).toBe('the Canon AE-1 (1976), including when it was made — its production years or release date')
  })
  test('the BRAND LANE never dates the specimen: a year on a brand-lane input is IGNORED (honesty — cannot know which one)', () => {
    const brandWithYear = label({ subject: 'Sub Pop', scope: 'item', subjectTerms: ['Sub Pop'], brandLane: true, objectType: 'mug', year: 1988 })
    expect(brandLaneQuery(brandWithYear)).toBe('Sub Pop — company, brand, maker or label: history, founding, what they are best known for, and its mug')
    expect(brandLaneQuery(brandWithYear)).not.toContain('1988')
    expect(brandLaneQuery(brandWithYear)).not.toContain('when it was made')
  })
  test('CLASS scope is UNCHANGED — a category has no specimen production date to seek', () => {
    expect(brandLaneQuery({ subject: 'camera', scope: 'class', subjectTerms: ['camera'] })).toBe('camera')
    expect(groundingSubject({ subject: 'camera', scope: 'class', subjectTerms: ['camera'] })).toBe('the category of object: camera')
  })
})

class FakeDraft implements DossierDraftSource {
  constructor(private proposed: ProposedDossier, private throws = false) {}
  async draft(): Promise<ProposedDossier> {
    if (this.throws) throw new Error('draft 503')
    return this.proposed
  }
}

const INPUT: DossierInput = { subject: 'Canon AE-1', scope: 'item', subjectTerms: ['Canon', 'AE-1'] }
const SRC: FetchedSource = { url: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1', text: 'The Canon AE-1 is a 35 mm SLR camera introduced in 1976.' }
const GOOD: ProposedDossier = {
  facts: [
    { text: 'The Canon AE-1 is a 35 mm SLR camera.', claimType: 'spec', sourceUrl: SRC.url, quote: 'The Canon AE-1 is a 35 mm SLR camera' },
    { text: 'It was introduced in 1976.', claimType: 'date', sourceUrl: SRC.url, quote: 'introduced in 1976' },
  ],
  sources: [SRC],
}
const EMPTY: ProposedDossier = { facts: [], sources: [] }
const OFF_SUBJECT: ProposedDossier = {
  // a real quote, but the "source" is about a different model → dropped by sourceMatchesSubject → 0 verified
  facts: [{ text: 'The A-1 tops out at 1/1000s.', claimType: 'spec', sourceUrl: 'https://x/a1', quote: 'top shutter 1/1000' }],
  sources: [{ url: 'https://x/a1', title: 'Canon A-1', text: 'top shutter 1/1000 second' }],
}

async function drain(gen: AsyncGenerator<ResearchEvent>): Promise<ResearchEvent[]> {
  const out: ResearchEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('LiveDossierProvider', () => {
  test('streams each verified fact, then the terminal dossier', async () => {
    const p = new LiveDossierProvider(new FakeDraft(GOOD))
    const evs = await drain(p.research(INPUT))
    const facts = evs.filter((e) => e.type === 'fact')
    expect(facts.length).toBe(2)
    expect(evs[evs.length - 1]!.type).toBe('done')
    const done = evs[evs.length - 1] as Extract<ResearchEvent, { type: 'done' }>
    expect(done.dossier?.facts.length).toBe(2)
    // every streamed fact carries provenance (the proof)
    for (const f of facts) if (f.type === 'fact') expect(f.fact.quote.length).toBeGreaterThan(0)
  })

  test('an empty primary falls back to the secondary source', async () => {
    const p = new LiveDossierProvider(new FakeDraft(EMPTY), new FakeDraft(GOOD))
    const evs = await drain(p.research(INPUT))
    expect(evs.filter((e) => e.type === 'fact').length).toBe(2) // came from the fallback
  })

  test('a draft whose facts all fail the provenance loop yields no facts (never a fake), then done:null', async () => {
    const p = new LiveDossierProvider(new FakeDraft(OFF_SUBJECT)) // off-subject → dropped → 0 verified, no fallback
    const evs = await drain(p.research(INPUT))
    expect(evs.filter((e) => e.type === 'fact').length).toBe(0)
    expect((evs[evs.length - 1] as Extract<ResearchEvent, { type: 'done' }>).dossier).toBeNull()
  })

  test('both draft sources throwing is non-fatal → a single done:null', async () => {
    const p = new LiveDossierProvider(new FakeDraft(GOOD, true), new FakeDraft(GOOD, true))
    const evs = await drain(p.research(INPUT))
    expect(evs).toEqual([{ type: 'done', dossier: null }])
  })
})

// F2c — FirecrawlGeminiDraft retry + timeout (mirrors the worker's GroundedResearchProvider, providers.ts:144-153).
// A transient OpenAI throw OR an empty-facts extract is retried up to maxAttempts; after maxAttempts it THROWS (not
// "return empty"), and LiveDossierProvider.buildFrom catches → done:null. The 3 cases pin the wiring the RCA requires:
//   (1) throw-retry:  a 5xx on attempt 1, ok on attempt 2 → facts returned (retry fires on a throw)
//   (2) empty-retry:  empty facts on attempt 1, ok on attempt 2 → facts returned (retry fires on !facts.length)
//   (3) all-fail:     5xx on every attempt → THROWS after maxAttempts (caught upstream → done:null)
// Each test is RED without the retry loop (single attempt → throw/empty propagates), GREEN with it.
describe('FirecrawlGeminiDraft — retry + throw-after-maxAttempts (F2c, mirrors the worker)', () => {
  const INPUT_DOCS = [{ url: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1', markdown: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' }]
  const DOSSIER_INPUT: DossierInput = { subject: 'Canon AE-1', scope: 'item', subjectTerms: ['Canon', 'AE-1'] }
  const FACTS_BODY = JSON.stringify({
    facts: [{ text: 'The Canon AE-1 is a 35mm SLR introduced in 1976.', claimType: 'date', quote: 'The Canon AE-1 is a 35mm SLR introduced in 1976.', sourceUrl: INPUT_DOCS[0]!.url }],
  })

  test('(1) a 5xx on attempt 1 + ok on attempt 2 → facts returned (retry fires on a THROW)', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    const seq = sequencedFetch([
      { ok: false, status: 503 }, // attempt 1: OpenAI 5xx → groundedFacts throws → draft catches → retry
      { ok: true, content: FACTS_BODY }, // attempt 2: ok → facts returned
    ])
    globalThis.fetch = seq.fetch
    const draft = new FirecrawlGeminiDraft(fakeWeb(INPUT_DOCS))
    const out = await draft.draft(DOSSIER_INPUT)
    expect(out.facts).toHaveLength(1)
    expect(seq.getCalls()).toBe(2) // the retry actually fired — RED if the loop was 1 attempt
  })

  test('(2) empty facts on attempt 1 + ok on attempt 2 → facts returned (retry fires on !facts.length)', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    const seq = sequencedFetch([
      { ok: true, content: JSON.stringify({ facts: [] }) }, // attempt 1: ok but empty → draft continues
      { ok: true, content: FACTS_BODY }, // attempt 2: ok with facts → returned
    ])
    globalThis.fetch = seq.fetch
    const draft = new FirecrawlGeminiDraft(fakeWeb(INPUT_DOCS))
    const out = await draft.draft(DOSSIER_INPUT)
    expect(out.facts).toHaveLength(1)
    expect(seq.getCalls()).toBe(2) // RED without the empty-facts retry branch
  })

  test('(3) all attempts 5xx → THROWS after maxAttempts (NOT "return empty") — buildFrom catches → done:null', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    const seq = sequencedFetch([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ])
    globalThis.fetch = seq.fetch
    const draft = new FirecrawlGeminiDraft(fakeWeb(INPUT_DOCS), 9000, 6, 50, 3)
    await expect(draft.draft(DOSSIER_INPUT)).rejects.toThrow(/after 3 attempts/)
    expect(seq.getCalls()).toBe(3) // exactly maxAttempts — no infinite loop
    // the upstream catch: a throwing draft → done:null (the reveal stands as-is, never a crash)
    const p = new LiveDossierProvider(new FirecrawlGeminiDraft(fakeWeb(INPUT_DOCS), 9000, 6, 50, 3))
    const evs = await drain(p.research(DOSSIER_INPUT))
    expect(evs).toEqual([{ type: 'done', dossier: null }])
  })

  test('(4) a HUNG OpenAI call (never resolves) throws at timeoutMs — the timeout makes the retry loop reach maxAttempts', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    globalThis.fetch = neverResolvingFetch()
    const draft = new FirecrawlGeminiDraft(fakeWeb(INPUT_DOCS), 9000, 6, 50, 3)
    const t0 = Date.now()
    await expect(draft.draft(DOSSIER_INPUT)).rejects.toThrow(/after 3 attempts|aborted|AbortError/i)
    expect(Date.now() - t0).toBeLessThan(2000) // 3 × 50ms timeout ≈ 150ms — NOT a 3 × 1113s hang
  })
})
