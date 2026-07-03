/**
 * Deep Dive player (§F2) — an on-demand, NPR/Serial-style two-voice story (Arlo & Mave) about the object, with a
 * per-speaker read-along transcript, scrubber + 15s skip, and a report control. It is NEVER auto-generated:
 * opening this screen PROBES for a durable episode (GET /v1/threads/:id) and, absent one, shows an EXPLICIT
 * "Generate a Deep Dive" button — generation (which spends a credit) only fires on that tap (adversarial D2/D7).
 *
 * State matrix (honest, never masked):
 *   probing   — checking for an existing Deep Dive (no charge, no generation);
 *   idle      — none yet → the explicit Generate CTA (the "external button");
 *   composing — the owned ~15–60s wait after Generate, orb "thinking";
 *   slow      — the poll budget lapsed but the worker may STILL be rendering → a non-terminal "check back",
 *               NOT the "held it back" fail copy (the worker's idleTimeout far exceeds our poll window);
 *   ready     — the player + read-along transcript (the REAL validated script; no fabricated placeholder);
 *   failed    — the worker returned `failed`, or the credit is spent (402 → paywall) → honest apology + retry;
 *   empty     — deep-linked with no thread to narrate → route back to a capture.
 * Route/file stay `/podcast` (converge header-entry + run-sc-podcast couple to them); only user-facing copy is
 * "Deep Dive" — never "podcast" / "episode".
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
type PlayerState = 'probing' | 'idle' | 'composing' | 'slow' | 'ready' | 'failed'

// The worker's idleTimeout (240s) far exceeds a naive 45s poll; a longer Serial render routinely needs >45s, so we
// poll generously and, on exhaustion, fall to a NON-terminal "slow" state — never a fabricated "held it back" fail.
const POLL_MS = 2000
const POLL_MAX = 90 // ~180s

function DeepDiveBody(): React.ReactElement {
  const api = useApi()
  const router = useRouter()
  const { surface, reduceMotion } = useTheme()
  const offline = !useConnectivity().online
  // threadId doubles as the catalog/session key the Deep Dive is gated + reported against.
  const threadId = useCaptureStore((s) => s.threadId)
  const title = useCaptureStore((s) => s.title)

  const [state, setState] = useState<PlayerState>('probing')
  const [playing, setPlaying] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | undefined>(undefined)
  const [transcript, setTranscript] = useState<Line[]>([])
  const [failReason, setFailReason] = useState<'limit' | 'render' | 'network' | null>(null)
  const cancelledRef = useRef(false)

  // Modal dismiss X, guarded → fallback camera on deep-link/reload. Present on EVERY state incl. READY.
  const closeHeader = <AppHeader leading="none" showClose />

  const compose = useCallback(async (): Promise<void> => {
    cancelledRef.current = false
    setState('composing')
    setFailReason(null)
    if (!threadId) return // EMPTY — handled below before any network call
    try {
      // Idempotent per (user, item, version): a still-composing or ready item resumes WITHOUT a second charge.
      const { token } = await api.generatePodcast({ catalogItemId: threadId, version: 1, subject: title || undefined })
      for (let i = 0; i < POLL_MAX && !cancelledRef.current; i++) {
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
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
      // Poll budget lapsed — the worker may STILL be rendering. Do NOT fake a failure; offer to keep waiting.
      if (!cancelledRef.current) setState('slow')
    } catch (e) {
      if (cancelledRef.current) return
      // 402 = scan/Deep Dive entitlement exhausted → paywall is the recovery.
      if (e instanceof ApiError && e.status === 402) setFailReason('limit')
      else setFailReason(offline ? 'network' : 'render')
      setState('failed')
    }
  }, [api, threadId, title, offline])

  // PROBE on mount — look for a durable Deep Dive; NEVER auto-generate (the credit-spending compose only fires on
  // the explicit CTA). A ready episode plays straight away with no re-gate, no re-charge (durable replay).
  useEffect(() => {
    cancelledRef.current = false
    let alive = true
    void (async () => {
      if (!threadId) return // the EMPTY branch renders below
      try {
        const t = await api.getThread(threadId)
        if (!alive) return
        const p = t.podcast
        if (p?.state === 'ready' && p.audioUrl) {
          setAudioUrl(p.audioUrl)
          if (p.transcript?.length) setTranscript(p.transcript as Line[])
          setState('ready')
        } else {
          setState('idle') // none / composing / failed → the user explicitly (re)generates; compose is idempotent
        }
      } catch {
        if (alive) setState('idle')
      }
    })()
    return () => { alive = false; cancelledRef.current = true }
  }, [threadId, api])

  // ---- EMPTY: deep-linked here with no thread to narrate. ----
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

  // ---- PROBING: checking for an existing Deep Dive (brief; no charge). ----
  if (state === 'probing') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Muted style={{ marginTop: space.xl, textAlign: 'center' }}>One moment…</Muted>
      </Screen>
    )
  }

  // ---- IDLE: the EXPLICIT generate CTA (the "external button"; generation never auto-fires). ----
  if (state === 'idle') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>A Deep Dive on {title || 'this object'}</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center', maxWidth: 340 }}>
          A short two-voice story — Arlo and Mave dig into what it is, where it came from, and why it matters. It
          takes a moment to put together.
        </Body>
        <Button id={ids.podcast.generate} label="Generate a Deep Dive" onPress={() => void compose()} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- COMPOSING: the owned wait after Generate. ----
  if (state === 'composing') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="thinking" />
        <Body {...tid(ids.podcast.composingState)} style={{ marginTop: space.xl, textAlign: 'center' }}>
          {offline
            ? "I'll compose your Deep Dive the moment you're back online — Arlo and Mave aren't going anywhere."
            : 'Composing your Deep Dive. Arlo and Mave are arguing about the details — give them a moment.'}
        </Body>
      </Screen>
    )
  }

  // ---- SLOW: poll budget lapsed but the worker may STILL be rendering — non-terminal, NOT a failure. ----
  if (state === 'slow') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="thinking" />
        <Body {...tid(ids.podcast.stillComposing)} style={{ marginTop: space.xl, textAlign: 'center', maxWidth: 360 }}>
          This one's taking a while — Arlo and Mave are still at it. It'll be here when it's ready; keep waiting or
          check back in a moment.
        </Body>
        <Button id={ids.podcast.playPause} label="Keep waiting" onPress={() => void compose()} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- FAILED: never a dead screen — honest apology, retry, paywall (on limit), report still reachable. ----
  if (state === 'failed') {
    return (
      <Screen id={ids.podcast.player} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="uncertain" />
        <Body style={{ marginTop: space.xl, textAlign: 'center', maxWidth: 360 }}>
          {failReason === 'limit'
            ? "You've used this period's fresh Deep Dives. Cached ones are still free — or you can top up for a fresh one."
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
          label="Report this Deep Dive"
          variant="secondary"
          onPress={() => void api.report({ targetId: threadId, kind: 'episode' })}
          style={{ marginTop: space.sm }}
        />
      </Screen>
    )
  }

  // ---- READY: the player + read-along transcript (the REAL validated script — never a fabricated placeholder). ----
  return (
    <Screen id={ids.podcast.player} header={closeHeader}>
      <OfflineBanner visible={offline} />
      <AudioElement id={ids.podcast.audio} src={audioUrl} playing={playing} />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }}>
        <FadeRise reduceMotion={reduceMotion}>
          <View {...tid(ids.podcast.cover)} style={[styles.cover, { backgroundColor: surface.card }]}>
            <Orb id={ids.processing.orb} state="speaking" size={80} />
            <Title style={{ marginTop: space.md, textAlign: 'center' }}>{title || 'A Deep Dive'}</Title>
            <Muted style={{ marginTop: space.xs }}>A Deep Dive · Arlo &amp; Mave</Muted>
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
            {transcript.map((l, i) => (
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

export default function DeepDive(): React.ReactElement {
  return (
    <SurfaceProvider surface="parchment">
      <DeepDiveBody />
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
