/**
 * The REAL voxi-api server (the missing "assemble + run" step). Wires createApp with production-shaped deps —
 * networkless Clerk JWT verification, the live identification cascade (CascadeEveClient → Vertex Gemini + Cloud
 * Vision + narrator), and in-memory stores — and serves it. Reads secrets from the repo-root .env.local (bun
 * auto-loads it). Bind: 0.0.0.0 so a phone on the same Wi-Fi reaches it at http://<mac-lan-ip>:8787.
 *
 * Run: `bun services/voxi-api/src/server.ts`  (from the repo root, so .env.local + node_modules resolve).
 */
import { verifyToken } from '@clerk/backend'
import { createApp, type NarrationAudioCache } from './app'
import { clerkVerifier } from './auth'
import { assertSigningKeyConfigured } from './signing'
import { CascadeEveClient } from './cascade-eve-client'
import { LiveNarrationTts } from './live-tts'
import { createPodcastBridge } from './podcast-client'
import { createVoiceRoutes } from './voice-routes'
import { buildLocalCollaborators } from './local-collaborators'
import { createPgStores } from './pg-stores'
import { Catalog } from '../../../packages/db/catalog'
import { VertexEmbeddingProvider, EMBED_DIM } from '../../eve-agent/agent/lib/embedding'
import { mkdirSync } from 'node:fs'
import { initTelemetry, logger, withRequestTelemetry } from '../../../packages/telemetry/src/index'

// Structured logs → stdout (always; Cloud Run captures them into Cloud Logging) + OTLP trace export to a
// collector → Cloud Trace when OTEL_EXPORTER_OTLP_ENDPOINT is set.
initTelemetry({ service: 'voxi-api', role: 'bff' })

if (!process.env.CLERK_JWT_KEY && !process.env.CLERK_SECRET_KEY) {
  logger.warn('no CLERK_JWT_KEY/CLERK_SECRET_KEY in env — auth will reject every request. Run from the repo root so .env.local loads.')
}

// Fail fast in production if the URL-signing key is unset (adversarial A1): the /media photo route serves raw
// bytes authenticated ONLY by this HMAC, so a default key would let anyone forge a URL to another user's photo.
assertSigningKeyConfigured()

// BFF ↔ podcast-worker: gate the credit here, render on the worker, proxy its honest status (real MP3 only).
const podcast = createPodcastBridge({
  workerUrl: process.env.PODCAST_WORKER_URL ?? 'http://127.0.0.1:8788',
  secret: process.env.PODCAST_WORKER_SECRET ?? 'dev-podcast-secret',
})

// PGlite's NodeFS only creates the LEAF dir, not parents — so ensure the data dirs (and their parents) exist.
const DATA_DIR = process.env.VOXI_DATA_DIR ?? '.voxi-data/bff'
const CATALOG_DIR = process.env.VOXI_CATALOG_DIR ?? '.voxi-data/catalog'
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(CATALOG_DIR, { recursive: true })

// The live identification cascade with the Stage-3 CATALOG MOAT wired: a file-backed per-user catalog + real
// Vertex multimodal embeddings. Each scan grows the user's private catalog and a re-scan of a known object hits
// it. Fully guarded — any embedding/catalog error degrades to the exact vlm+web-only path.
const catalog = await Catalog.create(EMBED_DIM, CATALOG_DIR)
const eve = new CascadeEveClient({ catalog, embedder: new VertexEmbeddingProvider() })
// Durable, file-backed persistence: threads + entitlements + podcast tokens survive a restart (PGlite on disk).
const durable = await createPgStores(DATA_DIR)
const local = buildLocalCollaborators({ photoPurge: (userId) => eve.purgeUser(userId), durable })

