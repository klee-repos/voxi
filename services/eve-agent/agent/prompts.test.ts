/**
 * GOLDEN tests for the extracted eve-agent prompts. Each prompt was moved out of code into `prompts/*.md`; a
 * refactor like that is only safe if the bytes the model receives are UNCHANGED. So here we reconstruct the
 * ORIGINAL inline prompt (verbatim, as it was before extraction) and assert the md-backed render is identical —
 * across every conditional branch (assert vs hedge, with/without candidates, with/without unsupported fields,
 * item vs class research). If someone edits a prompt file, these pin exactly what changed.
 */
import { test, expect, describe } from 'bun:test'
import { loadPrompt, renderPrompt } from './prompts'
import { researchPrompt, type ResearchInput } from './providers/live-research'

// ── identify_object (VLM) — a static prompt ──────────────────────────────────────────────────────────────
test('identify-object.md matches the single-primary + display_title prompt verbatim', () => {
  const original =
    `Identify the SINGLE most prominent human-made object in this image — the subject in focus, in the foreground, largest, or what a person would say the photo is "of". Ignore background and incidental objects. Identify THAT object AS SPECIFICALLY AS POSSIBLE — exact make, model, and year/generation if determinable (e.g. '2008 Cannondale SuperSix EVO', NOT 'bike'). Read any badges, logos, or text on it. Also return display_title: a concise, human-friendly name for it (2–5 words, Title Case, no size/spec/quantity noise — e.g. 'La Croix Sparkling Water', 'Canon AE-1', NOT 'aluminium beverage can'), and subject_note: a short phrase naming which object you chose if the scene has several. Set fine_confidence 0..1 for how sure you are of the exact make+model. Return JSON only.`
  expect(loadPrompt('identify-object.md')).toBe(original)
})

// ── narration.system — the original array build, reproduced exactly ──────────────────────────────────────
function originalNarrationSystem(a: { confident: boolean; label: string; chipLabel: string; candidates: string[]; unsupported: string[] }): string {
  return [
    "You are Voxi — a real-world Hitchhiker's Guide crossed with a Pokédex. Dry, witty, unmistakably British; wry, never purple; you never gush.",
    'Narrate what THIS specific object IS and what it is FOR, then the detail that matters most about it, then ONE genuinely interesting fact. Be SPECIFIC and VALUABLE, not generic — describe the actual thing, never a generic category. 3–5 SHORT clauses, ≤ ~80 words total. No greetings, no meta, no lists.',
    a.confident
      ? `The object is CONFIRMED as "${a.label}". You MAY state that identity (cite evidenceRef "id"). Prefer the grounded fact clauses below for the specifics and the interesting fact — cite their refs.`
      : `The identity is NOT confirmed (${a.chipLabel}). You must HEDGE — do NOT assert a specific make/model/year; speak in "looks like"/"I'd wager" terms. You MAY state ONE grounded, CLASS-level fact about what KIND of thing it is (cite its evidenceRef), but never the specific make/model/year.`,
    a.candidates.length > 1 ? `Possible candidates: ${a.candidates.join(' OR ')}.` : '',
    'HONESTY (hard rules): any falsifiable clause (spec, provenance, date, causal, superlative, comparative) MUST carry an evidenceRef from the evidence list below. If you cannot cite it, either say it as pure "flavor" (no facts) or omit it. NEVER invent specs or dates.',
    a.unsupported.length
      ? `Do NOT assert these fields UNLESS a fact from the evidence list below grounds it — then make it a "date"/"spec" clause citing that fact's ref (never smuggle it as flavor): ${a.unsupported.join(', ')}.`
      : '',
    'Label each clause with claimType (spec|provenance|date|causal|superlative|comparative|flavor).',
  ]
    .filter(Boolean)
    .join('\n')
}

const renderNarrationSystem = (a: { confident: boolean; label: string; chipLabel: string; candidates: string[]; unsupported: string[] }): string =>
  renderPrompt('narration.system.md', {
    confident: a.confident,
    label: a.label,
    chipLabel: a.chipLabel,
    hasCandidates: a.candidates.length > 1,
    candidates: a.candidates.join(' OR '),
    hasUnsupported: a.unsupported.length > 0,
    unsupportedFields: a.unsupported.join(', '),
  })

