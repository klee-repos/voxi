/**
 * Production RenderDeps assembly for the podcast worker — a TESTABLE factory (so the wiring is asserted without
 * booting the Bun server in server.ts).
 *
 * The load-bearing line is `detectNamedClaim`: the honesty gate's flavor auditor (confidence.ts) is a NO-OP when
 * `detectNamedClaim` is undefined, so a `flavor`-mislabeled clause smuggling a year / named provenance / a
 * causal-comparative would otherwise ship to paid TTS and the durable cached asset UNBLOCKED. The reveal-narration
 * path already wires this exact auditor (`live-narrator.ts` → `smugglesFalsifiable`); the podcast worker was the one
 * production path that never did. Deep Dive's narrative-interview script raises the base rate of evocative
 * provenance prose, so the auditor is a hard requirement here — fail-closed, mirroring the shipped reveal control.
 */
import { smugglesFalsifiable } from '../../eve-agent/agent/providers/live-narrator'
import { GeminiResearchProvider, GeminiScriptProvider, FfmpegMuxer } from './providers'
import { ElevenLabsTts } from './live-tts'
import type { RenderDeps, PodcastAssetStore } from './render'

export function buildProductionDeps(opts: { outDir: string; store: PodcastAssetStore }): RenderDeps {
  return {
    research: new GeminiResearchProvider(),
    script: new GeminiScriptProvider(),
    tts: new ElevenLabsTts(),
    muxer: new FfmpegMuxer(opts.outDir),
    store: opts.store,
    // The flavor auditor — without this, prod ships mislabeled-flavor falsifiable claims (see file header).
    detectNamedClaim: smugglesFalsifiable,
  }
}
