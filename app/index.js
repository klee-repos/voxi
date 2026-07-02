/**
 * App entry. Runs native-only startup (track-player playback service + voice WebRTC MediaManager) via a
 * platform-split module — a no-op on web — THEN boots expo-router. `main` in package.json points here so the
 * registrations happen before the first render. Order matters: startup side effects first, router last.
 */
// Error monitoring FIRST, so @sentry/react-native owns the global handler; the diagnostic below then chains
// through it (it calls `prev`). No-op when EXPO_PUBLIC_SENTRY_DSN is unset. Fail-soft — never blocks boot.
require('./src/lib/observability').initObservability()

// TEMP diagnostic: capture the full stack of otherwise-stackless errors (Hermes/LogBox hide it in Metro).
if (typeof ErrorUtils !== 'undefined' && ErrorUtils.setGlobalHandler) {
  const prev = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler()
  ErrorUtils.setGlobalHandler((e, isFatal) => {
    // eslint-disable-next-line no-console
    console.warn(`[globalError${isFatal ? ':FATAL' : ''}] ${e && e.message}\nSTACK:\n${(e && e.stack) || '(none)'}`)
    if (prev) prev(e, isFatal)
  })
}

// require (not import) so the handler above is installed BEFORE these modules evaluate/render.
require('./src/lib/nativeStartup')
require('expo-router/entry')
