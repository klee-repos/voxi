/**
 * Clerk auth seam (PLAN §12 / D2 — `@clerk/clerk-expo`).
 *
 * Production: ClerkProvider with a `tokenCache` backed by expo-secure-store (iOS Keychain) so sessions persist
 * with zero custom code; the BFF verifies the session JWT networkless. The publishable key comes from
 * `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.
 *
 * Testability seam: when no publishable key is present (the E2E web harness, CI, Storybook), we fall back to a
 * `FakeAuth` provider that yields a deterministic `test:<user>` bearer — the SAME token shape the harness's
 * testVerifier accepts (services/voxi-api/src/auth.ts). This keeps every screen renderable without a live
 * Clerk tenant, while the real provider is a drop-in when the key is set.
 */
import React, { createContext, useContext, useMemo } from 'react'
import Constants from 'expo-constants'
import { getAuthMode } from './testAuth'
import { EmailExistsError, NoAccountError, authModeError } from './authErrors'

// Re-export the auth error taxonomy so screens/hooks keep importing it from the auth module.
export { EmailExistsError, NoAccountError, authModeError } from './authErrors'

// expo-secure-store is unavailable on web; the import is guarded so the bundle works in the harness.
let SecureStore: typeof import('expo-secure-store') | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SecureStore = require('expo-secure-store')
} catch {
  SecureStore = null
}

export const PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  (Constants.expoConfig?.extra?.clerkPublishableKey as string | undefined) ??
  ''

/** SecureStore-backed token cache (the Clerk-recommended Expo pattern). */
export const tokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return (await SecureStore?.getItemAsync(key)) ?? null
    } catch {
      return null
    }
  },
  async saveToken(key: string, value: string): Promise<void> {
    try {
      await SecureStore?.setItemAsync(key, value)
    } catch {
      /* non-fatal */
    }
  },
}

/**
 * Auth shape the app consumes (a thin surface over Clerk so screens don't import Clerk directly and so the
 * FakeAuth fallback can satisfy the exact same contract).
 */
export interface AuthState {
  isLoaded: boolean
  isSignedIn: boolean
  userId: string | null
  /** The user's first name for the "Welcome, {firstName}" greeting (Clerk `user.firstName`). `null` while
   *  loading, signed-out, or when the account has none set — callers fall back to `email`, then a neutral word. */
  firstName: string | null
  /** The user's primary email address (Clerk `user.primaryEmailAddress.emailAddress`). `null` while loading or
   *  signed-out. In the FakeAuth fallback this is the tracked sign-in email. */
  email: string | null
  /** Bearer for the ApiClient. Clerk's session JWT in prod; `test:<user>` in the fallback. */
  getToken: () => Promise<string | null>
  /**
   * Account creation (/sign-up). Prepares an email-code verification; throws `EmailExistsError` if the address
   * already has an account (so the screen can offer "log in instead").
   */
  startSignUp: (email: string) => Promise<void>
  /**
   * Login (/sign-in). Prepares an email-code first-factor; may throw `NoAccountError` when Clerk surfaces
   * non-existence (dev instances). Under prod enumeration protection the "no account" switch happens at the
   * code stage instead (see NoAccountError).
   */
  startSignIn: (email: string) => Promise<void>
  /**
   * COMBINED email entry (sign-up-probe then sign-in fallback). RETAINED for the converge harness
   * (`e2e/web/converge/auth-gate.tsx`), which drives a programmatic sign-in; the real app screens use
   * startSignUp / startSignIn.
   */
  signInWithEmail: (email: string) => Promise<void>
  /**
   * Confirm the emailed code. `mode` picks the Clerk verification explicitly (sign-up vs sign-in) so the two
   * independent screens can never verify against the wrong flow; omitted → falls back to the last-started flow
   * ref (the combined signInWithEmail path).
   */
  verifyCode: (code: string, mode?: 'signUp' | 'signIn') => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

export const hasClerk = PUBLISHABLE_KEY.length > 0

/**
 * E2E (native Maestro build): a fixed user so flows land on the camera without driving welcome/OTP. Set ONLY in the
 * maestro EAS profile; that build also ships an EMPTY Clerk key, so `hasClerk` is false and FakeAuth is the active
 * provider — real Clerk can't even initialize (mutually exclusive by construction, matching the web harness).
 */
const TEST_USER = process.env.EXPO_PUBLIC_TEST_USER ?? ''

/**
 * Deterministic offline auth used when no Clerk key is configured. The userId is derived from the email so
 * the BFF's per-user ACL and metering behave realistically in E2E.
 */
function FakeAuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // In the maestro build, start signed-in as test:<TEST_USER> so index.tsx redirects straight to the camera —
  // UNLESS the auth-E2E deep link (`voxi://e2e?auth=…`) set a mode, in which case start SIGNED-OUT so the real
  // landing/sign-up/sign-in screens render and can be driven. getAuthMode() is set pre-mount by +native-intent.
  const [email, setEmail] = React.useState<string | null>(
    getAuthMode() ? null : TEST_USER ? `${TEST_USER}@voxi.dev` : null,
  )
  const [pending, setPending] = React.useState<string | null>(null)

