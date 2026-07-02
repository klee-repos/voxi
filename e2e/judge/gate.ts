/**
 * The DETERMINISTIC reveal-quality gate (PROMPT-QUALITY §3.D3). This — NOT an LLM — is the CI pass/fail. It makes
 * the structural, checkable properties of a good reveal into hard assertions: a concise human title of the ONE
 * primary object; a real, specific description; and ≥3 distinct facts EACH carrying provenance (a source + a
 * verbatim quote). The LLM judge (judge.ts) adds a quality SCORE on top, but only as a non-gating eval signal, so
 * "the LLM never decides pass/fail" (e2e/README) holds. Every check has a negative control in gate.test.ts.
 */

export interface RevealFact {
  text: string
  sourceUrl: string
  quote: string
}

export interface RevealContent {
  title: string
  description: string
  facts: RevealFact[]
}

export interface FixtureExpect {
  /** whole-token terms the title must contain (like spikes/accuracy-spike.ts) — the right object was named. */
  titleTokens: string[]
  /** the title must be at most this many words (a concise human title, not a spec dump). */
  maxTitleWords?: number
  /** the description must contain ≥1 of these (a real specific, not filler). */
  requiredDescriptionTokens: string[]
  /** the description must be at least this many words. */
  minDescriptionWords?: number
  /** how many distinct, provenance-carrying facts are required. */
  minFacts?: number
}

/** Bare category words a good, specific title must never be REDUCED to (it may still contain them as one token). */
export const BANNED_TITLE_CATEGORIES: ReadonlySet<string> = new Set([
  'object', 'thing', 'item', 'product', 'device', 'gadget', 'beverage', 'drink', 'can', 'bottle', 'container', 'a',
])

const words = (s: string): string[] => (s ?? '').trim().split(/\s+/).filter(Boolean)
const tokens = (s: string): string[] => (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

export function checkTitle(title: string, exp: FixtureExpect): string[] {
  const f: string[] = []
  const w = words(title)
  const max = exp.maxTitleWords ?? 6
  if (w.length === 0) f.push('title is empty')
  if (w.length > max) f.push(`title has ${w.length} words (> ${max}) — not a concise human title`)
  const tks = new Set(tokens(title))
  // Reduced to a bare category: every token is a banned category word (e.g. "a beverage can").
  if (tks.size > 0 && [...tks].every((t) => BANNED_TITLE_CATEGORIES.has(t))) f.push(`title "${title}" is a bare category, not the specific object`)
  // Whole-token: the title actually names the expected object.
  const missing = exp.titleTokens.map((t) => t.toLowerCase()).filter((t) => !tks.has(t))
  if (missing.length) f.push(`title "${title}" is missing expected token(s): ${missing.join(', ')}`)
  return f
}

export function checkDescription(description: string, exp: FixtureExpect): string[] {
  const f: string[] = []
  const min = exp.minDescriptionWords ?? 20
  const wc = words(description).length
  if (wc < min) f.push(`description has ${wc} words (< ${min}) — too thin`)
  const hay = description.toLowerCase()
  if (!exp.requiredDescriptionTokens.some((t) => hay.includes(t.toLowerCase()))) {
    f.push(`description mentions none of the required specifics: ${exp.requiredDescriptionTokens.join(' | ')}`)
  }
  return f
}

export function checkFacts(facts: RevealFact[], description: string, exp: FixtureExpect): string[] {
  const f: string[] = []
  const min = exp.minFacts ?? 3
  if (facts.length < min) f.push(`only ${facts.length} fact(s) (< ${min})`)
  // provenance: every fact carries a non-empty quote + a source URL (the "proof if challenged").
  facts.forEach((x, i) => {
    if (!x.text?.trim()) f.push(`fact ${i} has empty text`)
    if (!x.quote?.trim()) f.push(`fact ${i} has no verbatim quote (no provenance)`)
    if (!/^https?:\/\//.test(x.sourceUrl ?? '')) f.push(`fact ${i} has no real source URL (no provenance)`)
  })
  // distinct: no two facts share the same text; and facts are not just the description restated.
  const texts = facts.map((x) => (x.text ?? '').trim().toLowerCase())
  if (new Set(texts).size !== texts.length) f.push('facts are not mutually distinct')
  if (texts.some((t) => t && t === description.trim().toLowerCase())) f.push('a fact is identical to the description')
  return f
}

/** The full deterministic gate: title + description + facts. `ok` iff no check failed. */
export function gate(content: RevealContent, exp: FixtureExpect): { ok: boolean; failures: string[] } {
  const failures = [
    ...checkTitle(content.title, exp),
    ...checkDescription(content.description, exp),
    ...checkFacts(content.facts, content.description, exp),
  ]
  return { ok: failures.length === 0, failures }
}
