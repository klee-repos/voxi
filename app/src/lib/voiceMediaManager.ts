/**
 * Web / E2E / esbuild-converge default for the native `voiceMediaManager.native.ts`.
 *
 * There is no react-native-webrtc off-device, so this returns null: `pipecat.ts`'s `createRealVoiceSession`
 * treats a null MediaManager factory (and/or absent native modules) as "no real transport" and falls back to
 * the deterministic stub session. Keeping THIS the default resolution guarantees `react-native-webrtc` never
 * enters the web/E2E bundle (esbuild has no RN platform resolution). Metro overrides this with
 * `voiceMediaManager.native.ts` on device via the `.native` platform suffix.
 *
 * Same platform-split pattern as photo.ts / photo.native.ts and wireBilling.ts / wireBilling.native.ts.
 */
export function createVoiceMediaManager(): unknown {
  return null
}
