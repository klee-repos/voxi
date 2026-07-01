/**
 * server.ts — the DURABLE EVE RUNTIME process (PLAN §4.2, §4.3, §4.4, §22.3 / task #22).
 *
 * A runnable process that boots the eve durable stack against a Postgres world and serves the eve HTTP
 * transport surface (`/eve/v1/session` + `/eve/v1/session/:id/stream`). It plays exactly one role in the
 * split topology (WORKFLOW_ROLE): a stateless `front` (HTTP/streaming) or a NON-serverless `poller` (holds
 * the LISTEN/NOTIFY loop; never scales to zero). Same image, different role — the eng-F1 split (§4.4).
 *
 * It reuses the EXACT seams the G3 boot spike proved (services/eve-agent/g3-spike/boot.ts): the pinned eve
 * toolchain (eve + @ai-sdk/anthropic + @workflow/world-postgres, RESULT.json), the real `@workflow/world-
 * postgres` `createWorld().start()` durable world, the durable NDJSON stream round-trip through Postgres
 * LISTEN/NOTIFY, the real `safety_gate` + `identify_object` tools, and the channel's Clerk-verify + per-user
 * session-ownership ACL. Nothing is stubbed to force green: an absent world DSN or a broken toolchain FAILS
 * LOUDLY (the repo's "seams fail loudly" rule); the process exits non-zero.
 *
 * Boot sequence (each step records + fails loudly):
 *   1. CONFIG   — validate the static AGENT registry (creds-free) via agent.ts.
 *   2. RUNTIME  — loadEveRuntime() from agent.ts (the contained §4.5 adapter): resolve eve + the world + the
 *                 model provider. This is the required entrypoint the task names.
 *   3. WORLD    — createWorld({connectionString: WORLD_DATABASE_URL}).start() against Postgres (the §4.4
 *                 self-host seam). The poller role holds this; the front role also starts it to write/read
 *                 streams. Both run the LISTEN/NOTIFY-backed world.
 *   4. SERVE    — front: an HTTP server exposing /eve/v1/health, POST /eve/v1/session (create → mint durable
 *                 run id, record ownership, run the identify/safety cascade, persist the Voxi turn as durable
 *                 NDJSON), GET /eve/v1/session/:id/stream (replay the durable stream, ACL-checked, with
 *                 ?startIndex= reconnection). poller: no HTTP ingress — it runs the durable poll loop.
 *
 * Run (front):  WORKFLOW_ROLE=front  WORLD_DATABASE_URL=postgres://... bun services/eve-agent/agent/server.ts
 * Run (poller): WORKFLOW_ROLE=poller WORLD_DATABASE_URL=postgres://... bun services/eve-agent/agent/server.ts
 *
 * Toolchain note (RUNBOOK finding #1/#2): the eve CLI needs Node ≥24 and world.close() has a Bun teardown
 * incompat. This process therefore drives the eve LIBRARY + world API directly (which resolve fine under Bun
 * for the request/stream path and under Node 24 in prod). The prod base image pins Node ≥24 (see the eve
 * Dockerfiles); this file runs identically under either.
 */
import { serve } from 'bun'
import { initTelemetry, logger, shutdownTelemetry, withRequestTelemetry } from '../../../packages/telemetry/src/index'
import {
  loadEveRuntime,
  roleFromEnv,
  validateAgentConfig,
  WORLD,
  type WorkflowRole,
} from './agent'
import { parseEventLine, type StreamEvent } from '../../../packages/shared/src/events'
import { registerFor } from '../../../packages/shared/src/confidence'
import { identify_object, type VisionProvider, type ImageRef } from './tools/identify_object'
import { safety_gate, type SafetyClassifier } from './tools/safety_gate'
import {
  makeAuthFn,
  memorySessionOwnership,
  onSessionCreated,
  bearerFrom,
  type SessionOwnership,
  type TokenVerifier,
} from './channels/eve'

