/**
 * Native audio (react-native-track-player). Metro resolves THIS on device; the web build uses `AudioElement.tsx`
 * (a real DOM <audio>). Same testID contract on both. TrackPlayer owns the iOS audio session (background +
 * lock-screen, UIBackgroundModes:[audio]); the playback service is registered at startup (nativeStartup.native.ts).
 *
 * All access to the process-global singleton player goes through ONE `RevealAudioController`
 * (lib/revealAudioController.ts) so the reveal narration can never race itself. The previous three-effect design
 * let a speak-aloud open fire play() on an
 * empty queue + a double play()/configureAudioSession, churning the AVAudioSession mid-load and invalidating the
 * CoreMedia "Fig" player (AVFoundation -11800 / kCMBaseObjectError_ParamErr -12780). This file is now a thin
 * wrapper: it builds the real TrackPlayer adapter + a data-URI→cache-file resolver + a playback-session guard, and
 * drives the controller from ONE effect. `onPlayingChange` mirrors the web seam; `seekToStartOnPlay` restarts from
 * 0 so the button is a true "replay".
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { View } from 'react-native'
import TrackPlayer, { Event } from 'react-native-track-player'
// SDK 57: the functional file API (cacheDirectory/writeAsStringAsync/getInfoAsync/EncodingType) lives at
// `expo-file-system/legacy` — the root export is the new File API. Matches app/src/lib/photo.native.ts.
import { cacheDirectory, getInfoAsync, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy'
import { createRevealAudioController, type AudioPlayer } from '../lib/revealAudioController'
import { tid } from '../lib/testid'
import type { AudioHandle } from './AudioElement'

export interface AudioElementProps {
  id: string
  src?: string
  playing: boolean
  onPlayingChange?: (playing: boolean) => void
  seekToStartOnPlay?: boolean
  /** report playhead position + duration (seconds) — the Deep Dive scrubber + karaoke bind to this. Polled from
   *  TrackPlayer.getProgress() (a READ; safe outside the controller's mutation chain). */
  onProgress?: (positionSec: number, durationSec: number) => void
}

let setupPromise: Promise<void> | null = null
/** setupPlayer must run exactly once per process; it throws if already initialized, so we cache the promise. */
const ensureSetup = (): Promise<void> =>
  (setupPromise ??= TrackPlayer.setupPlayer().catch(() => {
    /* already set up (or transient) — treat as ready so playback still proceeds */
  }))

/** The real player the controller drives. */
const realPlayer: AudioPlayer = {
  setup: () => ensureSetup(),
  reset: () => TrackPlayer.reset(),
  add: async (url) => { await TrackPlayer.add({ url, title: 'Voxi', artist: 'the Guide' }) },
  play: () => TrackPlayer.play(),
  pause: () => TrackPlayer.pause(),
  seekTo: (s) => TrackPlayer.seekTo(s),
}

/** 32-bit FNV-1a → a collision-resistant cache filename. The old `voxi-narration-${b64.length}.mp3` keyed on
 *  LENGTH only, so two same-length narrations collided and a stale file could be silently reused. */
function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** A `data:` URI (the reveal narration) is decoded to a stable cache file (TrackPlayer can't play a data URI);
 *  http/file URLs (the podcast) pass through unchanged. */
async function resolveUrl(src: string): Promise<string> {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(src)
  if (!m) return src
  const b64 = m[2] ?? ''
  const uri = `${cacheDirectory ?? ''}voxi-narration-${hash32(b64)}.mp3`
  const info = await getInfoAsync(uri).catch(() => ({ exists: false }) as { exists: boolean })
  if (!info.exists) await writeAsStringAsync(uri, b64, { encoding: EncodingType.Base64 })
  return uri
}

/** Part B (H_session): force the AVAudioSession to a playback category
 *  before narration, so a session left in `.playAndRecord` by a prior WebRTC voice call can't invalidate the
 *  item. Best-effort — never blocks playback. (The voice loop also restores playback on disconnect; this is the
 *  point-of-use belt to that suspenders.) */
async function ensurePlaybackSession(): Promise<void> {
  try {
    // Lazy require so the CURRENT (pre-rebuild) binary — which has no expo-audio native module yet — degrades to
    // a no-op instead of crashing the module load. Activates after the native rebuild.
    const { setAudioModeAsync } = require('expo-audio') as typeof import('expo-audio')
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })
  } catch {
    /* non-fatal: expo-audio not in this binary yet, or a failed hint — never block narration */
  }
}

