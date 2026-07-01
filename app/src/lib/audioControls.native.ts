/**
 * Native podcast transport controls used by the player screen's ±15s buttons. Kept in a platform-split module
 * so podcast.tsx (cross-platform) never imports react-native-track-player into the web bundle.
 */
import TrackPlayer from 'react-native-track-player'

export async function seekBy(seconds: number): Promise<void> {
  try {
    await TrackPlayer.seekBy(seconds)
  } catch {
    /* nothing loaded yet — ignore */
  }
}
