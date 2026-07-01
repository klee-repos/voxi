/**
 * Deterministic tests for the identification cascade STREAM (PLAN §4.6, §8.4, §5, §8.3).
 *
 * No creds, no framework, no live model: FAKE providers supply exactly what Cloud Vision / Gemini / the vector
 * match would, and the REAL `runIdentificationCascade` drives the REAL `safety_gate` + `identify_object` +
 * shared arbiter. Every emitted event is round-tripped through the REAL `parseEventLine` (the same Zod contract
 * the client enforces) so the bridge can NEVER emit an off-contract event. This is the no-cheating deterministic
 * half; the live half (real Gemini + Cloud Vision through the same generator) is proven by spikes/live-bff-scan.ts.
 */
import { test, expect, describe } from 'bun:test'
import { runIdentificationCascade, buildResearchInput, type CascadeDeps } from './cascade'
import type { VisionProvider, VisionStages, ImageRef, IdentifyResult } from './tools/identify_object'
import type { SafetyClassifier, SafetyClassification } from './tools/safety_gate'
import type { Candidate } from '../../../packages/shared/src/arbitration'
import type { Researcher, ResearchInput } from './providers/live-research'
import type { NarrationInput } from './providers/live-narrator'
import type { DossierProvider, ResearchEvent } from './providers/live-dossier'
import type { DossierInput } from './subagents/researcher'
import type { ResearchDossier, DossierFact } from '../../../packages/shared/src/dossier'
import { parseEventLine, type StreamEvent } from '../../../packages/shared/src/events'

class FakeVision implements VisionProvider {
  constructor(private stages: VisionStages) {}
  async analyze(_i: ImageRef): Promise<VisionStages> {
    return this.stages
  }
}
class ThrowingVision implements VisionProvider {
  async analyze(): Promise<VisionStages> {
    throw new Error('vertex 503')
  }
}
class FakeSafety implements SafetyClassifier {
  constructor(private c: SafetyClassification) {}
  async classify(_i: ImageRef): Promise<SafetyClassification> {
    return this.c
  }
}
class ThrowingSafety implements SafetyClassifier {
  async classify(): Promise<SafetyClassification> {
    throw new Error('cloud vision safesearch 503')
  }
}

const IMG: ImageRef = { uri: 'gs://voxi-photos/redacted/abc.jpg' }
const SAFE = new FakeSafety({ category: 'safe', confidence: 1 })

/** Drain the async generator into an array, asserting EVERY event is a valid on-contract event as we go. */
async function drain(deps: CascadeDeps, sessionId = 'sess_test'): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of runIdentificationCascade(sessionId, IMG, deps)) {
    // The load-bearing no-cheating check: the bridge's own event must survive the client's real Zod parser.
    expect(parseEventLine(JSON.stringify(ev))).toEqual(ev)
    out.push(ev)
  }
  return out
}

/** A fake narrator that records whether it was called and returns fixed, already-"approved" clauses. */
class FakeNarrator {
  called = false
  constructor(private clauses: string[]) {}
  async narrate() {
    this.called = true
    return { clauses: this.clauses, dropped: 0 }
  }
}

const types = (evs: StreamEvent[]) => evs.map((e) => e.type)
const band = (evs: StreamEvent[]) => evs.find((e) => e.type === 'confidence_band') as Extract<StreamEvent, { type: 'confidence_band' }> | undefined

describe('cascade — monotonic indices + terminal done on every path', () => {
  test('indices are 0..n-1 and the last event is always `done` echoing the sessionId', async () => {
    const evs = await drain({ vision: new FakeVision({ vlm: { name: 'a thing', source: 'vlm', confidence: 0.4 } }), safety: SAFE }, 'sess_xyz')
    expect(evs.map((e) => e.index)).toEqual(evs.map((_, i) => i))
    const last = evs[evs.length - 1]!
    expect(last.type).toBe('done')
    expect((last as Extract<StreamEvent, { type: 'done' }>).sessionId).toBe('sess_xyz')
  })
})

describe('cascade — CONFIDENT reveal', () => {
  test('a high-cosine catalog match agreeing with the VLM → confidence_band CONFIDENT', async () => {
    const catalog: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 }
    const vlm: Candidate = { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.8 }
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'tool_start', 'tool_result', 'confidence_band', 'done'])
    expect(band(evs)!.band).toBe('CONFIDENT')
    expect(band(evs)!.title).toBe('2008 Cannondale SuperSix EVO')
    expect(band(evs)!.candidates).toEqual(['2008 Cannondale SuperSix EVO'])
  })
})