// ONE controller for the process-global player — serializes ALL narration/podcast access (kills the race).
const controller = createRevealAudioController({
  player: realPlayer,
  resolveUrl,
  ensurePlaybackSession,
  onError: (stage, err) =>
    // eslint-disable-next-line no-console
    console.warn(`[speech] ${stage} failed:`, err instanceof Error ? err.message : err),
})

// A stray PlaybackError (RNTP forwards it code-less → logs as `[unknown/unknown:]`) must never surface as an
// uncaught red ERROR. Attach ONE global listener that logs it and unsticks every mounted play/replay button.
const playingCallbacks = new Set<(p: boolean) => void>()
let globalListenersAttached = false
function attachGlobalListeners(): void {
  if (globalListenersAttached) return
  globalListenersAttached = true
  TrackPlayer.addEventListener(Event.PlaybackError, (e: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('[speech] playback-error', e)
    for (const cb of playingCallbacks) cb(false)
  })
}

export const AudioElement = forwardRef<AudioHandle, AudioElementProps>(function AudioElement(
  { id, src, playing, onPlayingChange, seekToStartOnPlay, onProgress },
  ref,
): React.ReactElement {
  // Keep the latest callback + src in refs so the subscription stays STABLE (the old inline `()=>{}` re-subscribed
  // every render) and the unmount hook sees the current src.
  const cbRef = useRef(onPlayingChange)
  cbRef.current = onPlayingChange
  const srcRef = useRef(src)
  srcRef.current = src
  const progressRef = useRef(onProgress)
  progressRef.current = onProgress
  // Last polled playhead so seekBy(delta) can compute an absolute target without another async read.
  const posRef = useRef(0)

  // Imperative transport for the Deep Dive scrubber + ±15. seek goes through the controller's SERIAL chain so it
  // never races a load/reset (the AVFoundation-race invariant); seekBy resolves against the last polled position.
  useImperativeHandle(
    ref,
    (): AudioHandle => ({
      seekTo: (seconds) => controller.seek(seconds),
      seekBy: (delta) => controller.seek(Math.max(0, posRef.current + delta)),
    }),
    [],
  )

  // Report real playing state (register once — no per-render churn).
  useEffect(() => {
    attachGlobalListeners()
    const notify = (p: boolean) => cbRef.current?.(p)
    playingCallbacks.add(notify)
    const sub = TrackPlayer.addEventListener(Event.PlaybackState, (e: { state?: unknown }) =>
      notify(String(e?.state ?? '').toLowerCase().includes('playing')),
    )
    return () => {
      playingCallbacks.delete(notify)
      sub.remove()
    }
  }, [])

  // Progress poll (only when a consumer wants it — the player). getProgress() is a READ, so it needs no serial
  // chain; ~250ms matches the web <audio> ontimeupdate cadence. Feeds the scrubber + word-level karaoke.
  useEffect(() => {
    if (!onProgress) return
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const p = await TrackPlayer.getProgress()
        if (!alive) return
        posRef.current = p.position || 0
        progressRef.current?.(p.position || 0, p.duration || 0)
      } catch {
        /* nothing loaded yet — ignore */
      }
    }
    void tick()
    const iv = setInterval(() => void tick(), 250)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [onProgress])

  // Single drive effect → the controller serializes reset/add/play internally (no more multi-effect race).
  useEffect(() => {
    controller.update({ src, playing, seekToStart: !!seekToStartOnPlay })
  }, [src, playing, seekToStartOnPlay])

  // Stop when this element leaves the screen — but only if the player is still on OUR src (don't pause the next
  // screen's audio on the shared singleton).
  useEffect(() => () => controller.stopIfCurrent(srcRef.current), [])

  return <View {...tid(id)} accessibilityRole="none" style={{ width: 0, height: 0 }} />
})
