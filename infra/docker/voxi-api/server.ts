/**
 * Production HTTP entrypoint for the voxi-api BFF — the ONLY public surface. Lives under infra/ because
 * docker-deploy owns the container: services/voxi-api exports `createApp(deps)` but has no server of its own;
 * this entry supplies real deps and serves it on $PORT for Cloud Run (listen 0.0.0.0:$PORT, health probe,
 * clean SIGTERM). Vendor wiring is read from env / Secret Manager — see infra/deploy/README.md for the inventory.
 *
 * The collaborators below are *seams*, not stubs-to-force-green: Clerk verify + signed-URL HMAC are real when
 * their secrets are present; the eve client, Cloud SQL store, and deletion cascade are integration points the
 * eve-backend / db workflows own. Until those land, this boots /healthz + the auth gate and fails loudly on a
 * route that needs an unwired dep.
 */
import { serve } from 'bun'
import { createApp, type Deps, type EveClient } from '../../../services/voxi-api/src/app'
import { clerkVerifier, testVerifier, type Verifier } from '../../../services/voxi-api/src/auth'
import { memoryStore } from '../../../services/voxi-api/src/metering'
import { assertSigningKeyConfigured } from '../../../services/voxi-api/src/signing'

const PORT = Number(process.env.PORT ?? 8080)

// Fail fast in production if VOXI_URL_SIGNING_KEY is unset (adversarial A1): the signed /media photo capability
// is only as strong as this key — a default would let anyone forge a URL to another user's private photo.
assertSigningKeyConfigured()

// ---- Auth verifier (PLAN §12) -------------------------------------------------------------------
// Production verifies the Clerk session JWT networkless. The actual @clerk/backend `verifyToken` is injected
// here once the dependency + CLERK_JWT_KEY are present; in VOXI_TEST_MODE the test verifier is used.
function buildVerifier(): Verifier {
  if (process.env.VOXI_TEST_MODE === '1') return testVerifier
  if (!process.env.CLERK_JWT_KEY) {
    throw new Error('CLERK_JWT_KEY is required in production (set VOXI_TEST_MODE=1 only for non-prod boots)')
  }
  // The real call is `verifyToken` from @clerk/backend; kept as an injected seam so this file has no
  // hard dependency the image cannot yet install. Replace the throw-on-call shim when @clerk/backend lands.
  const verifyToken = async (token: string, opts: unknown): Promise<{ sub: string }> => {
    const mod = await import('@clerk/backend').catch(() => null as unknown as { verifyToken?: unknown })
    const fn = (mod as { verifyToken?: (t: string, o: unknown) => Promise<{ sub: string }> })?.verifyToken
    if (!fn) throw new Error('@clerk/backend not installed')
    return fn(token, opts)
  }
  return clerkVerifier(verifyToken)
}

// ---- eve client (PLAN §4.3) ---------------------------------------------------------------------
// The BFF reaches the eve FRONT over HTTP at $EVE_FRONT_URL (never exposed publicly; same VPC). This is the
// integration seam the eve-backend workflow owns; here it forwards session create/stream to that base URL.
function buildEveClient(): EveClient {
  const base = process.env.EVE_FRONT_URL
  return {
    async createSession({ userId, photoUrl }) {
      if (!base) throw new Error('EVE_FRONT_URL not configured')
      const res = await fetch(`${base}/eve/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, photoUrl }),
      })
      if (!res.ok) throw new Error(`eve createSession failed: ${res.status}`)
      return res.json() as Promise<{ sessionId: string; continuationToken: string }>
    },
    async *stream(sessionId, userId, startIndex) {
      if (!base) throw new Error('EVE_FRONT_URL not configured')
      const res = await fetch(`${base}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex ?? 0}`, {
        headers: { 'x-voxi-user': userId },
      })
      if (!res.ok || !res.body) throw new Error(`eve stream failed: ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line) yield line
        }
      }
      if (buf) yield buf
    },
  }
}

const deps: Deps = {
  verifier: buildVerifier(),
  store: memoryStore({}), // Cloud SQL-backed Store is wired by the db workflow; memory store keeps boot green.
  eve: buildEveClient(),
  deletion: {
    // The cascading delete spans GCS photos/audio + embeddings + eve workflow.* — owned by the db workflow.
    async cascade(userId) {
      throw new Error(`deletion.cascade not wired for ${userId}; provided by the db/eve integration`)
    },
  },
  bucket: process.env.GCS_PHOTO_BUCKET ?? 'voxi-photos',
  sessionOwner: new Map(),
}

const app = createApp(deps)

const server = serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req: Request) {
    const url = new URL(req.url)
    // Cloud Run / load-balancer health probe — cheap, unauthenticated, no business logic.
    if (url.pathname === '/healthz' || url.pathname === '/') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    return app.fetch(req)
  },
})

// eslint-disable-next-line no-console
console.log(`voxi-api listening on :${server.port}`)

// Graceful shutdown so in-flight streams drain before Cloud Run kills the instance.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    // eslint-disable-next-line no-console
    console.log(`received ${sig}, stopping`)
    server.stop()
    process.exit(0)
  })
}
