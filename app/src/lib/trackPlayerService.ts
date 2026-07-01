/**
 * react-native-track-player playback service — the headless task that handles remote transport controls
 * (lock screen / Control Center / headset): play, pause, stop, and ±15s jumps map to the same episode. Kept
 * out of the web bundle (imported only by nativeStartup.native.ts). Registered once at startup in index.js.
 */
import TrackPlayer, { Event } from 'react-native-track-player'

export async function PlaybackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => void TrackPlayer.play())
  TrackPlayer.addEventListener(Event.RemotePause, () => void TrackPlayer.pause())
  TrackPlayer.addEventListener(Event.RemoteStop, () => void TrackPlayer.reset())
  TrackPlayer.addEventListener(Event.RemoteJumpForward, (e) => void TrackPlayer.seekBy(e?.interval ?? 15))
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, (e) => void TrackPlayer.seekBy(-(e?.interval ?? 15)))
}