// Spoken reveal (ANALYSIS-VOICE-PLAN B): ElevenLabs voices the SERVER-OWNED narration. Wired only when
// ELEVENLABS_API_KEY is present — otherwise `speech` stays undefined and POST /v1/threads/:id/speech 503s (loud,
// never faked). A bounded in-memory content-hash cache makes a stable reveal synthesize once (the autoplay+tap
// double-play is free); prod can swap in an object-store/CDN cache behind the same seam.
function boundedAudioCache(max = 256): NarrationAudioCache {
  const m = new Map<string, Uint8Array<ArrayBuffer>>()
  return {
    async get(key) {
      return m.get(key) ?? null
    },
    async put(key, bytes) {
      if (m.size >= max) m.delete(m.keys().next().value as string) // simple FIFO bound
      m.set(key, bytes)
    },
  }
}
const elevenKey = process.env.ELEVENLABS_API_KEY
const speech = elevenKey ? { tts: new LiveNarrationTts(elevenKey), cache: boundedAudioCache() } : undefined
if (!speech) logger.warn('no ELEVENLABS_API_KEY — POST /v1/threads/:id/speech will 503 (spoken reveal disabled)')

// Networkless Clerk verify: the injected @clerk/backend verifyToken + CLERK_JWT_KEY (PEM). Shared by the BFF
// and the mountable voice sub-app so a voice session is authed + ACL'd exactly like every other /v1/* route.
const verifier = clerkVerifier(verifyToken as never)

// "Ask Voxi" realtime voice: POST /v1/voice/session gates a voiceMin minute + mints a per-session connect URL
// pointing the app's Pipecat SmallWebRTC client at the voice media server (services/voice-bot/voice_server.py).
const voice = createVoiceRoutes({
  verifier,
  store: local.store,
  sessionOwner: local.sessionOwner,
  threads: durable.threads, // durable owner backstop: without it a legit owner's voice session 404s after a restart
  voiceServerBaseUrl: process.env.VOICE_SERVER_BASE_URL ?? 'http://192.168.1.193:7071',
})

const app = createApp({
  verifier,
  store: local.store,
  eve, // the live identification cascade
  deletion: local.deletion, // real cascade across every store here
  bucket: 'voxi-photos',
  sessionOwner: local.sessionOwner,
  threads: local.threads,
  // Durable collection persistence (COLLECTION-PERSISTENCE-PLAN): photo bytes, the reveal (for deterministic
  // replay), the podcast episode, the conversation, and the once-ever refund guard — all survive a restart.
  photos: durable.photos,
  reveals: durable.reveals,
  podcasts: durable.podcasts,
  messages: durable.messages,
  refunds: durable.refunds,
  interviews: local.interviews, // interviewer subagent (unknown-item "first witness")
  contributions: local.contributions, // real trust-gate + first-report auto-hide
  podcastStatus: podcast.status,
  podcastEnqueue: podcast.enqueue,
  speech, // spoken reveal (ElevenLabs) — undefined when no key → route 503s loud

  // Dev: full access so testing is never paywalled. (Real App Store JWS verification lands with billing; the
  // verifier exists in appstore.ts and is fail-closed, but a sandbox purchase can't be exercised here.)
  planFor: async () => 'voyager',
})

const port = Number(process.env.PORT ?? 8787)

// The voice sub-app owns /v1/voice/* (re-applies the same auth + ACL); everything else is the main BFF.
const route = (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  return url.pathname.startsWith('/v1/voice/') ? voice.fetch(req) : app.fetch(req)
}

// withRequestTelemetry emits one access-log line + one SERVER span per request, correlated by traceId, and
// runs the handler inside a trace context so every log beneath it carries the same id. Bodies are never
// logged (a photo data-URI is ~MBs — the redactor strips them); the request's content length is recorded.
Bun.serve({ port, hostname: '0.0.0.0', idleTimeout: 200, fetch: withRequestTelemetry(route, { role: 'bff' }) })
logger.info('voxi-api (live cascade) listening', { port, bind: `http://0.0.0.0:${port}` })
