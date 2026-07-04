/**
 * Production HTTP entrypoint for the voxi-api BFF — the ONLY public surface, deployed to Cloud Run.
 *
 * This assembles createApp with PRODUCTION-shaped, PROVEN-LIVE collaborators:
 *   - networkless Clerk JWT verification (@clerk/backend + CLERK_JWT_KEY),
 *   - the live identification cascade (CascadeEveClient → safety_gate → Vertex Gemini + Cloud Vision → arbiter
 *     → LiveNarrator → grounded deep-research), the exact path spikes/live-bff-scan.ts proves,
 *   - DURABLE collection persistence in Cloud SQL (threads/photos/reveals/messages/refunds), so a user's
 *     catalog survives restarts and multi-instance autoscaling (the container filesystem is ephemeral),
 *   - the spoken reveal (ElevenLabs) when ELEVENLABS_API_KEY is present,
 *   - GCP-native telemetry: structured NDJSON → Cloud Logging (automatic on Cloud Run) + one SERVER span per
 *     request (OTLP → Cloud Trace when a collector endpoint is configured).
 *
 * Nothing is stubbed to force green: a missing signing key, Clerk key, or DATABASE_URL fails loudly at boot;
 * an absent ELEVENLABS_API_KEY leaves the spoken-reveal route 503-ing (never a fake success).
 */
import { serve } from 'bun'
import { verifyToken } from '@clerk/backend'
import { createApp, type NarrationAudioCache } from '../../../services/voxi-api/src/app'
import { clerkVerifier } from '../../../services/voxi-api/src/auth'
import { assertSigningKeyConfigured } from '../../../services/voxi-api/src/signing'
import { CascadeEveClient } from '../../../services/voxi-api/src/cascade-eve-client'
import { LiveNarrationTts } from '../../../services/voxi-api/src/live-tts'
import { createPodcastBridge } from '../../../services/voxi-api/src/podcast-client'
import { createPodcastAudioDeleter } from '../../../services/voxi-api/src/gcs'
import { createCloudSqlStores } from '../../../services/voxi-api/src/cloudsql-stores'
import { createPgStores } from '../../../services/voxi-api/src/pg-stores'
import { warmGcpToken } from '../../../services/eve-agent/agent/lib/gcp-vision'
import { initTelemetry, logger, withRequestTelemetry } from '../../../packages/telemetry/src/index'
import { initSentry, flushSentry } from '../../../services/voxi-api/src/sentry'

// Structured logs → stdout (Cloud Run captures them into Cloud Logging) + OTLP span export → Cloud Trace when
// OTEL_EXPORTER_OTLP_ENDPOINT points at a collector. Must run before anything logs.
initTelemetry({ service: 'voxi-api', role: 'bff' })

// Error monitoring (Sentry). OPTIONAL + fail-soft: absent SENTRY_DSN → disabled; a bad init never blocks boot.
// Subscribes to the logger's error/fatal stream, so every 5xx/throw already routed through @voxi/telemetry ships.
initSentry()

const PORT = Number(process.env.PORT ?? 8080)
const ON_CLOUD_RUN = !!process.env.K_SERVICE

// Fail fast in prod: the signed /media photo route is only as strong as this HMAC key — a default would let
// anyone forge a URL to another user's private photo (adversarial A1).
assertSigningKeyConfigured()
if (!process.env.CLERK_JWT_KEY) {
  throw new Error('CLERK_JWT_KEY is required in production (networkless Clerk verify) — set it from Secret Manager')
}

// On Cloud Run the identification cascade authenticates to Vertex/Vision via the metadata server (there is no
// gcloud CLI). Warm the token cache before serving and refresh it on a timer; fail loud if the runtime service
// account can't mint one (that means missing roles — better to know at deploy than on the first photo).
if (ON_CLOUD_RUN) {
  await warmGcpToken()
  setInterval(() => {
    warmGcpToken().catch((e) => logger.warn('gcp_token_refresh_failed', { err: String(e) }))
  }, 30 * 60_000)
}

// DURABLE stores. Cloud SQL in prod (DATABASE_URL); a local file-backed PGlite for `docker run` smoke tests.
const databaseUrl = process.env.DATABASE_URL
if (ON_CLOUD_RUN && !databaseUrl) {
  throw new Error('DATABASE_URL is required on Cloud Run — the collection must persist in Cloud SQL, not on the ephemeral container disk')
}
const durable = databaseUrl
  ? await createCloudSqlStores(databaseUrl)
  : await createPgStores(process.env.VOXI_DATA_DIR ?? '.voxi-data/bff')
logger.info('durable_store_ready', { backend: databaseUrl ? 'cloud-sql' : 'pglite' })

// The live identification cascade (no catalog moat in v1 → the exact vlm+web+research path; the moat is additive).
const eve = new CascadeEveClient()

