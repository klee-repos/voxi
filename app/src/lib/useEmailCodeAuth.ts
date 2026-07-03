/**
 * useEmailCodeAuth — the shared email→code flow behind /sign-up and /sign-in (DRY: the two route screens are
 * thin wrappers over this + <EmailCodeForm/>). Holds the two-phase state, busy/error, a resend cooldown, and
 * maps thrown auth errors to calm, in-persona, recoverable copy.
 *
 * Enumeration-safety (the load-bearing bit): on a PROD Clerk instance sign-in of a non-existent email is masked
 * (a placeholder code that never verifies), so `NoAccountError` is NOT reliable. The dependable switch to
 * "create an account" therefore happens at the CODE stage — a failed sign-in verify sets `error.showSwitch`,
 * and the form renders the cross-link to /sign-up. Email-stage NoAccountError is a best-effort bonus (dev only).
 */
import { useEffect, useRef, useState } from 'react'
import { useAuth, EmailExistsError, NoAccountError } from './clerk'
import { useApi } from './api'
import { useOffline, isOfflineError } from './useOffline'

export type AuthMode = 'signUp' | 'signIn'
export type AuthPhase = 'email' | 'code'
export interface AuthError {
  message: string
  /** render the cross-link to the OTHER auth screen (exists → log in, no-account/bad-sign-in-code → create). */
  showSwitch: boolean
}

const RESEND_SECONDS = 30

export interface EmailCodeAuth {
  email: string
  setEmail: (v: string) => void
  code: string
  setCode: (v: string) => void
  phase: AuthPhase
  busy: null | 'sending' | 'verifying'
  error: AuthError | null
  offline: boolean
  cooldown: number
  canSubmitEmail: boolean
  canSubmitCode: boolean
  submitEmail: () => Promise<void>
  submitCode: () => Promise<void>
  resend: () => Promise<void>
  changeEmail: () => void
}

export function useEmailCodeAuth({
  mode,
  initialEmail = '',
  onSuccess,
}: {
  mode: AuthMode
  initialEmail?: string
  onSuccess: () => void
}): EmailCodeAuth {
  const { isLoaded, isSignedIn, startSignUp, startSignIn, verifyCode } = useAuth()
  const api = useApi()

  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<AuthPhase>('email')
  const [busy, setBusy] = useState<null | 'sending' | 'verifying'>(null)
  const [error, setError] = useState<AuthError | null>(null)
  const [netError, setNetError] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  // Guards the confirm+navigate so it runs once per mounted attempt. NOT reset on a remount — that's the point:
  // signing in flips DrawerHost's `enabled` in _layout, which remounts this screen; the fresh instance's ref is
  // false, so the post-verify effect re-fires on the remount and completes the navigation the old instance lost.
  const handledRef = useRef(false)

  const offline = useOffline(netError)
  const validEmail = /\S+@\S+\.\S+/.test(email.trim())
  const canSubmitEmail = validEmail && !offline && isLoaded && busy === null
  const canSubmitCode = code.trim().length >= 4 && !offline && busy === null

  // Resend cooldown ticker — cleared on unmount and when it reaches 0 (no setState-after-unmount).
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000)
    return () => clearInterval(t)
  }, [cooldown])

  // Post-verify: gate on isSignedIn alone (not a local "verified" flag) so it survives the sign-in remount — the
  // remounted screen mounts already-signed-in and re-fires this, confirming the session against the BFF and
  // handing off. Runs from an effect (not inline in submitCode) so the freshly-live token is in scope. Once-only
  // via handledRef; on a real failure it resets so the user can retry.
  useEffect(() => {
    if (!isSignedIn || handledRef.current) return
    handledRef.current = true
    let cancelled = false
    void (async () => {
      try {
        await api.me()
        if (!cancelled) onSuccess()
      } catch (e) {
        if (cancelled) return
        handledRef.current = false
        setBusy(null)
        applyError(e, 'code')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn])

  const start = (): Promise<void> => (mode === 'signUp' ? startSignUp(email.trim()) : startSignIn(email.trim()))

  const applyError = (e: unknown, at: AuthPhase): void => {
    if (isOfflineError(e)) {
      setNetError(true)
      setError({ message: "We're offline — signing in needs a connection. I'll be here when you're back.", showSwitch: false })
      return
    }
    if (e instanceof EmailExistsError) {
      setError({ message: 'That email already has an account.', showSwitch: true })
      return
    }
    if (e instanceof NoAccountError) {
      setError({ message: "There's no account for that email yet.", showSwitch: true })
      return
    }
    if (at === 'code') {
      // Sign-in: a wrong/placeholder code most often means the account doesn't exist (enumeration masking) →
      // offer the enumeration-safe switch to sign-up. Sign-up: just a mistyped code.
      setError(
        mode === 'signIn'
          ? { message: "That code didn't match. New here?", showSwitch: true }
          : { message: "That code didn't match. Check it and try again.", showSwitch: false },
      )
      return
    }
    const status = (e as { status?: number } | null)?.status
    setError({
      message:
        typeof status === 'number'
          ? 'The Guide is having a moment. Give it another go in a few seconds.'
          : "I couldn't send the code just now. Check the address and retry.",
      showSwitch: false,
    })
  }

  async function submitEmail(): Promise<void> {
    if (busy !== null || !canSubmitEmail) return
    setError(null)
    setNetError(false)
    setBusy('sending')
    try {
      await start()
      setCode('')
      setPhase('code')
      setCooldown(RESEND_SECONDS)
    } catch (e) {
      applyError(e, 'email')
    } finally {
      setBusy(null)
    }
  }

  async function submitCode(): Promise<void> {
    if (busy !== null || !canSubmitCode) return
    setError(null)
    setNetError(false)
    setBusy('verifying')
    try {
      await verifyCode(code.trim(), mode)
      // Navigation happens in the post-verify effect once isSignedIn flips (busy stays until then).
    } catch (e) {
      applyError(e, 'code')
      setBusy(null)
    }
  }

  async function resend(): Promise<void> {
    if (busy !== null || cooldown > 0 || offline) return
    setError(null)
    setBusy('sending')
    try {
      await start()
      setCooldown(RESEND_SECONDS)
    } catch (e) {
      applyError(e, 'email')
    } finally {
      setBusy(null)
    }
  }

  function changeEmail(): void {
    setPhase('email')
    setCode('')
    setError(null)
  }

  return {
    email,
    setEmail,
    code,
    setCode,
    phase,
    busy,
    error,
    offline,
    cooldown,
    canSubmitEmail,
    canSubmitCode,
    submitEmail,
    submitCode,
    resend,
    changeEmail,
  }
}