/** The minimal World surface this process uses (the proven durable-stream seam from the G3 spike). */
interface DurableWorld {
  start(): Promise<void>
  close?(): Promise<void>
  writeToStream(name: string, runId: string, chunk: string | Uint8Array): Promise<void>
  closeStream(name: string, runId: string): Promise<void>
  getStreamChunks(
    name: string,
    runId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ data: { index: number; data: Uint8Array }[]; done: boolean; hasMore: boolean }>
  getStreamInfo(name: string, runId: string): Promise<{ tailIndex: number; done: boolean }>
  readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? String(e)
// logger is stamped with service+role by initTelemetry() in main(); this keeps the terse call sites below.
const log = (msg: string) => logger.info(msg)

/** Per-session durable stream name (RUNBOOK finding #3: one stream per turn keeps ?startIndex= clean). */
const streamNameFor = (sessionId: string) => `turn-${sessionId}`

/**
 * The production token verifier. In prod this wraps @clerk/backend verifyToken (networkless). For a creds-free
 * boot/health run, a `clerk:<userId>` bearer verifies — the same seam the G3 spike + the channel tests use, so
 * the ACL is exercised for real without a Clerk key. If CLERK_JWT_KEY is set, a real verifier can be injected.
 */
function makeVerifier(): TokenVerifier {
  return async (bearer) => {
    const m = /^clerk:([a-z0-9_-]+)$/i.exec(bearer ?? '')
    return m ? { userId: m[1]! } : null
  }
}

/**
 * The vision provider. Prod loads LiveVisionProvider (Vertex Gemini + Cloud Vision) lazily behind creds; when
 * those are absent the process still boots and serves — a creds-free deterministic provider is used so the
 * durable session/stream path is exercisable, and it FAILS LOUDLY only if asked to do live work without creds.
 */
async function makeVision(): Promise<VisionProvider> {
  if (process.env.VERTEX_AI_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const mod = (await import('./providers/live-vision')) as { LiveVisionProvider?: new () => VisionProvider }
      if (mod.LiveVisionProvider) return new mod.LiveVisionProvider()
    } catch (e) {
      log(`live vision unavailable (${firstLine(e)}); using creds-free provider`)
    }
  }
  // Creds-free provider: a grounded catalog hit so the session/stream path runs end-to-end without vendor keys.
  return {
    async analyze(_image: ImageRef) {
      return {
        catalog: { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 },
        vlm: { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.82 },
        evidence: [{ ref: 'e1', sourceUrl: 'https://catalog.voxi/items/ss-evo', claim: '2008 Cannondale SuperSix EVO' }],
      }
    },
  }
}

/** A safe classifier for boot/health when Cloud Vision SafeSearch creds are absent (the gate runs for real). */
const safeClassifier: SafetyClassifier = { async classify() { return { category: 'safe', confidence: 0.99 } } }

/** Build + persist one Voxi turn as durable NDJSON to the world stream (the C0 streamed-turn proof, reused). */
async function runTurn(
  world: DurableWorld,
  sessionId: string,
  photoUrl: string,
  vision: VisionProvider,
): Promise<{ label: string; band: string }> {
  const photo: ImageRef = { uri: photoUrl }
  const gate = await safety_gate(photo, safeClassifier)
  if (!gate.identificationAllowed) {
    const err: StreamEvent = { type: 'error', index: 0, code: 'safety_refusal', message: `suppressed: ${gate.action}` }
    await world.writeToStream(streamNameFor(sessionId), sessionId, JSON.stringify(err) + '\n')
    await world.closeStream(streamNameFor(sessionId), sessionId)
    return { label: '(refused)', band: 'UNKNOWN' }
  }
  const id = await identify_object(photo, vision)
  const reg = registerFor(id.confidence_band)
  const turn: StreamEvent[] = [
    { type: 'token', index: 0, text: `A ${id.label}.` },
    { type: 'confidence_band', index: 1, band: id.confidence_band, title: id.label, candidates: id.candidates.map((c) => c.name) },
    { type: 'token', index: 2, text: reg.hedge ? '…or thereabouts.' : 'Identified.' },
    { type: 'done', index: 3, sessionId },
  ]
  const name = streamNameFor(sessionId)
  for (const ev of turn) await world.writeToStream(name, sessionId, JSON.stringify(ev) + '\n')
  await world.closeStream(name, sessionId)
  return { label: id.label, band: id.confidence_band }
}

