/**
 * Native-only startup side effects, run once from index.js BEFORE the app renders:
 *   1. register the track-player playback service (podcast audio + lock-screen controls).
 *
 * Metro resolves THIS on device; the web/E2E bundle resolves the no-op `nativeStartup.ts`, so native-only
 * modules (react-native-track-player) never enter a non-native bundle.
 *
 * (LiveKit voice: @livekit/react-native's registerGlobals() is called lazily from createRealVoiceSession — the
 * WebRTC globals set up only when a voice session actually starts, not at boot. The old pipecat MediaManager
 * factory wiring is gone — LiveKit owns the mic + the WebRTC media plane.)
 */
import TrackPlayer from 'react-native-track-player'
import { PlaybackService } from './trackPlayerService'

TrackPlayer.registerPlaybackService(() => PlaybackService)
