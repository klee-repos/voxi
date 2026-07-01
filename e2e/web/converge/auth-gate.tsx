/**
 * auth-gate.tsx — drives the REAL FakeAuth seam (app/src/lib/clerk.tsx) to a signed-in state for converge.
 *
 * The camera + threads screens read `useApi()`, whose client's `getToken` comes from the REAL `useAuth()`
 * context. The FakeAuth provider (the harness auth path, active because expo-constants has no Clerk key) starts
 * signed-OUT and yields a `test:<email-prefix>` bearer only after `signInWithEmail` + `verifyCode`. That bearer
 * is exactly what the BFF's testVerifier accepts and what scopes per-user metering/ACL. This gate runs that REAL
 * two-step sign-in on mount with `converge@voxi.dev` (→ userId `test:converge`, matching the harness seed key
 * `converge`) and renders its children only once the context reports signed-in — i.e. the real screens mount with
 * a real, working token, the same way they would after the welcome flow. No app/ source is edited.
 */
import React, { useEffect, useRef } from 'react'
import { AuthProvider, useAuth } from '../../../app/src/lib/clerk'

function SignIn({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const { isSignedIn, signInWithEmail, verifyCode } = useAuth()
  const started = useRef(false)

  // Step 1 — request the email OTP exactly once (sets the provider's `pending`). This is the SAME two-step the
  // welcome screen drives; FakeAuth's verifyCode reads `pending` from its memoized closure, so we must call a
  // FRESH verifyCode created AFTER `pending` is set — see Step 2.
  useEffect(() => {
    if (started.current || isSignedIn) return
    started.current = true
    void signInWithEmail('converge@voxi.dev')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Step 2 — verify. `signInWithEmail` setting `pending` re-creates the auth memo, so `verifyCode`'s identity
  // changes; this effect then runs with that fresh closure (which now sees `pending`) and completes the sign-in.
  useEffect(() => {
    if (!started.current || isSignedIn) return
    void verifyCode('000000')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyCode, isSignedIn])

  // Render children only once the REAL auth context is signed in (so useApi()'s getToken returns the bearer).
  return isSignedIn ? <>{children}</> : null
}

/** Wrap a subtree in the REAL AuthProvider and gate it on a real, programmatic FakeAuth sign-in. */
export function SignedIn({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <AuthProvider>
      <SignIn>{children}</SignIn>
    </AuthProvider>
  )
}
