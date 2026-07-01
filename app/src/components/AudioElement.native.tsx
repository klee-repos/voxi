/**
 * Native audio (react-native-track-player). Metro resolves THIS on device; the web build uses `AudioElement.tsx`
 * (a real DOM <audio>). Same testID contract on both. TrackPlayer owns the iOS audio session (background +
 * lock-screen, UIBackgroundModes:[audio]); the playback service is registered at startup (nativeStartup.native.ts).
 *
 * Two sources flow through here: a podcast HLS/http URL (played directly) and the reveal narration, which the BFF
 * returns as a `data:audio/mpeg;base64,…` URI. TrackPlayer cannot play a data URI, so we decode it to a cache
 * file once and play that. `onPlayingChange` mirrors the web seam so the reveal's play/replay button tracks real
 * state; `seekToStartOnPlay` restarts from 0 so the button is a true "replay".
 */
import React, { useEffect, useRef } from 'react'
import { View } from 'react-native'
import TrackPlayer, { Event } from 'react-native-track-player'
// SDK 57: the functional file API (cacheDirectory/writeAsStringAsync/getInfoAsync/EncodingType) lives at
// `expo-file-system/legacy` — the root export is the new File API. Matches app/src/lib/photo.native.ts.
import { cacheDirectory, getInfoAsync, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy'
import { tid } from '../lib/testid'

export interface AudioElementProps {
  id: string
  src?: string
  playing: boolean
  onPlayingChange?: (playing: boolean) => void
  seekToStartOnPlay?: boolean
}

let setupPromise: Promise<void> | null = null
/** setupPlayer must run exactly once per process; it throws if already initialized, so we cache the promise. */
function ensureSetup(): Promise<void> {
  if (!setupPromise) {
    setupPromise = TrackPlayer.setupPlayer().catch(() => {
      /* already set up (or transient) — treat as ready so playback still proceeds */
    })
  }
  return setupPromise
}

/** TrackPlayer needs a real URL. A `data:` URI (the reveal narration) is decoded to a stable cache file once. */
async function resolveUrl(src: string): Promise<string> {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(src)
  if (!m) return src // already an http/file URL (the podcast path)
  const b64 = m[2] ?? ''
  // A stable per-content filename so replays reuse the same file instead of rewriting it.
  const name = `voxi-narration-${b64.length}.mp3`
  const uri = `${cacheDirectory ?? ''}${name}`
  const info = await getInfoAsync(uri).catch(() => ({ exists: false }))
  if (!info.exists) await writeAsStringAsync(uri, b64, { encoding: EncodingType.Base64 })
  return uri
}

export function AudioElement({ id, src, playing, onPlayingChange, seekToStartOnPlay }: AudioElementProps): React.ReactElement {
  const loadedSrc = useRef<string | undefined>(undefined)

  // Report real playing state from TrackPlayer so the reveal button stays in sync (mirrors the web seam).
  useEffect(() => {
    if (!onPlayingChange) return
    const sub = TrackPlayer.addEventListener(Event.PlaybackState, (e: { state?: unknown }) => {
      // 'playing' is the only state we treat as playing; everything else (paused/stopped/ended) → false.
      onPlayingChange(String(e?.state ?? '').toLowerCase().includes('playing'))
    })
    return () => sub.remove()
  }, [onPlayingChange])

  // Load the source once when its URL settles (decode a data: URI to a cache file for TrackPlayer). Wrapped so a
  // file-decode / TrackPlayer failure degrades to "no audio" and never red-screens (unhandled-rejection safe).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!src) return
        await ensureSetup()
        if (cancelled || loadedSrc.current === src) return
        const url = await resolveUrl(src)
        if (cancelled) return
        await TrackPlayer.reset()
        await TrackPlayer.add({ url, title: 'Voxi', artist: 'the Guide' })
        loadedSrc.current = src
        if (playing) await TrackPlayer.play()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[speech] native audio load failed:', e instanceof Error ? e.message : e)
        onPlayingChange?.(false) // don't leave the button stuck on "Stop"
      }
    })()
    return () => { cancelled = true }
  }, [src]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drive transport from the `playing` prop.
  useEffect(() => {
    void (async () => {
      await ensureSetup()
      try {
        if (playing) {
          if (seekToStartOnPlay) await TrackPlayer.seekTo(0).catch(() => {})
          await TrackPlayer.play()
        } else {
          await TrackPlayer.pause()
        }
      } catch {
        /* not loaded yet — the src effect starts playback once it lands */
      }
    })()
  }, [playing, seekToStartOnPlay])

  // Stop playback when the screen unmounts (don't leak audio into the next screen).
  useEffect(() => () => { void TrackPlayer.pause() }, [])

  return <View {...tid(id)} accessibilityRole="none" style={{ width: 0, height: 0 }} />
}
