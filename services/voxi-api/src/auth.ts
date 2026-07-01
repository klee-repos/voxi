/**
 * Auth verification for the BFF (PLAN §12 — Clerk).
 *
 * Production verifies the Clerk session JWT networkless via `@clerk/backend` verifyToken + cached JWKS.
 * The verifier is pluggable so tests run without Clerk: a `test:<userId>` bearer verifies in VOXI_TEST_MODE.
 * The principal (claims.sub) is the key for per-user session-ownership ACL and our own `users` row.
 */
export interface Principal {
  userId: string
}

export type Verifier = (bearer: string) => Promise<Principal | null>

/** Test verifier — only honored when VOXI_TEST_MODE=1. Accepts `test:<userId>`. */
export const testVerifier: Verifier = async (bearer) => {
  if (process.env.VOXI_TEST_MODE !== '1') return null
  const m = /^test:([a-zA-Z0-9_-]+)$/.exec(bearer)
  return m ? { userId: m[1] } : null
}

/**
 * Production Clerk verifier (wired when @clerk/backend + CLERK_JWT_KEY are present). Networkless.
 * Left as the seam; the test suite uses testVerifier.
 */
export function clerkVerifier(verifyToken: (token: string, opts: unknown) => Promise<{ sub: string }>): Verifier {
  return async (bearer) => {
    try {
      const claims = await verifyToken(bearer, { jwtKey: process.env.CLERK_JWT_KEY })
      return { userId: claims.sub }
    } catch {
      return null
    }
  }
}

export function bearerFrom(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : null
}
