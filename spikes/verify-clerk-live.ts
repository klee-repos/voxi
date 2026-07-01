/**
 * LIVE Clerk auth verification: prove our REAL verifiers accept a REAL Clerk-issued session token, networkless.
 *
 *  1. @clerk/backend verifyToken directly (with the CLERK_JWT_KEY PEM) — sanity on the crypto + claims.
 *  2. our channels/eve.ts `clerkVerifier` (the §4.3 networkless AuthFn seam) → Principal.userId.
 *  3. the REAL BFF `createApp` with the REAL auth.ts `clerkVerifier` → GET /v1/me returns the token's user.
 *
 * The JWT is minted server-side via the Clerk Backend API (spikes flow); CLERK_JWT_KEY is the JWKS-derived
 * public key. bun auto-loads .env.local. Run: `bun spikes/verify-clerk-live.ts`.
 */
// @clerk/backend is a declared root dependency; if the monorepo install hasn't materialized it yet, fall back to
// an isolated install (avoids the slow full-workspace resolve during a quick local proof). Prod imports it bare.
let verifyToken: (token: string, opts: { jwtKey?: string }) => Promise<{ sub: string }>
try {
  ;({ verifyToken } = (await import('@clerk/backend')) as never)
} catch {
  ;({ verifyToken } = (await import('/tmp/ckb/node_modules/@clerk/backend/dist/index.mjs')) as never)
}
import { clerkVerifier as eveClerkVerifier } from '../services/eve-agent/agent/channels/eve'
import { clerkVerifier as bffClerkVerifier } from '../services/voxi-api/src/auth'
import { createApp } from '../services/voxi-api/src/app'
import { memoryStore } from '../services/voxi-api/src/metering'

const EXPECTED_USER = 'user_3FspNnJsJRKdZrWzmlGkplPM2Ey'
const jwt = (await Bun.file('/tmp/voxi-jwt.txt').text()).trim()
const jwtKey = process.env.CLERK_JWT_KEY
let pass = true
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) pass = false
}

console.log('\n── LIVE Clerk auth verification (real token, networkless PEM) ──')
console.log('jwt bytes:', jwt.length, '| CLERK_JWT_KEY present:', !!jwtKey)

// 1) @clerk/backend directly.
try {
  const payload = await verifyToken(jwt, { jwtKey })
  check(payload.sub === EXPECTED_USER, `@clerk/backend verifyToken → sub=${payload.sub}`)
} catch (e) {
  check(false, `@clerk/backend verifyToken threw: ${(e as Error).message}`)
}

// 2) our eve channel verifier (the networkless AuthFn seam).
const eveVerify = eveClerkVerifier(verifyToken as never, jwtKey)
const principal = await eveVerify(jwt)
check(principal?.userId === EXPECTED_USER, `channels/eve clerkVerifier → userId=${principal?.userId ?? 'null'}`)
// a garbage token must be rejected (fail-closed)
check((await eveVerify('not.a.jwt')) === null, 'a malformed token is rejected (null)')

// 3) the REAL BFF, with the REAL Clerk verifier, end-to-end over HTTP.
const app = createApp({
  verifier: bffClerkVerifier(verifyToken as never),
  store: memoryStore({ [EXPECTED_USER]: { scan: 3, podcast: 1, voiceMin: 10 } }),
  eve: { async createSession() { return { sessionId: 's', continuationToken: 'c' } }, async *stream() {} },
  deletion: { async cascade(u) { return { deleted: [u] } } },
  bucket: 'voxi-photos',
  sessionOwner: new Map(),
})
const meRes = await app.request('/v1/me', { headers: { authorization: `Bearer ${jwt}` } })
const me = meRes.status === 200 ? await meRes.json() : null
check(meRes.status === 200 && me?.userId === EXPECTED_USER, `BFF GET /v1/me with real token → ${meRes.status}, userId=${me?.userId ?? 'n/a'}`)
// no token → 401
check((await app.request('/v1/me')).status === 401, 'BFF rejects a missing token (401)')

console.log('\n' + (pass ? '✓ PASS — live Clerk auth works end-to-end (networkless).' : '✗ FAIL'))
process.exit(pass ? 0 : 1)
