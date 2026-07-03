/**
 * Static tests for the podcast-worker prompts (PLAN §6.2 / §F3). The script + research prompts were reformatted
 * into the "Deep Dive" NPR/Serial two-voice INTERVIEW (script.system.md) and a wider, story-biased research brief
 * (research.md), so their old byte-exact goldens no longer apply. These assert the load-bearing INVARIANTS
 * instead of the exact bytes — chiefly the HONESTY hard-rule sentence VERBATIM (the drift-guard we must not lose),
 * plus the interview framing and the duration budget. The fact-list user prompt (script.user.md) is unchanged, so
 * its byte-exact golden stays.
 *
 * (Whether the MODEL actually produces the interview shape — host asks ≥N questions, guest answers carry
 * evidenceRefs, in-band word count — is a property of Gemini's OUTPUT, not the prompt string, and is verified by
 * the cred-gated eval, not here.)
 */
import { test, expect, describe } from 'bun:test'
import { loadPrompt, renderPrompt } from './prompts'

// The honesty hard-rule sentence, VERBATIM. If a future prompt edit drops or softens it, this fails loudly — the
// self-labeling honesty contract the render gate depends on must survive every reformat.
const HONESTY_SENTENCE =
  'HONESTY (hard rules): every falsifiable clause (spec/provenance/date/causal/superlative/comparative) MUST set evidenceRef to one of the fact ids below. If you cannot ground it, make it a "flavor" clause (no facts). NEVER invent specs, dates, or numbers not in the facts.'

describe('script.system.md — the Deep Dive two-voice interview prompt', () => {
  const sys = loadPrompt('script.system.md')

  test('preserves the HONESTY hard-rule sentence VERBATIM (drift-guard)', () => {
    expect(sys).toContain(HONESTY_SENTENCE)
  })
  test('is a two-role interview (ARLO host asks, MAVE expert answers)', () => {
    expect(sys).toContain('ARLO')
    expect(sys).toContain('MAVE')
    expect(sys).toMatch(/host/i)
    expect(sys).toMatch(/expert|guest/i)
    expect(sys).toMatch(/serial|npr/i)
  })
  test('instructs a genuine question cadence (host asks questions)', () => {
    expect(sys).toMatch(/ask/i)
    expect(sys).toMatch(/question/i)
  })
  test('carries an explicit duration budget in the 1–5 min band', () => {
    // The steering target must be present so the generator aims for a Deep-Dive-length script.
    expect(sys).toMatch(/2\.5|3\.5|minute/i)
    expect(sys).toMatch(/18|30|clauses/i)
  })
  test('still specifies the JSON return shape', () => {
    expect(sys).toContain('{ clauses: [{ speaker, text, claimType, evidenceRef? }] }')
  })
})

describe('research.md — the wider, story-biased research brief', () => {
  test('asks for 8–12 story-worthy facts (not the old 5–6 spec list) and JSON-only', () => {
    const r = renderPrompt('research.md', { subject: 'a test object' })
    expect(r).toContain('a test object')
    expect(r).toMatch(/8[–-]12/)
    expect(r).not.toMatch(/5[–-]6/)
    expect(r).toMatch(/story|origin|history|matters/i)
    expect(r).toContain('JSON array')
  })
})

describe('script.user.md — byte-exact vs the original fact-list build (UNCHANGED)', () => {
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
