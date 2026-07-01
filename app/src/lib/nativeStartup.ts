/**
 * Web/E2E fallback for `nativeStartup.native.ts` — a no-op. There is no track-player or WebRTC media stack in
 * the web bundle, so startup registers nothing; the voice client stays on its deterministic stub.
 */
export {}