describe('cascade — PROBABLE surfaces BOTH candidates (never asserts one)', () => {
  test('catalog↔web disagreement on different models → PROBABLE with both names', async () => {
    const catalog: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.9, cosine: 0.7 }
    const web: Candidate = { name: '2010 Cannondale CAAD10', make: 'Cannondale', model: 'CAAD10', source: 'web', confidence: 0.8 }
    const vlm: Candidate = { name: 'Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.6 }
    const evs = await drain({ vision: new FakeVision({ catalog, web, vlm }), safety: SAFE })
    expect(band(evs)!.band).toBe('PROBABLE')
    expect(band(evs)!.candidates).toHaveLength(2)
    expect(band(evs)!.candidates).toContain('2008 Cannondale SuperSix EVO')
    expect(band(evs)!.candidates).toContain('2010 Cannondale CAAD10')
  })
})

describe('cascade — UNKNOWN → interview handoff', () => {
  test('nothing clears the floor → confidence_band UNKNOWN', async () => {
    const vlm: Candidate = { name: 'some gadget', make: 'Acme', source: 'vlm', confidence: 0.3 }
    const evs = await drain({ vision: new FakeVision({ vlm }), safety: SAFE })
    expect(band(evs)!.band).toBe('UNKNOWN')
  })
})

describe('cascade — persona narration streams as token events AFTER the reveal band (opt-in)', () => {
  const catalog: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 }
  const vlm: Candidate = { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.8 }

  test('CONFIDENT reveal + narrator → confidence_band, then narration tokens, then done', async () => {
    const narrator = new FakeNarrator(['A 2008 Cannondale SuperSix EVO.', 'A featherweight climbing frame, and it knows it.'])
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator })
    expect(narrator.called).toBe(true)
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'tool_start', 'tool_result', 'confidence_band', 'token', 'token', 'done'])
    const tokens = evs.filter((e) => e.type === 'token') as Extract<StreamEvent, { type: 'token' }>[]
    expect(tokens.map((t) => t.text)).toEqual(['A 2008 Cannondale SuperSix EVO.', 'A featherweight climbing frame, and it knows it.'])
    // narration comes strictly AFTER the reveal band
    expect(evs.findIndex((e) => e.type === 'confidence_band')).toBeLessThan(evs.findIndex((e) => e.type === 'token'))
  })

  test('UNKNOWN → narrator is NOT invoked (the interview handles it, not the persona)', async () => {
    const narrator = new FakeNarrator(['should never appear'])
    const evs = await drain({ vision: new FakeVision({ vlm: { name: 'a gadget', make: 'Acme', source: 'vlm', confidence: 0.3 } }), safety: SAFE, narrator })
    expect(narrator.called).toBe(false)
    expect(evs.some((e) => e.type === 'token')).toBe(false)
  })

  test('a safety refusal → narrator is NOT invoked (no narration on a suppressed image)', async () => {
    const narrator = new FakeNarrator(['should never appear'])
    await drain({ vision: new FakeVision({ vlm: { name: 'x', source: 'vlm', confidence: 0.9 } }), safety: new FakeSafety({ category: 'pills_medical', confidence: 0.9 }), narrator })
    expect(narrator.called).toBe(false)
  })
})

/** Records the ResearchInput it was called with; returns fixed grounded facts (or throws, to test non-fatality). */
class FakeResearcher implements Researcher {
  called = false
  lastInput: ResearchInput | null = null
  constructor(private facts: { ref: string; sourceUrl: string; claim: string }[], private throws = false) {}
  async research(input: ResearchInput) {
    this.called = true
    this.lastInput = input
    if (this.throws) throw new Error('grounded search 503')
    return this.facts
  }
}
/** Records the NarrationInput it received (so a test can assert the grounded facts were merged in); emits fixed clauses. */
class RecordingNarrator {
  lastInput: NarrationInput | null = null
  async narrate(input: NarrationInput) {
    this.lastInput = input
    return { clauses: ['A grounded reveal.'], dropped: 0 }
  }
}

