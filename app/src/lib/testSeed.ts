/**
 * E2E band-steer seed for the native Maestro tier (test-only). The OPTIONAL seed is a confidence "scan"
 * (confident | probable | unknown | slow | fail | pill | logobrand) set by the +native-intent deep-link handler
 * and read by the capture path, which forwards it as the `X-Voxi-Test-Seed` header so the test-BFF steers the
 * reveal band deterministically — the native analog of the web harness's `?scan` Referer seam.
 *
 * Gated on EXPO_PUBLIC_TEST_MODE (baked ONLY into the maestro build profile) so both the fixture-capture and the
 * seed are inert in any production/TestFlight binary even if a value somehow gets set.
 */
const TEST_MODE = process.env.EXPO_PUBLIC_TEST_MODE === '1'

let seed: string | null = null

/** Set by the deep-link handler. Overwrites unconditionally (never set-if-null) so one flow's seed can't bleed
 *  into the next on a warm relaunch; validated to the server's scan charset. */
export function setTestSeed(next: string | null): void {
  seed = next && /^[a-z]+$/.test(next) ? next : null
}

/** The band seed, or null when not in test mode / none set. */
export function getTestSeed(): string | null {
  return TEST_MODE ? seed : null
}

/** True only in the maestro/E2E build → the camera loads a bundled fixture (the iOS Simulator has no camera). */
export function isTestMode(): boolean {
  return TEST_MODE
}