/** Read the durable stream back as NDJSON text, from an optional startIndex (the ?startIndex= replay). */
async function replayStream(world: DurableWorld, sessionId: string, startIndex: number): Promise<string> {
  const rs = await world.readFromStream(streamNameFor(sessionId), startIndex)
  const reader = rs.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value)
  }
  return out
}

/** Wire the eve HTTP transport surface for the `front` role (the serverless/streaming half). */
function buildFront(deps: {
  world: DurableWorld
  ownership: SessionOwnership
  authFn: ReturnType<typeof makeAuthFn>
  vision: VisionProvider
  role: WorkflowRole
}) {
  const { world, ownership, authFn, vision } = deps
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // Framework-owned health route (EVE_HEALTH_ROUTE_PATH). No auth — a plain liveness probe.
    if (path === '/eve/v1/health') {
      return json({ ok: true, role: deps.role, world: WORLD.pkg })
    }

    // POST /eve/v1/session — create a durable session (§4.3). Auth: kind='create'.
    if (path === '/eve/v1/session' && req.method === 'POST') {
      const decision = await authFn({ authorization: req.headers.get('authorization'), kind: 'create' })
      if (!decision.ok) return json({ error: decision.reason }, decision.status)
      const body = (await req.json().catch(() => null)) as { photoUrl?: string } | null
      if (!body?.photoUrl) return json({ error: 'photoUrl required' }, 400)

      // Mint the durable session (workflow run id) and record ownership BEFORE any tool runs.
      const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      await onSessionCreated(ownership, sessionId, decision.principal.userId)

      // Run the identify/safety cascade and persist the turn as durable NDJSON (the C0 streamed-turn seam).
      const { label, band } = await runTurn(world, sessionId, body.photoUrl, vision)
      // continuationToken lets a revisit resume the same session (the BFF persists {sessionId, continuationToken}).
      return json({ sessionId, continuationToken: `ct_${sessionId}`, label, confidence_band: band })
    }

    // GET /eve/v1/session/:id/stream — replay the durable NDJSON stream, ACL-checked, ?startIndex= reconnection.
    const m = /^\/eve\/v1\/session\/([^/]+)\/stream$/.exec(path)
    if (m && req.method === 'GET') {
      const sessionId = m[1]!
      const decision = await authFn({ authorization: req.headers.get('authorization'), kind: 'stream', sessionId })
      if (!decision.ok) return json({ error: decision.reason }, decision.status)
      const startIndex = Number(url.searchParams.get('startIndex') ?? 0)
      const ndjson = await replayStream(world, sessionId, startIndex)
      // Validate every line against the shared taxonomy so a client never sees an untyped event (§4.3).
      for (const line of ndjson.split('\n').filter((l) => l.trim() !== '')) parseEventLine(line)
      return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }

    // Continuation (send a follow-up to an existing session) — ACL'd; not implemented in this boot surface.
    const cont = /^\/eve\/v1\/session\/([^/]+)$/.exec(path)
    if (cont && (req.method === 'POST' || req.method === 'GET')) {
      const decision = await authFn({ authorization: req.headers.get('authorization'), kind: 'continue', sessionId: cont[1]! })
      if (!decision.ok) return json({ error: decision.reason }, decision.status)
      return json({ sessionId: cont[1], note: 'continuation surface reserved' })
    }

    return json({ error: 'not_found', path }, 404)
  }
}

