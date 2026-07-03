/**
 * E2E auth-mode seed for the native Maestro tier (test-only). The maestro build auto-signs-in via
 * EXPO_PUBLIC_TEST_USER (FakeAuth), so the auth SCREENS never render there by default. The +native-intent
 * deep-link handler sets a mode from `voxi://e2e?auth=<mode>`; FakeAuth reads it at init to start SIGNED-OUT
 * (so the landing renders) and to steer its start* branches deterministically:
 *
 *   fresh      → signed-out; sign-up + sign-in both succeed (the happy paths)
 *   exists     → signed-out; startSignUp throws EmailExistsError   (the "log in instead" branch)
 *   noaccount  → signed-out; startSignIn throws NoAccountError      (the "create one" branch)
 *
 * TEST_MODE is read DYNAMICALLY (not cached) so unit tests can flip EXPO_PUBLIC_TEST_MODE + a mode and assert
 * the FakeAuth branches without a device. Inert in any production/TestFlight binary (TEST_MODE off there), so
 * a stray value can never affect a real build. The web converge tier does NOT use this (it reaches FakeAuth via
 * an empty Clerk key and drives the real screens directly) — this seam is native-only.
 */
export type AuthMode = 'fresh' | 'exists' | 'noaccount'

const MODES: readonly AuthMode[] = ['fresh', 'exists', 'noaccount']

let mode: AuthMode | null = null

function testModeOn(): boolean {
  return process.env.EXPO_PUBLIC_TEST_MODE === '1'
}

/** Set by the deep-link handler. Overwrites unconditionally so one flow's mode can't bleed into the next. */
export function setAuthMode(next: string | null): void {
  mode = next && (MODES as readonly string[]).includes(next) ? (next as AuthMode) : null
}

/** The auth mode, or null when not in test mode / none set. */
export function getAuthMode(): AuthMode | null {
  return testModeOn() ? mode : null
}

/** True when any auth mode is set → FakeAuth must start signed-OUT (override the TEST_USER auto-signin). */
export function isFreshAuth(): boolean {
  return getAuthMode() !== null
}
