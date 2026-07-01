/**
 * GOLDEN tests for the extracted podcast-worker prompts (PLAN §6.2). The research prompt, the two-host script
 * system prompt, and the fact-list user prompt were moved out of `providers.ts` into `prompts/*.md`. These
 * reconstruct the ORIGINAL inline strings and assert the md-backed render is byte-identical — so the words the
 * render pipeline sends to Gemini did not shift by a single character.
 */
import { test, expect, describe } from 'bun:test'
import { loadPrompt, renderPrompt } from './prompts'

test('research.md matches the original inline research prompt', () => {
  const subject = '2008 Cannondale SuperSix EVO'
  const original =
    `Research the object "${subject}". Using web search, give 5–6 SPECIFIC, verifiable facts about it — ` +
    `its make/model/generation, year, key specifications, provenance, and notability. Each fact must be the ` +
    `kind you could cite. Return ONLY a JSON array: [{"claim": "<one factual sentence>"}]. No prose.`
  expect(renderPrompt('research.md', { subject })).toBe(original)
})

test('script.system.md matches the original inline two-host system prompt', () => {
  const original = [
    'You write a SHORT two-host podcast segment (~8-12 clauses) about an object, for the show "Voxi\'s Guide".',
    'ARLO is the enthusiast (warm, carries momentum). MAVE is the skeptic / fact-checker (dry, precise). They alternate.',
    'HONESTY (hard rules): every falsifiable clause (spec/provenance/date/causal/superlative/comparative) MUST set evidenceRef to one of the fact ids below. If you cannot ground it, make it a "flavor" clause (no facts). NEVER invent specs, dates, or numbers not in the facts.',
    'Return JSON: { clauses: [{ speaker, text, claimType, evidenceRef? }] }. Keep each clause to one sentence.',
  ].join('\n')
  expect(loadPrompt('script.system.md')).toBe(original)
})

describe('script.user.md — byte-exact vs the original fact-list build', () => {
  const build = (subject: string, claims: string[]) => {
    const facts = claims.map((claim) => ({ claim }))
    const refs = facts.map((_, i) => `f${i + 1}`)
    const original = [`OBJECT: ${subject}`, 'FACTS you may cite:', ...facts.map((f, i) => `  ${refs[i]} → ${f.claim}`)].join('\n')
    const rendered = renderPrompt('script.user.md', { subject, facts: facts.map((f, i) => ({ ref: refs[i], claim: f.claim })) })
    return { original, rendered }
  }
  test('several facts', () => {
    const { original, rendered } = build('Canon AE-1', ['A 35mm SLR.', 'Introduced in 1976.', 'Had a microprocessor.'])
    expect(rendered).toBe(original)
  })
  test('a single fact', () => {
    const { original, rendered } = build('a camera', ['It takes photographs.'])
    expect(rendered).toBe(original)
  })
})
