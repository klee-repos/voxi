/**
 * Skeleton — the shared flat-pulse loading primitive (design.md "flat paper": a calm opacity
 * oscillation, NOT a gradient sweep). Extracted from RecentCard so the Collection grid's cold-load
 * skeleton and the camera RecentCard carousel share ONE pulse and can't drift.
 *
 * Dimensionless by design: pass a `style` for the shape (a grid square, a carousel card, an overline
 * bar). One Animated.Value per instance; the loop is STOPPED on unmount — load-bearing, because the
 * Collection grid renders up to PAGE (12) of these at once, and a leaked rAF chain would outlive the
 * loading branch and keep ticking after the transition. reduceMotion → a static flat 0.5 opacity
 * (no motion), per the app's reduce-motion contract (the flag calms motion, never hides content).
 *
 * Uses the RN Animated API with useNativeDriver:false (JS driver) — NOT reanimated — because this
 * animates `backgroundColor`/opacity, which the native driver can't drive, and so it renders
 * identically under react-native-web (the converge harness). FadeRise separately uses the native
 * driver for its opacity/translateY; the app is mixed-driver by intent.
 */
import React, { useEffect, useRef } from 'react'
import { Animated, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../lib/themeProvider'

export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  const a = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion) return // static flat opacity below — no loop to start, none to stop
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 600, useNativeDriver: false }),
        Animated.timing(a, { toValue: 0, duration: 600, useNativeDriver: false }),
      ]),
    )
    loop.start()
    // LOAD-BEARING cleanup: stop the rAF chain on unmount. The grid mounts up to PAGE of these; a
    // missing return leaks that many JS-driven loops past the loading branch. (No React render-test
    // harness in the repo to unit-pin this — preserved verbatim from RecentCard + gated by the
    // converge loading proof's empty-`errors` assertion.)
    return () => loop.stop()
  }, [a, reduceMotion])
  const opacity = reduceMotion ? 0.5 : a.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] })
  return <Animated.View style={[{ backgroundColor: surface.sunken }, style, { opacity }]} />
}
