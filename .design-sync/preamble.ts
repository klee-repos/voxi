/**
 * RN-web runtime preamble — MUST be the first import in the bundle entry so it
 * runs before any react-native-web module evaluates. Reproduces the globals
 * Metro's web runtime provides but esbuild does not (see the banner in
 * e2e/web/converge/harness.ts): RNW internals reach `global.performance.now()`
 * (ScrollView/VirtualizedList) and `global.cancelAnimationFrame` / `__DEV__`
 * (Animated), which throw "global is not defined" only in a bare esbuild bundle.
 */
const g = globalThis as unknown as { global?: unknown; process?: { env: Record<string, string> }; __DEV__?: boolean }
g.global = g.global || globalThis
// EXPO_PUBLIC_TEST_MODE=1 makes AuthProvider select FakeAuthProvider (a deterministic `test:` session) instead
// of Clerk — so DrawerMenu's useAuth()/useApi() resolve in the preview without real auth.
g.process = g.process || { env: { NODE_ENV: 'production', EXPO_PUBLIC_TEST_MODE: '1' } }
g.__DEV__ = false
export {}
