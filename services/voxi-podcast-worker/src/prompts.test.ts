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

  // The Deep Dive story framework (defamiliarization + Serial) — the fix for "it starts in the middle".
  test('uses the reveal CONTEXT to orient rather than rediscover the object', () => {
    expect(sys).toMatch(/context/i)
    expect(sys).toMatch(/orient/i)
  })
  test('directs a stage-setting, defamiliarizing intro (name it plainly, then make it strange)', () => {
    expect(sys).toMatch(/defamiliar/i)
    expect(sys).toMatch(/stage/i)
    expect(sys).toMatch(/strange/i)
    // and explicitly forbids the mid-thought / dry-intro failure modes
    expect(sys).toMatch(/mid-argument|middle of|Today we're looking at/i)
  })
  test('the naming opener must be a GROUNDED clause, not flavor (so a branded title is not cut)', () => {
    expect(sys).toMatch(/provenance/i)
    expect(sys).toMatch(/identified as|identity/i)
  })
  test('names the spine question shapes and the intimate↔cosmic zoom', () => {
    expect(sys).toMatch(/spine/i)
    expect(sys).toMatch(/How did this get here|What is this really|What did this witness|Why does this exist/i)
    expect(sys).toMatch(/zoom|intimate|cosmic/i)
  })
  test('treats what/purpose/maker as non-citeable background, cite-or-cut (honesty bridge)', () => {
    expect(sys).toMatch(/background/i)
    expect(sys).toMatch(/cut the line|keep it as (plain )?flavor/i)
  })

  // The OUTRO / "LAND IT" move (the fix for "it ends abruptly"): a real landing that bookends the open, in
  // character, gate-safe. Drift-guards on the load-bearing wording so a future reformat can't silently drop it.
  test('directs a real OUTRO that bookends the open and does not just stop (LAND IT)', () => {
    expect(sys).toContain('LAND IT')
    expect(sys).toMatch(/bookend|closes the loop/i)
    expect(sys).toMatch(/final word|sign off|sign-off|landing/i)
  })
  test('forbids radio-DJ boilerplate as the outro (so it stays in-story, not "thanks for listening")', () => {
    expect(sys).toMatch(/thanks for listening|tune in next time/i)
    expect(sys).toMatch(/do not|never|don't/i)
  })
  test('routes an object-naming bookend through the GROUNDED provenance clause (gate-safe outro, not a cut flavor name)', () => {
    // the outro must reuse the opener's grounding trick if it names the object, or the proper-noun auditor cuts it
    expect(sys).toMatch(/provenance/i)
  })
  test('the required-beats sentence now demands the LANDING alongside zoom and people (amended MUST sentence)', () => {
    expect(sys).toMatch(/MUST land[\s\S]*zoom[\s\S]*people[\s\S]*landing/i)
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

describe('script.user.md — a no-context job stays byte-exact to the original fact-list build (back-compat)', () => {
  // The template GAINED an optional reveal-context block (identity confidence + what/purpose/maker). With no
  // context every section elides and the render must be byte-identical to the original — so older items / global
  // catalog ids with no durable reveal are unaffected.
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
  test('WITH context: renders the identity confidence + what/purpose/maker block above the FACTS', () => {
    const rendered = renderPrompt('script.user.md', {
      subject: '1976 Canon AE-1', band: 'CONFIDENT', whatItIs: 'A 35mm SLR film camera.', purpose: 'Taking photographs.', maker: 'Made by Canon.',
      facts: [{ ref: 'f1', claim: 'Launched in 1976.' }],
    })
    expect(rendered).toBe(
      [
        'OBJECT: 1976 Canon AE-1 (identified with CONFIDENT confidence)',
        'WHAT IT IS: A 35mm SLR film camera.',
        "WHAT IT'S FOR: Taking photographs.",
        'WHO MADE IT: Made by Canon.',
        'FACTS you may cite:',
        '  f1 → Launched in 1976.',
      ].join('\n'),
    )
  })
})
