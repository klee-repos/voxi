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
  estimateWords,
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
import { buildProductionDeps } from './production-deps'

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
      // A realistic Deep Dive duration (~3 min) — asserted in-band [60,300]s by the clean-render test.
      return { audio: new TextEncoder().encode('AUDIO-BYTES'), durationSec: 190 }
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
// A realistic Deep Dive interview (~20 clauses, >120 words so it clears the length proxy). Falsifiable clauses
// cite a closed fact; flavor clauses carry NO smuggling (no year, proper-noun run, spec, superlative, or
// causal/comparative) so it passes with OR without the flavor auditor wired.
const cleanScript: Script = {
  facts: groundedFacts,
  clauses: [
    { speaker: 'arlo', text: 'Picture a bike so light you second-guess whether it is really there.', claimType: 'flavor' },
    { speaker: 'mave', text: 'That reaction is the whole point of this one.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'So what exactly are we looking at here?', claimType: 'flavor' },
    { speaker: 'mave', text: 'A Cannondale road bike, introduced in 2008.', claimType: 'date', evidenceRef: 'https://bikepedia.example/supersix' },
    { speaker: 'arlo', text: 'And the frame, that is the clever part?', claimType: 'flavor' },
    { speaker: 'mave', text: 'The frame is carbon, and that is where the lightness lives.', claimType: 'spec', evidenceRef: 'https://cannondale.com/2008' },
    { speaker: 'arlo', text: 'You can feel it the moment you lift it off the rack.', claimType: 'flavor' },
    { speaker: 'mave', text: 'It almost dares you to expect too much of it.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'Does that lightness cost you anything in the ride?', claimType: 'flavor' },
    { speaker: 'mave', text: 'Not in the way you would assume, and that is the surprise.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'Go on, what did the engineers actually pull off?', claimType: 'flavor' },
    { speaker: 'mave', text: 'They kept it stiff where it counts and forgiving everywhere else.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'So it is not just about shaving grams.', claimType: 'flavor' },
    { speaker: 'mave', text: 'It never was; the weight is just the headline.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'What stays with you after a long day on it?', claimType: 'flavor' },
    { speaker: 'mave', text: 'How little the bike asks of you on the way up a climb.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'That is a strange thing to say about a machine.', claimType: 'flavor' },
    { speaker: 'mave', text: 'And yet it is the honest thing to say about this one.', claimType: 'flavor' },
    { speaker: 'arlo', text: 'A carbon frame that still holds up years on.', claimType: 'flavor' },
    { speaker: 'mave', text: 'Quietly, and without making a fuss about it.', claimType: 'flavor' },
  ],
}

describe('render: honesty gate is DROP-and-KEEP — a bad clause is CUT (never voiced), the validated rest renders', () => {
  // A full valid interview + ONE injected violation. The violation must be dropped from the SHIPPED transcript;
  // the episode must still render (a single conversational aside can't sink a Serial-length episode).
  const withInjected = (bad: ScriptClause): Script => ({ facts: groundedFacts, clauses: [...cleanScript.clauses, bad] })
  const shipped = (out: Awaited<ReturnType<typeof renderPodcast>>): string =>
    out.kind === 'rendered' ? (out.asset.transcript ?? []).map((l) => l.text).join(' ') : ''

  test('an ungrounded falsifiable clause is DROPPED (never voiced); the validated clauses still render', async () => {
    const bad = { speaker: 'mave', text: 'It weighs exactly 6.8kg, the UCI legal minimum.', claimType: 'spec' } as ScriptClause // no evidenceRef
    const { deps, calls, store } = fakeDeps(withInjected(bad))
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rendered')
    expect(calls.tts).toBe(1)
    // The load-bearing assertion: the ungrounded clause NEVER reached audio, but the validated clauses DID.
    expect(shipped(out)).not.toContain('6.8kg')
    expect(shipped(out)).toContain('carbon')
    expect(await store.getStatus(job.catalogItemId, job.version)).toBe('ready')
  })

  test('a cited-but-unentailed (laundered) clause is DROPPED by the judge — not voiced; the rest renders', async () => {
    const bad = { speaker: 'mave', text: 'It weighs exactly 6.8kg.', claimType: 'spec', evidenceRef: 'https://cannondale.com/2008' } as ScriptClause
    const judge = (_c: { text: string }, e: { claim: string }) => e.claim.toLowerCase().includes('weigh')
    const { deps, calls } = fakeDeps(withInjected(bad), { judge: judge as RenderDeps['judge'] })
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rendered')
    expect(calls.tts).toBe(1)
    expect(shipped(out)).not.toContain('6.8kg')
  })

  test('a flavor clause the auditor flags is DROPPED; the rest renders (the interview-prose failure mode, fixed)', async () => {
    const bad = { speaker: 'arlo', text: 'It was a favourite of the collector Henry Vane in 1991.', claimType: 'flavor' } as ScriptClause
    const detectNamedClaim = (t: string) => /\b\d{4}\b/.test(t) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t)
    const { deps, calls } = fakeDeps(withInjected(bad), { detectNamedClaim })
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rendered')
    expect(calls.tts).toBe(1)
    expect(shipped(out)).not.toContain('Henry Vane')
  })

  test('if the gate cuts so much that too little remains, the episode FAILS (no stub shipped)', async () => {
    // Almost all clauses are ungrounded specs → dropped below the word floor → degenerate_length, no audio.
    const mostlyBad: Script = {
      facts: groundedFacts,
      clauses: [
        { speaker: 'arlo', text: 'A Cannondale.', claimType: 'date', evidenceRef: 'https://bikepedia.example/supersix' },
        ...Array.from({ length: 6 }, () => ({ speaker: 'mave' as const, text: 'It weighs exactly 6.8kg at the legal minimum.', claimType: 'spec' as const })), // no refs → all dropped
      ],
    }
    const { deps, calls, store } = fakeDeps(mostlyBad)
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') expect(out.reason).toBe('degenerate_length')
    expect(calls.tts).toBe(0)
    expect(store.renderCount()).toBe(0)
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

  test('validateScript directly: a clean grounded script passes and returns all its clauses', () => {
    const r = validateScript(cleanScript, {})
    expect('ok' in r && r.ok).toBe(true)
    if ('ok' in r) expect(r.script.clauses.length).toBe(cleanScript.clauses.length)
  })
})

describe('render: Deep Dive duration proxy (§F3 / D2) — pre-synthesis SCRIPT-WORD band, fail-closed before paid TTS', () => {
  test('a degenerate (too-short) script is REJECTED for length before any TTS', async () => {
    const shortScript: Script = {
      facts: groundedFacts,
      clauses: [
        { speaker: 'arlo', text: 'A Cannondale, carbon and light.', claimType: 'spec', evidenceRef: 'https://cannondale.com/2008' },
        { speaker: 'mave', text: 'Introduced in 2008.', claimType: 'date', evidenceRef: 'https://bikepedia.example/supersix' },
      ],
    }
    expect(estimateWords(shortScript)).toBeLessThan(120)
    const { deps, calls, store } = fakeDeps(shortScript)
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') expect(out.reason).toBe('degenerate_length')
    // The load-bearing assertion: no paid synthesis for a degenerate script.
    expect(calls.tts).toBe(0)
    expect(calls.mux).toBe(0)
    expect(store.renderCount()).toBe(0)
  })

  test('a runaway (too-long) script is REJECTED for length before any TTS', async () => {
    const runaway: Script = {
      facts: groundedFacts,
      // ~1600 words of clean flavor (no smuggling) — well past the ceiling.
      clauses: Array.from({ length: 200 }, () => ({ speaker: 'arlo' as const, text: 'It is a genuinely fine and capable machine.', claimType: 'flavor' as const })),
    }
    expect(estimateWords(runaway)).toBeGreaterThan(900)
    const { deps, calls } = fakeDeps(runaway)
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rejected_validation')
    if (out.kind === 'rejected_validation') expect(out.reason).toBe('degenerate_length')
    expect(calls.tts).toBe(0)
  })

  test('a realistic-length clean interview passes the length proxy (renders)', async () => {
    expect(estimateWords(cleanScript)).toBeGreaterThanOrEqual(120)
    const r = validateScript(cleanScript, {})
    expect('ok' in r && r.ok).toBe(true)
  })
})

describe('render: production deps wire the flavor auditor (§D1) — the honesty hole is closed IN PROD, not just in tests', () => {
  test('buildProductionDeps wires detectNamedClaim, which DROPS a mislabeled-flavor smuggle from the kept script (rest still renders)', () => {
    const store = memoryAssetStore()
    const deps = buildProductionDeps({ outDir: '/tmp/voxi-podcast-test', store })
    // The wiring itself — the thing prod was missing.
    expect(deps.detectNamedClaim).toBeDefined()
    // Drive the REAL prod-wired auditor through the pure validateScript (no vendors): a narrative flavor line
    // smuggling a year + a named provenance is CUT from the kept script (never voiced), while the valid rest stays.
    const smuggle = { speaker: 'mave', text: 'It was a favourite of the collector Henry Vane in 1991.', claimType: 'flavor' } as ScriptClause
    const script: Script = { facts: groundedFacts, clauses: [...cleanScript.clauses, smuggle] }
    const r = validateScript(script, deps)
    expect('ok' in r && r.ok).toBe(true)
    if ('ok' in r) {
      const kept = r.script.clauses.map((c) => c.text)
      expect(kept).not.toContain(smuggle.text) // the smuggle was dropped — never reaches audio
      expect(kept.length).toBe(cleanScript.clauses.length) // exactly the smuggle dropped, the rest kept
    }
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
      // Duration (post-TTS) must land in the 1–5 min Deep Dive band (§F3 / D2).
      expect(out.asset.durationSec).toBeGreaterThanOrEqual(60)
      expect(out.asset.durationSec).toBeLessThanOrEqual(300)
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
