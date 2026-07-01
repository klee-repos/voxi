/**
 * END-TO-END LIVE proof of the app path (PLAN §3, §4.3, §5): a real photo goes through the REAL BFF Hono routes
 * (`POST /v1/threads` → charge a scan → create session; `GET /v1/threads/:id/stream` → NDJSON) backed by a REAL
 * `EveClient` that runs the REAL identification cascade (LiveSafetyClassifier + LiveVisionProvider → live Cloud
 * Vision + Vertex Gemini → shared arbiter → the events.ts contract). Nothing is faked except auth+quota
 * plumbing (Clerk/metering are covered by their own deterministic tests). Run: `bun spikes/live-bff-scan.ts <img-url>`.
 *
 * This is the honest live analogue of app.test.ts's fake-eve integration test: same routes, same contract, but
 * the reveal is produced by real GCP calls end-to-end. It does NOT stand in for the full durable eve workflow
 * (storyteller narration / voice are creds+framework-gated); it proves the IDENTIFICATION half of the path live.
 */
import { createApp, type EveClient, type Deps } from '../services/voxi-api/src/app'
import { testVerifier } from '../services/voxi-api/src/auth'
import { memoryStore } from '../services/voxi-api/src/metering'
import { runIdentificationCascade } from '../services/eve-agent/agent/cascade'
import { LiveVisionProvider } from '../services/eve-agent/agent/providers/live-vision'
import { LiveSafetyClassifier } from '../services/eve-agent/agent/providers/live-safety'
import { LiveNarrator } from '../services/eve-agent/agent/providers/live-narrator'
import { loadImageBytes } from '../services/eve-agent/agent/lib/gcp-vision'
import { parseEventLine, type StreamEvent } from '../packages/shared/src/events'

process.env.VOXI_TEST_MODE = '1'

/** The production-shaped EveClient: it runs the real cascade for the photo captured at session-create time. */
class CascadeEveClient implements EveClient {
  private photos = new Map<string, string>()
  private vision = new LiveVisionProvider()
  private safety = new LiveSafetyClassifier()
  private narrator = new LiveNarrator()
  private n = 0

  async createSession({ userId, photoUrl }: { userId: string; photoUrl: string }) {
    const sessionId = `sess_${userId}_${this.n++}`
    this.photos.set(sessionId, photoUrl)
    return { sessionId, continuationToken: `ct_${sessionId}` }
  }

  async *stream(sessionId: string): AsyncIterable<string> {
    const photoUrl = this.photos.get(sessionId)
    if (!photoUrl) throw new Error(`no photo for session ${sessionId}`)
    // preload fetches the image ONCE; both stages reuse the bytes, and a dead URL → hard_failure (not a refusal).
    const stream = runIdentificationCascade(sessionId, { uri: photoUrl }, { vision: this.vision, safety: this.safety, narrator: this.narrator, preload: loadImageBytes })
    for await (const ev of stream) yield JSON.stringify(ev)
  }
}

/** Resolve a valid default image via the Wikipedia summary API (guarantees a live URL when none is passed). */
async function defaultImage(): Promise<string> {
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Canon_AE-1', { headers: { 'user-agent': 'voxi-spike/1.0' } })
  const j = (await r.json()) as { originalimage?: { source: string } }
  return j.originalimage?.source ?? 'https://en.wikipedia.org/static/images/icons/wikipedia.png'
}

const imgUrl = process.argv[2] ?? (await defaultImage())

const deps: Deps = {
  verifier: testVerifier,
  store: memoryStore({ u1: { scan: 5, podcast: 1, voiceMin: 10 } }),
  eve: new CascadeEveClient(),
  deletion: { async cascade(userId) { return { deleted: [`photos:${userId}`] } } },
  bucket: 'voxi-photos',
  sessionOwner: new Map(),
}
const app = createApp(deps)
const auth = { authorization: 'Bearer test:u1' }

console.log('\n── LIVE BFF scan → reveal (real routes + real cascade + real GCP) ──')
console.log('photo:', imgUrl)

// 1) Create the thread (charges a scan, mints the eve session).
const createRes = await app.request('/v1/threads', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ photoUrl: imgUrl, title: 'live scan' }),
})
if (createRes.status !== 200) {
  console.error('FAIL — POST /v1/threads →', createRes.status, await createRes.text())
  process.exit(1)
}
const { threadId } = (await createRes.json()) as { threadId: string }
console.log('threadId:', threadId, '· scan charged (remaining:', await deps.store.remaining('u1', 'scan'), ')')

// 2) Stream the NDJSON — parse each line through the REAL client-side contract parser (no untyped events allowed).
const streamRes = await app.request(`/v1/threads/${threadId}/stream`, { headers: auth })
if (streamRes.status !== 200) {
  console.error('FAIL — stream →', streamRes.status, await streamRes.text())
  process.exit(1)
}
const raw = await streamRes.text()
const events: StreamEvent[] = raw
  .split('\n')
  .filter((l) => l.trim())
  .map(parseEventLine) // throws if the BFF ever emits an off-contract line

console.log('\nstream events:')
for (const e of events) console.log('  ', JSON.stringify(e))

// 3) Assert the shape the app renders: a terminal `done`, and either a reveal band or an honest refusal.
const band = events.find((e) => e.type === 'confidence_band') as Extract<StreamEvent, { type: 'confidence_band' }> | undefined
const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }> | undefined
const done = events.find((e) => e.type === 'done')

const narration = (events.filter((e) => e.type === 'token') as Extract<StreamEvent, { type: 'token' }>[]).map((t) => t.text)
const ok = !!done && (!!band || !!err) && events.map((e) => e.index).every((idx, i) => idx === i)
console.log('\n' + (ok ? '✓ PASS' : '✗ FAIL') + ' — live app path (identify + narrate):')
if (band) console.log(`   reveal → band=${band.band} title="${band.title}"${band.candidates.length ? ` candidates=[${band.candidates.join(' | ')}]` : ''}`)
if (narration.length) console.log(`   narration (honesty-gated) → ${narration.map((n) => `“${n}”`).join(' ')}`)
if (err) console.log(`   refusal → code=${err.code} "${err.message}"`)
console.log(`   terminal done=${!!done} · monotonic indices=${events.map((e) => e.index).every((idx, i) => idx === i)}`)
process.exit(ok ? 0 : 1)
