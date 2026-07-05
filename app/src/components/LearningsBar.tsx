/**
 * The "Initial learnings" bar — a FIXED-HEIGHT slot above the dock during research (INITIAL-LEARNINGS-PLAN F1/F3).
 * Rotates through the grounded learnings one at a time (TikTok-style cycle-up): the slot starts at "Researching"
 * + three pulsing dots, then cycles through the facts + grounded sections as they arrive (a timed rotation, so the
 * bar stays alive — newest entries join the rotation). The slot NEVER changes height (2-line, numberOfLines={2},
 * maxHeight-clipped) whatever the fact length. Full text rides the accessibilityLabel.
 *
 * On `researchComplete` the bar FLIES OUT: the current learning spawns a clone that travels bar-slot → Details-icon
 * (measured via the threaded detailsIconRef; falls back to a downward travel if the icon isn't laid out yet — B2),
 * the Details icon spring-bounces + a count badge lands (driven by the caller via the onFlyLand callback), and the
 * bar fades + slides down. Then onDone() so the caller unmounts it.
 *
 * Converge-safe (GATE B fold A): core RN `Animated` (`useNativeDriver:false`) — NO react-native-reanimated import.
 * reduceMotion: the cycle becomes an opacity cross-fade + the fly degrades to an instant cross-fade (B5).
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Animated, Easing, StyleSheet, type ViewStyle, type TextStyle, type LayoutRectangle } from 'react-native'
import { useTheme } from '../lib/themeProvider'
import { motion, radius, space, typeStyles } from '../lib/theme'
import { ids, tid, tidWith } from '../lib/testid'
import { currentLearning, learningsList } from '../lib/learnings'
import { computeFlyPath, rectIsValid, type Rect } from '../lib/learningsFly'
import type { RevealFact, RevealSection, SectionBucket } from '../state/captureStore'

type Surface = ReturnType<typeof useTheme>['surface']

const CYCLE_MS = 2800
const SLOT_HEIGHT = 56 // fixed: 2-line at the slot's type size; maxHeight clips, never grows (B8)
const FLY_FALLBACK_DX = 0
const FLY_FALLBACK_DY = 96 // if the icon rect isn't measurable, the clone travels downward toward the dock zone

/** Three pulsing dots (mirrors RevealTopBar's IdentifyingDots — the pre-name "working" signal). */
function PulseDots({ reduceMotion, color }: { reduceMotion: boolean; color: string }): React.ReactElement {
  const ops = useRef([new Animated.Value(1), new Animated.Value(1), new Animated.Value(1)]).current
  useEffect(() => {
    if (reduceMotion) {
      ops.forEach((o) => o.setValue(1))
      return
    }
    const runs = ops.map((o, i) => {
      o.setValue(0.3)
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(o, { toValue: 1, duration: 600, useNativeDriver: false }),
          Animated.timing(o, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        ]),
      )
      const start = setTimeout(() => loop.start(), i * 200)
      return { loop, start }
    })
    return () => {
      runs.forEach(({ loop, start }) => { clearTimeout(start); loop.stop() })
      ops.forEach((o) => o.stopAnimation())
    }
  }, [reduceMotion, ops])
  return (
    <View style={styles.dots} pointerEvents="none" aria-hidden accessibilityElementsHidden>
      {ops.map((o, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: o, backgroundColor: color }]} />
      ))}
    </View>
  )
}