describe('buildResearchInput — honesty-safe keying (A8/A9)', () => {
  const mk = (over: Partial<IdentifyResult>): IdentifyResult => ({
    label: 'x', granularity_level: 'make_model', confidence_band: 'CONFIDENT', evidence: [], unsupported_fields: [], route: 'reveal', candidates: [], reason: '', ...over,
  })

  test('CONFIDENT via VLM (source vlm): year + parenthetical edition are STRIPPED from the research key', () => {
    const chosen: Candidate = { name: '1976 Canon AE-1', make: 'Canon', model: 'AE-1 (Montréal Olympic Ed.)', year: 1976, source: 'vlm', confidence: 0.9 }
    const ri = buildResearchInput(mk({ label: '1976 Canon AE-1', candidates: [chosen], category: 'camera' }))
    expect(ri).toEqual({ scope: 'item', label: '1976 Canon AE-1', make: 'Canon', model: 'AE-1', year: undefined, category: 'camera' })
  })

  test('CONFIDENT via a NON-vlm stage (catalog/web carried the year): the year IS a research key', () => {
    const chosen: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 }
    const ri = buildResearchInput(mk({ label: '2008 Cannondale SuperSix EVO', candidates: [chosen] }))
    expect(ri?.scope).toBe('item')
    expect(ri?.year).toBe(2008)
    expect(ri?.model).toBe('SuperSix EVO')
  })

  test('PROBABLE → class scope keyed on category ONLY (no make/model/year)', () => {
    const ri = buildResearchInput(mk({ confidence_band: 'PROBABLE', label: 'A or B', category: 'watch' }))
    expect(ri).toEqual({ scope: 'class', label: 'A or B', category: 'watch' })
  })

  test('UNKNOWN → null (the interview handles it, never the persona)', () => {
    expect(buildResearchInput(mk({ confidence_band: 'UNKNOWN' }))).toBeNull()
  })
})

describe('cascade — grounded enrichment merges facts into narration evidence (CONFIDENT item / PROBABLE class)', () => {
  const catalog: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 }
  const vlm: Candidate = { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.8 }
  const FACTS = [{ ref: 'fact1', sourceUrl: 'https://ex/1', claim: 'A featherweight climbing frame.' }]

  test('CONFIDENT → researcher called at item scope; the grounded fact reaches the narrator evidence', async () => {
    const researcher = new FakeResearcher(FACTS)
    const narrator = new RecordingNarrator()
    await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator, researcher })
    expect(researcher.called).toBe(true)
    expect(researcher.lastInput?.scope).toBe('item')
    expect(researcher.lastInput?.make).toBe('Cannondale')
    expect(narrator.lastInput?.evidence.some((e) => e.ref === 'fact1')).toBe(true)
  })

  test('PROBABLE → researcher called at CLASS scope (no specific model) and the class fact reaches narration', async () => {
    const web: Candidate = { name: '2010 Cannondale CAAD10', make: 'Cannondale', model: 'CAAD10', source: 'web', confidence: 0.8 }
    const cat: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.9, cosine: 0.7 }
    const v: Candidate = { name: 'Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.6, category: 'bicycle' }
    const researcher = new FakeResearcher(FACTS)
    const narrator = new RecordingNarrator()
    const evs = await drain({ vision: new FakeVision({ catalog: cat, web, vlm: v }), safety: SAFE, narrator, researcher })
    expect(band(evs)!.band).toBe('PROBABLE')
    expect(researcher.lastInput?.scope).toBe('class')
    expect(researcher.lastInput?.make).toBeUndefined()
    expect(researcher.lastInput?.category).toBe('bicycle')
    expect(narrator.lastInput?.evidence.some((e) => e.ref === 'fact1')).toBe(true)
  })

  test('UNKNOWN → researcher is NOT called (no identity to ground)', async () => {
    const researcher = new FakeResearcher(FACTS)
    await drain({ vision: new FakeVision({ vlm: { name: 'a gadget', make: 'Acme', source: 'vlm', confidence: 0.3 } }), safety: SAFE, narrator: new RecordingNarrator(), researcher })
    expect(researcher.called).toBe(false)
  })

  test('a researcher THROW is non-fatal — the reveal + narration still stream', async () => {
    const researcher = new FakeResearcher(FACTS, true) // throws
    const narrator = new RecordingNarrator()
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator, researcher })
    expect(band(evs)!.band).toBe('CONFIDENT')
    expect(evs.some((e) => e.type === 'token')).toBe(true) // narration still emitted on web evidence only
    expect(narrator.lastInput?.evidence.some((e) => e.ref === 'fact1')).toBe(false) // no facts merged on throw
  })

  test('NO researcher → narration evidence is exactly the identify evidence (byte-identical to today)', async () => {
    const narrator = new RecordingNarrator()
    await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator })
    expect(narrator.lastInput?.evidence.every((e) => e.ref !== 'fact1')).toBe(true)
  })
})

