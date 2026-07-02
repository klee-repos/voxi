/**
 * Processing (PLAN §10.2 screen 4 / D7) — EVENT-DRIVEN loading. The full-bleed captured photo is the constant
 * backdrop from viewfinder → capture → analysis → reveal (the same store-held data-URI reveal renders). A green
 * scan-line sweeps over it while the Guide identifies; a status + narrator Orb sit in a bottom pill.
 *
 * Consumes the eve NDJSON stream (api.streamThread) until a TERMINAL event, then settles → CONFIDENT/PROBABLE →
 * /reveal, UNKNOWN → /interview. Every `processing.*` id + the `?startIndex=` reconnect are UNCHANGED.
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Animated, StyleSheet, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Screen, Button } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { LoadingPill } from '../src/components/LoadingPill'
import { ids, tid } from '../src/lib/testid'
import { space } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'
import { useApi } from '../src/lib/api'
import { useCaptureStore } from '../src/state/captureStore'
import { beginThreadStream, applyStreamEvent, type StreamActions } from '../src/lib/threadStream'
import { loadingLines, firstLine, settledReveal, longWaitAck } from '../src/lib/loadingCopy'
import { haptics } from '../src/lib/haptics'
import type { OrbState } from '../src/lib/pipecat'

type Settled =
  | { kind: 'reveal'; title: string }
  | { kind: 'partial'; title: string; refinedFrom: string | null }
  | { kind: 'interview' }

export default function Processing(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion } = useTheme()
  const { height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const threadId = useCaptureStore((s) => s.threadId)
  const photoUri = useCaptureStore((s) => s.photoUri)
  const isRevisit = useCaptureStore((s) => s.isRevisit)
  const setBand = useCaptureStore((s) => s.setBand)
  const appendText = useCaptureStore((s) => s.appendText)
  const appendFact = useCaptureStore((s) => s.appendFact)
  const appendSection = useCaptureStore((s) => s.appendSection)
  const upgradeDescription = useCaptureStore((s) => s.upgradeDescription)
  const setLoadingLine = useCaptureStore((s) => s.setLoadingLine)
  const setError = useCaptureStore((s) => s.setError)
  const setResearchComplete = useCaptureStore((s) => s.setResearchComplete)
  const setResearchError = useCaptureStore((s) => s.setResearchError)
  const setLastSeenIndex = useCaptureStore((s) => s.setLastSeenIndex)

  // Fresh analysis vs revisiting a saved entry — drives the loader copy, gates OFF the identity scan-line, and
  // suppresses the celebratory haptic (a revisit is a retrieval, not a new find). Set before we navigate here,
  // so it is already correct on mount and stable for this screen's life.
  const kind = isRevisit ? 'revisit' : 'analyze'

  const [orb, setOrb] = useState<OrbState>('thinking')
  const [line, setLine] = useState(() => firstLine(kind))
  const [longWait, setLongWait] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [settled, setSettled] = useState<Settled | null>(null)
  const partialTitleRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // On band-settle we navigate to /reveal but keep the stream running so the async `fact`/`description_upgrade`
  // events keep flowing into the shared store (reveal.tsx renders reactively). `keepAlive` tells the unmount
  // cleanup NOT to abort in that case; `mounted` guards UI setState after nav. A cancel/new-capture still aborts.
  const keepAliveRef = useRef(false)
  const mountedRef = useRef(true)

  const scanning = !settled && !failed
  const scan = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion || !scanning) {
      scan.stopAnimation()
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scan, { toValue: 1, duration: 1800, useNativeDriver: false }),
        Animated.timing(scan, { toValue: 0, duration: 0, useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduceMotion, scanning, scan])

  async function run(): Promise<void> {
    if (!threadId) return
    setFailed(null)
    setOffline(false)
    setSettled(null)
    // Fresh run (initial scan OR an `unavailable`-retry re-entry): clear the terminal research flags so a resumed
    // stream re-drives the buckets loading→active/empty rather than staying stuck on a prior drop's `unavailable`.
    useCaptureStore.setState({ researchError: false, researchComplete: false })
    partialTitleRef.current = null
    setLine(firstLine(kind))
    setLoadingLine(firstLine(kind))
    setOrb('thinking')
    // Registers THIS stream as the single in-flight one (and aborts any prior), so a later in-place reveal swipe
    // can abort it — closing the keepAlive-contamination gap. Its controller doubles as this screen's cancel handle.
    const ac = beginThreadStream()
    abortRef.current = ac
    // The durable event→store writes, shared with the reveal's swipe path (threadStream.applyStreamEvent).
    const actions: StreamActions = {
      setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setBand, setResearchComplete, setResearchError,
    }

    let rotate: ReturnType<typeof setInterval> | null = null
    if (!reduceMotion) {
      const lines = loadingLines(kind)
      let i = 0
      rotate = setInterval(() => {
        i = (i + 1) % lines.length
        const next = lines[i] ?? firstLine(kind)
        setLine(next)
        setLoadingLine(next)
      }, 2500)
    }
    const longTimer = setTimeout(() => setLongWait(true), 9000)

    const settleDelay = reduceMotion ? 0 : 450
    const ui = (fn: () => void): void => { if (mountedRef.current) fn() } // skip UI setState after we navigate away
    let navigated = false
    const navTo = (path: '/reveal' | '/interview'): void => {
      if (navigated) return
      navigated = true
      if (path === '/reveal') keepAliveRef.current = true // keep the stream alive across the reveal navigation
      setTimeout(() => { if (!ac.signal.aborted) router.replace(path) }, settleDelay)
    }

    try {
      for await (const ev of api.streamThread(threadId, { signal: ac.signal })) {
        // Durable state (setLastSeenIndex + token/fact/section/description/band/done) — the SHARED reducer, so the
        // reveal's swipe path and processing can never drift on the mapping. UI/orb/line/nav/haptics stay here.
        applyStreamEvent(ev, actions)
        if (ev.type === 'token') {
          ui(() => setOrb('speaking'))
        } else if (ev.type === 'partial_id') {
          partialTitleRef.current = ev.title
          ui(() => { setOrb('thinking'); setLine(`Looks like ${ev.title}. Confirming…`) })
        } else if (ev.type === 'confidence_band') {
          // setBand already applied by applyStreamEvent — here we only route + animate.
          if (ev.band === 'CONFIDENT') {
            ui(() => { setOrb('speaking'); setSettled({ kind: 'reveal', title: ev.title }) })
            if (!isRevisit) haptics.success() // no "achievement unlocked" on a revisit — it's a retrieval
            navTo('/reveal') // INSTANT reveal; the stream keeps running for the async facts + description upgrade
          } else if (ev.band === 'PROBABLE') {
            const tentative = partialTitleRef.current
            const refinedFrom = tentative && tentative !== ev.title ? tentative : null
            ui(() => { setOrb('uncertain'); setSettled({ kind: 'partial', title: ev.title, refinedFrom }) })
            if (!isRevisit) haptics.success()
            navTo('/reveal')
          } else {
            ui(() => { setOrb('uncertain'); setSettled({ kind: 'interview' }) })
            if (!isRevisit) haptics.warning()
            navTo('/interview')
            break // UNKNOWN hands off to the interview — no async research to keep streaming for
          }
        } else if (ev.type === 'error') {
          // A terminal error AFTER the band settled is a swallowed phase-2 research failure (the cascade never emits
          // one, but be defensive): resolve loading buckets to `empty`, keep the reveal. A PRE-band error is the
          // real phase-1 hard-failure / refusal → the existing error path (drives the refund + failure screen).
          if (navigated) { setResearchComplete(); return }
          ui(() => { setOrb('uncertain'); setFailed(ev.message || ev.code) })
          haptics.error()
          setError(ev.message || ev.code)
          return
        } else if (ev.type === 'done') {
          // The async research stream ended — a still-loading bucket now settles to `empty` (never perpetual).
          // applyStreamEvent already made the unguarded `setResearchComplete()` write (ui() is a post-nav no-op).
          break
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      // A network drop / stream error. POST-band (already on the reveal): flip loading buckets to `unavailable`
      // (retriable) via an UNGUARDED store write — NOT `empty` (that would falsely claim the object has nothing to
      // know). PRE-band: the existing hard-failure display (a genuine identification failure, not a research gap).
      if (navigated) { setResearchError(); return }
      ui(() => { setOrb('uncertain'); setOffline(true); setFailed(e instanceof Error ? e.message : 'stream_failed') })
      haptics.error()
      return
    } finally {
      if (rotate) clearInterval(rotate)
      clearTimeout(longTimer)
    }

    // Safety net: the stream ended without ever settling a band (no error either) → fall back to the store outcome.
    if (!navigated && mountedRef.current) {
      const outcome = useCaptureStore.getState().outcome
      setTimeout(() => { if (!ac.signal.aborted) router.replace(outcome === 'interview' ? '/interview' : '/reveal') }, settleDelay)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    keepAliveRef.current = false
    void run()
    return () => {
      mountedRef.current = false
      // Abort ONLY on a genuine unmount (cancel / a new capture). When we navigated to /reveal we set keepAlive so
      // the background stream keeps delivering the async facts to the store.
      if (!keepAliveRef.current) abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  function cancel(): void {
    keepAliveRef.current = false
    abortRef.current?.abort()
    router.replace('/(tabs)/camera')
  }

  const orbState: OrbState = failed ? 'uncertain' : settled ? (settled.kind === 'reveal' ? 'speaking' : 'uncertain') : orb
  const statusText = failed
    ? "I couldn't get a clear read on that one. The fault is mine, not yours."
    : settled
      ? settled.kind === 'reveal'
        ? settledReveal(kind, settled.title)
        : settled.kind === 'partial'
          ? settled.refinedFrom
            ? `On closer look it's ${settled.title}, not ${settled.refinedFrom}. I've confirmed it.`
            : `A confident maybe: ${settled.title}.`
          : "I don't know this one — yet. Let's write its entry together."
      : line
  const scanY = scan.interpolate({ inputRange: [0, 1], outputRange: [0, winH || 800] })
  const onImage = !!photoUri

  return (
    <Screen id={ids.processing.screen} padded={false} style={{ minHeight: winH }}>
      {/* full-bleed captured image — same framing as the viewfinder + reveal */}
      <View style={StyleSheet.absoluteFill}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: surface.card }]}>
            <Orb id={ids.processing.orb} state={orbState} size={96} />
          </View>
        )}
      </View>

      {/* scan sweep over the full image — the identity scan is the strongest "analyzing" signal, so it is
          suppressed on a REVISIT (a replay is retrieval, not re-identification). */}
      {onImage && scanning && !reduceMotion && !isRevisit ? (
        <Animated.View style={[styles.scanWrap, { transform: [{ translateY: scanY }] }]} pointerEvents="none">
          <View style={[styles.scanTrail, { backgroundColor: surface.accent }]} />
          <View style={[styles.scanLine, { backgroundColor: surface.accent }]} />
        </Animated.View>
      ) : null}
      {failed && onImage ? <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: 0.35 }]} pointerEvents="none" /> : null}

      {/* Back chevron over the photo that ABORTS the scan and returns to camera. Absolute overlay so it floats
          on the full-bleed backdrop; the header self-insets. */}
      <View style={styles.headerOverlay} pointerEvents="box-none">
        <AppHeader leading="back" onMedia onLeadingPress={cancel} />
      </View>
      <OfflineBanner visible={offline} />

      {/* status over the image */}
      <View style={[styles.statusWrap, { paddingBottom: space.xxl + insets.bottom }]} pointerEvents="box-none">
        <LoadingPill
          text={statusText}
          ack={longWait && scanning ? longWaitAck(kind) : undefined}
          orbState={orbState}
          onImage={onImage}
          textTestId={ids.processing.loadingLine}
          textData={{ mode: kind }}
          ackTestId={ids.processing.longWaitAck}
        />
        {failed ? (
          <View style={styles.failArea}>
            <View {...tid(ids.processing.failureState)} accessibilityRole="alert" />
            <Button id={ids.processing.retryBtn} label="Try again" onPress={() => void run()} />
          </View>
        ) : null}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 },
  scanWrap: { position: 'absolute', left: 0, right: 0, top: 0 },
  scanTrail: { height: 60, opacity: 0.1 },
  scanLine: { height: 2, opacity: 0.9 },
  statusWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: space.lg, gap: space.md },
  failArea: { alignSelf: 'stretch', gap: space.md },
})
