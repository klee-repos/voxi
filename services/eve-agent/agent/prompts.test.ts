/**
 * GOLDEN tests for the extracted eve-agent prompts. Each prompt was moved out of code into `prompts/*.md`; a
 * refactor like that is only safe if the bytes the model receives are UNCHANGED. So here we reconstruct the
 * ORIGINAL inline prompt (verbatim, as it was before extraction) and assert the md-backed render is identical —
 * across every conditional branch (assert vs hedge, with/without candidates, with/without unsupported fields,
 * item vs class research). If someone edits a prompt file, these pin exactly what changed.
 */
import { test, expect, describe } from 'bun:test'
import { loadPrompt, renderPrompt } from './prompts'

// ── identify_object (VLM) — a static prompt. The byte-exact golden was retired when the ARTWORK & ARTIFACT LANE
//    was added (§F5, museum eval); we now pin the load-bearing INVARIANTS so a future edit can't silently drop the
//    make/model, OCR, filler-ban, JSON, or art-lane guidance (the drift-guard survives, the brittleness doesn't). ──
describe('identify-object.md — load-bearing invariants', () => {
  const p = loadPrompt('identify-object.md')
  test('keeps the exact make/model/year guidance', () => {
    expect(p).toContain('exact make, model, and year/generation')
    expect(p).toContain('2008 Cannondale SuperSix EVO')
  })
  test('keeps the OCR (read text exactly) guidance', () => {
    expect(p).toMatch(/Read any badges, logos, stamps, or text on it EXACTLY/)
  })
  test('keeps the filler-word ban and the JSON contract', () => {
    expect(p).toMatch(/NEVER use filler or non-answer words/)
    expect(p).toContain('Return JSON only')
    expect(p).toContain('display_title')
  })
  test('adds the ARTWORK & ARTIFACT LANE (a painting is the work, not a thing depicted in it)', () => {
    expect(p).toContain('ARTWORK & ARTIFACT LANE')
    expect(p).toMatch(/the painting is/i)
    expect(p).toContain('The Starry Night')
    expect(p).toMatch(/artist \/ maker \/ culture/i)
  })
})

// ── narration.system — the original array build, reproduced exactly ──────────────────────────────────────
function originalNarrationSystem(a: { confident: boolean; label: string; chipLabel: string; candidates: string[]; unsupported: string[] }): string {
  return [
    "You are Voxi — a real-world Hitchhiker's Guide crossed with a Pokédex. Dry, witty, unmistakably British; wry, never purple; you never gush.",
    `Answer, each point as its OWN clause, ALWAYS about THIS EXACT object. Give TWO or THREE short sentences for each bucket you can ground — a grounded detail or two, not a bare one-liner — keep each bucket tight (≤ ~55 words), and OMIT a bucket rather than pad it with a generic category truth. In order: FIRST, in plain words, say WHAT KIND of thing it is — ALWAYS name its category/type up front so the reader knows what it is (e.g. "a wireless game controller", "a 35mm SLR camera"), even when you must hedge the exact make/model — then the detail that sets THIS one apart, and — when an evidence ref whose url is "voxi:observed" is present — an "observation" clause that RESTATES the mark read off it (e.g. "it bears the Sub Pop stamp") and nothing more (bucket "what_is_it"); THEN what THIS is FOR — name the object, then what it was made to DO or what it commemorates, grounded where a cited fact exists, not a generic category truism (bucket "purpose"); THEN WHO it is from — the brand or maker plus a grounded detail — whenever a cited fact is about that brand, company, label, or designer (bucket "maker"); and THEN WHEN it was made — a short, grounded date/era clause — whenever a cited fact gives the object's or model's own production date (bucket "made"). Keep identity and purpose in DIFFERENT clauses. No greetings, no meta, no lists.`,
    a.confident
      ? `The object is CONFIRMED as "${a.label}". You MAY state that identity (cite evidenceRef "id"). Prefer the grounded fact clauses below for the specifics and the interesting fact — cite their refs.`
      : `The identity is NOT confirmed (${a.chipLabel}). You must HEDGE the make/model/year — speak in "looks like"/"I'd wager" terms and never assert a specific model, year, or edition; but ALWAYS still state plainly WHAT KIND of thing it is (its category/type) — hedge only the precise make/model, never the plain identification. You MAY state a mark you READ off it as an "observation" (citing its "voxi:observed" ref), and any grounded fact about that brand or the KIND of thing it is (cite its evidenceRef).`,
    a.candidates.length > 1 ? `Possible candidates: ${a.candidates.join(' OR ')}.` : '',
    `HONESTY (hard rules): any falsifiable clause (spec, provenance, date, causal, superlative, comparative) MUST carry an evidenceRef from the evidence list below; if you cannot cite it, say it as pure "flavor" (no facts) or omit it — NEVER invent specs or dates. An evidenceRef whose url is "voxi:observed" is a mark you READ off the object: cite it ONLY in an "observation" clause that merely restates that mark, NEVER to assert a make/model/year/edition or the maker's history. A brand you only READ off the object is NOT proof it was MADE there — state only the relationship a cited fact supports ("branded by"/"merch from"/"released by"/"sold by"), NEVER "made by" unless a cited fact names the actual manufacturer. NEVER state personal data read off an object (names, dates, numbers, addresses).`,
    a.unsupported.length
      ? `Do NOT assert these fields UNLESS a fact from the evidence list below grounds it — then make it a "date"/"spec" clause citing that fact's ref (never smuggle it as flavor): ${a.unsupported.join(', ')}.`
      : '',
    `Label each clause with claimType (spec|provenance|date|causal|superlative|comparative|observation|flavor) AND bucket (what_is_it|purpose|maker|made). For the maker bucket, WHENEVER a cited fact is about the brand, company, label, or designer, give TWO short sentences: FIRST WHO they are — what kind of company or label, where or when they started, what they are best known for (cite the facts) — THEN the relationship to THIS object ("branded by"/"merch from"/"released by"/"made by"). Do not merely date this object; tell the user who is behind it. Omit the maker only when nothing grounds it (never guess who made it). For the "made" bucket, give ONE short, date-led sentence stating WHEN THIS object or model was PRODUCED/manufactured/released — the year, era, or production span (claimType "date", citing a fact's ref): e.g. "Produced from 1954 to 1966." or "Dates to the late 19th century." This must be about when THIS specific object or model was MADE — NEVER when its broad category, material, or underlying technology was invented, patented, or founded (do not date a plywood board to when plywood was patented, or a camera to when the SLR was invented). Omit the "made" bucket unless a cited fact grounds the object's own production date.`,
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

// (The old researchPrompt() golden lived here — it pinned the native-grounding research.system/research.user prompt
// rendering. That path is gone: groundedFacts (lib/grounded-research) now grounds via research-extract.system.md over
// Firecrawl markdown. The item/class SUBJECT is still pinned, in live-research.test.ts → researchSubject().)
