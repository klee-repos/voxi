/**
 * LiveDossierProvider — the async provider drives buildDossier over a draft and STREAMS each verified fact, then
 * the terminal dossier. A draft whose facts fail the provenance loop yields nothing (never a fake); an empty
 * primary falls back to the secondary source. The draft is faked here so the STREAMING + FALLBACK are exercised
 * without a live model/crawl (the closed provenance loop itself is tested in subagents/researcher/index.test.ts).
 */
import { test, expect, describe } from 'bun:test'
import { LiveDossierProvider, type DossierDraftSource, type ResearchEvent } from './live-dossier'
import type { ProposedDossier, FetchedSource, DossierInput } from '../subagents/researcher'

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
