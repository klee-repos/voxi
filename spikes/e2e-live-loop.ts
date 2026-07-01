/**
 * E2E of the ASSEMBLED running system (no fakes forcing green): a REAL Clerk session token → the REAL BFF
 * routes (createApp with the REAL clerkVerifier + the REAL CascadeEveClient) → a REAL photo (data-URI) → the
 * live cascade (Vertex Gemini + Cloud Vision + narrator) → the events.ts NDJSON the app renders. Asserts a
 * grounded reveal + narration. Run from repo root: `bun spikes/e2e-live-loop.ts`.
 */
import { verifyToken } from '@clerk/backend'
import { createApp } from '../services/voxi-api/src/app'
import { clerkVerifier } from '../services/voxi-api/src/auth'
import { CascadeEveClient } from '../services/voxi-api/src/cascade-eve-client'
import type { Store, Entitlements } from '../services/voxi-api/src/metering'
import type { ThreadStore, ThreadRecord } from '../services/voxi-api/src/app'
import { parseEventLine, type StreamEvent } from '../packages/shared/src/events'

const SECRET = process.env.CLERK_SECRET_KEY
const USER = process.env.VOXI_TEST_USER ?? 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey' // kevin+voxitest
if (!SECRET) { console.error('CLERK_SECRET_KEY missing (run from repo root so .env.local loads)'); process.exit(1) }

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
function memThreads(): ThreadStore {
  const rows = new Map<string, ThreadRecord>()
  return { async put(r) { rows.set(r.threadId, r) }, async listByOwner(u) { return [...rows.values()].filter((r) => r.ownerUserId === u) }, async get(id) { return rows.get(id) ?? null } }
}

async function mintToken(): Promise<string> {
  const h = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
  const s = await fetch('https://api.clerk.com/v1/sessions', { method: 'POST', headers: h, body: JSON.stringify({ user_id: USER }) }).then((r) => r.json())
  const t = await fetch(`https://api.clerk.com/v1/sessions/${s.id}/tokens`, { method: 'POST', headers: h, body: JSON.stringify({ expires_in_seconds: 300 }) }).then((r) => r.json())
  if (!t.jwt) throw new Error('mint token failed: ' + JSON.stringify(s).slice(0, 200))
  return t.jwt
}

console.log('\n── E2E: real token → real BFF → live cascade → reveal ──')
const app = createApp({
  verifier: clerkVerifier(verifyToken as never),
  store: demoStore(), eve: new CascadeEveClient(),
  deletion: { async cascade(u) { return { deleted: [u] } } }, bucket: 'voxi-photos',
  sessionOwner: new Map(), threads: memThreads(), planFor: async () => 'voyager',
})

// a REAL photo → data-URI (the exact shape the phone sends). Cached local fixture so the test is deterministic
// and not at the mercy of Wikimedia rate-limits; self-heals via Special:FilePath (works where hotlinking 400s).
async function fixtureDataUri(): Promise<string> {
  const path = new URL('./.fixtures/canon-ae1.jpg', import.meta.url).pathname
  let bytes: Uint8Array
  if (await Bun.file(path).exists()) {
    bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  } else {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) voxi-e2e/1.0 dev@voxi.test'
    const r = await fetch('https://commons.wikimedia.org/wiki/Special:FilePath/Canon_AE-1_with_50mm_f1.8_S.C._II.jpg?width=1024', { headers: { 'user-agent': ua } })
    bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`fixture download not a JPEG (http ${r.status}, ${bytes.length}B)`)
    await Bun.write(path, bytes)
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('cached fixture is not a JPEG')
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`
}
const dataUri = await fixtureDataUri()
console.log('photo:', ((dataUri.length * 0.75) / 1024).toFixed(0), 'KB → data-URI')

const token = await mintToken()
console.log('minted a real Clerk session token:', token.length, 'bytes')

// 401 without a token (auth actually enforced)
const noauth = await app.request('/v1/threads', { method: 'POST', body: JSON.stringify({ photoUrl: dataUri }) })
const authEnforced = noauth.status === 401

// POST /v1/threads (charges a scan, mints the eve session) + stream
const created = await app.request('/v1/threads', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ photoUrl: dataUri }) })
if (created.status !== 200) { console.error('FAIL POST /v1/threads →', created.status, await created.text()); process.exit(1) }
const { threadId } = (await created.json()) as { threadId: string }
const streamRes = await app.request(`/v1/threads/${threadId}/stream`, { headers: { authorization: `Bearer ${token}` } })
const events: StreamEvent[] = (await streamRes.text()).split('\n').filter((l) => l.trim()).map(parseEventLine)

for (const e of events) console.log('  ', JSON.stringify(e).slice(0, 140))
const band = events.find((e) => e.type === 'confidence_band') as Extract<StreamEvent, { type: 'confidence_band' }> | undefined
const toks = events.filter((e) => e.type === 'token') as Extract<StreamEvent, { type: 'token' }>[]
const done = events.some((e) => e.type === 'done')
const label = (band?.title ?? '').toLowerCase()
const grounded = label.includes('canon') && label.includes('ae')

const pass = authEnforced && !!band && grounded && toks.length > 0 && done
console.log('\n' + (pass ? '✓ PASS' : '✗ FAIL') + ' — assembled loop:')
console.log(`   auth enforced(401):${authEnforced} · reveal:"${band?.title}" (${band?.band}) grounded:${grounded} · narration tokens:${toks.length} · done:${done}`)
process.exit(pass ? 0 : 1)
