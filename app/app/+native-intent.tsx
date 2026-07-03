/**
 * expo-router pre-mount deep-link hook. Maestro drives `openLink voxi://e2e?seed=<band>` to steer the reveal band;
 * we stash the seed SYNCHRONOUSLY here (before the router builds its initial navigation state — a `_layout`
 * Linking listener would race the async getInitialURL redirect) and send the app to `/`, which routes a signed-in
 * FakeAuth user (the maestro build) straight to the camera.
 *
 * Inert unless EXPO_PUBLIC_TEST_MODE=1 (only the maestro build sets it). Every other URL passes through unchanged,
 * so production deep-linking is untouched.
 */
import { setTestSeed } from '../src/lib/testSeed'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (process.env.EXPO_PUBLIC_TEST_MODE === '1' && /(?:^|[/:])e2e\b/.test(path)) {
      const seed = /[?&]seed=([a-z]+)/.exec(path)?.[1] ?? null
      setTestSeed(seed)
      return '/'
    }
  } catch {
    /* a malformed test link must never crash startup */
  }
  return path
}
