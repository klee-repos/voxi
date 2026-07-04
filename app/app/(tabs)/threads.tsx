/**
 * Threads / collection (PLAN §10.2 screen 9) — the retention engine, the proto-Pokédex "collection": a
 * PHOTO-BOOK grid of captured-object tiles GROUPED BY DATE (Today / Yesterday / earlier), each tile revisiting
 * the durable eve session behind that capture. Loads via TanStack Query against the owner-scoped GET /v1/threads.
 *
 * INFINITE SCROLL is client-side by design: the `['threads']` cache is a SHARED single source of truth (the
 * reveal's swipe-paging reads the FULL list from it — reveal.tsx pageableThreads — and the camera-home recent
 * carousel + delete/regenerate invalidations depend on its `{threads:[]}` shape). So we keep one un-paginated
 * fetch and virtualize the RENDER: a `FlatList` over date-flattened rows (collectionRows.buildRows) mounts only
 * on-screen tiles (the fix for "too many images loading at once"), and a `visibleCount` window grows on
 * onEndReached — the loaded set expands as you scroll. Nothing here changes the cache, so no other surface moves.
 *
 * State matrix (PLAN §10.2): loading = a spinner while the collection fetches; empty = the DESIGNED first-run
 * state (warm invite + "Capture your first object"); error = an in-persona error with retry; offline =
 * global.offlineBanner (cached list still shown if present). Revisit = tap a tile → resume that thread (reveal).
 * testids: threads.screen / emptyState / captureCta / count / grid / item / loadingMore.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { View, Text, FlatList, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { Screen, Title, Body, Muted, Button } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { OfflineBanner } from '../../src/components/Banners'
import { CatalogTile } from '../../src/components/CatalogTile'
import { Skeleton } from '../../src/components/Skeleton'
import { ids, tid, tidWith } from '../../src/lib/testid'
import { space, radius, typeStyles } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useApi } from '../../src/lib/api'
import { useOffline, isOfflineError } from '../../src/lib/useOffline'
import { useRevisitThread } from '../../src/lib/useRevisitThread'
import { threadsKey } from '../../src/lib/queryKeys'
import { orderThreads } from '../../src/lib/collectionOrder'
import { buildRows, groupByDate, type CollectionRow } from '../../src/lib/collectionRows'

/** Tiles revealed per infinite-scroll page (grows `visibleCount` on onEndReached). */
const PAGE = 12
/** Pair rows shown in the cold-load skeleton — mirrors one full page (PAGE/2) so the loading grid reads
 *  with the same density + geometry as the real photo-book grid that's about to replace it. */
const SKELETON_PAIRS = PAGE / 2

