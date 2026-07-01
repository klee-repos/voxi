/**
 * RecentlyIdentified — the Shazam "Recently Found" carousel peeking at the bottom of the capture home. A peek
 * of the SAME `useQuery(['threads'])` data as the Collection (latest 8), so the growing catalog is visible on
 * the home screen, not hamburger-only.
 *
 * `ThreadSummary` is only `{ threadId, title, createdAt }` — there is NO thumbnail URL and NO band on the list
 * query (both would be a contract change the UI-only constraint forbids), so cards are cream title-only tiles.
 * Three distinct states inside `camera.recent` (a loading/errored query must NEVER collapse to the empty ghost
 * and falsely tell a returning collector they have zero finds): LOADING skeletons, ERROR + retry, EMPTY ghost.
 * Tap = the canonical revisit (`onOpen` → reset+setThread+/processing). Presentational: the screen owns the
 * query + navigation and passes them in.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, ScrollView, Pressable, Animated, StyleSheet } from 'react-native'
import { FadeRise } from './FadeRise'
import { ids, tid } from '../lib/testid'
import { radius, space, shadow, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { Surface } from '../lib/theme'
import type { ThreadSummary } from '../lib/apiClient'

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
  return <Animated.View style={[styles.card, { backgroundColor: surface.sunken, opacity }]} />
}

export function RecentlyIdentified({
  threads,
  isLoading,
  isError,
  onRetry,
  onOpen,
  onSeeAll,
}: {
  threads: ThreadSummary[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  onOpen: (threadId: string) => void
  onSeeAll: () => void
}): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  return (
    <View {...tid(ids.camera.recent)} style={styles.wrap}>
      <View style={styles.header}>
        <Text style={[typeStyles.overline, { color: surface.textTertiary }]}>Recently catalogued</Text>
        {!isLoading && !isError && threads.length > 0 ? (
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
        <View style={[styles.card, styles.stateCard, { backgroundColor: surface.surface }, shadow]}>
          <Text style={[typeStyles.footnote, { color: surface.textMuted }]}>Couldn't reach your collection.</Text>
          <Pressable accessibilityRole="link" onPress={onRetry} hitSlop={8}>
            <Text style={[typeStyles.subhead, { color: surface.accentSecondary, marginTop: space.xs }]}>Retry</Text>
          </Pressable>
        </View>
      ) : threads.length === 0 ? (
        <View style={[styles.card, styles.ghost, { borderColor: surface.border }]}>
          <Text style={[typeStyles.footnote, { color: surface.textTertiary, textAlign: 'center' }]}>
            Nothing catalogued yet.{'\n'}Point me at something.
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {threads.slice(0, 8).map((t, i) => (
            <FadeRise key={t.threadId} reduceMotion={reduceMotion} delay={Math.min(i, 8) * 40}>
              <Pressable
                {...tid(ids.camera.recentItem)}
                accessibilityRole="button"
                onPress={() => onOpen(t.threadId)}
                style={({ pressed }) => [styles.card, { backgroundColor: surface.card, opacity: pressed ? 0.85 : 1 }, shadow]}
              >
                <Text numberOfLines={3} style={[typeStyles.name, { color: surface.text }]}>
                  {t.title}
                </Text>
                <Text style={[typeStyles.caption, { color: surface.textTertiary, marginTop: space.xs }]}>
                  {new Date(t.createdAt).toLocaleDateString()}
                </Text>
              </Pressable>
            </FadeRise>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, marginBottom: space.sm },
  seeAll: { minHeight: 32, justifyContent: 'center' },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  card: { width: 140, minHeight: 104, borderRadius: radius.lg, padding: space.md, justifyContent: 'flex-end' },
  stateCard: { justifyContent: 'center' },
  ghost: { borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
})