// Spoken reveal (ElevenLabs): voices the SERVER-OWNED narration. A bounded content-hash cache makes a stable
// reveal synthesize exactly once. Absent key → `speech` undefined → POST /v1/threads/:id/speech 503s (loud).
function boundedAudioCache(max = 256): NarrationAudioCache {
  const m = new Map<string, Uint8Array<ArrayBuffer>>()
  return {
    async get(key) {
      return m.get(key) ?? null
    },
    async put(key, bytes) {
      if (m.size >= max) m.delete(m.keys().next().value as string)
      m.set(key, bytes)
    },
  }
}
const elevenKey = process.env.ELEVENLABS_API_KEY
const speech = elevenKey ? { tts: new LiveNarrationTts(elevenKey), cache: boundedAudioCache() } : undefined
if (!speech) logger.warn('no_elevenlabs_key', { effect: 'spoken reveal disabled (POST /v1/threads/:id/speech → 503)' })

// Deep Dive (podcast) render bridge. The BFF gates the credit then hands the render to the standalone worker
// over HTTP; on poll it proxies the worker's honest status. Wired ONLY when both the worker URL and the shared
// secret are present — absent either, `podcastEnqueue`/`podcastStatus` stay undefined and POST /v1/podcast 402s
// loudly (never a fake success), matching the seams-not-stubs rule.
const podcastWorkerUrl = process.env.PODCAST_WORKER_URL
const podcastWorkerSecret = process.env.PODCAST_WORKER_SECRET
const podcastBridge =
  podcastWorkerUrl && podcastWorkerSecret
    ? createPodcastBridge({ workerUrl: podcastWorkerUrl, secret: podcastWorkerSecret })
    : undefined
if (!podcastBridge) logger.warn('no_podcast_worker', { effect: 'Deep Dive render disabled (missing PODCAST_WORKER_URL/SECRET)' })

// Deep Dive audio + render state live in GCS (so the worker scales to zero). The deleter purges an item's objects
// from both the public audio bucket and the private state bucket, wired into the per-item delete AND the account
// purge below — the SQL row delete alone would orphan the GCS objects (deletion-completeness / P6).
const audioBucket = process.env.GCS_AUDIO_BUCKET ?? 'voxi-podcast-audio'
const stateBucket = process.env.GCS_STATE_BUCKET ?? 'voxi-podcast-state'
const deletePodcastAudio = createPodcastAudioDeleter({ audioBucket, stateBucket })

const app = createApp({
  verifier: clerkVerifier(verifyToken as never),
  store: durable.store,
  eve,
  deletion: {
    // Account deletion cascades across the durable stores AND the cascade's per-session photo/narration caches.
    async cascade(userId: string) {
      // Purge the user's rendered podcast GCS objects BEFORE the row cascade deletes the podcast_assets index that
      // finds them (else the objects orphan, un-purgeable). Best-effort: a GCS failure must not block the SQL purge.
      const items = (await (durable.podcasts.listItemIdsByUser?.(userId).catch(() => [] as string[]))) ?? []
      for (const item of items) await deletePodcastAudio(item).catch((e) => logger.warn('podcast_audio_purge_failed', { item, err: String(e) }))
      const evePhotos = eve.purgeUser(userId)
      const counts = await durable.purgeUser(userId)
      return { deleted: [`eve-photos:${evePhotos}`, `podcast-audio-items:${items.length}`, ...Object.entries(counts).map(([k, v]) => `${k}:${v}`)] }
    },
  },
  bucket: process.env.GCS_PHOTO_BUCKET ?? 'voxi-photos',
  sessionOwner: new Map<string, string>(),
  // Durable collection persistence (COLLECTION-PERSISTENCE-PLAN) — survives restarts + multi-instance autoscale.
  threads: durable.threads,
  photos: durable.photos,
  reveals: durable.reveals,
  podcasts: durable.podcasts,
  messages: durable.messages,
  refunds: durable.refunds,
  speech,
  // Deep Dive render: enqueue to the worker (once per fresh gate) + proxy its honest status on poll.
  podcastEnqueue: podcastBridge?.enqueue,
  podcastStatus: podcastBridge?.status,
  deletePodcastAudio,
  // v1 has no paywall: full access so the TestFlight loop is never entitlement-blocked. Real StoreKit 2
  // verification (appstore.ts) lands with billing; until then everyone is a voyager.
  planFor: async () => 'voyager',
})

// Health probe bypasses telemetry entirely (Cloud Run probes are frequent — a span per probe floods Trace).
const wrapped = withRequestTelemetry((req: Request) => app.fetch(req), { role: 'bff' })
const server = serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 200,
  fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz' || url.pathname === '/') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return wrapped(req)
  },
})
logger.info('voxi-api_listening', { port: server.port, onCloudRun: ON_CLOUD_RUN })

// Graceful shutdown: stop accepting, drain in-flight streams, close the DB pool before Cloud Run kills us.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    logger.info('shutdown', { signal: sig })
    server.stop()
    // Drain the Sentry queue before we exit — a 5xx captured microseconds before scale-down would otherwise be
    // dropped (the async transport hasn't flushed and process.exit skips beforeExit).
    await flushSentry()
    durable.close().finally(() => process.exit(0))
  })
}