  const value = useMemo<AuthState>(
    () => ({
      isLoaded: true,
      isSignedIn: email !== null,
      userId: email ? `test:${email.split('@')[0]}` : null,
      // FakeAuth has no name on file; the greeting falls back to `email`, then a neutral word.
      firstName: null,
      email,
      async getToken() {
        return email ? `test:${email.split('@')[0]}` : null
      },
      // The deterministic error branches are steered by the deep-link auth mode (native) or set directly (unit).
      async startSignUp(e: string) {
        const err = authModeError('signUp', getAuthMode())
        if (err) throw err
        setPending(e)
      },
      async startSignIn(e: string) {
        const err = authModeError('signIn', getAuthMode())
        if (err) throw err
        setPending(e)
      },
      async signInWithEmail(e: string) {
        setPending(e)
      },
      async verifyCode() {
        if (pending) setEmail(pending)
      },
      async signOut() {
        setEmail(null)
        setPending(null)
      },
    }),
    [email, pending],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * Bridges the real `@clerk/clerk-expo` hooks into our AuthState. Loaded lazily ONLY when a key is present so
 * the harness bundle never needs the native Clerk module.
 */
function ClerkBridge({ children }: { children: React.ReactNode }): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const clerk = require('@clerk/clerk-expo') as typeof import('@clerk/clerk-expo')
  const { ClerkProvider } = clerk
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <ClerkAuthAdapter clerk={clerk}>{children}</ClerkAuthAdapter>
    </ClerkProvider>
  )
}

function ClerkAuthAdapter({
  clerk,
  children,
}: {
  clerk: typeof import('@clerk/clerk-expo')
  children: React.ReactNode
}): React.ReactElement {
  const { useAuth: useClerkAuth, useSignIn, useSignUp, useUser } = clerk
  const auth = useClerkAuth()
  const signIn = useSignIn()
  const signUp = useSignUp()
  // `useUser()` returns `{ user: null, isLoaded: false }` both while loading AND when signed-out — the optional
  // chaining + `?? null` covers every state so the greeting never renders `undefined`.
  const user = useUser()
  // Which flow the pending email-OTP belongs to, so verifyCode attempts the right verification.
  const flow = React.useRef<'signIn' | 'signUp'>('signIn')

  const value = useMemo<AuthState>(() => {
    const errCode = (err: unknown): string | undefined =>
      (err as { errors?: { code?: string }[] } | null)?.errors?.[0]?.code

    // Shared Clerk preparations — the split intents + the combined fallback all reuse these (DRY). Each re-guards
    // `isLoaded` so TS narrows `signUp`/`signIn` to their loaded variants inside the helper (callers guard too).
    const prepareSignUp = async (email: string): Promise<void> => {
      if (!signUp.isLoaded) return
      await signUp.signUp.create({ emailAddress: email })
      await signUp.signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      flow.current = 'signUp'
    }
    const prepareSignIn = async (email: string): Promise<void> => {
      if (!signIn.isLoaded) return
      // prepareFirstFactor needs the emailAddressId from the factor list.
      const attempt = await signIn.signIn.create({ identifier: email })
      const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === 'email_code') as
        | { emailAddressId?: string }
        | undefined
      await signIn.signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor?.emailAddressId } as never)
      flow.current = 'signIn'
    }

    return {
      isLoaded: auth.isLoaded,
      isSignedIn: !!auth.isSignedIn,
      userId: auth.userId ?? null,
      // `primaryEmailAddress` is the primary email (verified-or-not) — fine for a greeting.
      firstName: user.user?.firstName ?? null,
      email: user.user?.primaryEmailAddress?.emailAddress ?? null,
      getToken: () => auth.getToken(),
      async startSignUp(email: string) {
        if (!signUp.isLoaded) return
        try {
          await prepareSignUp(email)
        } catch (err) {
          if (errCode(err) === 'form_identifier_exists') throw new EmailExistsError()
          throw err
        }
      },
      async startSignIn(email: string) {
        if (!signIn.isLoaded) return
        try {
          await prepareSignIn(email)
        } catch (err) {
          // Surfaces only with enumeration protection OFF (dev instances); prod masks it → code-stage switch.
          if (errCode(err) === 'form_identifier_not_found') throw new NoAccountError()
          throw err
        }
      },
      async signInWithEmail(email: string) {
        if (!signIn.isLoaded || !signUp.isLoaded) return
        // SIGN-UP FIRST — under enumeration protection sign-in masks a non-existent email; sign-up cleanly reveals
        // existence (`form_identifier_exists`), so it's the reliable probe. (Combined path — auth-gate harness.)
        try {
          await prepareSignUp(email)
        } catch (err) {
          if (errCode(err) === 'form_identifier_exists') await prepareSignIn(email)
          else throw err
        }
      },
      async verifyCode(code: string, mode?: 'signUp' | 'signIn') {
        // Explicit mode wins so the two independent screens never verify against the wrong flow; the combined
        // path passes none and rides the last-started flow ref.
        const which = mode ?? flow.current
        if (which === 'signUp') {
          if (!signUp.isLoaded) return
          const res = await signUp.signUp.attemptEmailAddressVerification({ code })
          if (res.status === 'complete') await signUp.setActive({ session: res.createdSessionId })
        } else {
          if (!signIn.isLoaded) return
          const res = await signIn.signIn.attemptFirstFactor({ strategy: 'email_code', code } as never)
          if (res.status === 'complete') await signIn.setActive({ session: res.createdSessionId })
        }
      },
      async signOut() {
        await auth.signOut()
      },
    }
  }, [auth, signIn, signUp, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** The provider mounted in _layout.tsx. Picks the real Clerk path iff a key is configured. */
export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // maestro/E2E build → deterministic FakeAuth regardless of any baked Clerk key. EXPO_PUBLIC_TEST_MODE is pinned
  // OFF in the prod/preview EAS profiles, so real builds never take this path (defence-in-depth: the BFF also
  // rejects `test:` bearers unless the server runs VOXI_TEST_MODE).
  if (process.env.EXPO_PUBLIC_TEST_MODE === '1') return <FakeAuthProvider>{children}</FakeAuthProvider>
  return hasClerk ? <ClerkBridge>{children}</ClerkBridge> : <FakeAuthProvider>{children}</FakeAuthProvider>
}
