/**
 * Web / E2E default for `voiceMediaManager.native.ts` (Metro loads the native one via the `.native` suffix).
 *
 * Returns null so `pipecat.ts` falls back to the deterministic stub session, and keeps `react-native-webrtc`
 * out of the web/esbuild bundle (esbuild has no RN platform resolution).
 */
export function createVoiceMediaManager(): unknown {
  return null
}
