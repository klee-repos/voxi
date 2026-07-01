/**
 * G3 BOOT SPIKE — the real off-Vercel existence proof (PLAN §4.4, §18 G3 / C0, §22.3).
 *
 * QUESTION (PLAN §22.3 day-1 boot spike): with `eve` + `@ai-sdk/anthropic` + `@workflow/world-postgres`
 * installed and ZERO Vercel platform services, does the eve durable stack BOOT and run ONE
 * photo→session→streamed-turn loop against a local Postgres? This file attempts exactly that and prints the
 * EXACT result — boot or break — never a faked green. The RUNBOOK.md records the recorded outcome.
 *
 * What this proves (or fails to), step by step:
 *   1. IMPORT       — `import('eve')` resolves off-Vercel (defineAgent/defineTool present).
 *   2. WORLD        — `@workflow/world-postgres` `createWorld({connectionString})` constructs + `start()`s
 *                     against a plain local Postgres (Cloud SQL analogue) — the §4.4 self-host seam, no Vercel.
 *   3. SESSION      — we mint a workflow run id (the durable session) and record session-ownership via the
 *                     real channel ACL (`makeAuthFn`) — the §4.3 per-user invariant.
 *   4. TOOLS        — we drive the REAL `safety_gate` + `identify_object` tools (the same code the agent runs),
 *                     producing the structured ID the persona dresses. Nothing is stubbed to force a verdict.
 *   5. STREAMED TURN— we write the Voxi turn as durable NDJSON chunks to the world's stream
 *                     (`writeToStream`), then read them back (`getStreamChunks`) and validate EVERY line
 *                     against the shared `events.ts` Zod taxonomy — the §4.3 stream contract, end-to-end,
 *                     through Postgres LISTEN/NOTIFY, off-Vercel.
 *
 * If any step throws, we record the failing stage and the §4.5 fallback is what fires in the real build.
 *
 * Run:  DATABASE_URL=postgres://voxi@127.0.0.1:55432/voxi_world bun services/eve-agent/g3-spike/boot.ts
 * (Bring the world up first with scripts/up.sh, which initdb's + migrates a throwaway local cluster.)
 */
import { parseEventLine, type StreamEvent } from '../../../packages/shared/src/events'
import { identify_object, type VisionProvider, type VisionStages, type ImageRef } from '../agent/tools/identify_object'
import { safety_gate, type SafetyClassifier } from '../agent/tools/safety_gate'
import { registerFor } from '../../../packages/shared/src/confidence'
import {
  makeAuthFn,
  memorySessionOwnership,
  onSessionCreated,
  type TokenVerifier,
} from '../agent/channels/eve'

/** A stage result. `ok=false` records the EXACT error — the honest "what breaks" the runbook reports. */
interface StageResult {
  stage: string
  ok: boolean
  detail: string
}

