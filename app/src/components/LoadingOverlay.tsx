/**
 * LoadingOverlay — the ONE dark-overlay loading layer over a persistent full-bleed photo (LOADING-EXPERIENCE
 * -PLAN §3.4 / §7.5). It is the identity-analysis scrim + green scan-line sweep + the shared `LoadingPill`
 * (+ fail/retry), rendered ABOVE the caller's photo so the photo never remounts. Used identically by the reveal
 * surface's pre-band state and the `/processing` alias, so the scan timing / reduce-motion / copy can't drift
 * (the adversarial A2 finding: the shared hook alone did not guarantee one rendering).
 *
 * The overlay carries the `processing.*` testIDs (loadingLine / longWaitAck / orb / failureState / retryBtn) so
 * the E2E contract migrated onto the reveal surface, unweakened. The caller controls the OVERLAY's opacity for
 * the settle cross-dissolve; the scrim is a design.md `scrim` token (flat — no gradient).
 */
import React, { useEffect, useRef } from 'react'
import { View, Animated, StyleSheet, type ViewStyle } from 'react-native'
import { LoadingPill } from './LoadingPill'
import { Button } from './ui'
import { ids, tid } from '../lib/testid'
import { space } from '../lib/theme'
import type { ThreadRun, RunKind } from '../lib/useThreadStreamRun'

const SCAN_MS = 1800

export function LoadingOverlay({
  run,
  kind,
  isRevisit,
  reduceMotion,
  onImage,
  winH,
  bottomInset,
  scrimColor,
  accentColor,
  hideStatus = false,
  style,
}: {
  run: ThreadRun
  kind: RunKind
  /** a revisit REPLAY suppresses the identity scan-line (retrieval, not re-identification). */
  isRevisit: boolean
  reduceMotion: boolean
  /** true = pill uses dark glass + light text (over a photo). */
  onImage: boolean
  winH: number
  bottomInset: number
  /** design.md `scrim` token — the flat dark overlay behind the loader. */
  scrimColor: string
  /** the green scan-line color (design.md action lane). */
  accentColor: string
  /** when the caller hosts the status itself (the reveal shows it IN the dock card, so the loading→result morph
   *  never switches position), render ONLY the scrim + scan-line here — no bottom pill. */
  hideStatus?: boolean
  /** the caller animates this (opacity) to cross-dissolve the overlay out on settle. */
  style?: Animated.WithAnimatedValue<ViewStyle>
}): React.ReactElement {
  const scanning = run.scanning
  const scan = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion || !scanning || isRevisit) {
      scan.stopAnimation()
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scan, { toValue: 1, duration: SCAN_MS, useNativeDriver: false }),
        Animated.timing(scan, { toValue: 0, duration: 0, useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduceMotion, scanning, isRevisit, scan])
  const scanY = scan.interpolate({ inputRange: [0, 1], outputRange: [0, winH || 800] })

  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents="box-none">
      {/* the flat dark scrim (design.md `scrim`) — the "dark overlay" the loader sits on; deepens on failure */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: run.failed ? 'rgba(0,0,0,0.5)' : scrimColor }]} pointerEvents="none" />

      {/* identity scan sweep — the strongest "analyzing" signal, suppressed on revisit + reduce-motion */}
      {onImage && scanning && !reduceMotion && !isRevisit ? (
        <Animated.View style={[styles.scanWrap, { transform: [{ translateY: scanY }] }]} pointerEvents="none">
          <View style={[styles.scanTrail, { backgroundColor: accentColor }]} />
          <View style={[styles.scanLine, { backgroundColor: accentColor }]} />
        </Animated.View>
      ) : null}

      {/* the bottom status pill (+ fail/retry) — carries the migrated processing.* ids. Hidden when the caller
          hosts the status itself (the reveal, which morphs the dock card in place). */}
      {!hideStatus ? (
        <View style={[styles.statusWrap, { paddingBottom: space.xxl + bottomInset }]} pointerEvents="box-none">
          <LoadingPill
            text={run.statusText}
            ack={run.ack}
            orbState={run.orb}
            onImage={onImage}
            textTestId={ids.processing.loadingLine}
            textData={{ mode: kind }}
            ackTestId={ids.processing.longWaitAck}
          />
          {run.failed ? (
            <View style={styles.failArea}>
              <View {...tid(ids.processing.failureState)} accessibilityRole="alert" />
              <Button id={ids.processing.retryBtn} label="Try again" onPress={run.retry} />
            </View>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  scanWrap: { position: 'absolute', left: 0, right: 0, top: 0 },
  scanTrail: { height: 60, opacity: 0.1 },
  scanLine: { height: 2, opacity: 0.9 },
  statusWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: space.lg, gap: space.md },
  failArea: { alignSelf: 'stretch', gap: space.md },
})
