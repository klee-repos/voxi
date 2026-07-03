/**
 * The podcast render worker as a runnable process (the missing entrypoint). A Bun HTTP service that receives a
 * gated job from the BFF, runs the REAL renderPodcast pipeline (search-grounded research → claim-structured
 * Gemini script → honesty + defamation gates → live ElevenLabs two-voice TTS → ffmpeg loudnorm mux), stores a
 * real MP3, and reports status the BFF polls. No fakes: every provider is live.
 *
 *   POST /render   {token, catalogItemId, version, subject}   (x-worker-secret)  → 202, renders async
 *   GET  /status?token=...                                    (x-worker-secret)  → {state, audioUrl?}
 *   GET  /audio/:item/v:version/episode.mp3                                       → the rendered MP3 (range-safe)
 *
 * Run: `bun services/voxi-podcast-worker/src/server.ts` (from repo root so .env.local loads the vendor keys).
 */
import { renderPodcast, memoryAssetStore, type PodcastJob } from './render'
import type { PodcastContext } from '../../../packages/shared/src/podcast'
import { buildProductionDeps } from './production-deps'
import { audioRangeResponse } from './audio-range'
import { warmGcpToken } from '../../eve-agent/agent/lib/gcp-vision'
import { mkdirSync } from 'node:fs'
import { initTelemetry, logger, withRequestTelemetry } from '../../../packages/telemetry/src/index'

initTelemetry({ service: 'voxi-podcast-worker', role: 'podcast' })

// Cloud Run injects PORT; honor it first so the container's listen port matches the platform contract. Falls
// back to PODCAST_WORKER_PORT (local dev override) then the dev default.
const PORT = Number(process.env.PODCAST_WORKER_PORT ?? process.env.PORT ?? 8788)

// Research + script generation hit Vertex Gemini via the synchronous gcloudToken() accessor, which THROWS on
// Cloud Run unless the token cache is warmed at boot (there is no gcloud CLI in the container — the token comes
// from the metadata server). Warm it before serving and refresh on a timer; fail loud if the runtime SA can't
// mint one (missing roles → better to know at deploy than on the first render).
const ON_CLOUD_RUN = !!process.env.K_SERVICE
if (ON_CLOUD_RUN) {
  await warmGcpToken()
  setInterval(() => {
    warmGcpToken().catch((e) => logger.warn('gcp_token_refresh_failed', { err: String(e) }))
  }, 30 * 60_000)
}
const SECRET = process.env.PODCAST_WORKER_SECRET ?? 'dev-podcast-secret'
const PUBLIC_BASE = process.env.PODCAST_PUBLIC_BASE ?? `http://192.168.1.193:${PORT}`
// Durable by default (COLLECTION-PERSISTENCE-PLAN A14): a rendered episode survives a restart and the deletion
// cascade can find + purge it. Prod overrides with a GCS-backed path. (Was /tmp — ephemeral + un-purgeable.)
const OUT_DIR = process.env.PODCAST_OUT_DIR ?? '.voxi-data/podcasts'
mkdirSync(OUT_DIR, { recursive: true })

const store = memoryAssetStore()
const jobs = new Map<string, { catalogItemId: string; version: number; subject: string }>() // token → job
// Assembled via the testable factory so the flavor-auditor wiring (detectNamedClaim) is asserted in tests, not
// silently dropped here as it was before (the honesty hole D1 fixed).
const deps = buildProductionDeps({ outDir: OUT_DIR, store })

const fileFor = (item: string, version: number) => `${OUT_DIR}/${item.replace(/[^\w.-]/g, '_')}__v${version}.mp3`
const audioUrlFor = (item: string, version: number) => `${PUBLIC_BASE}/audio/${encodeURIComponent(item)}/v${version}/episode.mp3`

