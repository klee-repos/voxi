/**
 * Deterministic tests for the reveal ENRICHMENT mapping (ANALYSIS-VOICE-PLAN A1/A6–A9) — no OpenAI, no Firecrawl, no creds.
 *
 * The live Firecrawl→OpenAI grounded call is proven by a spike; here we test the pure, load-bearing pieces: extracted
 * facts become citable evidence paired with their source URL, facts missing a quote/source are DROPPED (never citable),
 * and the per-scope subject exposes only the honesty-safe keys (item vs class).
 */
import { afterEach, test, expect, describe } from 'bun:test'
import { factsToEvidence, researchSubject, LiveResearcher, type ResearchInput } from './live-research'
import type { WebResearchProvider } from '../tools/web_research'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.OPENAI_API_KEY
})

/** Signal-aware never-resolve (see openai.test.ts). Required for the timeout case — a signal-blind mock hangs the test. */
function neverResolvingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
}

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

// F2e — timeout parity for the BFF researcher's groundedFacts call. The try/catch at live-research.ts:82-89 swallows
// a THROW but NOT a hang — a hung OpenAI call never settles → the cascade hangs at this enrichment step. Wiring
// `timeoutMs` into the groundedFacts call converts a hang to a throw → the catch returns []. No retry here (enrichment
// is best-effort, NOT fail-closed like the dossier). RED: without the timeout the await never settles (test times
// out). GREEN: with it the abort fires → groundedFacts throws → research returns [] fast. The constructor takes an
// injectable `timeoutMs` (default `OPENAI_CALL_TIMEOUT_MS`) so the test drives 50ms instead of the shipped 90s.
describe('LiveResearcher.research — timeout parity (F2e, the last BFF groundedFacts callsite)', () => {
  const docs = [{ url: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1', markdown: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' }]
  const input: ResearchInput = { scope: 'item', label: '1976 Canon AE-1', make: 'Canon', model: 'AE-1', year: 1976, category: 'camera' }

  test('a HUNG OpenAI call → research returns [] at ~timeoutMs (NOT a hang) — the timeout converts hang→throw→[]', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    globalThis.fetch = neverResolvingFetch()
    const researcher = new LiveResearcher(fakeWeb(docs), 50) // 50ms timeout — NOT the 90s shipped default
    const t0 = Date.now()
    const out = await researcher.research(input)
    expect(out).toEqual([]) // the timeout threw → caught → [] (the reveal proceeds on web evidence only)
    expect(Date.now() - t0).toBeLessThan(2000) // bounded — NOT a cascade hang
  })

  test('a 5xx OpenAI error is also caught → [] (the same arm a timeout lands in; fail-soft, never a crash)', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'openai down' }), { status: 500 })) as typeof fetch
    const researcher = new LiveResearcher(fakeWeb(docs), 50)
    expect(await researcher.research(input)).toEqual([])
  })

  test('no web wired → [] (no Firecrawl → no grounding; reveal proceeds on web evidence only)', async () => {
    const researcher = new LiveResearcher(null)
    expect(await researcher.research(input)).toEqual([])
  })
})
