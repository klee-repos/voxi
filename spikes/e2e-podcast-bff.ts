/**
 * E2E of the BFF↔worker podcast path (no fakes): real Clerk token → BFF POST /v1/podcast (gates a credit +
 * enqueues to the running worker) → BFF GET /v1/podcast/:token (proxies the worker's honest status) → a REAL
 * MP3 the worker rendered (live Gemini research+script → honesty gates → ElevenLabs → ffmpeg). Requires the
 * podcast worker running on :8788. Run from repo root: `bun spikes/e2e-podcast-bff.ts`.
 */
import { verifyToken } from '@clerk/backend'
import { createApp } from '../services/voxi-api/src/app'
import { clerkVerifier } from '../services/voxi-api/src/auth'
import { CascadeEveClient } from '../services/voxi-api/src/cascade-eve-client'
import { createPodcastBridge } from '../services/voxi-api/src/podcast-client'
import type { Store, Entitlements } from '../services/voxi-api/src/metering'

const SECRET = process.env.CLERK_SECRET_KEY
const USER = process.env.VOXI_TEST_USER ?? 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey'
if (!SECRET) { console.error('CLERK_SECRET_KEY missing'); process.exit(1) }

function demoStore(): Store {
  const ent = new Map<string, Entitlements>()
  const of = (u: string) => { let e = ent.get(u); if (!e) { e = { scan: 1000, podcast: 100, voiceMin: 1000 }; ent.set(u, e) } return e }
  const tokens = new Map<string, string>()
  return {
    async tryDecrement(u, m, n) { const e = of(u); if (e[m] < n) return false; e[m] -= n; return true },
    async getToken(k) { return tokens.get(k) ?? null }, async putToken(k, t) { tokens.set(k, t) },
    async remaining(u, m) { return of(u)[m] }, async credit(u, m, n) { of(u)[m] += n },
  }
}
async function mintToken(): Promise<string> {
  const h = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
  const s = await fetch('https://api.clerk.com/v1/sessions', { method: 'POST', headers: h, body: JSON.stringify({ user_id: USER }) }).then((r) => r.json())
  const t = await fetch(`https://api.clerk.com/v1/sessions/${s.id}/tokens`, { method: 'POST', headers: h, body: JSON.stringify({ expires_in_seconds: 600 }) }).then((r) => r.json())
  if (!t.jwt) throw new Error('mint failed')
  return t.jwt
}

const podcast = createPodcastBridge({ workerUrl: process.env.PODCAST_WORKER_URL ?? 'http://127.0.0.1:8788', secret: process.env.PODCAST_WORKER_SECRET ?? 'dev-podcast-secret' })
const app = createApp({
  verifier: clerkVerifier(verifyToken as never), store: demoStore(), eve: new CascadeEveClient(),
  deletion: { async cascade(u) { return { deleted: [u] } } }, bucket: 'voxi-photos', sessionOwner: new Map(),
  podcastStatus: podcast.status, podcastEnqueue: podcast.enqueue, planFor: async () => 'voyager',
})

console.log('\n── E2E: BFF /v1/podcast → worker render → status → real MP3 ──')
const token = await mintToken()
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
// fresh subject so it exercises a REAL render (not the cached canon item)
const subject = 'Fender Stratocaster'
const catalogItemId = `strat-e2e-${Date.now().toString(36)}`
const gated = await app.request('/v1/podcast', { method: 'POST', headers: auth, body: JSON.stringify({ catalogItemId, version: 1, subject }) })
const gateJson = (await gated.json()) as { token?: string; error?: string }
console.log('gate:', gated.status, JSON.stringify(gateJson))
if (gated.status !== 200 || !gateJson.token) { console.error('✗ gate failed'); process.exit(1) }
const gen = gateJson.token

let ready: { state: string; audioUrl?: string } | null = null
for (let i = 0; i < 50; i++) {
  const r = await app.request(`/v1/podcast/${encodeURIComponent(gen)}`, { headers: auth })
  const st = (await r.json()) as { state: string; audioUrl?: string; error?: string }
  if (i % 3 === 0) console.log(`  [${i * 3}s] ${r.status} ${JSON.stringify(st)}`)
  if (st.state === 'ready') { ready = st; break }
  if (st.state === 'failed') { console.error('✗ render failed'); process.exit(1) }
  await new Promise((res) => setTimeout(res, 3000))
}
if (!ready?.audioUrl) { console.error('✗ never became ready'); process.exit(1) }

const local = ready.audioUrl.replace(/http:\/\/[^/]+/, 'http://127.0.0.1:8788')
const audio = new Uint8Array(await fetch(local).then((r) => r.arrayBuffer()))
const isMp3 = audio.length > 40000 && (audio[0] === 0xff || (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33))
console.log(`\naudioUrl: ${ready.audioUrl}`)
console.log(`fetched: ${(audio.length / 1024).toFixed(0)} KB, mp3-magic:${isMp3}`)
console.log(isMp3 ? '✓ PASS — BFF gated → worker rendered a real MP3 → BFF proxied ready+audioUrl' : '✗ FAIL — audio not a real MP3')
process.exit(isMp3 ? 0 : 1)
