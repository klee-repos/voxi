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
import { gcloudToken } from '../../eve-agent/agent/lib/gcp-vision'
import { firecrawlFromEnv } from '../../eve-agent/agent/tools/web_research'
import { CompositeResearchProvider, GroundedResearchProvider, GeminiResearchProvider, GlmScriptProvider, FfmpegMuxer } from './providers'
import { ElevenLabsTts } from './live-tts'
import { createGcsClient, type GcsClient } from './gcs'
import { gcsAssetStore } from './gcs-asset-store'
import type { RenderDeps, PodcastAssetStore } from './render'

/**
 * Assemble the production RenderDeps. Durable-by-GCS by default (scale-to-zero): the render STATUS + finished asset
 * live in the private `stateBucket`, the MP3 in the public `audioBucket`. `store`/`gcs` are optional overrides so a
 * unit test can drive the wiring (e.g. the detectNamedClaim auditor) without touching GCS or gcloud.
 */
export function buildProductionDeps(opts: {
  outDir: string
  audioBucket?: string
  stateBucket?: string
  gcs?: GcsClient
  store?: PodcastAssetStore
}): RenderDeps {
  const gcs = opts.gcs ?? createGcsClient(gcloudToken)
  const audioBucket = opts.audioBucket ?? process.env.GCS_AUDIO_BUCKET ?? 'voxi-podcast-audio'
  const stateBucket = opts.stateBucket ?? process.env.GCS_STATE_BUCKET ?? 'voxi-podcast-state'
  return {
    research: new CompositeResearchProvider(new GroundedResearchProvider(firecrawlFromEnv() ?? null), new GeminiResearchProvider()),
    script: new GlmScriptProvider(),
    tts: new ElevenLabsTts(),
    muxer: new FfmpegMuxer(opts.outDir, gcs, audioBucket),
    store: opts.store ?? gcsAssetStore(gcs, { stateBucket }),
    // The flavor auditor — without this, prod ships mislabeled-flavor falsifiable claims (see file header).
    detectNamedClaim: smugglesFalsifiable,
  }
}
