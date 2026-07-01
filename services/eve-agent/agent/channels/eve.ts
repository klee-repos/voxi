/**
 * eve HTTP channel — custom AuthFn + per-user session-ownership ACL (PLAN §4.2, §4.3, §12 / G3 S2).
 *
 * The channel is the public-ish front door of the eve agent: every inbound request (session create, the
 * NDJSON stream, a transcript follow-up) is authenticated and authorized HERE, before any tool runs.
 *
 * Two enforcement layers, both in this file:
 *   1. AUTHENTICATE — verify the **Clerk session JWT networkless** (`@clerk/backend` verifyToken + cached JWKS;
 *      NO network call per request, just a signature check against the cached key). The verifier is INJECTED so
 *      this channel runs deterministically with no creds (a fake key/verifier in tests). principal = claims.sub.
 *   2. AUTHORIZE (the ACL) — a user may only create/stream/continue sessions THEY own. Session ownership is
 *      recorded on create and checked on every subsequent access, so user A can never stream user B's session
 *      (the §4.3 invariant; the same ACL the BFF enforces, enforced again at the agent boundary — defence in depth).
 *
 * G3 checklist S2 asserts THIS boots off-Vercel: the Clerk verify is a stateless signature check that runs
 * identically on Cloud Run — auth-as-a-service stores only identities; all compute/data stay on GCP (§12).
 */

/** The principal extracted from a verified Clerk JWT. `userId` = `claims.sub` (the key for every ACL + our users row). */
export interface Principal {
  userId: string
}

/**
 * Pluggable networkless token verifier. In prod this wraps `@clerk/backend` `verifyToken(token, { jwtKey })`
 * with the cached JWKS/PEM (no per-request network). In tests, a deterministic fake. Returns null on any
 * invalid/expired/malformed token — the channel treats null as 401.
 */
export type TokenVerifier = (bearer: string) => Promise<Principal | null>

/**
 * Build the production Clerk verifier from an injected `verifyToken` (so this module imports nothing live and
 * stays testable). Networkless: `verifyToken` checks the signature against the cached `jwtKey` — no JWKS fetch
 * per call. Any throw (bad signature, expiry, clock skew beyond tolerance) → null → 401.
 */
export function clerkVerifier(
  verifyToken: (token: string, opts: { jwtKey?: string }) => Promise<{ sub: string }>,
  jwtKey: string | undefined = process.env.CLERK_JWT_KEY,
): TokenVerifier {
  return async (bearer) => {
    if (!bearer) return null
    try {
      const claims = await verifyToken(bearer, { jwtKey })
      return claims.sub ? { userId: claims.sub } : null
    } catch {
      return null
    }
  }
}

/** Extract the raw token from an `Authorization: Bearer <jwt>` header. */
export function bearerFrom(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m?.[1] ?? null
}

/**
 * The session-ownership ACL store. Records `sessionId -> ownerUserId` on create; every later access is checked.
 * Pluggable so prod backs it with Postgres (`threads.eve_session_id` + owner) and tests use an in-memory map.
 */
export interface SessionOwnership {
  record(sessionId: string, userId: string): Promise<void>
  ownerOf(sessionId: string): Promise<string | null>
}

/** A simple in-memory ownership store (tests / the G3 boot spike). Prod uses the threads table. */
export function memorySessionOwnership(): SessionOwnership {
  const owners = new Map<string, string>()
  return {
    async record(sessionId, userId) {
      owners.set(sessionId, userId)
    },
    async ownerOf(sessionId) {
      return owners.get(sessionId) ?? null
    },
  }
}

/** The decision the channel returns to the runtime: allow (with the principal) or deny (with an HTTP status). */
export type AuthDecision =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; reason: string }

/** What kind of access the request wants — `create` mints a new session; the rest touch an existing one. */
export type AccessKind = 'create' | 'stream' | 'continue'

export interface AuthRequest {
  authorization: string | undefined | null
  kind: AccessKind
  /** required for stream/continue — the session being accessed. */
  sessionId?: string
}

/**
 * The custom AuthFn the eve channel installs. Authenticate, then (for an existing session) authorize ownership.
 * This is the single function the runtime calls per inbound request; everything downstream trusts its principal.
 */
export function makeAuthFn(verify: TokenVerifier, ownership: SessionOwnership) {
  return async function authFn(req: AuthRequest): Promise<AuthDecision> {
    // 1) authenticate (networkless Clerk verify).
    const principal = await verify(bearerFrom(req.authorization) ?? '')
    if (!principal) return { ok: false, status: 401, reason: 'invalid or missing Clerk session token' }

    // 2) authorize. `create` needs no prior ownership; record happens after the runtime mints the id.
    if (req.kind === 'create') return { ok: true, principal }

    // stream/continue: the session must exist AND be owned by this principal.
    if (!req.sessionId) return { ok: false, status: 403, reason: 'no sessionId on a non-create access' }
    const owner = await ownership.ownerOf(req.sessionId)
    if (owner === null) return { ok: false, status: 403, reason: 'unknown session' }
    if (owner !== principal.userId) {
      // The load-bearing line: user A cannot touch user B's session even with a valid token (§4.3).
      return { ok: false, status: 403, reason: 'session is owned by another user' }
    }
    return { ok: true, principal }
  }
}

/** Record ownership right after the runtime mints a sessionId for a `create` (so the next access can be ACL'd). */
export async function onSessionCreated(
  ownership: SessionOwnership,
  sessionId: string,
  userId: string,
): Promise<void> {
  await ownership.record(sessionId, userId)
}
