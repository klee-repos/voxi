/**
 * The podcast render worker as a runnable process. A Bun HTTP service that receives a gated job from the BFF, runs
 * the REAL renderPodcast pipeline (search-grounded research → claim-structured OpenAI script → honesty + defamation
 * gates → live ElevenLabs two-voice TTS → ffmpeg loudnorm mux), uploads the MP3 to the PUBLIC audio bucket, and
 * keeps render status + the finished asset in the PRIVATE state bucket. Fully STATELESS (keyed on (item,version) in
 * GCS) so it scales to zero between renders — no in-memory job map, no local audio files served. No fakes.
 *
 *   POST /render   {catalogItemId, version, subject, context?}   (x-worker-secret)  → 202, renders async
 *   GET  /status?item=&version=                                  (x-worker-secret)  → {state, audioUrl?, transcript?}
 *
 * The rendered MP3 is served DIRECTLY by GCS at a stable public URL (Range-native) — the worker never serves audio,
 * so playback/scrubbing doesn't cold-start it. Run: `bun services/voxi-podcast-worker/src/server.ts` from repo root.
 */
import { renderPodcast, type PodcastJob } from './render'
import type { PodcastContext } from '../../../packages/shared/src/podcast'
import { buildProductionDeps } from './production-deps'
import { assertProdKeys } from '../../../packages/shared/src/prod-keys'
import { createGcsClient } from './gcs'
import { warmGcpToken, gcloudToken } from '../../eve-agent/agent/lib/gcp-vision'
import { mkdirSync } from 'node:fs'
import { initTelemetry, logger, withRequestTelemetry } from '../../../packages/telemetry/src/index'

initTelemetry({ service: 'voxi-podcast-worker', role: 'podcast' })

// Cloud Run injects PORT; honor it first so the container's listen port matches the platform contract.
const PORT = Number(process.env.PODCAST_WORKER_PORT ?? process.env.PORT ?? 8788)
const SECRET = process.env.PODCAST_WORKER_SECRET ?? 'dev-podcast-secret'
const AUDIO_BUCKET = process.env.GCS_AUDIO_BUCKET ?? 'voxi-podcast-audio' // PUBLIC — holds only episode.mp3
const STATE_BUCKET = process.env.GCS_STATE_BUCKET ?? 'voxi-podcast-state' // PRIVATE — status + asset.json
// Transient ffmpeg staging only (the MP3 is uploaded to GCS, then both local files are deleted). /tmp is writable
// by the non-root container user.
const OUT_DIR = process.env.PODCAST_OUT_DIR ?? '.voxi-data/podcasts'
mkdirSync(OUT_DIR, { recursive: true })

const ON_CLOUD_RUN = !!process.env.K_SERVICE
const gcs = createGcsClient(gcloudToken)

// GLM (research/script) needs no gcloud token, but the GCS writes do (createGcsClient uses the synchronous
// gcloudToken(), which THROWS on Cloud Run unless the cache is warmed at boot — no gcloud CLI in the container). Warm
// it, then FAIL LOUD if the SA can't write GCS — a missing storage role would otherwise surface as an opaque render
// 'failed' on the first user Deep Dive, deep in the IAM propagation window (P5). Better to crash-loop at deploy.
if (ON_CLOUD_RUN) {
  await warmGcpToken()
  // Retry the probe: a freshly-granted storage binding can take a minute to propagate, so a cold deploy shouldn't
  // hard-crash on the first PUT. After the retries a real 403 (missing role) still crash-loops → fails the deploy.
  let probed = false
  for (let attempt = 1; attempt <= 6 && !probed; attempt++) {
    try {
      await gcs.put(STATE_BUCKET, '.probe/boot', 'ok', 'text/plain')
      probed = true
    } catch (e) {
      if (attempt === 6) throw e
      logger.warn('gcs_write_probe_retry', { attempt, err: String(e) })
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  setInterval(() => {
    warmGcpToken().catch((e) => logger.warn('gcp_token_refresh_failed', { err: String(e) }))
  }, 30 * 60_000)
}

// OPENAI_API_KEY + FIRECRAWL_API_KEY are required on Cloud Run (the render's research/script run on OpenAI
// gpt-5.4-mini over Firecrawl). Assert at boot so a missing/typo'd secret crash-loops loudly instead of failing every render opaque.
assertProdKeys()

const deps = buildProductionDeps({ outDir: OUT_DIR, audioBucket: AUDIO_BUCKET, stateBucket: STATE_BUCKET, gcs })

// Stable public URL for the rendered MP3 — GCS serves it (Range-native), so the worker can be scaled to zero.
const audioUrlFor = (item: string, version: number) =>
  `https://storage.googleapis.com/${AUDIO_BUCKET}/podcasts/${encodeURIComponent(item)}/v${version}/episode.mp3`

function unauthorized(req: Request): boolean {
  return req.headers.get('x-worker-secret') !== SECRET
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 240,
  fetch: withRequestTelemetry(async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    // --- enqueue a render (called by the BFF after it gates the credit) ---
    if (req.method === 'POST' && url.pathname === '/render') {
      if (unauthorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 })
      const body = (await req.json().catch(() => null)) as { catalogItemId?: string; version?: number; subject?: string; context?: PodcastContext } | null
      if (!body?.catalogItemId || !body?.subject) return Response.json({ error: 'catalogItemId, subject required' }, { status: 400 })
      const version = body.version ?? 1
      // The server-owned reveal context (identity + what/purpose/maker + grounded facts) — the BFF is the only writer
      // (never client-trusted), and it is optional so an older BFF still renders.
      const job: PodcastJob = { catalogItemId: body.catalogItemId, version, subject: body.subject, ...(body.context ? { context: body.context } : {}) }
      // Fire-and-forget: the BFF's gate returns immediately; the app polls /status. Idempotency is the store's CAS
      // (queued→rendering) — a duplicate delivery observes 'rendering'/'ready' and does NOT render twice.
      renderPodcast(job, deps)
        .then((o) =>
          logger.info('podcast render complete', {
            subject: job.subject,
            version,
            kind: o.kind,
            ...('grounding' in o ? { grounding: o.grounding } : {}),
            ...('reason' in o ? { reason: o.reason } : {}),
            ...('details' in o && o.details ? { details: JSON.stringify(o.details).slice(0, 400) } : {}),
          }),
        )
        .catch((e) => logger.error('podcast render failed', e instanceof Error ? e : new Error(String(e)), { subject: job.subject, version }))
      return Response.json({ ok: true }, { status: 202 })
    }

    // --- status poll (called by the BFF's PodcastStatusService, keyed on item+version it resolved from the token) ---
    if (req.method === 'GET' && url.pathname === '/status') {
      if (unauthorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 })
      const item = url.searchParams.get('item')
      const version = Number(url.searchParams.get('version'))
      if (!item || !Number.isFinite(version)) return Response.json({ error: 'item, version required' }, { status: 400 })
      const status = await deps.store.getStatus(item, version)
      if (status === 'ready') {
        const asset = await deps.store.getAsset(item, version)
        return Response.json({ state: 'ready', audioUrl: audioUrlFor(item, version), transcript: asset?.transcript ?? [] })
      }
      if (status === 'failed') return Response.json({ state: 'failed' })
      return Response.json({ state: 'composing' }) // null | queued | rendering
    }

    return new Response('not found', { status: 404 })
  }, { role: 'podcast' }),
})
logger.info('voxi-podcast-worker listening', { port: PORT, outDir: OUT_DIR, audioBucket: AUDIO_BUCKET, stateBucket: STATE_BUCKET })
