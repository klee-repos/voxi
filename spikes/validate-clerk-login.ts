/**
 * VALIDATE the login fix (sign-up-first) against the LIVE Clerk instance, mirroring the app's exact
 * `signInWithEmail`/`verifyCode` logic. Proves BOTH branches complete → session, which the naive sign-in-first
 * flow could not under enumeration protection:
 *   Round 1 — a NEW email  → sign-up branch → session
 *   Round 2 — SAME email   → `form_identifier_exists` → sign-in branch → session
 * Uses a `+clerk_test` email (Clerk dev accepts code 424242). Run: `bun spikes/validate-clerk-login.ts`.
 */
const PK = 'pk_test_cmVzb2x2ZWQtZG92ZS05NS5jbGVyay5hY2NvdW50cy5kZXYk'
const FAPI = 'https://' + atob(PK.replace('pk_test_', '')).replace(/\$$/, '')
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const CODE = '424242'

async function newClient() {
  const H = { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://voxi.app' }
  const db = await fetch(`${FAPI}/v1/dev_browser?_clerk_js_version=5`, { method: 'POST', headers: H }).then((r) => r.json())
  const jwt = db?.token
  const q = `?__clerk_db_jwt=${jwt}&_clerk_js_version=5`
  const Hc = { ...H, cookie: `__clerk_db_jwt=${jwt}` }
  await fetch(`${FAPI}/v1/client${q}`, { headers: Hc }).catch(() => {})
  const post = (path: string, body: Record<string, string>) => fetch(`${FAPI}${path}${q}`, { method: 'POST', headers: Hc, body: form(body) }).then((r) => r.json())
  return { post }
}

/** Mirrors the app: sign-up FIRST; on form_identifier_exists, fall back to email-code sign-in. */
async function appLogin(email: string): Promise<{ branch: string; status?: string; session?: string }> {
  const { post } = await newClient()
  const su = await post('/v1/client/sign_ups', { email_address: email })
  if (su?.errors?.[0]?.code === 'form_identifier_exists') {
    const si = await post('/v1/client/sign_ins', { identifier: email })
    const sid = si?.response?.id
    const factor = (si?.response?.supported_first_factors ?? []).find((f: { strategy: string }) => f.strategy === 'email_code')
    await post(`/v1/client/sign_ins/${sid}/prepare_first_factor`, { strategy: 'email_code', email_address_id: factor?.email_address_id })
    const done = await post(`/v1/client/sign_ins/${sid}/attempt_first_factor`, { strategy: 'email_code', code: CODE })
    return { branch: 'sign-in', status: done?.response?.status, session: done?.response?.created_session_id }
  }
  const id = su?.response?.id
  await post(`/v1/client/sign_ups/${id}/prepare_verification`, { strategy: 'email_code' })
  const done = await post(`/v1/client/sign_ups/${id}/attempt_verification`, { strategy: 'email_code', code: CODE })
  return { branch: 'sign-up', status: done?.response?.status, session: done?.response?.created_session_id }
}

console.log('\n── VALIDATE login fix (sign-up-first, mirrors the app) ──')
const email = `voxi.flow.${Date.now().toString(36)}+clerk_test@example.com`
console.log('email:', email)

const r1 = await appLogin(email)
console.log(`  Round 1 (new email)   → branch=${r1.branch} status=${r1.status} session=${r1.session ? '✓' : '✗'}`)
const r2 = await appLogin(email)
console.log(`  Round 2 (now exists)  → branch=${r2.branch} status=${r2.status} session=${r2.session ? '✓' : '✗'}`)

const pass = r1.branch === 'sign-up' && r1.status === 'complete' && !!r1.session && r2.branch === 'sign-in' && r2.status === 'complete' && !!r2.session
console.log('\n' + (pass ? '✓ PASS — new email signs UP, returning email signs IN, both → session. Login fix validated.' : '✗ FAIL — see above'))
process.exit(pass ? 0 : 1)
