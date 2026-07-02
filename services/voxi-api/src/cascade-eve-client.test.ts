/**
 * Regression guard for the BFF's assembled identification stream (cascade-eve-client.ts). The deep-research layer
 * (dossier → `fact` chips + `description_upgrade`) is real and unit-tested at the cascade level (cascade.test.ts),
 * but it only reaches users if `CascadeEveClient` actually PASSES a `dossier` provider into the cascade. It once did
 * not — so the reveal read generic ("what a watch is") even though the research code worked. This test drives the
 * REAL client `stream()` with injected fakes (creds-free) and asserts the assembled NDJSON carries the progressive
 * `fact` events AND the grounded `description_upgrade`. Remove the `dossier:` wire and this goes red.
 */
import { test, expect, describe } from 'bun:test'
import { CascadeEveClient } from './cascade-eve-client'
import type { VisionProvider, VisionStages, ImageRef } from '../../eve-agent/agent/tools/identify_object'
import type { SafetyClassifier, SafetyClassification } from '../../eve-agent/agent/tools/safety_gate'
import type { NarrationInput } from '../../eve-agent/agent/providers/live-narrator'
import type { DossierProvider, ResearchEvent } from '../../eve-agent/agent/providers/live-dossier'
import type { DossierInput } from '../../eve-agent/agent/subagents/researcher'
import type { ResearchDossier, DossierFact } from '../../../packages/shared/src/dossier'
import type { Candidate } from '../../../packages/shared/src/arbitration'
import { parseEventLine, type StreamEvent } from '../../../packages/shared/src/events'

class FakeVision implements VisionProvider {
  constructor(private stages: VisionStages) {}
  async analyze(_i: ImageRef): Promise<VisionStages> {
    return this.stages
  }
}
class FakeSafety implements SafetyClassifier {
  async classify(_i: ImageRef): Promise<SafetyClassification> {
    return { category: 'safe', confidence: 1 }
  }
}
class FakeNarrator {
  async narrate(_i: NarrationInput) {
    return { clauses: ['A first-pass line.'], dropped: 0 }
  }
}
/** Streams a verified fact, then the terminal dossier — exactly what the live dossier provider yields. */
class FakeDossier implements DossierProvider {
  called = false
  constructor(private facts: DossierFact[], private dossier: ResearchDossier | null) {}
  async *research(input: DossierInput): AsyncGenerator<ResearchEvent> {
    this.called = true
    void input
    for (const fact of this.facts) yield { type: 'fact', fact }
    yield { type: 'done', dossier: this.dossier }
  }
}

// A high-cosine catalog match agreeing with the VLM → CONFIDENT (so the reveal + research path both run).
const CATALOG: Candidate = { name: 'Rolex Submariner', make: 'Rolex', model: 'Submariner', source: 'catalog', confidence: 0.95, cosine: 0.96 }
const VLM: Candidate = { name: 'Rolex dive watch', make: 'Rolex', model: 'Submariner', source: 'vlm', confidence: 0.85, displayTitle: 'Rolex Submariner' }
const FACT: DossierFact = {
  text: 'The Submariner was Rolex’s first divers’ wristwatch, launched in 1953.',
  claimType: 'date', evidenceRef: 'fact1', sourceUrl: 'https://www.rolex.com/en-us/watches/submariner', sourceTitle: 'Submariner',
  quote: 'the Oyster Perpetual Submariner was Rolex’s first divers’ wristwatch',
}
const DOSSIER: ResearchDossier = {
  subject: 'Rolex Submariner', scope: 'item', overview: [], facts: [FACT],
  evidence: [{ ref: 'fact1', sourceUrl: FACT.sourceUrl, claim: FACT.quote }],
  sources: [{ url: FACT.sourceUrl, title: 'Submariner' }], provenance: { model: 't', generatedAt: 0, toolCalls: 0 },
}
// A data: URI so the injected preloader (loadImageBytes) resolves WITHOUT any network fetch.
const PHOTO = 'data:image/jpeg;base64,AAAA'

async function drain(client: CascadeEveClient, userId: string): Promise<StreamEvent[]> {
  const { sessionId } = await client.createSession({ userId, photoUrl: PHOTO })
  const out: StreamEvent[] = []
  for await (const line of client.stream(sessionId, userId)) out.push(parseEventLine(line))
  return out
}

describe('CascadeEveClient — the assembled BFF stream wires deep research', () => {
  test('a CONFIDENT reveal streams the progressive `fact` chips AND the grounded `description_upgrade`', async () => {
    const dossier = new FakeDossier([FACT], DOSSIER)
    const client = new CascadeEveClient(undefined, {
      vision: new FakeVision({ catalog: CATALOG, vlm: VLM }),
      safety: new FakeSafety(),
      narrator: new FakeNarrator(),
      dossier,
    })
    const evs = await drain(client, 'A')

    expect(dossier.called).toBe(true) // the client actually invoked the deep-research provider…
    const fact = evs.find((e) => e.type === 'fact') as Extract<StreamEvent, { type: 'fact' }> | undefined
    expect(fact).toBeDefined() // …and its verified fact reached the wire, with provenance attached
    expect(fact!.sourceUrl).toBe(FACT.sourceUrl)
    expect(fact!.quote.length).toBeGreaterThan(0)
    // the whole point: the thin first-pass description is REPLACED by a grounded upgrade
    expect(evs.some((e) => e.type === 'description_upgrade')).toBe(true)
    // ordering: reveal band < fact < description_upgrade < done
    const idx = (t: StreamEvent['type']) => evs.findIndex((e) => e.type === t)
    expect(idx('confidence_band')).toBeLessThan(idx('fact'))
    expect(idx('fact')).toBeLessThan(idx('description_upgrade'))
    expect(idx('description_upgrade')).toBeLessThan(idx('done'))
  })

  test('the default client (no overrides) constructs a real dossier provider — the wire is present in production', () => {
    const client = new CascadeEveClient()
    // The field must exist; without it the deep-research block in the cascade is dead. (private access via bracket.)
    expect((client as unknown as { dossier: unknown }).dossier).toBeDefined()
  })
})
