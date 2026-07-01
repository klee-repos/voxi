/**
 * Podcast player (PLAN §10.2 screen 7 / §6.2) — two AI hosts Arlo & Mave with a per-speaker visual system in
 * the read-along transcript (D8), generative cover, scrubber + 15s skip, and a report-episode control. Honest
 * latency: a single-call render means a 15–40s "composing your episode" wait — podcast.composingState renders
 * while polling GET /v1/podcast/:token after POST /v1/podcast gates the paid generation. On ready it streams
 * HLS via react-native-track-player (native; the web shell shows the player chrome). Parchment read-along.
 *
 * State matrix (PLAN §10.2 D1 — {loading, empty, error, offline}, honestly, not masked):
 *   loading (composing) — POST gated, polling status; the owned 15–40s wait, orb "thinking";
 *   empty               — no thread to compose against (deep-linked cold) → route back to a capture;
 *   error (failed)      — gate refused (402 → paywall) OR the worker returned `failed` → in-persona apology,
 *                         retry, and report-episode still reachable (never a dead screen);
 *   offline             — global.offlineBanner pins to the top; we don't fabricate "ready" when the network is
 *                         down (the previous version's silent fall-through to ready is removed).
 * Reduce-motion (PLAN §10.3): the cover cross-fades in instead of rising; the orb honors the flag itself.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, Button } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { AudioElement } from '../src/components/AudioElement'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { FadeRise } from '../src/components/FadeRise'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid, tidWith } from '../src/lib/testid'
import { onColorInk, radius, space, speakers, type as typeTokens } from '../src/lib/theme'
import { useApi } from '../src/lib/api'
import { useConnectivity } from '../src/lib/connectivity'
import { ApiError } from '../src/lib/apiClient'
import { useCaptureStore } from '../src/state/captureStore'
import { seekBy } from '../src/lib/audioControls'

type Speaker = 'ARLO' | 'MAVE'
interface Line { speaker: Speaker; text: string }
type PlayerState = 'composing' | 'ready' | 'failed'

const SAMPLE: Line[] = [
  { speaker: 'ARLO', text: "Right, this is a cracking little object — let me tell you why it matters." },
  { speaker: 'MAVE', text: "Before you wax lyrical, can we source that claim? I'll allow it only if we can." },
  { speaker: 'ARLO', text: 'Fair. Two independent references say the same thing, so on we go.' },
  { speaker: 'MAVE', text: 'Good. Then the record stands. Carry on — but mind the superlatives.' },
]

function PodcastBody(): React.ReactElement {
  const api = useApi()
  const router = useRouter()
  const { surface, reduceMotion } = useTheme()
  const offline = !useConnectivity().online
  // threadId doubles as the catalog/session key the podcast is gated + reported against.
  const threadId = useCaptureStore((s) => s.threadId)
  const title = useCaptureStore((s) => s.title)

  const [state, setState] = useState<PlayerState>('composing')
  const [playing, setPlaying] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | undefined>(undefined)
  const [transcript, setTranscript] = useState<Line[]>([])
  const [failReason, setFailReason] = useState<'limit' | 'render' | 'network' | null>(null)
  const cancelledRef = useRef(false)

  // Modal dismiss X (right slot), guarded → fallback camera on deep-link/reload. Present on EVERY state incl.
  // READY (which previously had no close control on web — a latent trap this fixes).
  const closeHeader = <AppHeader leading="none" showClose />

  const compose = useCallback(async (): Promise<void> => {
    cancelledRef.current = false
    setState('composing')
    setFailReason(null)
    if (!threadId) return // EMPTY — handled below before any network call
    try {
      const { token } = await api.generatePodcast({ catalogItemId: threadId, version: 1, subject: title || undefined })
      // Poll the worker via the BFF; it never fabricates "ready". We honestly surface failed/timeout.
      for (let i = 0; i < 45 && !cancelledRef.current; i++) {
        const st = await api.podcastStatus(token)
        if (st.state === 'ready') {
          setAudioUrl(st.audioUrl)
          if (st.transcript?.length) setTranscript(st.transcript as Line[])
          setState('ready')
          return
        }
        if (st.state === 'failed') {
          setFailReason('render')
          setState('failed')
          return
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (!cancelledRef.current) {
        // Timed out without a terminal status — treat as a render failure rather than faking "ready".
        setFailReason('render')
        setState('failed')
      }
    } catch (e) {
      if (cancelledRef.current) return
      // 402 = scan/podcast entitlement exhausted → paywall is the recovery (PLAN §13 / §6.4).
      if (e instanceof ApiError && e.status === 402) setFailReason('limit')
      else setFailReason(offline ? 'network' : 'render')
      setState('failed')
    }
  }, [api, threadId, offline])

  useEffect(() => {
    void compose()
    return () => { cancelledRef.current = true }
  }, [compose])

  // ---- EMPTY: deep-linked here with no thread to narrate. ----
  if (!threadId) {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>No episode yet</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center' }}>
          Arlo and Mave need a subject. Photograph an object and I'll have them put together its story.
        </Body>
        <Button id={ids.podcast.playPause} label="Capture an object" onPress={() => router.replace('/(tabs)/camera')} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- LOADING (composing): the owned 15–40s wait. ----
  if (state === 'composing') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="thinking" />
        <Body {...tid(ids.podcast.composingState)} style={{ marginTop: space.xl, textAlign: 'center' }}>
          {offline
            ? "I'll compose your episode the moment you're back online — Arlo and Mave aren't going anywhere."
            : 'Composing your episode. Arlo and Mave are arguing about the details — give them a moment.'}
        </Body>
      </Screen>
    )
  }

  // ---- ERROR (failed): never a dead screen — apology, retry, paywall (on limit), and report still reachable. ----
  if (state === 'failed') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="uncertain" />
        <Body style={{ marginTop: space.xl, textAlign: 'center', maxWidth: 360 }}>
          {failReason === 'limit'
            ? "You've used this period's fresh episodes. Cached community episodes are still free — or you can top up for a fresh one."
            : failReason === 'network'
              ? "I couldn't reach the studio. Check your connection and I'll have another go."
              : "I couldn't verify enough to tell this one properly, so I held it back. Better silent than wrong."}
        </Body>
        {failReason === 'limit' ? (
          <Button id={ids.podcast.playPause} label="See plans" onPress={() => router.push('/paywall')} style={{ marginTop: space.lg }} />
        ) : (
          <Button id={ids.podcast.playPause} label="Try again" onPress={() => void compose()} style={{ marginTop: space.lg }} />
        )}
        <Button
          id={ids.podcast.reportEpisode}
          label="Report this episode"
          variant="secondary"
          onPress={() => void api.report({ targetId: threadId, kind: 'episode' })}
          style={{ marginTop: space.sm }}
        />
      </Screen>
    )
  }

  // ---- READY: the player + read-along transcript. ----
  return (
    <Screen id={ids.podcast.player} header={closeHeader}>
      <OfflineBanner visible={offline} />
      <AudioElement id={ids.podcast.audio} src={audioUrl} playing={playing} />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }}>
        <FadeRise reduceMotion={reduceMotion}>
          <View {...tid(ids.podcast.cover)} style={[styles.cover, { backgroundColor: surface.card }]}>
            <Orb id={ids.processing.orb} state="speaking" size={80} />
            <Title style={{ marginTop: space.md, textAlign: 'center' }}>{title || 'An Episode'}</Title>
            <Muted style={{ marginTop: space.xs }}>Arlo &amp; Mave · the Guide</Muted>
          </View>

          <View style={styles.controls}>
            <Button id={ids.podcast.playPause} label={playing ? 'Pause' : 'Play'} onPress={() => setPlaying((p) => !p)} />
            <Button id={ids.podcast.skip15} label="+15s" variant="secondary" onPress={() => void seekBy(15)} />
            <Button
              id={ids.podcast.reportEpisode}
              label="Report"
              variant="secondary"
              onPress={() => void api.report({ targetId: threadId, kind: 'episode' })}
            />
          </View>

          <View style={styles.transcript}>
            {(transcript.length ? transcript : SAMPLE).map((l, i) => (
              <View key={i} {...tidWith(ids.podcast.transcriptLine, { speaker: l.speaker })} style={styles.lineRow}>
                <View style={[styles.speakerTag, { backgroundColor: speakers[l.speaker].color }]}>
                  <Muted style={{ color: onColorInk, fontFamily: typeTokens.family.sans['600'] }}>{speakers[l.speaker].name}</Muted>
                </View>
                <Body style={{ flex: 1 }}>{l.text}</Body>
              </View>
            ))}
          </View>
        </FadeRise>
      </ScrollView>
    </Screen>
  )
}

export default function Podcast(): React.ReactElement {
  return (
    <SurfaceProvider surface="parchment">
      <PodcastBody />
    </SurfaceProvider>
  )
}

const styles = StyleSheet.create({
  cover: { alignItems: 'center', padding: space.xl, borderRadius: radius.lg },
  controls: { flexDirection: 'row', gap: space.md, marginTop: space.lg, flexWrap: 'wrap' },
  transcript: { marginTop: space.xl, gap: space.md },
  lineRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  speakerTag: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, minWidth: 56, alignItems: 'center' },
})