export function LearningsBar({
  facts,
  sections,
  researchComplete,
  reduceMotion,
  detailsIconRef,
  onFlyLand,
  onDone,
}: {
  facts: RevealFact[]
  sections: Partial<Record<SectionBucket, RevealSection>>
  researchComplete: boolean
  reduceMotion: boolean
  /** ref to the Details dock icon — the fly's target (threaded via BucketDock). Null until the dock reappears. */
  detailsIconRef: React.RefObject<View | null>
  /** fired when the clone reaches the icon — the caller bounces the Details icon + lands the count badge. */
  onFlyLand: () => void
  /** fired when the bar's exit animation finishes — the caller unmounts it. */
  onDone: () => void
}): React.ReactElement | null {
  const surface = useTheme().surface
  const [cycleIndex, setCycleIndex] = useState(0)
  const [flying, setFlying] = useState(false)
  const [flyPath, setFlyPath] = useState<{ dx: number; dy: number; fromX: number; fromY: number } | null>(null)
  const [cloneText, setCloneText] = useState('')

  const slotRef = useRef<View>(null)
  const barFade = useRef(new Animated.Value(1)).current
  const cloneOpacity = useRef(new Animated.Value(0)).current
  const cloneTravel = useRef(new Animated.Value(0)).current

  const items = learningsList({ facts, sections })
  const current = currentLearning({ facts, sections }, cycleIndex)

  // Advance the cycle on a timer while research is streaming (B1: visible during researching||generating).
  useEffect(() => {
    if (researchComplete || items.length === 0) return // freeze on researchComplete; nothing to cycle pre-first-fact
    const t = setInterval(() => setCycleIndex((i) => i + 1), CYCLE_MS)
    return () => clearInterval(t)
  }, [researchComplete, items.length])

  // The cycle-up entrance: each new current.text slides up + fades in (reduce-motion → opacity-only cross-fade, B5).
  const enter = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion) {
      Animated.timing(enter, { toValue: 1, duration: motion.fast, useNativeDriver: false }).start()
      return
    }
    enter.setValue(0)
    Animated.timing(enter, { toValue: 1, duration: motion.base, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start()
  }, [current.text, reduceMotion, enter])

  // The fly-out: when researchComplete flips true, measure the slot + the Details icon, then launch the clone.
  useEffect(() => {
    if (!researchComplete || flying) return
    setFlying(true)
    setCloneText(current.text)
    if (reduceMotion) {
      // reduce-motion: no spatial travel — cross-fade the bar out + land immediately (B5).
      Animated.timing(barFade, { toValue: 0, duration: motion.base, useNativeDriver: false }).start(onDone)
      const id = setTimeout(onFlyLand, motion.fast)
      return () => clearTimeout(id)
    }
    // Measure the slot (reliable — own ref). The Details icon measure may fail if it hasn't laid out yet (B2).
    slotRef.current?.measureInWindow((x, y, w, h) => {
      const barRect: Rect = { x, y, w, h }
      const fromX = barRect.x + barRect.w / 2
      const fromY = barRect.y + barRect.h / 2
      const icon = detailsIconRef.current
      const measureIcon = (cb: (r: Rect | null) => void) => {
        if (!icon) return cb(null)
        icon.measureInWindow((ix, iy, iw, ih) => cb(rectIsValid({ x: ix, y: iy, w: iw, h: ih }) ? { x: ix, y: iy, w: iw, h: ih } : null))
      }
      measureIcon((iconRect) => {
        const path = iconRect ? computeFlyPath(barRect, iconRect) : { dx: FLY_FALLBACK_DX, dy: FLY_FALLBACK_DY, durationMs: 420, scaleTo: 0.22 }
        setFlyPath({ dx: path.dx, dy: path.dy, fromX, fromY })
        cloneOpacity.setValue(1)
        cloneTravel.setValue(0)
        // The clone travels + shrinks + fades; the bar fades + slides down in parallel.
        Animated.parallel([
          Animated.timing(cloneTravel, { toValue: 1, duration: path.durationMs, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
          Animated.timing(cloneOpacity, { toValue: 0, duration: path.durationMs, useNativeDriver: false }),
          Animated.timing(barFade, { toValue: 0, duration: path.durationMs, useNativeDriver: false }),
        ]).start(() => {
          onFlyLand()
          onDone()
        })
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchComplete])

  if (flying && !flyPath && !reduceMotion) return null // brief: between setFlying + measure resolving

  return (
    <Animated.View
      {...tidWith(ids.learnings.bar, { phase: researchComplete ? 'flying' : 'researching' }, `Initial learnings. ${current.fullText}`)}
      accessibilityLiveRegion="polite"
      style={{ opacity: barFade }}
    >
      <View ref={slotRef} onLayout={() => {}} collapsable={false} style={styles.slot}>
        {current.placeholder ? (
          <View style={styles.researchingRow}>
            <Text style={[typeStyles.body, { color: surface.text, fontSize: 15 }]}>Researching</Text>
            <PulseDots reduceMotion={reduceMotion} color={surface.text} />
          </View>
        ) : (
          <Animated.Text
            key={current.text}
            {...tid(ids.learnings.fact)}
            style={[typeStyles.body, styles.slotText, {
              color: surface.text,
              opacity: enter,
              transform: reduceMotion ? [] : [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            }]}
            numberOfLines={2}
          >{current.text}</Animated.Text>
        )}
      </View>
      {/* The flying clone (rendered during the fly-out only) — a tiny chip of the current fact that travels to Details. */}
      {flying && flyPath && !reduceMotion ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.clone,
            {
              left: flyPath.fromX,
              top: flyPath.fromY,
              opacity: cloneOpacity,
              transform: [
                { translateX: cloneTravel.interpolate({ inputRange: [0, 1], outputRange: [0, flyPath.dx] }) },
                { translateY: cloneTravel.interpolate({ inputRange: [0, 1], outputRange: [0, flyPath.dy] }) },
                { scale: cloneTravel.interpolate({ inputRange: [0, 1], outputRange: [1, 0.22] }) },
              ],
            },
          ]}
        >
          <Text style={[typeStyles.caption, { color: surface.text }]} numberOfLines={1}>{cloneText}</Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  )
}

// `styles.clone` is positioned absolutely in WINDOW coords (set via left/top from measureInWindow), so it needs a
// high z-index + a fixed transform origin. It's rendered as a sibling overlay during the fly only.
const styles = StyleSheet.create({
  slot: {
    height: SLOT_HEIGHT,
    maxHeight: SLOT_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: space.md,
  } as ViewStyle,
  slotText: {
    fontSize: 15,
    lineHeight: 22,
  } as TextStyle,
  researchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  } as ViewStyle,
  dots: {
    flexDirection: 'row',
    gap: 3,
  } as ViewStyle,
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  } as ViewStyle,
  clone: {
    position: 'absolute',
    maxWidth: 220,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    zIndex: 99,
  } as ViewStyle,
})
