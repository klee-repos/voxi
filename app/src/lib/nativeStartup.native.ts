/**
 * Native-only startup side effects, run once from index.js BEFORE the app renders:
 *   1. register the track-player playback service (podcast audio + lock-screen controls), and
 *   2. install the real WebRTC MediaManager factory so the voice ("Ask Voxi") client uses live media.
 *
 * Metro resolves THIS on device; the web/E2E bundle resolves the no-op `nativeStartup.ts`, so native-only
 * modules (react-native-track-player / react-native-webrtc) never enter a non-native bundle.
 */
import TrackPlayer from 'react-native-track-player'
import { PlaybackService } from './trackPlayerService'
import { setVoiceMediaManagerFactory } from './pipecat'

TrackPlayer.registerPlaybackService(() => PlaybackService)

// LAZY: only load the WebRTC-backed MediaManager (which imports react-native-webrtc) when a voice session
// actually starts — NOT at app boot. Importing react-native-webrtc eagerly initializes native media on the main
// thread and crashes before the JS runtime is ready (MediaDevices._registerEvents). Deferring the require() to
// voice-start means the app boots normally (capture + podcast work); any WebRTC failure at voice-start is caught
// by createVoiceSession's fail-safe (→ stub), so it can never crash the app.
setVoiceMediaManagerFactory(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createVoiceMediaManager } = require('./voiceMediaManager') as typeof import('./voiceMediaManager')
  return createVoiceMediaManager()
})
