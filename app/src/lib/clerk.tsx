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
  /** Bearer for the ApiClient. Clerk's session JWT in prod; `test:<user>` in the fallback. */
  getToken: () => Promise<string | null>
  /** Email-OTP / magic-link sign-in entry (the welcome screen drives this). */
  signInWithEmail: (email: string) => Promise<void>
  verifyCode: (code: string) => Promise<void>
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
 * Deterministic offline auth used when no Clerk key is configured. The userId is derived from the email so
 * the BFF's per-user ACL and metering behave realistically in E2E.
 */
function FakeAuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [email, setEmail] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<string | null>(null)

  const value = useMemo<AuthState>(
    () => ({
      isLoaded: true,
      isSignedIn: email !== null,
      userId: email ? `test:${email.split('@')[0]}` : null,
      async getToken() {
        return email ? `test:${email.split('@')[0]}` : null
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
  const { useAuth: useClerkAuth, useSignIn, useSignUp } = clerk
  const auth = useClerkAuth()
  const signIn = useSignIn()
  const signUp = useSignUp()
  // Which flow the pending email-OTP belongs to, so verifyCode attempts the right verification.
  const flow = React.useRef<'signIn' | 'signUp'>('signIn')

  const value = useMemo<AuthState>(
    () => ({
      isLoaded: auth.isLoaded,
      isSignedIn: !!auth.isSignedIn,
      userId: auth.userId ?? null,
      getToken: () => auth.getToken(),
      async signInWithEmail(email: string) {
        if (!signIn.isLoaded || !signUp.isLoaded) return
        try {
          // SIGN-UP FIRST. Under Clerk enumeration protection, sign-in MASKS a non-existent real email as
          // `needs_first_factor` and sends a placeholder code that can never verify ("code didn't match").
          // Sign-up, however, cleanly reveals existence (`form_identifier_exists`), so it's the reliable branch.
          await signUp.signUp.create({ emailAddress: email })
          await signUp.signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
          flow.current = 'signUp'
        } catch (err) {
          const code = (err as { errors?: { code?: string }[] })?.errors?.[0]?.code
          if (code === 'form_identifier_exists') {
            // EXISTING user → email-code sign-in. prepareFirstFactor needs the emailAddressId from the factor list.
            const attempt = await signIn.signIn.create({ identifier: email })
            const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === 'email_code') as { emailAddressId?: string } | undefined
            await signIn.signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor?.emailAddressId } as never)
            flow.current = 'signIn'
          } else {
            throw err
          }
        }
      },
      async verifyCode(code: string) {
        if (flow.current === 'signUp') {
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
    }),
    [auth, signIn, signUp],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** The provider mounted in _layout.tsx. Picks the real Clerk path iff a key is configured. */
export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return hasClerk ? <ClerkBridge>{children}</ClerkBridge> : <FakeAuthProvider>{children}</FakeAuthProvider>
}
