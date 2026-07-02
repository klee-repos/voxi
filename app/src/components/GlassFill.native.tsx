/**
 * GlassFill (native) — real Apple Liquid Glass on iOS 26 (`expo-glass-effect` `GlassView`, gated on
 * `isLiquidGlassAvailable()`), falling back to a warm-tinted `expo-blur` `BlurView` on iOS < 26 / Android. Same
 * absolute-fill, `pointerEvents:'none'`, radius-clipped contract as the web `GlassFill` (`GlassFill.tsx`).
 * Converge/esbuild never resolves `.native.tsx`, so it gets the base `.tsx` instead.
 */
import React from 'react'
import { View, StyleSheet } from 'react-native'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import { BlurView } from 'expo-blur'
import { glass } from '../lib/theme'
import type { GlassFillProps } from './GlassFill'

export function GlassFill({ radiusStyle, strong }: GlassFillProps): React.ReactElement {
  const tint = strong ? glass.tintStrong : glass.tint
  const clip = [StyleSheet.absoluteFill, styles.clip, radiusStyle]
  // iOS 26: genuine UIGlassEffect. Pass the WARM tintColor — bare "regular" glass reads cold/off-brand (design.md).
  if (isLiquidGlassAvailable()) {
    return <GlassView glassEffectStyle="regular" tintColor={tint} style={clip} pointerEvents="none" />
  }
  // iOS < 26 / Android: a real frosted blur + the warm tint overlay + the specular rim.
  return (
    <BlurView tint="light" intensity={glass.intensity} pointerEvents="none" style={clip}>
      <View style={[StyleSheet.absoluteFill, styles.rim, radiusStyle, { backgroundColor: tint }]} />
    </BlurView>
  )
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  rim: { borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border },
})
