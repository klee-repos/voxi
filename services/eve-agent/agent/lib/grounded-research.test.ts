import { afterEach, test, expect } from 'bun:test'
import { groundedFacts } from './grounded-research'
import type { WebResearchProvider } from '../tools/web_research'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.OPENAI_API_KEY
})

/** A deterministic Firecrawl stand-in: returns fixed docs (real URLs + markdown) — a sanctioned seam (fixed shapes
 *  mirroring a real vendor response), never a stub that fakes success. */
const fakeWeb = (docs: { url: string; title: string; markdown: string }[]): WebResearchProvider => ({
  async search() {
    return docs
  },
  async scrape(url) {
    return docs.find((d) => d.url === url) ?? null
  },
})

/** Signal-aware never-resolving fetch (see openai.test.ts for the rationale). A signal-blind `new Promise(()=>{})`
 *  hangs in BOTH red and green — `AbortSignal.timeout` only dispatches `abort`, it does NOT reject the promise.
 *  The mock must listen for the abort event itself. */
function neverResolvingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
}

test('groundedFacts: Firecrawl docs → OpenAI extracts facts with PER-FACTOR sourceUrls + the fetched sources', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  const docs = [
    { url: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1', markdown: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' },
  ]
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { model: string }
    expect(body.model).toBe('gpt-5.4-mini') // the extractor is OpenAI gpt-5.4-mini, not Gemini
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: [{ text: 'The Canon AE-1 is a 35mm SLR introduced in 1976.', claimType: 'date', quote: 'The Canon AE-1 is a 35mm SLR introduced in 1976.', sourceUrl: docs[0]!.url }],
              }),
            },
          },
        ],
      }),
    )
  }) as typeof fetch
  const { facts, sources } = await groundedFacts({ web: fakeWeb(docs), subject: 'Canon AE-1', query: 'Canon AE-1', item: true })
  expect(facts).toHaveLength(1)
  expect(facts[0]!.sourceUrl).toBe(docs[0]!.url) // per-fact attribution — the real Firecrawl URL, NOT round-robin
  expect(facts[0]!.quote).toBe('The Canon AE-1 is a 35mm SLR introduced in 1976.')
  expect(sources.map((s) => s.url)).toEqual([docs[0]!.url])
})

test('groundedFacts: empty Firecrawl result → empty facts (best-effort, no throw)', async () => {
  const { facts } = await groundedFacts({ web: fakeWeb([]), subject: 'x', query: 'x', item: true })
  expect(facts).toEqual([])
})

test('groundedFacts: an OpenAI error propagates (fail-loud, never a fake empty-success over real docs)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  const docs = [{ url: 'https://x', title: 'X', markdown: 'something' }]
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'openai down' }), { status: 500 })) as typeof fetch
  await expect(groundedFacts({ web: fakeWeb(docs), subject: 'x', query: 'x', item: true })).rejects.toThrow(/openai/)
})

// F2b — a hung OpenAI extract (unbounded reasoning on the GLM-5.2 predecessor spun ~1113s; any black-holed vendor
// socket is the same shape) MUST throw at `timeoutMs` when the caller passes one, NOT hang the reveal's research phase.
// The `timeoutMs` is forwarded into `openaiJSON` → `chat`'s `AbortSignal.timeout`. RED: omit `timeoutMs` and the await
// never settles (test times out). GREEN: with `timeoutMs:50` the abort fires → the signal-aware mock rejects →
// groundedFacts throws. This is the wiring the dossier + researcher rely on.
test('groundedFacts: a never-resolving OpenAI call throws at timeoutMs (forwarded from GroundedFactsInput.timeoutMs)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  const docs = [{ url: 'https://x', title: 'X', markdown: 'something' }]
  globalThis.fetch = neverResolvingFetch()
  const t0 = Date.now()
  await expect(
    groundedFacts({ web: fakeWeb(docs), subject: 'x', query: 'x', item: true, timeoutMs: 50 }),
  ).rejects.toThrow(/aborted|AbortError|openai:/i)
  expect(Date.now() - t0).toBeLessThan(2000)
})
