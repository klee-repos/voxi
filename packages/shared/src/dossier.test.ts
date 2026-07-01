/**
 * ResearchDossier boundary schema (PROMPT-QUALITY §3.B3): a well-formed dossier round-trips, and a malformed one
 * is rejected at the boundary so client/BFF/agent can never silently disagree on the shape.
 */
import { test, expect, describe } from 'bun:test'
import { parseDossier, ResearchDossier, DossierFact } from './dossier'

const GOOD = {
  subject: 'Canon AE-1',
  scope: 'item' as const,
  overview: [{ text: 'A 35mm SLR.', claimType: 'spec' as const, evidenceRef: 'fact1' }],
  facts: [
    { text: 'A 35mm SLR.', claimType: 'spec' as const, evidenceRef: 'fact1', sourceUrl: 'https://x/ae1', sourceTitle: 'Canon AE-1', quote: 'The Canon AE-1 is a 35 mm SLR.', order: 0 },
  ],
  evidence: [{ ref: 'fact1', sourceUrl: 'https://x/ae1', claim: 'The Canon AE-1 is a 35 mm SLR.' }],
  sources: [{ url: 'https://x/ae1', title: 'Canon AE-1' }],
  provenance: { model: 'test', generatedAt: 0, toolCalls: 2 },
}

describe('ResearchDossier zod', () => {
  test('a well-formed dossier round-trips', () => {
    const d = parseDossier(GOOD)
    expect(d.subject).toBe('Canon AE-1')
    expect(d.facts[0]!.quote).toContain('35 mm SLR')
  })
  test('scope is constrained to item|class', () => {
    expect(() => ResearchDossier.parse({ ...GOOD, scope: 'guess' })).toThrow()
  })
  test('a fact index/order are optional (assigned at stream/persist time)', () => {
    const f = DossierFact.parse({ text: 't', claimType: 'spec', evidenceRef: 'r', sourceUrl: 'u', quote: 'q' })
    expect(f.sourceTitle).toBe('') // defaulted
    expect(f.index).toBeUndefined()
  })
  test('a malformed dossier (missing sources) is rejected', () => {
    const { sources: _omit, ...bad } = GOOD
    expect(() => parseDossier(bad)).toThrow()
  })
})
