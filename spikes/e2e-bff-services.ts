/**
 * E2E of the newly-wired BFF collaborators (real logic, no green-forcing stubs): the interviewer subagent
 * behind /v1/interview, the trust-gated /v1/tips + first-report /v1/reports, and the REAL deletion cascade.
 * Real Clerk token; in-process app.request so it never touches the running device BFF. Run from repo root.
 */
import { verifyToken } from '@clerk/backend'
import { createApp } from '../services/voxi-api/src/app'
import { clerkVerifier } from '../services/voxi-api/src/auth'
import { CascadeEveClient } from '../services/voxi-api/src/cascade-eve-client'
import { buildLocalCollaborators } from '../services/voxi-api/src/local-collaborators'

const SECRET = process.env.CLERK_SECRET_KEY
const USER = process.env.VOXI_TEST_USER ?? 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey'
if (!SECRET) { console.error('CLERK_SECRET_KEY missing'); process.exit(1) }
async function mintToken(): Promise<string> {
  const h = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }
  const s = await fetch('https://api.clerk.com/v1/sessions', { method: 'POST', headers: h, body: JSON.stringify({ user_id: USER }) }).then((r) => r.json())
  const t = await fetch(`https://api.clerk.com/v1/sessions/${s.id}/tokens`, { method: 'POST', headers: h, body: JSON.stringify({ expires_in_seconds: 300 }) }).then((r) => r.json())
  if (!t.jwt) throw new Error('mint failed'); return t.jwt
}

const eve = new CascadeEveClient()
const local = buildLocalCollaborators({ photoPurge: (u) => eve.purgeUser(u) })
const app = createApp({
  verifier: clerkVerifier(verifyToken as never), store: local.store, eve, deletion: local.deletion,
  bucket: 'voxi-photos', sessionOwner: local.sessionOwner, threads: local.threads,
  interviews: local.interviews, contributions: local.contributions, planFor: async () => 'voyager',
})

const token = await mintToken()
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: H, body: JSON.stringify(b) })
const checks: [string, boolean][] = []

console.log('\n── E2E: BFF collaborators (interviews / tips / reports / deletion) ──')

// seed a couple threads so deletion has something to purge
await post('/v1/threads', { photoUrl: 'data:image/jpeg;base64,/9j/AAAA', title: 'x' }).catch(() => {})

// 1. Interview: real capped bank with the required whyAsked transparency line.
const ivRes = await post('/v1/interview', { threadId: 'thread_sextant' })
const iv = (await ivRes.json()) as { interviewId: string; visibility: string; questions: { id: string; prompt: string; whyAsked: string }[] }
console.log('interview:', ivRes.status, `${iv.questions?.length} questions, visibility=${iv.visibility}`)
checks.push(['interview 200', ivRes.status === 200])
checks.push(['3 capped questions', iv.questions?.length === 3])
checks.push(['every question has whyAsked', iv.questions?.every((q) => !!q.whyAsked)])
checks.push(['defaults private', iv.visibility === 'private'])

// 2. Answer 'what' (→ not done), then 'markings' (→ early-stop done, mints a private entry).
const a1 = await post(`/v1/interview/${iv.interviewId}/answer`, { questionId: 'what', answer: 'a brass sextant' })
const a1j = (await a1.json()) as { done: boolean }
const a2 = await post(`/v1/interview/${iv.interviewId}/answer`, { questionId: 'markings', answer: 'H. Hughes & Son, London' })
const a2j = (await a2.json()) as { done: boolean }
console.log('answers: what→done=', a1j.done, ' markings→done=', a2j.done)
checks.push(['first answer not done', a1j.done === false])
checks.push(['name+marking → early-stop done', a2j.done === true])
checks.push(['finalized private entry kept', [...local.entries.values()].some((e) => e.testimony.what === 'a brass sextant')])

// 3. Tips: a TL0 user's tip goes to human review (real trust gate).
const tipRes = await post('/v1/tips', { catalogItemId: 'cat_1', text: 'The serial dates it to 1943.' })
const tip = (await tipRes.json()) as { tipId: string; status: string; trustLevel: number }
console.log('tip:', tipRes.status, `status=${tip.status} trustLevel=${tip.trustLevel}`)
checks.push(['tip 200', tipRes.status === 200])
checks.push(['TL0 → pending_review', tip.status === 'pending_review' && tip.trustLevel === 0])

// 4. Report: the first report on a target auto-hides it.
const repRes = await post('/v1/reports', { targetId: tip.tipId, kind: 'tip' })
const rep = (await repRes.json()) as { autoHidden: boolean }
console.log('report:', repRes.status, `autoHidden=${rep.autoHidden}`)
checks.push(['first report auto-hides', rep.autoHidden === true])

// 5. Deletion cascade: actually purges the user's rows (entries + tips + threads + entitlements + sessions).
const del = await app.request('/v1/account', { method: 'DELETE', headers: H })
const delj = (await del.json()) as { deleted: string[] }
console.log('delete:', del.status, JSON.stringify(delj.deleted))
checks.push(['delete 200', del.status === 200])
checks.push(['cascade purged real rows', delj.deleted.some((d) => d.startsWith('entries:')) && delj.deleted.some((d) => d.startsWith('tips:'))])
checks.push(['entries actually gone after delete', [...local.entries.values()].every((e) => e.ownerUserId !== USER)])

console.log('')
let ok = true
for (const [name, pass] of checks) { console.log(`  ${pass ? '✓' : '✗'} ${name}`); if (!pass) ok = false }
console.log('\n' + (ok ? '✓ PASS — all BFF collaborators real + wired' : '✗ FAIL'))
process.exit(ok ? 0 : 1)