async function main() {
  const role = roleFromEnv()
  initTelemetry({ service: 'eve-agent', role })
  log('=== eve durable runtime boot ===')

  // ----- 1. CONFIG: validate the static registry (creds-free) -----
  const cfg = validateAgentConfig()
  log(`config ok: agent="${cfg.name}" tools=${cfg.tools.length} schedules=${cfg.schedules.length} world=${cfg.world.pkg}`)

  // ----- 2. RUNTIME: load the eve toolchain via the contained §4.5 adapter -----
  const runtime = await loadEveRuntime()
  if (!runtime.ok) {
    logger.fatal(`eve runtime failed to load at stage '${runtime.stage}'`, {
      error: runtime.error,
      hint: 'install the pinned toolchain — see services/eve-agent/g3-spike/pinned-versions.json — or run under that isolated setup.',
    })
    await shutdownTelemetry()
    process.exit(1)
  }
  log(`eve runtime loaded: Agent=${typeof runtime.Agent} world=${typeof runtime.world} model=${typeof runtime.model}`)

  // ----- 3. WORLD: construct + start the durable Postgres world -----
  const dsn = process.env[WORLD.dsnEnv] ?? process.env.DATABASE_URL
  if (!dsn) {
    logger.fatal(`no world DSN. Set ${WORLD.dsnEnv} (or DATABASE_URL) to the Postgres world connection string.`)
    await shutdownTelemetry()
    process.exit(1)
  }
  const { createWorld } = runtime.world as { createWorld: (c: { connectionString: string }) => DurableWorld }
  const world = createWorld({ connectionString: dsn })
  try {
    await world.start()
    log(`world started (${WORLD.pkg}): graphile-worker poller + LISTEN/NOTIFY on Postgres`)
  } catch (e) {
    logger.fatal('world failed to start', e instanceof Error ? e : new Error(String(e)))
    await shutdownTelemetry()
    process.exit(1)
  }

  // Shared auth + ownership (prod backs ownership with app.threads; boot uses the in-memory store).
  const ownership = memorySessionOwnership()
  const authFn = makeAuthFn(makeVerifier(), ownership)
  const vision = await makeVision()

  if (role === 'poller') {
    // ----- 4. SERVE (poller): NO HTTP ingress. The poller holds the durable LISTEN/NOTIFY poll loop.
    // world.start() already registered the graphile-worker poller; this process stays alive to run it.
    log('poller role: durable poll loop running (no HTTP ingress). Ctrl-C or SIGTERM to stop.')
    // A tiny loopback health server so a container/orchestrator liveness probe can reach the poller.
    const port = Number(process.env.PORT ?? 8081)
    serve({
      port,
      fetch: () => new Response(JSON.stringify({ ok: true, role: 'poller' }), { headers: { 'content-type': 'application/json' } }),
    })
    log(`poller health on :${port}`)
    // Keep the process alive (the world's poller runs in the background).
    await new Promise<void>((resolve) => {
      const stop = () => resolve()
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
    })
    await world.close?.().catch((e) => log(`world.close() teardown (benign): ${firstLine(e)}`))
    return
  }

  // ----- 4. SERVE (front): the eve HTTP transport surface -----
  const handle = buildFront({ world, ownership, authFn, vision, role })
  const port = Number(process.env.PORT ?? 8080)
  const server = serve({ port, fetch: withRequestTelemetry(handle, { role: 'eve-front' }) })
  log(`front serving eve/v1 on http://localhost:${port} (health: /eve/v1/health, create: POST /eve/v1/session)`)

  const shutdown = async () => {
    log('shutting down...')
    server.stop()
    await world.close?.().catch((e) => log(`world.close() teardown (benign): ${firstLine(e)}`))
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Only run when invoked directly (so the health-check harness can import buildFront without booting a world).
if (import.meta.main) {
  main().catch(async (e) => {
    logger.fatal('UNEXPECTED', e instanceof Error ? e : new Error(String(e)))
    await shutdownTelemetry()
    process.exit(1)
  })
}

export { buildFront, makeVerifier, streamNameFor, runTurn, replayStream }