describe('narration.system.md — byte-exact across every branch', () => {
  const cases = [
    { name: 'CONFIDENT, no candidates, no unsupported', confident: true, label: '1976 Canon AE-1', chipLabel: 'Confident', candidates: ['1976 Canon AE-1'], unsupported: [] as string[] },
    { name: 'CONFIDENT, unsupported fields present', confident: true, label: 'Canon AE-1', chipLabel: 'Confident', candidates: ['Canon AE-1'], unsupported: ['year'] },
    { name: 'PROBABLE, two candidates (the common hedge case)', confident: false, label: 'a camera', chipLabel: 'A confident maybe', candidates: ['Canon AE-1', 'Nikon FM'], unsupported: ['make', 'model', 'year'] },
    { name: 'PROBABLE, single candidate, no unsupported', confident: false, label: 'a camera', chipLabel: 'A confident maybe', candidates: ['a camera'], unsupported: [] },
  ]
  for (const c of cases) {
    test(c.name, () => expect(renderNarrationSystem(c)).toBe(originalNarrationSystem(c)))
  }
})

// ── narration.user — the original array build, reproduced exactly ────────────────────────────────────────
interface Ev { ref: string; claim: string; sourceUrl: string }
function originalNarrationUser(label: string, band: string, evidence: Ev[]): string {
  return [
    `OBJECT: ${label} (confidence: ${band})`,
    'EVIDENCE you may cite (ref → claim → url):',
    ...evidence.map((e) => `  ${e.ref} → ${e.claim} → ${e.sourceUrl}`),
    evidence.length === 1 && evidence[0]!.ref === 'id' ? '(no external evidence — keep specifics to flavor only)' : '',
  ]
    .filter(Boolean)
    .join('\n')
}
const renderNarrationUser = (label: string, band: string, evidence: Ev[]): string =>
  renderPrompt('narration.user.md', { label, band, evidence, noExternal: evidence.length === 1 && evidence[0]!.ref === 'id' })

describe('narration.user.md — byte-exact across evidence shapes', () => {
  test('multiple external evidence refs', () => {
    const ev: Ev[] = [
      { ref: 'w1', claim: 'The Canon AE-1 is a 35mm SLR.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1' },
      { ref: 'fact1', claim: 'Introduced in 1976.', sourceUrl: 'https://camerapedia.org/ae1' },
    ]
    expect(renderNarrationUser('1976 Canon AE-1', 'CONFIDENT', ev)).toBe(originalNarrationUser('1976 Canon AE-1', 'CONFIDENT', ev))
  })
  test('only the "id" self-ref → the no-external note appears', () => {
    const ev: Ev[] = [{ ref: 'id', claim: '1976 Canon AE-1', sourceUrl: 'voxi:cascade' }]
    expect(renderNarrationUser('1976 Canon AE-1', 'CONFIDENT', ev)).toBe(originalNarrationUser('1976 Canon AE-1', 'CONFIDENT', ev))
  })
  test('no evidence at all', () => {
    expect(renderNarrationUser('a camera', 'PROBABLE', [])).toBe(originalNarrationUser('a camera', 'PROBABLE', []))
  })
})

// ── research.system + research.user — via the REAL exported researchPrompt() ─────────────────────────────
function originalResearchPrompt(input: ResearchInput): { system: string; user: string } {
  const itemSubject = [input.make, input.model].filter(Boolean).join(' ').trim() || input.label
  const subject = input.scope === 'item' ? `the ${itemSubject}` : `the category of object: ${input.category || input.label}`
  const system = [
    'You are a terse research assistant. Return 3–5 SHORT declarative sentences, each ONE concrete, checkable fact grounded in a source.',
    input.scope === 'item'
      ? 'Facts about THIS specific make/model: what it is and what it is for, one or two defining specs or design facts, and one genuinely interesting fact. Do NOT invent a production year or sub-variant — only state a year if the search results establish it.'
      : 'Facts about the CATEGORY/CLASS only (never a specific make, model, or year): what this kind of object is, and one genuinely interesting fact about the class.',
    'No preamble, no lists, no markdown, no hedging — just the sentences.',
  ].join('\n')
  return { system, user: `Subject: ${subject}. Give the most defining, checkable facts.` }
}

describe('researchPrompt() — byte-exact vs the original for item and class scope', () => {
  const item: ResearchInput = { scope: 'item', label: '1976 Canon AE-1', make: 'Canon', model: 'AE-1', year: 1976, category: 'camera' }
  const klass: ResearchInput = { scope: 'class', label: 'a confident maybe', category: 'camera' }
  test('item scope', () => expect(researchPrompt(item)).toEqual(originalResearchPrompt(item)))
  test('class scope', () => expect(researchPrompt(klass)).toEqual(originalResearchPrompt(klass)))
})