export default function Threads(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface } = useTheme()
  const openThread = useRevisitThread()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: threadsKey,
    queryFn: () => api.listThreads(),
  })

  // offline = passive navigator signal OR an active network-failed fetch (vs an HTTP/app error, which is an
  // in-persona error block, not the offline banner).
  const offline = useOffline(isOfflineError(error))

  const threads = data?.threads ?? []

  // Collection is a top-level drawer destination (a peer of Capture), not a pushed screen → the header shows the
  // menu hamburger that opens the drawer, NOT a back chevron. Same header across all four states
  // (loading/error/empty/populated).
  const menuHeader = <AppHeader leading="menu" />

  // ---- infinite-scroll window: keep the WHOLE ordered list in memory (unchanged cache) but only build rows for
  // the first `visibleCount`; onEndReached grows the window. Newest-first — the SAME order the reveal pages through.
  const ordered = useMemo(() => orderThreads(threads), [threads])
  const total = ordered.length
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const shown = useMemo(() => ordered.slice(0, visibleCount), [ordered, visibleCount])
  const rows = useMemo(() => buildRows(groupByDate(shown, Date.now())), [shown])
  const hasMore = shown.length < total
  const loadMore = useCallback(() => {
    setVisibleCount((c) => (c < total ? Math.min(total, c + PAGE) : c)) // idempotent + clamped (safe if a delete shrinks total)
  }, [total])

  // Revisit → resume the durable eve session behind this thread (shared with the camera-home recent carousel via
  // useRevisitThread): /processing STREAMS the thread, the BFF REPLAYS the persisted reveal (no re-run/re-bill),
  // and the photo is seeded so the image shows immediately instead of a blank card.
  const renderRow = useCallback(
    ({ item: row }: { item: CollectionRow }) => {
      if (row.kind === 'header') {
        return <Text style={[typeStyles.overline, styles.groupLabel, { color: surface.textMuted }]}>{row.label}</Text>
      }
      return (
        <View style={styles.pairRow}>
          {row.items.map((item) => (
            <CatalogTile key={item.threadId} variant="grid" item={item} onPress={() => openThread(item)} />
          ))}
          {row.items.length === 1 ? <View style={styles.spacer} /> : null}
        </View>
      )
    },
    [surface.textMuted, openThread],
  )

  // ---- loading: a skeleton photo-book that mirrors the real grid's geometry (a flat opacity pulse, not a
  // gradient sweep — design.md "flat paper"). The shape (title + count + "Today" + SKELETON_PAIRS of square
  // tile-pairs) matches the populated grid byte-for-byte in sizing, so the cold load reads as the grid
  // assembling itself rather than a bare spinner. resolves naturally to the empty or populated branch.
  if (isLoading) {
    return (
      <Screen id={ids.threads.screen} header={menuHeader} padded={false}>
        <ScrollView {...tid(ids.threads.skeleton)} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
          <View style={styles.listHeader}>
            <Skeleton style={styles.skelTitle} />
            <Skeleton style={styles.skelCount} />
          </View>
          <Skeleton style={styles.skelOverline} />
          {Array.from({ length: SKELETON_PAIRS }, (_v, i) => (
            <View key={i} style={styles.pairRow}>
              <Skeleton style={styles.skelTile} />
              <Skeleton style={styles.skelTile} />
            </View>
          ))}
          {/* a11y: a pure skeleton with no text is a hole for VoiceOver — keep a muted loading cue. */}
          <Muted style={{ textAlign: 'center', marginTop: space.lg }}>Opening your collection…</Muted>
        </ScrollView>
      </Screen>
    )
  }

  // ---- error: fetch failed and we have nothing to show ----
  if (isError && threads.length === 0) {
    return (
      <Screen id={ids.threads.screen} center header={menuHeader}>
        <OfflineBanner visible={offline} />
        <Title style={{ textAlign: 'center' }}>The Guide is briefly out of reach.</Title>
        <Body style={{ textAlign: 'center', marginTop: space.md, maxWidth: 380 }}>
          I couldn't fetch your collection just now. {offline ? 'You appear to be offline.' : 'A momentary lapse on my end.'}
        </Body>
        <Button id={ids.threads.captureCta} label="Try again" onPress={() => void refetch()} style={{ marginTop: space.xl }} />
      </Screen>
    )
  }

  // ---- empty: designed first-run state (F2) ----
  if (threads.length === 0) {
    return (
      <Screen id={ids.threads.screen} center header={menuHeader}>
        <OfflineBanner visible={offline} />
        <View {...tid(ids.threads.emptyState)} style={styles.empty}>
          <Title style={{ textAlign: 'center' }}>The Guide awaits your first find.</Title>
          <Body style={{ textAlign: 'center', marginTop: space.md }}>
            Nothing catalogued yet. Photograph your first object and we'll begin filling it in — a bike, a camera,
            a curious bottle.
          </Body>
          <Button
            id={ids.threads.captureCta}
            label="Capture your first object"
            onPress={() => router.replace('/(tabs)/camera')}
            style={{ marginTop: space.xl }}
          />
        </View>
      </Screen>
    )
  }

  // ---- populated: the photo-book grid (virtualized + infinite-scroll). No footer button — the tab/drawer is the
  // capture entry point (the whole screen IS the catalog). `threads.grid` marks the scroll container; each tile is
  // the single canonical `threads.item` (one per thread, so the selector matches exactly `shown`). ----
  return (
    <Screen id={ids.threads.screen} header={menuHeader} padded={false}>
      <OfflineBanner visible={offline} />
      {/* Hidden anchor carrying the infinite-scroll window (shown/total) — mounted OUTSIDE the FlatList so the
          virtualizer can never drop it; lets E2E read the window growth deterministically (not via volatile
          DOM tile counts). */}
      <View {...tidWith(ids.threads.window, { shown: String(shown.length), total: String(total) })} style={styles.windowAnchor} pointerEvents="none" />
      <FlatList
        {...tid(ids.threads.grid)}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        showsVerticalScrollIndicator={false}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Title>Your collection</Title>
            <View {...tid(ids.threads.count)} style={styles.countRow}>
              <Text style={[typeStyles.calloutBold, { color: surface.text }]}>{total}</Text>
              <Muted> catalogued</Muted>
            </View>
          </View>
        }
        ListFooterComponent={
          hasMore ? (
            <View {...tid(ids.threads.loadingMore)} style={styles.footer}>
              <ActivityIndicator color={surface.accent} />
            </View>
          ) : null
        }
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  empty: { maxWidth: 420 },
  // space.xl (the app's standard Screen gutter, matching Settings) so the grid title + tiles line up under the
  // header hamburger (which aligns to that same content gutter). space.lg here left the grid 8pt left of the icon.
  listContent: { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.xxl },
  listHeader: { marginBottom: space.md },
  countRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: space.xs },
  groupLabel: { marginTop: space.lg, marginBottom: space.sm },
  pairRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  spacer: { flex: 1 }, // keeps a lone trailing tile at column width (never full-bleed)
  footer: { paddingVertical: space.lg, alignItems: 'center' },
  windowAnchor: { height: 0 }, // zero-height hidden anchor (data-shown / data-total only)
  // cold-load skeleton shapes — each mirrors a real element's geometry so the loading grid reads as the
  // populated grid assembling itself. skelTile byte-matches the CatalogTile `grid` cell (flex:1, 1:1, radius.md).
  skelTitle: { width: 170, height: 26, borderRadius: radius.sm },
  skelCount: { width: 92, height: 16, borderRadius: radius.sm, marginTop: space.xs },
  skelOverline: { width: 64, height: 13, borderRadius: radius.sm, marginTop: space.lg, marginBottom: space.sm },
  skelTile: { flex: 1, aspectRatio: 1, borderRadius: radius.md },
})
