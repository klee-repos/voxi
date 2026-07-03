/**
 * GlassFill — an absolute-fill liquid-glass layer dropped as the FIRST child of an existing card. It blurs +
 * warm-tints whatever is painted BEHIND the card and NEVER participates in the card's layout
 * (`position:absolute`, `pointerEvents:'none'`), so the host card keeps its exact paddings, `maxHeight`, and flex
 * height chain intact. This is why it's a fill layer, not a wrapper.
 *
 * Web/converge path (this file): a react-native-web View carrying `backdropFilter`. Native uses the real iOS
 * material — see `GlassFill.native.tsx`. esbuild resolves this base file (default resolveExtensions exclude
 * `.native.tsx`).
 */
import React from 'react'
import { View, Platform, StyleSheet, type ViewStyle } from 'react-native'
import { glass } from '../lib/theme'

export interface GlassFillProps {
  /** any `border*Radius` keys — matched to the host card's radius so the blur clips to the same rounded rect. */
  radiusStyle?: ViewStyle
  /** denser tint for a card sitting over the (already dimmed) scrim vs. directly over the bright photo. */
  strong?: boolean
  /** deepest tint — the reveal reading sheet only, so enlarged prose stays crisp (kept distinct from `strong`
   *  so the ⋯ MORE sheet, the other `strong` consumer, is not darkened with it). */
  card?: boolean
}

export function GlassFill({ radiusStyle, strong, card }: GlassFillProps): React.ReactElement {
  const filter = `blur(${glass.blur}px) saturate(${glass.saturate})`
  const tint = card ? glass.tintCard : strong ? glass.tintStrong : glass.tint
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
        { backgroundColor: tint },
        web,
      ]}
    />
  )
}

const styles = StyleSheet.create({
  fill: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border },
})