/** A fake async deep-research provider: streams the given verified facts, then the terminal dossier (or null). */
class FakeDossier implements DossierProvider {
  called = false
  lastInput: DossierInput | null = null
  constructor(private facts: DossierFact[], private dossier: ResearchDossier | null, private throws = false) {}
  async *research(input: DossierInput): AsyncGenerator<ResearchEvent> {
    this.called = true
    this.lastInput = input
    for (const fact of this.facts) {
      if (this.throws) throw new Error('research 503') // mid-stream failure must be non-fatal
      yield { type: 'fact', fact }
    }
    yield { type: 'done', dossier: this.dossier }
  }
}

describe('cascade — async deep research streams verified facts + a description upgrade AFTER the reveal (opt-in)', () => {
  const catalog: Candidate = { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 }
  const vlm: Candidate = { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.8 }
  const FACT: DossierFact = { text: 'The frame is carbon.', claimType: 'spec', evidenceRef: 'fact1', sourceUrl: 'https://ex/1', sourceTitle: 'Cannondale', quote: 'the frame is carbon' }
  const DOSSIER: ResearchDossier = {
    subject: 'Cannondale SuperSix EVO', scope: 'item', overview: [], facts: [FACT],
    evidence: [{ ref: 'fact1', sourceUrl: 'https://ex/1', claim: 'the frame is carbon' }],
    sources: [{ url: 'https://ex/1', title: 'Cannondale' }], provenance: { model: 't', generatedAt: 0, toolCalls: 0 },
  }

  test('CONFIDENT → confidence_band, first-pass tokens, fact events (with provenance), description_upgrade, THEN done', async () => {
    const dossier = new FakeDossier([FACT], DOSSIER)
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator: new RecordingNarrator(), dossier })
    expect(dossier.called).toBe(true)
    expect(dossier.lastInput?.scope).toBe('item')
    const fact = evs.find((e) => e.type === 'fact') as Extract<StreamEvent, { type: 'fact' }> | undefined
    expect(fact).toBeDefined()
    expect(fact!.quote).toBe('the frame is carbon') // provenance rides the event
    expect(fact!.sourceUrl).toBe('https://ex/1')
    expect(evs.some((e) => e.type === 'description_upgrade')).toBe(true)
    // ordering: reveal band < fact < description_upgrade < done (facts stream AFTER the instant reveal)
    const doneIdx = evs.findIndex((e) => e.type === 'done')
    expect(evs.findIndex((e) => e.type === 'confidence_band')).toBeLessThan(evs.findIndex((e) => e.type === 'fact'))
    expect(evs.findIndex((e) => e.type === 'fact')).toBeLessThan(doneIdx)
    expect(evs.findIndex((e) => e.type === 'description_upgrade')).toBeLessThan(doneIdx)
    // monotonic indices survive the two-phase stream
    expect(evs.map((e) => e.index)).toEqual(evs.map((_, i) => i))
    // and every event (incl. fact/description_upgrade) is on-contract (drain round-trips through the strict parser)
  })

  test('a dossier that yields NO usable dossier (done:null) → facts may stream but no description_upgrade', async () => {
    const dossier = new FakeDossier([], null)
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator: new RecordingNarrator(), dossier })
    expect(evs.some((e) => e.type === 'description_upgrade')).toBe(false)
    expect(evs[evs.length - 1]!.type).toBe('done')
  })

  test('a research THROW mid-stream is non-fatal — the reveal + a terminal done still stand', async () => {
    const dossier = new FakeDossier([FACT], DOSSIER, true) // throws before yielding the fact
    const evs = await drain({ vision: new FakeVision({ catalog, vlm }), safety: SAFE, narrator: new RecordingNarrator(), dossier })
    expect(band(evs)!.band).toBe('CONFIDENT')
    expect(evs[evs.length - 1]!.type).toBe('done') // deferred done still fires after the swallowed failure
  })

  test('UNKNOWN → the dossier provider is NOT invoked (nothing confirmed to research)', async () => {
    const dossier = new FakeDossier([FACT], DOSSIER)
    await drain({ vision: new FakeVision({ vlm: { name: 'a gadget', make: 'Acme', source: 'vlm', confidence: 0.3 } }), safety: SAFE, narrator: new RecordingNarrator(), dossier })
    expect(dossier.called).toBe(false)
  })
})

