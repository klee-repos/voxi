/**
 * absent-native.tsx — stands in for native-only modules that are ABSENT on the web target, for the converge
 * scope ONLY.
 *
 * The app's seams use the lazy-`require()`-in-try/catch pattern (clerk → @clerk/clerk-expo, cameraPermission →
 * react-native-vision-camera/expo-linking, pipecat → @pipecat-ai/*, etc.): on a platform where the native module
 * is present they wire the real API, and on web they CATCH the failed resolution and fall back to the
 * deterministic stub (FakeAuth, the web camera-permission provider, the in-process voice session). On the real
 * `expo start --web` build these modules simply aren't installed for web, so the require throws and the stub
 * path runs — which is the path the whole web E2E suite already exercises.
 *
 * A static bundler resolves `require(...)` at build time, so to reproduce that SAME runtime behavior we alias
 * each absent native module to this shim. Importing it throws, which is precisely the "module not present"
 * signal the seams' try/catch is written to handle → the deterministic stub engages. No app/ source is edited.
 */
throw new Error('absent native module (web target) — converge stub path engaged')
export {}
