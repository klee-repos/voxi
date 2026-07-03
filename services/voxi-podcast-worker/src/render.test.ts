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
  contextFacts,
  mergeFacts,
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
import type { PodcastContext } from '../../../packages/shared/src/podcast'
import { smugglesFalsifiable } from '../../eve-agent/agent/providers/live-narrator'

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

describe('render: a FAILED item can be RETRIED — "try again" re-renders, not a dead-end', () => {
  test('a prior failed (item,version) re-renders on a fresh call (failed→rendering lease)', async () => {
    const { deps, store, calls } = fakeDeps(cleanScript)
    // simulate a prior attempt that FAILED for this item
    await store.compareAndSetStatus(job.catalogItemId, job.version, 'queued', 'failed')
    expect(await store.getStatus(job.catalogItemId, job.version)).toBe('failed')
    // the retry must actually re-run the pipeline — NOT bail as in_progress (the reported "try again fails instantly")
    const out = await renderPodcast(job, deps)
    expect(out.kind).toBe('rendered')
    expect(calls.tts).toBe(1)
    expect(await store.getStatus(job.catalogItemId, job.version)).toBe('ready')
  })
})

// ---- DEEPDIVE context completeness: the interview is built from what the reveal ALREADY learned ----
// The worker must fold the reveal's grounded facts + identity + sourced sections into the closed facts[] the
// interview cites, merged with the additive deep-dive research — not re-research the subject alone.

const REVEAL_CTX: PodcastContext = {
  subject: '1976 Canon AE-1',
  band: 'CONFIDENT',
  whatItIs: 'A 35mm SLR film camera you focus and wind by hand.',
  purpose: 'Making photographs on 35mm film.', // NO purposeSourceUrl → orientation only, never a citeable fact
  maker: 'Canon, in Japan.',
  makerSourceUrl: 'https://en.wikipedia.org/wiki/Canon_Inc',
  whenMade: 'Produced from 1976 to 1984.',
  whenMadeSourceUrl: 'https://camerapedia.example/canon-ae1-production',
  priorFacts: [
    { text: 'The Canon AE-1 was launched in 1976.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', quote: 'launched in 1976' },
    { text: 'It uses the Canon FD breech-lock lens mount.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_FD' },
  ],
}
const RESEARCH: Fact[] = [{ claim: 'Over one million units were sold.', sourceUrl: 'https://sales.example/ae1', confidence: 0.9 }]

// A capturing ScriptProvider: records the closed facts[] it is handed and returns a script whose facts ARE that
// set (mirroring GeminiScriptProvider), so any clause we author is validated against the real merged evidence.
function capturingDeps(clauses: ScriptClause[], research: Fact[] | (() => Promise<Fact[]>), over: Partial<RenderDeps> = {}) {
  const seen: { facts: Fact[] } = { facts: [] }
  const researchFn = typeof research === 'function' ? research : async () => research
  const deps: RenderDeps = {
    research: { async research() { return researchFn() } },
    script: { async writeScript(_job, facts) { seen.facts = facts; return { facts, clauses } } },
    tts: { async synthesize() { return { audio: new TextEncoder().encode('AUDIO'), durationSec: 190 } } },
    muxer: { async assemble({ catalogItemId, version }) { return { playlistKey: `p/${catalogItemId}/v${version}/e.mp3`, segmentKeys: [`p/${catalogItemId}/v${version}/e.mp3`] } } },
    store: memoryAssetStore(),
    ...over,
  }
  return { deps, seen }
}

