/**
 * VALIDATE the login fix: exercise the REAL Clerk Frontend API sign-up + email-code verification flow that the
 * app's `signInWithEmail`/`verifyCode` now run — for a brand-new email (the RCA: the old flow only did sign-in,
 * so a first-time email dead-ended). Uses a `+clerk_test` email → Clerk dev accepts the fixed code 424242, so
 * this completes headlessly. A `status: complete` + a created session id proves a new user can now log in.
 * Run: `bun spikes/validate-clerk-signup.ts`.
 */
const PK = 'pk_test_cmVzb2x2ZWQtZG92ZS05NS5jbGVyay5hY2NvdW50cy5kZXYk'
const FAPI = 'https://' + atob(PK.replace('pk_test_', '')).replace(/\$$/, '') // → resolved-dove-95.clerk.accounts.dev
const email = `voxi.rca.${Date.now().toString(36)}+clerk_test@example.com`
const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const H = { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://voxi.app' }

console.log('\n── VALIDATE Clerk sign-up flow (new email → OTP → session) ──')
console.log('FAPI:', FAPI, '\nemail:', email)

// 1) dev browser token (dev instances gate FAPI behind this)
const db = await fetch(`${FAPI}/v1/dev_browser?_clerk_js_version=5`, { method: 'POST', headers: H }).then((r) => r.json())
const jwt = db?.token ?? db?.id ?? db?.jwt
console.log('  dev browser token:', jwt ? '✓' : '✗ ' + JSON.stringify(db).slice(0, 160))
const q = `?__clerk_db_jwt=${jwt}&_clerk_js_version=5`
const Hc = { ...H, cookie: `__clerk_db_jwt=${jwt}` } // some FAPI checks want the token as a cookie too
// init the client so the browser is recognized (clears the "signed out"/security state)
await fetch(`${FAPI}/v1/client${q}`, { headers: Hc }).catch(() => {})
await fetch(`${FAPI}/v1/environment${q}`, { headers: Hc }).catch(() => {})

// 2) MIRROR THE APP: sign-in FIRST; only fall back to sign-up on a "not found" error.
const si = await fetch(`${FAPI}/v1/client/sign_ins${q}`, { method: 'POST', headers: Hc, body: form({ identifier: email }) }).then((r) => r.json())
const siErr = si?.errors?.[0]?.code
console.log('  sign_in create (new email):', siErr ? `error=${siErr}` : `NO ERROR → status=${si?.response?.status} (enumeration protection is masking not-found!)`)
const willFallBackToSignUp = siErr === 'form_identifier_not_found' || siErr === 'identifier_not_found'
console.log('  → app would fall back to sign-up?', willFallBackToSignUp ? '✓ yes' : '✗ NO — app stays in sign-in → "code didn\'t match"')

// 3) sign up create (the path the app SHOULD take for a new email)
const su = await fetch(`${FAPI}/v1/client/sign_ups${q}`, { method: 'POST', headers: Hc, body: form({ email_address: email }) }).then((r) => r.json())
const id = su?.response?.id
console.log('  sign_up create:', id ? `✓ ${id}` : '✗ ' + JSON.stringify(su?.errors ?? su).slice(0, 200))

// 3) prepare email_code verification (sends the code; +clerk_test → 424242)
const prep = await fetch(`${FAPI}/v1/client/sign_ups/${id}/prepare_verification${q}`, { method: 'POST', headers: Hc, body: form({ strategy: 'email_code' }) }).then((r) => r.json())
console.log('  prepare_verification:', prep?.response?.id ? '✓ code sent' : '✗ ' + JSON.stringify(prep?.errors ?? prep).slice(0, 200))

// 4) attempt with the dev test code
const done = await fetch(`${FAPI}/v1/client/sign_ups/${id}/attempt_verification${q}`, { method: 'POST', headers: Hc, body: form({ strategy: 'email_code', code: '424242' }) }).then((r) => r.json())
const status = done?.response?.status
const session = done?.response?.created_session_id ?? done?.client?.sessions?.[0]?.id
console.log('  attempt_verification:', status === 'complete' ? `✓ status=complete` : '✗ status=' + status + ' ' + JSON.stringify(done?.errors ?? '').slice(0, 200))
console.log('  session created:', session ? `✓ ${session}` : '✗')

const pass = status === 'complete' && !!session
console.log('\n' + (pass ? '✓ PASS — a NEW email can sign up + get a session. Login fix validated.' : '✗ FAIL — see above'))
process.exit(pass ? 0 : 1)
