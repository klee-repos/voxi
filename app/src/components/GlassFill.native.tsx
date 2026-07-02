/**
 * GlassFill (native) — the real Apple Liquid Glass on iOS 26 (`expo-glass-effect` `GlassView`, gated on
 * `isLiquidGlassAvailable()`), falling back to a warm-tinted `expo-blur` `BlurView` on iOS < 26 / Android. Same
 * absolute-fill, `pointerEvents:'none'`, radius-clipped contract as the web `GlassFill` (`GlassFill.tsx`), so the
 * host card's layout is untouched. Never seen by the converge esbuild bundle — it resolves the base `.tsx`
 * (default resolveExtensions exclude `.native.tsx`, exactly like `AudioElement.native.tsx`).
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
  // iOS 26: the genuine UIGlassEffect material. Pass the WARM tintColor so it honours the brand palette — a bare
  // "regular" system glass would read cold/off-brand (design.md: green + blue + warm neutrals only).
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