describe('cascade — safety refusals terminate BEFORE identification (and never leak a label)', () => {
  test('pills_medical → error(safety_refusal) + done, identify_object NEVER runs', async () => {
    const vlm: Candidate = { name: 'Atorvastatin 20mg', make: 'Pfizer', model: 'Lipitor', source: 'vlm', confidence: 0.95 }
    const evs = await drain({ vision: new FakeVision({ vlm }), safety: new FakeSafety({ category: 'pills_medical', confidence: 0.9 }) })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'error', 'done'])
    const err = evs.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err.code).toBe('safety_refusal')
    // The suppressed identity must NOT appear anywhere in the stream (no make/model/spec leak).
    const blob = JSON.stringify(evs)
    expect(blob).not.toContain('Lipitor')
    expect(blob).not.toContain('Atorvastatin')
    expect(evs.some((e) => e.type === 'confidence_band')).toBe(false)
  })

  test('nsfw → block → error(safety_refusal) + done, identify_object NEVER runs', async () => {
    const evs = await drain({ vision: new FakeVision({ vlm: { name: 'x', source: 'vlm', confidence: 0.9 } }), safety: new FakeSafety({ category: 'nsfw', confidence: 0.9 }) })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'error', 'done'])
    expect(evs.some((e) => e.type === 'tool_start' && e.tool === 'identify_object')).toBe(false)
  })

  test('weapon → category name only: a band with NO candidates, and identify_object NEVER runs', async () => {
    const vlm: Candidate = { name: 'Glock 19 Gen4 9mm', make: 'Glock', model: '19 Gen4', source: 'vlm', confidence: 0.95 }
    const evs = await drain({ vision: new FakeVision({ vlm }), safety: new FakeSafety({ category: 'weapon', confidence: 0.9 }) })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'confidence_band', 'done'])
    expect(band(evs)!.candidates).toEqual([])
    const blob = JSON.stringify(evs)
    expect(blob).not.toContain('Glock')
    expect(blob).not.toContain('9mm')
  })
})

describe('cascade — a dead image URL is a hard_failure, NOT a safety refusal', () => {
  test('an injected preloader that throws → hard_failure BEFORE the safety gate ever runs', async () => {
    const evs = await drain({
      vision: new FakeVision({ vlm: { name: 'x', source: 'vlm', confidence: 0.9 } }),
      safety: SAFE,
      preload: async () => {
        throw new Error('fetch … → 404')
      },
    })
    // No tool events — we never got to classify. The user sees a retryable technical failure, not "unsafe".
    expect(types(evs)).toEqual(['error', 'done'])
    const err = evs.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err.code).toBe('hard_failure')
  })

  test('a successful preloader threads bytes to the stages and proceeds normally', async () => {
    const evs = await drain({
      vision: new FakeVision({ vlm: { name: 'Nikon F', make: 'Nikon', model: 'F', source: 'vlm', confidence: 0.9 } }),
      safety: SAFE,
      preload: async () => ({ b64: 'AAAA', mime: 'image/jpeg' }),
    })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'tool_start', 'tool_result', 'confidence_band', 'done'])
  })
})

describe('cascade — a safety CLASSIFIER fault is a technical hard_failure, NOT a content refusal', () => {
  test('the classifier throwing (Cloud Vision outage) → hard_failure, safety_gate tool_result ok:false, NO identification', () => {
    // fail-closed (identify never runs) but the user is told it is a retryable technical issue, not "unsafe".
    return drain({ vision: new FakeVision({ vlm: { name: 'Nikon F', make: 'Nikon', model: 'F', source: 'vlm', confidence: 0.9 } }), safety: new ThrowingSafety() }).then((evs) => {
      expect(types(evs)).toEqual(['tool_start', 'tool_result', 'error', 'done'])
      const sg = evs.find((e) => e.type === 'tool_result') as Extract<StreamEvent, { type: 'tool_result' }>
      expect(sg.ok).toBe(false)
      const err = evs.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
      expect(err.code).toBe('hard_failure') // NOT 'safety_refusal'
      expect(err.message).not.toContain('willing to look at') // never the content-refusal copy
      expect(evs.some((e) => e.type === 'tool_start' && e.tool === 'identify_object')).toBe(false)
    })
  })
})

describe('cascade — a hard identification failure is a typed hard_failure (BFF refunds the scan)', () => {
  test('vision provider throws → tool_result ok:false, error(hard_failure), done', async () => {
    const evs = await drain({ vision: new ThrowingVision(), safety: SAFE })
    expect(types(evs)).toEqual(['tool_start', 'tool_result', 'tool_start', 'tool_result', 'error', 'done'])
    const idResult = evs.filter((e) => e.type === 'tool_result')[1] as Extract<StreamEvent, { type: 'tool_result' }>
    expect(idResult.ok).toBe(false)
    const err = evs.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>
    expect(err.code).toBe('hard_failure')
  })
})
