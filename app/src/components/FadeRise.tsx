/**
 * FadeRise — the reduce-motion-aware mount transition for content that "rises" into view (PLAN §10.3).
 *
 * With reduce-motion ON we swap the rise for a plain cross-fade (no translate, faster) but still show the
 * content — the flag never hides anything, it only calms the motion.
 *
 * Uses the RN Animated API (JS-driven) rather than Reanimated worklets so it renders identically under
 * react-native-web (the E2E harness) and on native. The real build can swap a Reanimated entering animation here.
 */
import React, { useEffect, useRef } from 'react'
import { Animated, type ViewStyle } from 'react-native'
import { motion } from '../lib/theme'

export function FadeRise({
  children,
  reduceMotion,
  style,
  delay = 0,
}: {
  children: React.ReactNode
  reduceMotion: boolean
  style?: ViewStyle
  /** Stagger a list's items in (e.g. carousel/grid tiles). Ignored under reduce-motion (all appear at once). */
  delay?: number
}): React.ReactElement {
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      // reduce-motion → a quick cross-fade; otherwise the slower rise
      duration: reduceMotion ? motion.fast : motion.slow,
      delay: reduceMotion ? 0 : delay,
      useNativeDriver: true,
    }).start()
  }, [progress, reduceMotion, delay])

  const translateY = reduceMotion
    ? 0
    : progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] })

  return (
    <Animated.View style={[{ opacity: progress, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  )
}
