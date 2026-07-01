/**
 * E2E against the ACTUAL RUNNING server over HTTP (not in-process) — the exact path the phone takes: real Clerk
 * token → POST http://<bff>/v1/threads with the captured photo as a data-URI → GET .../stream → a grounded
 * reveal. Proves the assembled live server (catalog moat + durable persistence + cascade) truly serves a
 * CONFIDENT identification. Also opens a voice session (voiceMin gate + connect URL). Run from repo root.
 */
const BFF = process.env.BFF_URL ?? 'http://127.0.0.1:8787'
const SECRET = process.env.CLERK_SECRET_KEY
const USER = process.env.VOXI_TEST_USER ?? 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey'
if (!SECRET) { console.error('CLERK_SECRET_KEY missing'); process.exit(1) }

async function mintToken(): Promise<string> {
  const h = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
  const s = await fetch('https://api.clerk.com/v1/sessions', { method: 'POST', headers: h, body: JSON.stringify({ user_id: USER }) }).then((r) => r.json())
  const t = await fetch(`https://api.clerk.com/v1/sessions/${s.id}/tokens`, { method: 'POST', headers: h, body: JSON.stringify({ expires_in_seconds: 600 }) }).then((r) => r.json())
  if (!t.jwt) throw new Error('mint failed'); return t.jwt
}

const path = new URL('./.fixtures/canon-ae1.jpg', import.meta.url).pathname
const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
const dataUri = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`
const token = await mintToken()
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

console.log(`\n── E2E over HTTP against ${BFF} (the live assembled server) ──`)
const created = await fetch(`${BFF}/v1/threads`, { method: 'POST', headers: H, body: JSON.stringify({ photoUrl: dataUri, title: 'Live HTTP scan' }) })
if (created.status !== 200) { console.error('POST /v1/threads →', created.status, await created.text()); process.exit(1) }
const { threadId } = (await created.json()) as { threadId: string }
console.log('created thread:', threadId)

const streamRes = await fetch(`${BFF}/v1/threads/${threadId}/stream`, { headers: H })
const lines = (await streamRes.text()).split('\n').filter((l) => l.trim())
const events = lines.map((l) => JSON.parse(l) as { type: string; band?: string; title?: string; text?: string })
const band = events.find((e) => e.type === 'confidence_band')
const toks = events.filter((e) => e.type === 'token')
const label = (band?.title ?? '').toLowerCase()
const grounded = label.includes('canon') && label.includes('ae')
console.log(`reveal: "${band?.title}" (${band?.band}) · narration tokens: ${toks.length}`)

// Persistence: the thread must now appear in the owner-scoped collection (durable).
const list = (await (await fetch(`${BFF}/v1/threads`, { headers: H })).json()) as { threads: { threadId: string }[] }
const listed = list.threads.some((t) => t.threadId === threadId)

// Voice: open a session — charges voiceMin + returns a connect URL pointing at the media server.
const vs = await fetch(`${BFF}/v1/voice/session`, { method: 'POST', headers: H, body: JSON.stringify({ threadId }) })
const vsj = (await vs.json()) as { connectUrl?: string; url?: string; error?: string }
const voiceOk = vs.status === 200 && !!(vsj.connectUrl || vsj.url)
console.log(`voice session: ${vs.status} ${voiceOk ? '(connect URL minted)' : JSON.stringify(vsj)}`)

const pass = !!band && band.band === 'CONFIDENT' && grounded && toks.length > 0 && listed && voiceOk
console.log('\n' + (pass ? '✓ PASS' : '✗ FAIL') + ' — live server:')
console.log(`   reveal grounded+CONFIDENT:${grounded && band?.band === 'CONFIDENT'} · thread persisted+listed:${listed} · voice session:${voiceOk}`)
process.exit(pass ? 0 : 1)
