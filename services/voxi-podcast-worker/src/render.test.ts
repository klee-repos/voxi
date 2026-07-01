/**
 * Executable tests for the podcast render pipeline (PLAN §6.2 / §14.5 / RT-1, RT-9, eng-F8). `bun test`.
 *
 * Fake providers (no creds) assert the no-cheating invariants:
 *  - an UNGROUNDED spec clause → episode rejected, NO audio produced (honesty gate, fail-closed, RT-1);
 *  - a defamatory clause without ≥2 independent sources → rejected, NO audio (defamation gate, RT-9);
 *  - a clean, grounded script → renders exactly ONCE;
 *  - a DUPLICATE job for the same (catalogItemId, version) → does NOT render twice (idempotency, eng-F8);
 *  - concurrent duplicate deliveries → exactly one render wins the compare-and-set lease.
 *
 * The TTS/Muxer providers count their invocations, so "no audio produced" and "rendered once" are asserted on
 * REAL observable calls — not by reaching into internals.
 */
import { test, expect, describe } from 'bun:test'
import {
  renderPodcast,
  validateScript,
  memoryAssetStore,
  type RenderDeps,
  type Script,
  type ScriptClause,
  type Fact,
  type PodcastJob,
  type ResearchProvider,
  type ScriptProvider,
  type TtsProvider,
  type Muxer,
  type PushSink,
} from './render'

// ---- fakes that COUNT real invocations ----

interface Counters {
  research: number
  script: number
  tts: number
  mux: number
  push: number
}

function fakeDeps(
  scriptToReturn: Script,
  over: Partial<RenderDeps> = {},
): { deps: RenderDeps; calls: Counters; store: ReturnType<typeof memoryAssetStore> } {
  const calls: Counters = { research: 0, script: 0, tts: 0, mux: 0, push: 0 }
  const store = memoryAssetStore()

  const research: ResearchProvider = {
    async research() {
      calls.research++
      return scriptToReturn.facts
    },
  }
  const script: ScriptProvider = {
    async writeScript() {
      calls.script++
      return scriptToReturn
    },
  }
  const tts: TtsProvider = {
    async synthesize() {
      calls.tts++
      return { audio: new TextEncoder().encode('AUDIO-BYTES'), durationSec: 300 }
    },
  }
  const muxer: Muxer = {
    async assemble({ catalogItemId, version }) {
      calls.mux++
      return {
        playlistKey: `g/${catalogItemId}/v${version}/playlist.m3u8`,
        segmentKeys: [`g/${catalogItemId}/v${version}/0.ts`, `g/${catalogItemId}/v${version}/1.ts`],
      }
    },
  }
  const push: PushSink = {
    async notifyReady() {
      calls.push++
    },
  }

  const deps: RenderDeps = { research, script, tts, muxer, store, push, ...over }
  return { deps, calls, store }
}

const job: PodcastJob = { catalogItemId: 'c-supersix', version: 1, subject: '2008 Cannondale SuperSix EVO' }

// A grounded, validatable script: every falsifiable clause cites a closed fact; flavor asserts nothing.
const groundedFacts: Fact[] = [
  { claim: 'The 2008 Cannondale SuperSix EVO frame is carbon.', sourceUrl: 'https://cannondale.com/2008', confidence: 0.95 },
  { claim: 'It was introduced in 2008.', sourceUrl: 'https://bikepedia.example/supersix', confidence: 0.9 },
]
const cleanScript: Script = {
  facts: groundedFacts,
  clauses: [
    { speaker: 'arlo', text: 'A 2008 Cannondale SuperSix EVO.', claimType: 'date', evidenceRef: 'https://bikepedia.example/supersix' },
    { speaker: 'mave', text: 'Carbon, and obsessively light.', claimType: 'spec', evidenceRef: 'https://cannondale.com/2008' },
    { speaker: 'arlo', text: 'It goes up hills faster than is strictly dignified.', claimType: 'flavor' },
  ],
}