// A real-shaped Deep Dive: the opener NAMES the object as a grounded provenance clause citing the identity fact
// (voxi:cascade); other falsifiable clauses cite reveal priorFacts / the research fact; the rest is clean flavor.
// Long enough that dropping the one research-cited clause (the degraded path) still clears the 120-word floor.
const CTX_CLAUSES: ScriptClause[] = [
  { speaker: 'arlo', text: 'This is a 1976 Canon AE-1, and you have probably walked past a hundred of them.', claimType: 'provenance', evidenceRef: 'voxi:cascade' },
  { speaker: 'mave', text: 'It arrived in the middle of that decade and quietly rewired the whole camera business.', claimType: 'date', evidenceRef: 'https://en.wikipedia.org/wiki/Canon_AE-1' },
  { speaker: 'arlo', text: 'So what makes this particular slab of metal worth a second look?', claimType: 'flavor' },
  { speaker: 'mave', text: 'The lens twists on through a mount that outlived a dozen fashions.', claimType: 'spec', evidenceRef: 'https://en.wikipedia.org/wiki/Canon_FD' },
  { speaker: 'arlo', text: 'And people actually bought these in enormous numbers?', claimType: 'flavor' },
  { speaker: 'mave', text: 'More than a million of them left the factory before it was done.', claimType: 'superlative', evidenceRef: 'https://sales.example/ae1' },
  { speaker: 'arlo', text: 'I always assumed it was just another old camera on a shelf.', claimType: 'flavor' },
  { speaker: 'mave', text: 'Almost everyone does, and that is exactly the surprise here.', claimType: 'flavor' },
  { speaker: 'arlo', text: 'What stays with you after you have held one for a while?', claimType: 'flavor' },
  { speaker: 'mave', text: 'How much of the person who owned it is still pressed into the grip.', claimType: 'flavor' },
  { speaker: 'arlo', text: 'That is a strange thing to say about a machine.', claimType: 'flavor' },
  { speaker: 'mave', text: 'And yet it is the honest thing to say about this one.', claimType: 'flavor' },
  { speaker: 'arlo', text: 'It really does invite you to slow down and look again.', claimType: 'flavor' },
  { speaker: 'mave', text: 'Which is the whole reason we are still talking about it.', claimType: 'flavor' },
]

describe('render: reveal context feeds the closed facts[] the interview cites (context completeness)', () => {
  test('priorFacts + the sourced maker section + the CONFIDENT identity are merged with the research into the closed facts', async () => {
    const { deps, seen } = capturingDeps(CTX_CLAUSES, RESEARCH)
    const out = await renderPodcast({ catalogItemId: 'canon-ae1', version: 1, subject: '1976 Canon AE-1', context: REVEAL_CTX }, deps)
    expect(out.kind).toBe('rendered')
    const claims = seen.facts.map((f) => f.claim)
    expect(claims).toContain('The Canon AE-1 was launched in 1976.') // reveal priorFact
    expect(claims).toContain('It uses the Canon FD breech-lock lens mount.') // reveal priorFact
    expect(claims).toContain('Canon, in Japan.') // SOURCED maker section → citeable fact
    expect(claims).toContain('Over one million units were sold.') // additive research
    expect(seen.facts.some((f) => f.sourceUrl === 'voxi:cascade' && /1976 Canon AE-1/.test(f.claim))).toBe(true) // identity
    // the SOURCELESS purpose section is orientation-only and must NEVER become a citeable fact (laundering guard)
    expect(claims).not.toContain('Making photographs on 35mm film.')
  })

  test('the stage-setting opener AND a priorFact-grounded clause survive the honesty gate and ship', async () => {
    const { deps } = capturingDeps(CTX_CLAUSES, RESEARCH)
    const out = await renderPodcast({ catalogItemId: 'canon-ae1', version: 1, subject: '1976 Canon AE-1', context: REVEAL_CTX }, deps)
    const shipped = out.kind === 'rendered' ? (out.asset.transcript ?? []).map((l) => l.text).join(' ') : ''
    expect(shipped).toContain('This is a 1976 Canon AE-1') // the named, oriented opener (not cut)
    expect(shipped).toContain('mount that outlived') // a reveal-priorFact-grounded clause
  })
})

describe('render: P3 — naming a branded object survives ONLY when grounded (proper-noun auditor)', () => {
  const filler: ScriptClause[] = Array.from({ length: 14 }, (_, i) => ({
    speaker: (i % 2 ? 'mave' : 'arlo') as ScriptClause['speaker'],
    text: 'It sits there quietly and asks almost nothing of you at all.',
    claimType: 'flavor',
  }))
  const idFact: Fact = { claim: 'The object is a Sub Pop Mug.', sourceUrl: 'voxi:cascade', confidence: 1 }

  test('the proper-noun auditor flags a branded/multi-word name (why a flavor opener is unsafe)', () => {
    expect(smugglesFalsifiable('This is a Sub Pop Mug.')).toBe(true)
    expect(smugglesFalsifiable('Look at this Herman Miller chair.')).toBe(true)
  })

  test('same opener words: KEPT as a grounded provenance clause, CUT as flavor', () => {
    const asProvenance: Script = { facts: [idFact], clauses: [{ speaker: 'arlo', text: 'This is a Sub Pop Mug.', claimType: 'provenance', evidenceRef: 'voxi:cascade' }, ...filler] }
    const asFlavor: Script = { facts: [idFact], clauses: [{ speaker: 'arlo', text: 'This is a Sub Pop Mug.', claimType: 'flavor' }, ...filler] }
    const prov = validateScript(asProvenance, { detectNamedClaim: smugglesFalsifiable })
    const flav = validateScript(asFlavor, { detectNamedClaim: smugglesFalsifiable })
    expect('ok' in prov && prov.script.clauses.some((c) => c.text === 'This is a Sub Pop Mug.')).toBe(true)
    // the flavor opener is dropped — the episode would ship WITHOUT ever naming the object (the "starts in the middle" bug)
    expect('ok' in flav && flav.script.clauses.some((c) => c.text === 'This is a Sub Pop Mug.')).toBe(false)
  })
})

