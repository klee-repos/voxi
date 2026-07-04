import { afterEach, test, expect } from 'bun:test'
import { groundedFacts } from './grounded-research'
import type { WebResearchProvider } from '../tools/web_research'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.GLM_API_KEY
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

test('groundedFacts: Firecrawl docs → GLM extracts facts with PER-FACTOR sourceUrls + the fetched sources', async () => {
  process.env.GLM_API_KEY = 'k-test'
  const docs = [
    { url: 'https://en.wikipedia.org/wiki/Canon_AE-1', title: 'Canon AE-1', markdown: 'The Canon AE-1 is a 35mm SLR introduced in 1976.' },
  ]
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { model: string }
    expect(body.model).toBe('glm-5.2') // the extractor is GLM-5.2, not Gemini
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

test('groundedFacts: a GLM error propagates (fail-loud, never a fake empty-success over real docs)', async () => {
  process.env.GLM_API_KEY = 'k-test'
  const docs = [{ url: 'https://x', title: 'X', markdown: 'something' }]
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'glm down' }), { status: 500 })) as typeof fetch
  await expect(groundedFacts({ web: fakeWeb(docs), subject: 'x', query: 'x', item: true })).rejects.toThrow(/glm/)
})
