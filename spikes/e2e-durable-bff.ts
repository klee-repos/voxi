/**
 * E2E: the BFF's collection + entitlements are DURABLE through the real app layer. Real Clerk token → POST
 * /v1/threads (persists to PGlite) → restart (close + reopen the same dataDir, rebuild the app) → GET /v1/threads
 * still lists it → DELETE /v1/account purges the durable rows. No fakes forcing green; a trivial eve is used only
 * so this doesn't import the cascade (which another agent is editing). Run from repo root.
 */
import { verifyToken } from '@clerk/backend'
import { createApp, type EveClient } from '../services/voxi-api/src/app'
import { clerkVerifier } from '../services/voxi-api/src/auth'
import { buildLocalCollaborators } from '../services/voxi-api/src/local-collaborators'
import { createPgStores } from '../services/voxi-api/src/pg-stores'
import { rmSync } from 'node:fs'

const SECRET = process.env.CLERK_SECRET_KEY
const USER = process.env.VOXI_TEST_USER ?? 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey'
if (!SECRET) { console.error('CLERK_SECRET_KEY missing'); process.exit(1) }
async function mintToken(): Promise<string> {
  const h = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
  const s = await fetch('https://api.clerk.com/v1/sessions', { method: 'POST', headers: h, body: JSON.stringify({ user_id: USER }) }).then((r) => r.json())
  const t = await fetch(`https://api.clerk.com/v1/sessions/${s.id}/tokens`, { method: 'POST', headers: h, body: JSON.stringify({ expires_in_seconds: 300 }) }).then((r) => r.json())
  if (!t.jwt) throw new Error('mint failed'); return t.jwt
}

// Trivial eve: createSession mints a deterministic id; stream unused here (this test is about persistence).
let seq = 0
const fakeEve: EveClient = {
  async createSession({ userId }) { const sessionId = `sess_${userId}_dur_${seq++}`; return { sessionId, continuationToken: `ct_${sessionId}` } },
  async *stream() { yield JSON.stringify({ type: 'done', index: 0, sessionId: 'x' }) },
}

const DIR = '/tmp/voxi-durable-bff-e2e'
rmSync(DIR, { recursive: true, force: true })
const token = await mintToken()
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const checks: [string, boolean][] = []

console.log('\n── E2E: durable BFF collection across a restart ──')

// Phase 1: open durable stores, create a thread via the real route.
let durable = await createPgStores(DIR)
let app = createApp({ verifier: clerkVerifier(verifyToken as never), store: durable.store, eve: fakeEve, deletion: buildLocalCollaborators({ durable }).deletion, bucket: 'b', sessionOwner: new Map(), threads: durable.threads, planFor: async () => 'voyager' })
const created = await app.request('/v1/threads', { method: 'POST', headers: H, body: JSON.stringify({ photoUrl: 'data:image/jpeg;base64,/9j/x', title: 'A brass sextant' }) })
const { threadId } = (await created.json()) as { threadId: string }
const before = await (await app.request('/v1/threads', { headers: H })).json() as { threads: { threadId: string }[] }
console.log('phase1: created', threadId, '· list has', before.threads.length)
checks.push(['created thread', created.status === 200 && !!threadId])
checks.push(['listed before restart', before.threads.some((t) => t.threadId === threadId)])
await durable.close()

// Phase 2: RESTART — reopen the same dataDir, rebuild the app. The thread must survive.
durable = await createPgStores(DIR)
app = createApp({ verifier: clerkVerifier(verifyToken as never), store: durable.store, eve: fakeEve, deletion: buildLocalCollaborators({ durable }).deletion, bucket: 'b', sessionOwner: new Map(), threads: durable.threads, planFor: async () => 'voyager' })
const after = await (await app.request('/v1/threads', { headers: H })).json() as { threads: { threadId: string; title: string }[] }
console.log('phase2 (after restart): list has', after.threads.length)
checks.push(['thread SURVIVED restart', after.threads.some((t) => t.threadId === threadId)])
checks.push(['title intact', after.threads.find((t) => t.threadId === threadId)?.title === 'A brass sextant'])

// Phase 3: deletion cascade purges the durable rows.
const del = await (await app.request('/v1/account', { method: 'DELETE', headers: H })).json() as { deleted: string[] }
console.log('phase3 delete:', JSON.stringify(del.deleted))
checks.push(['cascade purged durable threads', del.deleted.some((d) => d.startsWith('threads:'))])
const post = await (await app.request('/v1/threads', { headers: H })).json() as { threads: unknown[] }
checks.push(['collection empty after delete', post.threads.length === 0])
await durable.close()

console.log('')
let ok = true
for (const [n, p] of checks) { console.log(`  ${p ? '✓' : '✗'} ${n}`); if (!p) ok = false }
console.log('\n' + (ok ? '✓ PASS — durable BFF persistence + deletion verified' : '✗ FAIL'))
process.exit(ok ? 0 : 1)
