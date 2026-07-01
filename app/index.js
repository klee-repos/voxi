/**
 * App entry. Runs native-only startup (track-player playback service + voice WebRTC MediaManager) via a
 * platform-split module — a no-op on web — THEN boots expo-router. `main` in package.json points here so the
 * registrations happen before the first render. Order matters: startup side effects first, router last.
 */
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
