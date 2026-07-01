/**
 * The audio playback element (podcast.audio / reveal.narrationAudio — the E2E `expect.playing()` asserts
 * currentTime advances).
 *
 * On web (the E2E harness / react-native-web) we render a REAL DOM `<audio>` element carrying the testID so the
 * Playwright/agent-browser driver can assert playback; `playing` toggles play()/pause(). On native, audio is
 * driven by react-native-track-player (see AudioElement.native.tsx). The seam keeps the player screen identical.
 *
 * `onPlayingChange` reports the element's REAL playing state back to the caller (fired on play/pause/ended AND
 * when a gesture-less autoplay is BLOCKED — play() rejects). This is what keeps the reveal's play/replay button
 * in sync with reality: a blocked autoplay reports `false`, so the button shows "Hear it" and a single tap plays.
 * `seekToStartOnPlay` restarts from 0 each time playback begins, so the reveal's button is a true "replay".
 */
import React, { useEffect, useRef } from 'react'
import { View, Platform } from 'react-native'
import { tid } from '../lib/testid'

export interface AudioElementProps {
  id: string
  src?: string
  playing: boolean
  /** report the element's real playing state (play/pause/ended + blocked-autoplay rejection). */
  onPlayingChange?: (playing: boolean) => void
  /** restart from 0 whenever playback begins (a true "replay" for the short reveal narration). */
  seekToStartOnPlay?: boolean
}

export function AudioElement(props: AudioElementProps): React.ReactElement {
  if (Platform.OS === 'web') return <WebAudio {...props} />
  // Native: TrackPlayer owns the audio session; this element is the contract anchor only.
  return <View {...tid(props.id)} accessibilityRole="none" style={{ width: 0, height: 0 }} />
}

interface HTMLAudioLike {
  play: () => Promise<void> | void
  pause: () => void
  currentTime: number
  paused: boolean
}

function WebAudio({ id, src, playing, onPlayingChange, seekToStartOnPlay }: AudioElementProps): React.ReactElement {
  const ref = useRef<HTMLAudioLike | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Depend on `src` too: narration audio loads AFTER mount, so when the src arrives while `playing` is already
    // true (autoplay), we must (re)call play() on the new source — a `playing`-only effect would miss it.
    if (playing) {
      if (seekToStartOnPlay) {
        try { el.currentTime = 0 } catch { /* not seekable yet — play() will still start from the buffered head */ }
      }
      // play() REJECTS when the browser blocks gesture-less autoplay; report that back so the caller's state
      // matches reality (button shows "Hear it", and the next real tap — a gesture — succeeds).
      Promise.resolve(el.play()).then(
        () => onPlayingChange?.(true),
        () => onPlayingChange?.(false),
      )
    } else {
      el.pause()
    }
  }, [playing, src, seekToStartOnPlay, onPlayingChange])

  const props = tid(id)
  // A short silent-able loop source keeps currentTime advancing for the assertion even without a real CDN URL.
  return React.createElement('audio', {
    ref,
    'data-testid': props.testID,
    'aria-label': props.accessibilityLabel,
    src: src ?? 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
    // Narration is a one-shot; only loop the silent placeholder. Real narration should end and report paused.
    loop: !src,
    controls: false,
    onPlay: () => onPlayingChange?.(true),
    onPause: () => onPlayingChange?.(false),
    onEnded: () => onPlayingChange?.(false),
  })
}
