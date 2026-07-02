/**
 * GlassFill — an absolute-fill LIQUID GLASS layer (Apple, "Adopting Liquid Glass"), dropped as the FIRST child of an
 * existing card. It blurs + warm-tints whatever is painted BEHIND the card (the full-bleed reveal photo / the scrim),
 * clips to the card's corner radius, and NEVER participates in the card's layout (`position:absolute`,
 * `pointerEvents:'none'`) — so the host card keeps its EXACT paddings, `maxHeight`, flex children (the ScrollView's
 * height chain stays intact), and top-only sheet radius. This is why it's a fill layer, not a wrapper.
 *
 * Web/converge path (this file): a react-native-web View carrying `backdropFilter`. RNW 0.21 renders it but does NOT
 * auto-prefix an inline style literal, so the explicit `WebkitBackdropFilter` key is REQUIRED (not redundant). Native
 * uses the real iOS 26 material — see `GlassFill.native.tsx`. The two files share `GlassFillProps`; esbuild resolves
 * this base file (default resolveExtensions exclude `.native.tsx`, exactly like `AudioElement`).
 */
import React from 'react'
import { View, Platform, StyleSheet, type ViewStyle } from 'react-native'
import { glass } from '../lib/theme'

export interface GlassFillProps {
  /** any `border*Radius` keys — matched to the host card's radius so the blur clips to the same rounded rect. */
  radiusStyle?: ViewStyle
  /** denser tint for a card sitting over the (already dimmed) scrim vs. directly over the bright photo. */
  strong?: boolean
}

export function GlassFill({ radiusStyle, strong }: GlassFillProps): React.ReactElement {
  const filter = `blur(${glass.blur}px) saturate(${glass.saturate})`
  // `backdropFilter` is a web CSS prop RN core's ViewStyle doesn't type; RNW renders it. The `WebkitBackdropFilter`
  // key is load-bearing (RNW does not prefix an inline literal), NOT belt-and-suspenders.
  const web =
    Platform.OS === 'web' ? ({ backdropFilter: filter, WebkitBackdropFilter: filter } as ViewStyle) : null
  return (
    <View
      pointerEvents="none"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        styles.fill,
        radiusStyle,
        { backgroundColor: strong ? glass.tintStrong : glass.tint },
        web,
      ]}
    />
  )
}

const styles = StyleSheet.create({
  fill: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border },
})