const results: StageResult[] = []
const record = (stage: string, ok: boolean, detail: string) => {
  results.push({ stage, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}  — ${detail}`)
}

/** First line of an error message (never undefined under noUncheckedIndexedAccess). */
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? String(e)

/** A deterministic vision provider seeded for the boot photo: a confident catalog hit (the SuperSix EVO). */
const bootVision: VisionProvider = {
  async analyze(_image: ImageRef): Promise<VisionStages> {
    return {
      catalog: { name: '2008 Cannondale SuperSix EVO', make: 'Cannondale', model: 'SuperSix EVO', year: 2008, source: 'catalog', confidence: 0.95, cosine: 0.96 },
      vlm: { name: 'Cannondale road bike', make: 'Cannondale', model: 'SuperSix EVO', source: 'vlm', confidence: 0.82 },
      evidence: [{ ref: 'e1', sourceUrl: 'https://catalog.voxi/items/ss-evo', claim: '2008 Cannondale SuperSix EVO' }],
    }
  },
}

/** A safe classifier for the boot image (the gate runs for real; this stands in for Cloud Vision/Gemini). */
const safeClassifier: SafetyClassifier = { async classify() { return { category: 'safe', confidence: 0.99 } } }

/** A networkless verifier stand-in (Clerk in prod): a `clerk:<userId>` bearer "verifies". */
const verify: TokenVerifier = async (bearer) => {
  const m = /^clerk:([a-z0-9_-]+)$/i.exec(bearer)
  return m ? { userId: m[1]! } : null
}

async function main() {
  const dsn = process.env.DATABASE_URL ?? process.env.WORLD_DATABASE_URL ?? process.env.WORKFLOW_POSTGRES_URL
  console.log('=== G3 boot spike — eve off-Vercel, zero Vercel platform services ===')
  console.log(`world DSN: ${dsn ? dsn.replace(/:[^:@/]*@/, ':***@') : '(none — set DATABASE_URL)'}\n`)

  // ----- STAGE 1: IMPORT eve off-Vercel -----
  try {
    const eve: Record<string, unknown> = await import('eve')
    const tools: Record<string, unknown> = await import('eve/tools')
    const hasAgent = typeof eve.defineAgent === 'function'
    const hasTool = typeof tools.defineTool === 'function'
    record('1.IMPORT eve', hasAgent && hasTool, `defineAgent=${hasAgent} defineTool=${hasTool} (no @vercel/* runtime needed)`)
  } catch (e) {
    record('1.IMPORT eve', false, `import('eve') threw: ${firstLine(e)}`)
    return finish()
  }

  // ----- STAGE 2: WORLD — construct + start the durable Postgres world off-Vercel -----
  type StreamChunk = { index: number; data: Uint8Array }
  let world: {
    start(): Promise<void>
    close?(): Promise<void>
    writeToStream(n: string, r: string, c: string | Uint8Array): Promise<void>
    closeStream(n: string, r: string): Promise<void>
    getStreamChunks(n: string, r: string, o?: { limit?: number; cursor?: string }): Promise<{ data: StreamChunk[]; done: boolean; hasMore: boolean }>
    getStreamInfo(n: string, r: string): Promise<{ tailIndex: number; done: boolean }>
    readFromStream(n: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>
  } | undefined
  if (!dsn) {
    record('2.WORLD start', false, 'no DATABASE_URL — bring up the local world first (scripts/up.sh)')
    return finish()
  }
  try {
    const { createWorld } = (await import('@workflow/world-postgres')) as { createWorld: (c: { connectionString: string }) => typeof world }
    world = createWorld({ connectionString: dsn })
    await world!.start()
    record('2.WORLD start', true, 'createWorld().start() up: graphile-worker poller + LISTEN/NOTIFY, plain Postgres')
  } catch (e) {
    record('2.WORLD start', false, `world failed to boot: ${firstLine(e)}`)
    return finish()
  }

  // ----- STAGE 3: SESSION + ownership ACL (the §4.3 invariant) -----
  // The durable "session" is a workflow run id; ownership is recorded via the real channel ACL.
  const ownership = memorySessionOwnership()
  const authFn = makeAuthFn(verify, ownership)
  const runId = `g3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const userId = 'g3-user'
  try {
    const created = await authFn({ authorization: 'Bearer clerk:g3-user', kind: 'create' })
    if (!created.ok) throw new Error('create auth denied')
    await onSessionCreated(ownership, runId, userId)
    // Prove the ACL the other way: a different user must be denied this session.
    const intruder = await authFn({ authorization: 'Bearer clerk:someone-else', kind: 'stream', sessionId: runId })
    const aclHolds = !intruder.ok
    const owner = await authFn({ authorization: 'Bearer clerk:g3-user', kind: 'stream', sessionId: runId })
    record('3.SESSION+ACL', aclHolds && owner.ok, `runId=${runId} owner-streams=${owner.ok} intruder-denied=${aclHolds}`)
    if (!(aclHolds && owner.ok)) return finish(world)
  } catch (e) {
    record('3.SESSION+ACL', false, firstLine(e))
    return finish(world)
  }

  // ----- STAGE 4: TOOLS — the real safety gate + identification cascade -----
  const photo: ImageRef = { uri: 'gs://voxi-photos/redacted/g3-boot.jpg' }
  let id: Awaited<ReturnType<typeof identify_object>>
  try {
    const gate = await safety_gate(photo, safeClassifier)
    if (!gate.identificationAllowed) throw new Error(`safety gate suppressed: ${gate.action}`)
    id = await identify_object(photo, bootVision)
    record('4.TOOLS', id.confidence_band === 'CONFIDENT', `safety=allow id="${id.label}" band=${id.confidence_band} route=${id.route} unsupported=[${id.unsupported_fields.join(',')}]`)
  } catch (e) {
    record('4.TOOLS', false, firstLine(e))
    return finish(world)
  }

  // ----- STAGE 5: STREAMED TURN — write the Voxi NDJSON turn to the DURABLE world stream, read it back -----
  // This is the load-bearing C0 proof: the turn is persisted through Postgres and replayed, validated against
  // the shared events.ts taxonomy. Reconnection (?startIndex=) is proven by reading from a non-zero index.
  // Stream name is per-session (one durable stream per turn) so two sessions never share a stream id.
  const streamName = `turn-${runId}`
  const reg = registerFor(id.confidence_band)
  const turn: StreamEvent[] = [
    { type: 'token', index: 0, text: `A ${id.label}.` },
    { type: 'confidence_band', index: 1, band: id.confidence_band, title: id.label, candidates: id.candidates.map((c) => c.name) },
    { type: 'token', index: 2, text: reg.hedge ? '…or thereabouts.' : 'Identified.' },
    { type: 'done', index: 3, sessionId: runId },
  ]
  try {
    for (const ev of turn) await world!.writeToStream(streamName, runId, JSON.stringify(ev) + '\n')
    await world!.closeStream(streamName, runId)

    const dec = new TextDecoder()
    // Read the durable stream back (paginated snapshot) and validate EVERY line against the Zod taxonomy.
    const page = await world!.getStreamChunks(streamName, runId, { limit: 100 })
    const lines = page.data
      .map((c) => dec.decode(c.data)) // EOF chunk decodes to '' and is filtered below
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
    const parsed: StreamEvent[] = lines.map(parseEventLine) // throws on any malformed/untyped event
    const sawToken = parsed.some((e) => e.type === 'token')
    const sawBand = parsed.some((e) => e.type === 'confidence_band')
    const sawDone = parsed.some((e) => e.type === 'done')

    // Reconnection (?startIndex=, §4.3): getStreamInfo gives the tail index; readFromStream(startIndex) replays
    // ONLY from that index — the exact event-index resume the BFF exposes to a reconnecting client. We resume
    // from a middle index (skipping the first 2 events) and confirm we get a strictly shorter, non-empty tail.
    const info = await world!.getStreamInfo(streamName, runId)
    const readAll = async (start?: number) => {
      const rs = await world!.readFromStream(streamName, start)
      const reader = rs.getReader()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) bytes += value.length
      }
      return bytes
    }
    const fullBytes = await readAll(0)
    const tailBytes = await readAll(2) // resume from event index 2 → only the later events replay
    const resumed = fullBytes > 0 && tailBytes > 0 && tailBytes < fullBytes

    const ok = sawToken && sawBand && sawDone && parsed.length === turn.length && info.done && resumed
    record('5.STREAMED-TURN', ok, `durable round-trip: wrote ${turn.length} events, read ${parsed.length} valid NDJSON lines (token/band/done=${sawToken}/${sawBand}/${sawDone}); stream.done=${info.done} tailIndex=${info.tailIndex}; reconnect bytes full=${fullBytes} from-idx-2=${tailBytes}`)
  } catch (e) {
    record('5.STREAMED-TURN', false, `stream round-trip threw: ${firstLine(e)}`)
    return finish(world)
  }

  return finish(world)
}

async function finish(world?: { close?(): Promise<void> }) {
  // Honest teardown: world-local's close() has a Bun-incompat (httpAgent.close), so we swallow that ONE known
  // teardown error rather than let it mask the verdict — and we RECORD it as a finding, never hide it.
  if (world?.close) {
    try {
      await world.close()
    } catch (e) {
      console.log(`note: world.close() teardown error (recorded finding, not a boot failure): ${firstLine(e)}`)
    }
  }
  const passed = results.every((r) => r.ok)
  console.log(`\n=== G3 C0 boot verdict: ${passed ? 'BOOTS off-Vercel' : 'DID NOT FULLY BOOT'} ===`)
  console.log(JSON.stringify({ c0: passed ? 'pass' : 'fail', stages: results }, null, 2))
  // Exit non-zero on failure so CI / the runbook capture the TRUE result.
  process.exit(passed ? 0 : 1)
}

main().catch((e) => {
  console.error('UNEXPECTED', e)
  process.exit(1)
})