function unauthorized(req: Request): boolean {
  return req.headers.get('x-worker-secret') !== SECRET
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 240,
  fetch: withRequestTelemetry(async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    // --- serve rendered audio (no secret; the URL is unguessable-enough for dev) ---
    // Honors `Range:` with a real 206 (audioRangeResponse) — WITHOUT it iOS AVPlayer treats the episode as a
    // non-seekable progressive stream and the scrubber + ±15 do nothing. `Response(Bun.file)` alone does NOT
    // range-handle in a fetch handler (the prior "range-safe via Bun.file" was false).
    const audioMatch = /^\/audio\/([^/]+)\/v(\d+)\/episode\.mp3$/.exec(url.pathname)
    if (req.method === 'GET' && audioMatch) {
      const item = decodeURIComponent(audioMatch[1]!)
      const version = Number(audioMatch[2])
      const f = Bun.file(fileFor(item, version))
      if (!(await f.exists())) return new Response('not found', { status: 404 })
      return audioRangeResponse(f, f.size, req.headers.get('range'))
    }

    // --- enqueue a render (called by the BFF after it gates the credit) ---
    if (req.method === 'POST' && url.pathname === '/render') {
      if (unauthorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 })
      const body = (await req.json().catch(() => null)) as { token?: string; catalogItemId?: string; version?: number; subject?: string; context?: PodcastContext } | null
      if (!body?.token || !body?.catalogItemId || !body?.subject) return Response.json({ error: 'token, catalogItemId, subject required' }, { status: 400 })
      const version = body.version ?? 1
      // Carry the server-owned reveal context (identity + what/purpose/maker + grounded facts) into the job so the
      // interview is built from everything the reveal learned — the BFF is the only writer of this (never trusted
      // from a raw client), and it is optional so an older BFF that doesn't send it still renders.
      const job: PodcastJob = { catalogItemId: body.catalogItemId, version, subject: body.subject, ...(body.context ? { context: body.context } : {}) }
      // Idempotent: a repeat token/job for an already-known token is a no-op (render.ts also CAS-guards).
      if (!jobs.has(body.token)) {
        jobs.set(body.token, { catalogItemId: job.catalogItemId, version, subject: job.subject })
        // Fire-and-forget: the BFF's gate returns immediately; the app polls /status.
        renderPodcast(job, deps)
          .then((o) =>
            logger.info('podcast render complete', {
              subject: job.subject,
              version,
              kind: o.kind,
              // whether the closed facts came from fresh research or (research having failed) the reveal's own
              // facts alone — so a degraded-but-shipped episode is observable, not a silent success.
              ...('grounding' in o ? { grounding: o.grounding } : {}),
              // surface WHY a render didn't ship (the old log dropped this — an RCA blind spot).
              ...('reason' in o ? { reason: o.reason } : {}),
              ...('details' in o && o.details ? { details: JSON.stringify(o.details).slice(0, 400) } : {}),
            }),
          )
          .catch((e) => logger.error('podcast render failed', e instanceof Error ? e : new Error(String(e)), { subject: job.subject, version }))
      }
      return Response.json({ ok: true }, { status: 202 })
    }

    // --- status poll (called by the BFF's PodcastStatusService) ---
    if (req.method === 'GET' && url.pathname === '/status') {
      if (unauthorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 })
      const token = url.searchParams.get('token') ?? ''
      const job = jobs.get(token)
      if (!job) return Response.json({ error: 'not_found' }, { status: 404 })
      const status = await store.getStatus(job.catalogItemId, job.version)
      if (status === 'ready') {
        const asset = await store.getAsset(job.catalogItemId, job.version)
        return Response.json({ state: 'ready', audioUrl: audioUrlFor(job.catalogItemId, job.version), transcript: asset?.transcript ?? [] })
      }
      if (status === 'failed') return Response.json({ state: 'failed' })
      return Response.json({ state: 'composing' }) // null | queued | rendering
    }

    return new Response('not found', { status: 404 })
  }, { role: 'podcast' }),
})
logger.info('voxi-podcast-worker listening', { port: PORT, outDir: OUT_DIR, publicBase: PUBLIC_BASE })