describe('render: honesty gate (fail-closed, no audio on ungrounded claim)', () => {
  test('an ungrounded spec clause is REJECTED and NO audio is produced', async () => {
    const ungrounded: Script = {
      facts: groundedFacts,
      clauses: [
        { speaker: 'arlo', text: 'A 2008 Cannondale SuperSix EVO.', claimType: 'date', evidenceRef: 'https://bikepedia.example/supersix' },
        // spec clause with NO evidence ref — the gate must hard-reject this.
        { speaker: 'mave', text: 'It weighs exactly 6.8kg, the UCI legal minimum.', claimType: 'spec' } as ScriptClause,
      ],
    }
    const { deps, calls, store } = fakeDeps(ungrounded)
    const out = await renderPodcast(job, deps)

    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') {
      expect(out.reason).toBe('ungrounded_claim')
      expect(out.audioProduced).toBe(false)
      expect(out.details.join(' ')).toMatch(/no evidence ref/)
    }
    // The load-bearing assertion: synthesis NEVER ran. No unvalidated audio reached the cache.
    expect(calls.tts).toBe(0)
    expect(calls.mux).toBe(0)
    expect(calls.push).toBe(0)
    expect(store.renderCount()).toBe(0)
    expect(await store.getStatus(job.catalogItemId, job.version)).toBe('failed')
  })

  test('a cited-but-unentailed (laundered) clause is rejected by the judge — still no audio', async () => {
    const laundered: Script = {
      facts: groundedFacts,
      clauses: [
        // cites the carbon fact but asserts a weight it does not support.
        { speaker: 'mave', text: 'It weighs exactly 6.8kg.', claimType: 'spec', evidenceRef: 'https://cannondale.com/2008' },
      ],
    }
    const judge = (_c: { text: string }, e: { claim: string }) => e.claim.toLowerCase().includes('weigh')
    const { deps, calls } = fakeDeps(laundered, { judge: judge as RenderDeps['judge'] })
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    expect(calls.tts).toBe(0)
  })

  test('a falsifiable claim mislabeled `flavor` is caught by the auditor — no audio', async () => {
    const mislabeled: Script = {
      facts: groundedFacts,
      clauses: [
        { speaker: 'arlo', text: 'It was a favourite of the collector Henry Vane in 1991.', claimType: 'flavor' },
      ],
    }
    const detectNamedClaim = (t: string) => /\b\d{4}\b/.test(t) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t)
    const { deps, calls } = fakeDeps(mislabeled, { detectNamedClaim })
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') expect(out.details.join(' ')).toMatch(/auditor/)
    expect(calls.tts).toBe(0)
  })
})

describe('render: defamation gate (RT-9)', () => {
  test('a negative claim about an identifiable entity with <2 independent sources is rejected — no audio', async () => {
    const defamatory: Script = {
      // single source for the negative claim → fails the ≥2-independent-source bar.
      facts: [{ claim: 'The Cannondale model was recalled.', sourceUrl: 'https://oneblog.example/recall', confidence: 0.7 }],
      clauses: [
        { speaker: 'mave', text: 'The Cannondale was recalled because it was defective and dangerous.', claimType: 'causal', evidenceRef: 'https://oneblog.example/recall' },
      ],
    }
    const { deps, calls } = fakeDeps(defamatory)
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') {
      expect(out.reason).toBe('defamation')
      expect(out.audioProduced).toBe(false)
    }
    expect(calls.tts).toBe(0)
    expect(calls.mux).toBe(0)
  })

  test('validateScript directly: a clean grounded script passes both gates', () => {
    const r = validateScript(cleanScript, {})
    expect(r).toEqual({ ok: true })
  })
})

