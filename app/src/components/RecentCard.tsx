/**
 * RecentCard — the camera-home "Recently catalogued" surface. REPLACES the old slide-up `Tray` bottom sheet
 * (grab handle + full-width scrim-dim) with a compact FLOATING CARD that matches the reveal's information panel:
 * it reuses the reveal `floatCard` geometry (rounded-xl, shallow shadow, side margins, centered, maxWidth) and
 * the `RevealDock` `BucketCard` MORPH (single-node opacity + translateY rise + subtle scale, `useNativeDriver:false`,
 * reduce-motion → cross-fade). The app is parchment (cream) everywhere, so this is a white card over cream (or over
 * the live viewfinder on native) — a hairline border defines its edge on the low-contrast cream canvas.
 *
 *   camera.recentToggle ─tap→  card morphs up from the bottom, clearing the capture bar:
 *   ┌ camera.recent (dark card) ─────────────────────────┐
 *   │ RECENTLY CATALOGUED                       See all › │  ← overline + blue link (populated only)
 *   │ ┌ CatalogTile ┐┌ CatalogTile ┐┌ … ┐  → horizontal   │  ← camera.recentItem (+ recentItemPhoto)
 *   └────────────────────────────────────────────────────┘
 *   camera.recentClose = the light tap-away scrim behind it.
 *
 * Three states carried verbatim from the old carousel (a loading/errored `['threads']` query must NEVER collapse
 * to the empty ghost and falsely tell a returning collector they have zero finds): LOADING skeletons, ERROR +
 * retry, EMPTY ghost. Tap a tile → `onOpen(item)` (the shared `useRevisitThread` revisit, photo seeded).
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, ScrollView, Pressable, Animated, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CatalogTile } from './CatalogTile'
import { FadeRise } from './FadeRise'
import { ids, tid, tidWith } from '../lib/testid'
import { radius, space, shadow, motion, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { Surface } from '../lib/theme'
import type { ThreadSummary } from '../lib/apiClient'

// A lighter dim than the design.md bottom-sheet scrim (0.35): the card floats, it isn't a full sheet, so the
// viewfinder stays legible behind it while still catching a tap-to-close (plan D4 — "light, not the sheet-dim").
const CARD_SCRIM = 'rgba(20,18,14,0.25)'
// Clear the capture bar (orb 80 + its paddingBottom space.xl + a gap) so the floating card never covers the shutter.
const BAR_CLEARANCE = 80 + space.xl + space.lg

function Skeleton({ surface, reduceMotion }: { surface: Surface; reduceMotion: boolean }): React.ReactElement {
  const a = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 600, useNativeDriver: false }),
        Animated.timing(a, { toValue: 0, duration: 600, useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [a, reduceMotion])
  const opacity = reduceMotion ? 0.5 : a.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] })
  return <Animated.View style={[styles.skeleton, { backgroundColor: surface.sunken, opacity }]} />
}

export function RecentCard({
  open,
  onClose,
  threads,
  isLoading,
  isError,
  onRetry,
  onOpen,
  onSeeAll,
}: {
  open: boolean
  onClose: () => void
  threads: ThreadSummary[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  onOpen: (item: ThreadSummary) => void
  onSeeAll: () => void
}): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  const insets = useSafeAreaInsets()
  // Single-node morph (BucketCard pattern): 0 = hidden below, 1 = settled. reduce-motion → opacity cross-fade only.
  const enter = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(enter, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? motion.fast : motion.base,
      useNativeDriver: false,
    }).start()
  }, [open, reduceMotion, enter])

  const scrimOpacity = enter // 0 → 1 (peaks at CARD_SCRIM's own alpha)
  const cardStyle = {
    opacity: enter,
    transform: reduceMotion
      ? []
      : [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
        ],
  }

  const populated = !isLoading && !isError && threads.length > 0

  return (
    <View pointerEvents={open ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: CARD_SCRIM, opacity: scrimOpacity }]}>
        <Pressable
          {...tid(ids.camera.recentClose, 'Close recent')}
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.View
        {...tidWith(ids.camera.recent, { open: String(open) }, 'Recently catalogued')}
        accessibilityViewIsModal
        style={[
          styles.cardWrap,
          { bottom: insets.bottom + BAR_CLEARANCE, transform: cardStyle.transform, opacity: cardStyle.opacity },
        ]}
      >
        <View style={[styles.card, shadow, { backgroundColor: surface.surface, borderColor: surface.border }]}>
          <View style={styles.header}>
            <Text style={[typeStyles.overline, { color: surface.textTertiary }]}>Recently catalogued</Text>
            {populated ? (
              <Pressable accessibilityRole="link" onPress={onSeeAll} hitSlop={8} style={styles.seeAll}>
                <Text style={[typeStyles.subhead, { color: surface.accentSecondary }]}>See all</Text>
              </Pressable>
            ) : null}
          </View>

          {isLoading ? (
            <View style={styles.row}>
              <Skeleton surface={surface} reduceMotion={reduceMotion} />
              <Skeleton surface={surface} reduceMotion={reduceMotion} />
              <Skeleton surface={surface} reduceMotion={reduceMotion} />
            </View>
          ) : isError ? (
            <View style={[styles.stateCard, { backgroundColor: surface.card }]}>
              <Text style={[typeStyles.footnote, { color: surface.textMuted }]}>Couldn't reach your collection.</Text>
              <Pressable accessibilityRole="link" onPress={onRetry} hitSlop={8}>
                <Text style={[typeStyles.subhead, { color: surface.accentSecondary, marginTop: space.xs }]}>Retry</Text>
              </Pressable>
            </View>
          ) : threads.length === 0 ? (
            <View style={[styles.ghost, { borderColor: surface.border }]}>
              <Text style={[typeStyles.footnote, { color: surface.textTertiary, textAlign: 'center' }]}>
                Nothing catalogued yet.{'\n'}Point me at something.
              </Text>
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
              {threads.slice(0, 8).map((t, i) => (
                <FadeRise key={t.threadId} reduceMotion={reduceMotion} delay={Math.min(i, 8) * 40}>
                  {/* Close the card BEFORE revisiting: the shared useRevisitThread hook is state-agnostic (it can't
                      reach camera-local trayOpen), so the card that owns the open state clears it here — otherwise
                      the card would still be open (its scrim blocking the shutter) on return to the camera tab. */}
                  <CatalogTile variant="carousel" item={t} onPress={() => { onClose(); onOpen(t) }} />
                </FadeRise>
              ))}
            </ScrollView>
          )}
        </View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  cardWrap: { position: 'absolute', left: 0, right: 0, paddingHorizontal: space.md, alignItems: 'center', zIndex: 21 },
  card: { width: '100%', maxWidth: 460, borderRadius: radius.xl, borderWidth: 1, paddingVertical: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, marginBottom: space.sm },
  seeAll: { minHeight: 32, justifyContent: 'center' },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  skeleton: { width: 140, minHeight: 116, borderRadius: radius.lg },
  stateCard: { marginHorizontal: space.lg, borderRadius: radius.lg, padding: space.md, minHeight: 116, justifyContent: 'center' },
  ghost: { marginHorizontal: space.lg, borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.lg, minHeight: 116, alignItems: 'center', justifyContent: 'center' },
})
