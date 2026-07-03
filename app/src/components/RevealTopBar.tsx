/**
 * RevealTopBar — the reveal ITEM's "One bar" top chrome (CATALOG-TOP-BAR handoff). A single floating glass pill
 * over the full-bleed photo holding [back · title (LEFT-aligned) · ⋯], intentionally rhyming with the reveal's
 * floating bottom dock (both are inset, rounded GlassFill cards — a matched pair). Replaces the older three-blob
 * header (two glass discs + a centred name pill). Bespoke to the reveal, so the universal AppHeader stays pristine.
 *
 * Pre-settle (`!band`) the title slot shows an "Identifying" placeholder with three pulsing dots (today the title
 * was simply hidden). The header sits ABOVE the loading overlay via reveal's headerOverlay `zIndex:10`, so the
 * placeholder is visible during the analyze; it reads as subordinate chrome to the immersive Orb loading below.
 *
 * Contract the converge E2E reads (do not break): nav.header / nav.back / nav.more; reveal.title carries the FULL
 * object name (truncation is visual only); reveal.howSure carries `data-band` AND is the tap target that toggles
 * the how-sure/correct details (reveal-rnw.web.ts taps it) — so onToggleDetails rides the howSure Pressable, and
 * tid(reveal.title) rides the inner Text.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native'
import { GlassFill } from './GlassFill'
import { ids, tid, tidWith } from '../lib/testid'
import { space, radius, type, floatShadow } from '../lib/theme'
import { revealHeaderTitle } from '../lib/revealHeaderTitle'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'

export function RevealTopBar({
  band,
  title,
  showMore,
  onBack,
  onMore,
  onToggleDetails,
  reduceMotion,
}: {
  band: ConfidenceBand | null
  title: string
  showMore: boolean
  onBack: () => void
  onMore: () => void
  /** tap the name → toggle the how-sure / correct / tip details in the dock below (setShowDetails). */
  onToggleDetails: () => void
  reduceMotion: boolean
}): React.ReactElement {
  const insets = useSafeAreaInsets()
  const slot = revealHeaderTitle(band, title)
  return (
    // box-none so the inset side gutters + the margin above/below the pill pass touches through to the pager;
    // only the pill's three controls capture. Top rhythm = safe-area top + space.sm (matches the old header).
    <View pointerEvents="box-none" style={{ paddingTop: insets.top + space.sm, paddingHorizontal: space.md }}>
      <View {...tid(ids.nav.header)} style={[styles.pill, floatShadow]}>
        {/* the pill's Liquid-Glass fill (default tint) — self-clips its rounded blur + carries the specular rim,
            so the pill host stays overflow-visible for the separation shadow. */}
        <GlassFill radiusStyle={styles.pillRadius} />

        <Pressable {...tid(ids.nav.back, 'Back')} accessibilityRole="button" onPress={onBack} hitSlop={12} style={styles.ctrl}>
          <ChevronLeft size={24} color="#FFFFFF" strokeWidth={2.5} />
        </Pressable>

        {slot.kind === 'name' ? (
          <Pressable
            {...tidWith(ids.reveal.howSure, { band: band as string }, 'The name — tap for details')}
            accessibilityRole="button"
            onPress={onToggleDetails}
            style={styles.titleSlot}
          >
            <Text {...tid(ids.reveal.title)} numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
              {slot.text}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.titleSlot}>
            <Text style={styles.identifying}>Identifying</Text>
            <IdentifyingDots reduceMotion={reduceMotion} />
          </View>
        )}

        {showMore ? (
          <Pressable {...tid(ids.nav.more, 'More actions')} accessibilityRole="button" onPress={onMore} hitSlop={12} style={styles.ctrl}>
            <MoreHorizontal size={24} color="#FFFFFF" strokeWidth={2.5} />
          </Pressable>
        ) : (
          // a fixed spacer keeps the title's left edge stable + the pill symmetric whether or not ⋯ shows.
          <View style={styles.ctrl} />
        )}
      </View>
    </View>
  )
}

/** Three 4pt dots pulsing opacity 0.3→1 over 1.2s, staggered 0 / 0.2 / 0.4s — the pre-name "working" signal.
 *  reduceMotion freezes them at full opacity; the loop is stopped + reset when reduceMotion flips or on unmount. */
function IdentifyingDots({ reduceMotion }: { reduceMotion: boolean }): React.ReactElement {
  const opacities = useRef([new Animated.Value(1), new Animated.Value(1), new Animated.Value(1)]).current
  useEffect(() => {
    if (reduceMotion) {
      opacities.forEach((o) => o.setValue(1))
      return
    }
    const runs = opacities.map((o, i) => {
      o.setValue(0.3)
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(o, { toValue: 1, duration: 600, useNativeDriver: false }),
          Animated.timing(o, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        ]),
      )
      const start = setTimeout(() => loop.start(), i * 200) // stagger 0 / 0.2 / 0.4s
      return { loop, start }
    })
    return () => {
      runs.forEach(({ loop, start }) => { clearTimeout(start); loop.stop() })
      opacities.forEach((o) => o.stopAnimation())
    }
  }, [reduceMotion, opacities])
  return (
    <View style={styles.dots} pointerEvents="none">
      {opacities.map((o, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: o }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  // The single floating pill. NO overflow:hidden (would clip the shadow) — GlassFill self-clips its blur. The
  // separation shadow (`floatShadow`) is applied at the usage site — SHARED with the bottom dock so the two
  // floating glass cards read as one matched pair (same fill `glass.tint`, same border `glass.border`, same lift).
  pill: {
    height: 50,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  pillRadius: { borderRadius: radius.pill },
  ctrl: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  // flex:1 + minWidth:0 lets the single-line title truncate (tail ellipsis) instead of overflowing the pill.
  titleSlot: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
  // No explicit lineHeight on these single-line labels: the handoff's tight 18/22 is smaller than Nunito's natural
  // line box (~1.36em), which pins the glyph HIGH on native so it reads as not vertically centred next to the 40pt
  // icon controls. Letting the text use its natural metrics — flex-centred by the row's alignItems:'center' — sits
  // the glyph on the pill's true centre line.
  title: { fontFamily: type.family.sans['700'], fontSize: 18, letterSpacing: -0.2, color: '#FFFFFF' },
  identifying: { fontFamily: type.family.sans['600'], fontSize: 16, color: 'rgba(255,255,255,0.74)' },
  dots: { flexDirection: 'row', alignItems: 'center', marginLeft: space.sm, gap: space.xs },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF' },
})
