/**
 * Deep Dive player (§F2) — an on-demand, NPR/Serial-style two-voice story (Arlo & Mave), presented as a
 * DARK, full-screen, Spotify-style player: a large word-level karaoke read-along (the hero), a seekable scrubber,
 * and ±15 / play-pause transport. It is NEVER auto-generated: opening PROBES for a durable episode
 * (GET /v1/threads/:id) and, absent one, shows an EXPLICIT "Generate a Deep Dive" CTA; generation (which spends a
 * credit) only fires on that tap (adversarial D2/D7).
 *
 * Generation is owned by `deepDiveStore` — a MODULE-LEVEL poller that survives this screen's unmount, so leaving
 * mid-compose does not stop it (the reveal dock shows a "generating" ring meanwhile), and returning shows the live
 * state or the finished audio. This screen renders from that store; it holds only playhead + playing UI state.
 *
 * State (honest, never masked): probing · idle (Generate CTA) · composing (the large ComposeHero + elapsed) ·
 * slow (non-terminal "still rendering", NOT a failure) · ready (the player) · failed (apology + retry/paywall) ·
 * empty (no thread → back to capture). Route/file stay `/podcast`; only user-facing copy is "Deep Dive".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, StyleSheet, Pressable, Text } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useRouter } from 'expo-router'
import { RefreshCw } from 'lucide-react-native'
import { Screen, Title, Body, Muted, Button } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { AudioElement, type AudioHandle } from '../src/components/AudioElement'
import { Orb } from '../src/components/Orb'
import { ComposeHero } from '../src/components/ComposeHero'
import { Scrubber } from '../src/components/Scrubber'
import { PlayerTransport } from '../src/components/PlayerTransport'
import { KaraokeTranscript } from '../src/components/KaraokeTranscript'
import { OfflineBanner } from '../src/components/Banners'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid, tidWith } from '../src/lib/testid'
import { space, typeStyles, type as typeTokens, hit } from '../src/lib/theme'
import { useApi } from '../src/lib/api'
import { useConnectivity } from '../src/lib/connectivity'
import { useCaptureStore } from '../src/state/captureStore'
import { startDeepDive, regenerateDeepDive, seedReadyDeepDive, useDeepDiveStatus } from '../src/state/deepDiveStore'

function DeepDiveBody(): React.ReactElement {
  const api = useApi()
  const router = useRouter()
  const { surface, reduceMotion } = useTheme()
  const offline = !useConnectivity().online
  const threadId = useCaptureStore((s) => s.threadId)
  const title = useCaptureStore((s) => s.title)

  const status = useDeepDiveStatus(threadId)
  const [probed, setProbed] = useState(false)

  // Playhead + playing (UI-only). Reset the playhead when a new audio arrives.
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef<AudioHandle>(null)

  const closeHeader = <AppHeader leading="none" showClose />

  // PROBE on mount — a durable Deep Dive already? seed the store to READY (no charge, no generate). NEVER compose here.
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!threadId) { setProbed(true); return }
      try {
        const t = await api.getThread(threadId)
        if (!alive) return
        const p = t.podcast
        if (p?.state === 'ready' && p.audioUrl) seedReadyDeepDive(threadId, p.audioUrl, p.transcript as { speaker: 'ARLO' | 'MAVE'; text: string }[] | undefined)
      } catch {
        /* probe is best-effort — an idle CTA is the safe fallback */
      } finally {
        if (alive) setProbed(true)
      }
    })()
    return () => { alive = false }
  }, [threadId, api])

  const onGenerate = useCallback((): void => {
    if (threadId) startDeepDive(api, { threadId, subject: title })
  }, [api, threadId, title])

  // On a limit failure the recovery is the paywall; otherwise a retry re-enters the (idempotent) generate.
  const onRetry = useCallback((): void => {
    if (status.failReason === 'limit') { router.push('/paywall'); return }
    onGenerate()
  }, [status.failReason, onGenerate, router])

  const onReport = useCallback((): void => {
    if (threadId) void api.report({ targetId: threadId, kind: 'episode' })
  }, [api, threadId])

  // Regenerate (retest affordance) — force a FRESH deep dive at a new version. Reset the local playhead so the
  // fresh episode's transport starts clean; the store guard collapses a sub-frame double-tap (no double charge).
  const onRegenerate = useCallback((): void => {
    if (!threadId) return
    setPlaying(false)
    setPosition(0)
    setDuration(0)
    regenerateDeepDive(api, { threadId, subject: title })
  }, [api, threadId, title])

  // ---- EMPTY ----
  if (!threadId) {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>No Deep Dive yet</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center' }}>
          Arlo and Mave need a subject. Photograph an object and I'll have them put together its story.
        </Body>
        <Button id={ids.podcast.generate} label="Capture an object" onPress={() => router.replace('/(tabs)/camera')} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- PROBING ----
  if (!probed && status.state === 'idle') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Muted style={{ marginTop: space.xl, textAlign: 'center' }}>One moment…</Muted>
      </Screen>
    )
  }

  // ---- IDLE: the EXPLICIT generate CTA ----
  if (status.state === 'idle') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>A Deep Dive on {title || 'this object'}</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center', maxWidth: 340 }}>
          A short two-voice story — Arlo and Mave dig into what it is, where it came from, and why it matters. It
          takes a moment to put together.
        </Body>
        <Button id={ids.podcast.generate} label="Generate a Deep Dive" onPress={onGenerate} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- COMPOSING: the large "how long" hero (survives if you leave — the dock shows a generating ring). ----
  if (status.state === 'composing') {
    return (
      <Screen id={ids.podcast.player} header={closeHeader}>
        <OfflineBanner visible={offline} />
        <View {...tid(ids.podcast.composingState)} style={styles.fill}>
          <ComposeHero
            startedAt={status.startedAt}
            title={`A Deep Dive on ${title || 'this object'}`}
            copy={offline ? "You're offline — I'll keep composing the moment you're back." : 'Arlo and Mave are digging in. This usually takes a minute or two.'}
            surface={surface}
          />
        </View>
      </Screen>
    )
  }

  // ---- SLOW: non-terminal, NOT a failure ----
  if (status.state === 'slow') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="thinking" />
        <Body {...tid(ids.podcast.stillComposing)} style={{ marginTop: space.xl, textAlign: 'center', maxWidth: 360 }}>
          This one's taking a while — Arlo and Mave are still at it. It'll be here when it's ready; keep waiting or
          check back in a moment.
        </Body>
        <Button id={ids.podcast.playPause} label="Keep waiting" onPress={onGenerate} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- FAILED ----
  if (status.state === 'failed') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="uncertain" />
        <Body style={{ marginTop: space.xl, textAlign: 'center', maxWidth: 360 }}>
          {status.failReason === 'limit'
            ? "You've used this period's fresh Deep Dives. Cached ones are still free — or you can top up for a fresh one."
            : status.failReason === 'network'
              ? "I couldn't reach the studio. Check your connection and I'll have another go."
              : "I couldn't verify enough to tell this one properly, so I held it back. Better silent than wrong."}
        </Body>
        <Button id={ids.podcast.playPause} label={status.failReason === 'limit' ? 'See plans' : 'Try again'} onPress={onRetry} style={{ marginTop: space.lg }} />
        <Button id={ids.podcast.reportEpisode} label="Report this Deep Dive" variant="secondary" onPress={onReport} style={{ marginTop: space.sm }} />
      </Screen>
    )
  }

  // ---- READY: the dark Spotify-style player — karaoke hero + scrubber + transport. ----
  const transcript = (status.transcript ?? []) as { speaker: 'ARLO' | 'MAVE'; text: string }[]
  const onProgress = (pos: number, dur: number): void => {
    setPosition(pos)
    if (Number.isFinite(dur) && dur > 0) setDuration(dur)
    // End of the episode → reset the button to "play". `playing` is USER INTENT only; it is NOT mirrored from the
    // hardware PlaybackState (on native those async play/buffer/pause events fought the user's tap — that mirror was
    // the transport bug: pause bounced back to play, and skip/seek looked dead because playback never settled).
    if (Number.isFinite(dur) && dur > 0 && pos >= dur - 0.35) setPlaying(false)
  }
  // The ready player's header carries a regenerate control immediately LEFT of the close X (retest affordance).
  const readyHeader = (
    <AppHeader
      leading="none"
      showClose
      rightAccessory={
        <Pressable {...tid(ids.podcast.regenerate, 'Regenerate Deep Dive')} accessibilityRole="button" onPress={onRegenerate} hitSlop={12} style={styles.headerCtrl}>
          <RefreshCw size={22} color={surface.text} strokeWidth={2.5} />
        </Pressable>
      }
    />
  )
  return (
    <Screen id={ids.podcast.player} padded={false} header={readyHeader}>
      <OfflineBanner visible={offline} />
      <AudioElement ref={audioRef} id={ids.podcast.audio} src={status.audioUrl} playing={playing} onProgress={onProgress} />
      {/* off-layout state anchor so the E2E + Maestro can assert the transport actually drives playback (playing
          sticks on tap; position advances/seeks) — the native-transport regression proof. */}
      <View {...tidWith(ids.podcast.playerState, { playing: String(playing), pos: String(Math.floor(position)) })} style={styles.srOnly} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <View style={styles.playerBody}>
        {transcript.length ? (
          <KaraokeTranscript transcript={transcript} positionSec={position} durationSec={duration} surface={surface} reduceMotion={reduceMotion} />
        ) : (
          <View style={styles.noTranscript}>
            <Orb id={ids.processing.orb} state={playing ? 'speaking' : 'idle'} size={96} />
            <Muted style={{ marginTop: space.xl, textAlign: 'center' }}>A Deep Dive · Arlo &amp; Mave</Muted>
          </View>
        )}

        <View {...tid(ids.podcast.cover)} style={styles.dock}>
          <Text accessibilityRole="header" numberOfLines={1} style={[typeStyles.heading, styles.dockTitle, { color: surface.text }]}>{title || 'A Deep Dive'}</Text>
          <Muted style={{ marginBottom: space.md }}>A Deep Dive · Arlo &amp; Mave</Muted>
          <Scrubber positionSec={position} durationSec={duration} onSeek={(s) => audioRef.current?.seekTo(s)} surface={surface} />
          <View style={styles.transport}>
            <PlayerTransport
              playing={playing}
              onPlayPause={() => setPlaying((p) => !p)}
              onSkipBack={() => audioRef.current?.seekBy(-15)}
              onSkipForward={() => audioRef.current?.seekBy(15)}
              surface={surface}
            />
          </View>
          <Pressable {...tid(ids.podcast.reportEpisode, 'Report this Deep Dive')} accessibilityRole="button" onPress={onReport} hitSlop={8} style={styles.report}>
            <Text style={[typeStyles.footnote, { color: surface.textMuted }]}>Report</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  )
}

export default function DeepDive(): React.ReactElement {
  return (
    <SurfaceProvider surface="dark">
      {/* Now full-screen (fullScreenModal), the near-black surface extends under the notch, so force LIGHT
          status-bar glyphs — legible on #17181A where the app's global dark glyphs would vanish. Mounted here at
          the wrapper (not in a DeepDiveBody branch) so it covers every state — composing, ready, all of them — and
          reverts to the global dark bar when the screen pops (expo-status-bar is last-mounted-wins; no-op on web). */}
      <StatusBar style="light" />
      <DeepDiveBody />
    </SurfaceProvider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  playerBody: { flex: 1, paddingHorizontal: space.xl, paddingTop: space.md },
  noTranscript: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // The Screen's SafeAreaView already insets the bottom (home indicator) — keep the dock's own bottom padding
  // small so the controls sit close to the edge (no double gap under the play row).
  dock: { paddingTop: space.md, paddingBottom: space.xs },
  dockTitle: { fontFamily: typeTokens.family.sans['800'] },
  transport: { marginTop: space.md },
  report: { alignSelf: 'center', marginTop: space.md, minHeight: 32, justifyContent: 'center' },
  headerCtrl: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  srOnly: { position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 },
})