describe('render: clean script renders exactly once', () => {
  test('a clean, grounded script produces audio + an HLS asset, fires push once', async () => {
    const { deps, calls, store } = fakeDeps(cleanScript)
    const out = await renderPodcast(job, deps)

    expect(out.kind).toBe('rendered')
    if (out.kind === 'rendered') {
      expect(out.asset.catalogItemId).toBe('c-supersix')
      expect(out.asset.version).toBe(1)
      expect(out.asset.playlistKey).toContain('playlist.m3u8')
      expect(out.asset.segmentKeys.length).toBeGreaterThan(0)
    }
    expect(calls.research).toBe(1)
    expect(calls.script).toBe(1)
    expect(calls.tts).toBe(1) // exactly one multi-speaker call (D5)
    expect(calls.mux).toBe(1)
    expect(calls.push).toBe(1) // deduped on the rendering→ready transition
    expect(await store.getStatus('c-supersix', 1)).toBe('ready')
    expect(store.renderCount()).toBe(1)
  })
})

describe('render: idempotency per (catalogItemId, version) — never render twice (eng-F8)', () => {
  test('a duplicate job for the same (item, version) does NOT render again; same asset, one TTS call', async () => {
    const { deps, calls, store } = fakeDeps(cleanScript)

    const first = await renderPodcast(job, deps)
    expect(first.kind).toBe('rendered')

    // Duplicate Cloud Task delivery for the SAME (item, version).
    const second = await renderPodcast(job, deps)
    expect(second.kind).toBe('replayed')
    if (first.kind === 'rendered' && second.kind === 'replayed') {
      expect(second.asset.playlistKey).toBe(first.asset.playlistKey)
    }

    // The whole point: synthesis + mux ran ONCE across both deliveries.
    expect(calls.tts).toBe(1)
    expect(calls.mux).toBe(1)
    expect(calls.push).toBe(1) // push deduped on the single status transition
    expect(store.renderCount()).toBe(1)
  })

  test('a different version DOES render (the key is (item, version), not item alone)', async () => {
    const { deps, calls } = fakeDeps(cleanScript)
    await renderPodcast({ ...job, version: 1 }, deps)
    await renderPodcast({ ...job, version: 2 }, deps)
    expect(calls.tts).toBe(2)
  })

  test('concurrent duplicate deliveries: exactly one render wins the compare-and-set lease', async () => {
    // Shared store + counters across both concurrent calls.
    const calls = { tts: 0, mux: 0 }
    const store = memoryAssetStore()
    const tts: TtsProvider = {
      async synthesize() {
        calls.tts++
        return { audio: new Uint8Array([1, 2, 3]), durationSec: 300 }
      },
    }
    const muxer: Muxer = {
      async assemble({ catalogItemId, version }) {
        calls.mux++
        return { playlistKey: `g/${catalogItemId}/v${version}/playlist.m3u8`, segmentKeys: ['s0'] }
      },
    }
    const research: ResearchProvider = { async research() { return cleanScript.facts } }
    const scriptProv: ScriptProvider = { async writeScript() { return cleanScript } }
    const deps: RenderDeps = { research, script: scriptProv, tts, muxer, store }

    const [a, b] = await Promise.all([renderPodcast(job, deps), renderPodcast(job, deps)])

    // Exactly one synthesis happened regardless of the race.
    expect(calls.tts).toBe(1)
    expect(calls.mux).toBe(1)
    // One winner rendered; the loser is either replayed (ready) or saw the lease in-progress.
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toContain('rendered')
    expect(kinds.some((k) => k === 'replayed' || k === 'in_progress')).toBe(true)
    expect(store.renderCount()).toBe(1)
  })
})

describe('render: fail-closed on provider exception', () => {
  test('a TTS exception ships no asset and releases the lease as failed', async () => {
    const throwingTts: TtsProvider = {
      async synthesize() {
        throw new Error('tts vendor 503')
      },
    }
    const { deps, calls, store } = fakeDeps(cleanScript, { tts: throwingTts })
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('failed')
    expect(calls.mux).toBe(0)
    expect(calls.push).toBe(0)
    expect(store.renderCount()).toBe(0)
    expect(await store.getStatus(job.catalogItemId, job.version)).toBe('failed')
  })
})