describe('render: resilience — research failure degrades to reveal facts (observable), never a silent success', () => {
  test('research throws but reveal priorFacts exist → renders with grounding "priorFacts"', async () => {
    const { deps } = capturingDeps(CTX_CLAUSES, async () => { throw new Error('grounded research failed (all attempts)') })
    const out = await renderPodcast({ catalogItemId: 'canon-ae1', version: 1, subject: '1976 Canon AE-1', context: REVEAL_CTX }, deps)
    expect(out.kind).toBe('rendered')
    if (out.kind === 'rendered') expect(out.grounding).toBe('priorFacts')
  })

  test('research succeeds → grounding "research"', async () => {
    const { deps } = capturingDeps(CTX_CLAUSES, RESEARCH)
    const out = await renderPodcast({ catalogItemId: 'canon-ae1', version: 1, subject: '1976 Canon AE-1', context: REVEAL_CTX }, deps)
    expect(out.kind === 'rendered' && out.grounding).toBe('research')
  })

  test('research throws AND no reveal context → fails closed (nothing to fall back on)', async () => {
    const { deps } = capturingDeps(CTX_CLAUSES, async () => { throw new Error('grounded research failed') })
    const out = await renderPodcast({ catalogItemId: 'x', version: 1, subject: 'x' }, deps)
    expect(out.kind).toBe('failed')
  })
})

describe('contextFacts / mergeFacts (pure)', () => {
  test('folds priorFacts + sourced sections + a CONFIDENT identity; drops sourceless sections', () => {
    const facts = contextFacts(REVEAL_CTX)
    const urls = facts.map((f) => f.sourceUrl)
    expect(urls).toContain('https://en.wikipedia.org/wiki/Canon_AE-1') // priorFact
    expect(urls).toContain('https://en.wikipedia.org/wiki/Canon_Inc') // sourced maker
    expect(facts.some((f) => f.claim === 'Produced from 1976 to 1984.' && f.sourceUrl === 'https://camerapedia.example/canon-ae1-production')).toBe(true) // sourced made date folded (parallel to maker)
    expect(facts.some((f) => f.sourceUrl === 'voxi:cascade')).toBe(true) // identity (CONFIDENT)
    expect(facts.some((f) => f.claim === 'Making photographs on 35mm film.')).toBe(false) // sourceless purpose dropped
    // a made date WITHOUT a source is orientation only — never a citeable fact (mirrors the sourceless-purpose rule)
    expect(contextFacts({ ...REVEAL_CTX, whenMadeSourceUrl: undefined }).some((f) => f.claim === 'Produced from 1976 to 1984.')).toBe(false)
  })
  test('no identity fact when the id is not CONFIDENT (the hedge is honored)', () => {
    expect(contextFacts({ ...REVEAL_CTX, band: 'PROBABLE' }).some((f) => f.sourceUrl === 'voxi:cascade')).toBe(false)
  })
  test('undefined context → no facts', () => {
    expect(contextFacts(undefined)).toEqual([])
  })
  test('mergeFacts dedupes on normalized claim text (reveal facts win) and preserves order', () => {
    const a: Fact[] = [{ claim: 'Same fact.', sourceUrl: 'u1', confidence: 1 }]
    const b: Fact[] = [{ claim: 'same   FACT.', sourceUrl: 'u2', confidence: 1 }, { claim: 'Other.', sourceUrl: 'u3', confidence: 1 }]
    expect(mergeFacts(a, b).map((f) => f.claim)).toEqual(['Same fact.', 'Other.'])
  })
})
