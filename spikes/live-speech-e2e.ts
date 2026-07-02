/**
 * END-TO-END LIVE spoken reveal, exactly as the app hits it:
 *   real photo → POST /v1/threads → GET /stream → POST /v1/threads/:id/speech → REAL ElevenLabs audio →
 *   the same base64→data:URL the client builds.
 * Unlike the fake-MP3 converge test, this proves audible audio comes back and the client's data-URL encoding
 * round-trips. Needs ELEVENLABS_API_KEY + gcloud. Run: `bun spikes/live-speech-e2e.ts [img-url]`.
 */
import { createApp, type Deps } from '../services/voxi-api/src/app'
import { testVerifier } from '../services/voxi-api/src/auth'
import { memoryStore } from '../services/voxi-api/src/metering'
import { CascadeEveClient } from '../services/voxi-api/src/cascade-eve-client'
import { LiveNarrationTts } from '../services/voxi-api/src/live-tts'

process.env.VOXI_TEST_MODE = '1'

const key = process.env.ELEVENLABS_API_KEY
if (!key) { console.error('ELEVENLABS_API_KEY missing'); process.exit(1) }

// The SAME portable base64 the client uses (app/src/lib/apiClient.ts bytesToBase64) — verified here to round-trip.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2]
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : B64[b2 & 63]
  }
  return out
}

async function defaultImage(): Promise<string> {
  const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/Canon_AE-1', { headers: { 'user-agent': 'voxi-spike/1.0' } })
  const j = (await r.json()) as { originalimage?: { source: string } }
  return j.originalimage?.source ?? 'https://en.wikipedia.org/static/images/icons/wikipedia.png'
}
const imgUrl = process.argv[2] ?? (await defaultImage())

const audioCache = new Map<string, Uint8Array<ArrayBuffer>>()
const deps: Deps = {
  verifier: testVerifier,
  store: memoryStore({ u1: { scan: 5, podcast: 1, voiceMin: 10 } }),
  eve: new CascadeEveClient(),
  deletion: { async cascade(u) { return { deleted: [`photos:${u}`] } } },
  bucket: 'voxi-photos',
  sessionOwner: new Map(),
  speech: {
    tts: new LiveNarrationTts(key),
    cache: { async get(k) { return audioCache.get(k) ?? null }, async put(k, b) { audioCache.set(k, b) } },
  },
}
const app = createApp(deps)
const auth = { authorization: 'Bearer test:u1' }

console.log('\n── LIVE spoken reveal E2E (real /speech route + real ElevenLabs) ──')
console.log('photo:', imgUrl)

// 1) create thread
const cr = await app.request('/v1/threads', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: imgUrl }) })
if (cr.status !== 200) { console.error('FAIL POST /v1/threads', cr.status, await cr.text()); process.exit(1) }
const { threadId } = (await cr.json()) as { threadId: string }
deps.sessionOwner.set(threadId, 'u1') // the route ACLs on this map (createApp populates it in POST /v1/threads too)

// 2) stream → captures the server-owned narration
const sr = await app.request(`/v1/threads/${threadId}/stream`, { headers: auth })
const rawLines = (await sr.text()).split('\n').filter((l) => l.trim())
const tokens = rawLines.map((l) => JSON.parse(l)).filter((e) => e.type === 'token').map((e) => e.text as string)
console.log(`\nnarration (${tokens.length} clause(s)): ${tokens.map((t) => `“${t}”`).join(' ') || '(none — nothing to speak!)'}`)

// 3) POST /speech → real audio
const sp = await app.request(`/v1/threads/${threadId}/speech`, { method: 'POST', headers: auth })
console.log('\nPOST /v1/threads/:id/speech →', sp.status, sp.headers.get('content-type'))
if (sp.status !== 200) { console.error('FAIL — /speech did not return audio:', await sp.text()); process.exit(1) }
const bytes = new Uint8Array(await sp.arrayBuffer())
const validMp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
console.log(`audio: ${bytes.length} bytes · valid MP3 header: ${validMp3}`)

// 4) client encoding round-trip: bytesToBase64 must equal the canonical base64 (else the data: URL is corrupt).
const mine = bytesToBase64(bytes)
const canonical = Buffer.from(bytes).toString('base64')
const encOk = mine === canonical
console.log(`client base64 round-trips: ${encOk ? '✓' : '✗ CORRUPT — data URL would be unplayable'}`)
await Bun.write(process.env.TTS_OUT ?? '/tmp/voxi-reveal-e2e.mp3', bytes)

const audible = validMp3 && bytes.length > 5000 // a real spoken clause is tens of KB; a silent stub is tiny
console.log(`\n${audible && encOk && tokens.length ? '✓ PASS' : '✗ FAIL'} — audible audio from the real route, encoding intact, narration present`)
process.exit(audible && encOk && tokens.length ? 0 : 1)
