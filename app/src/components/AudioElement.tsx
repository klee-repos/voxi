/**
 * The audio playback element (podcast.audio / reveal.narrationAudio — the E2E `expect.playing()` asserts
 * currentTime advances). On web we render a REAL DOM `<audio>` carrying the testID so the driver can assert
 * playback; on native, react-native-track-player drives audio (see AudioElement.native.tsx).
 *
 * `onPlayingChange` reports the element's REAL playing state, including when a gesture-less autoplay is BLOCKED
 * (play() rejects) — so a blocked autoplay reports `false` and the reveal button shows "Hear it" until a tap.
 * `seekToStartOnPlay` restarts from 0 each time playback begins, so the button is a true "replay".
 *
 * The Deep Dive player also needs the PLAYHEAD (for its scrubber + word-level karaoke): `onProgress(pos, dur)`
 * reports position + duration, and an imperative `AudioHandle` ref exposes `seekTo`/`seekBy`. All three are
 * ADDITIVE + optional — the reveal narration + bucket-audio callers pass none of them and are unchanged.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { View, Platform } from 'react-native'
import { tid } from '../lib/testid'

/** Imperative transport for the Deep Dive scrubber + ±15 controls. */
export interface AudioHandle {
  seekTo(seconds: number): void
  seekBy(delta: number): void
}

export interface AudioElementProps {
  id: string
  src?: string
  playing: boolean
  /** report the element's real playing state (play/pause/ended + blocked-autoplay rejection). */
  onPlayingChange?: (playing: boolean) => void
  /** restart from 0 whenever playback begins (a true "replay" for the short reveal narration). */
  seekToStartOnPlay?: boolean
  /** report playhead position + duration (seconds) as playback advances / metadata loads (the player's scrubber
   *  + karaoke bind to this). Optional — reveal/bucket callers don't pass it. */
  onProgress?: (positionSec: number, durationSec: number) => void
}

export const AudioElement = forwardRef<AudioHandle, AudioElementProps>(function AudioElement(props, ref) {
  if (Platform.OS === 'web') return <WebAudio {...props} handleRef={ref} />
  // Native: TrackPlayer owns the audio session; this element is the contract anchor only (real impl in .native).
  return <View {...tid(props.id)} accessibilityRole="none" style={{ width: 0, height: 0 }} />
})

interface HTMLAudioLike {
  play: () => Promise<void> | void
  pause: () => void
  currentTime: number
  duration: number
  paused: boolean
}

function WebAudio({
  id,
  src,
  playing,
  onPlayingChange,
  seekToStartOnPlay,
  onProgress,
  handleRef,
}: AudioElementProps & { handleRef: React.ForwardedRef<AudioHandle> }): React.ReactElement {
  const ref = useRef<HTMLAudioLike | null>(null)

  // Imperative seek for the player's scrubber + ±15 buttons. Clamped to [0, duration]; silent if not seekable yet.
  useImperativeHandle(
    handleRef,
    (): AudioHandle => ({
      seekTo(seconds) {
        const el = ref.current
        if (!el || !Number.isFinite(seconds)) return
        const dur = Number.isFinite(el.duration) ? el.duration : Infinity
        try {
          el.currentTime = Math.max(0, Math.min(seconds, dur))
        } catch {
          /* not seekable yet */
        }
      },
      seekBy(delta) {
        const el = ref.current
        if (!el) return
        const dur = Number.isFinite(el.duration) ? el.duration : Infinity
        try {
          el.currentTime = Math.max(0, Math.min((el.currentTime || 0) + delta, dur))
        } catch {
          /* not seekable yet */
        }
      },
    }),
    [],
  )

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
  const report = (): void => {
    const el = ref.current
    if (el && onProgress) onProgress(el.currentTime || 0, el.duration)
  }
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
    onTimeUpdate: report,
    onLoadedMetadata: report,
    onDurationChange: report,
  })
}
