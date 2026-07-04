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
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, ScrollView, ActivityIndicator, Pressable, StyleSheet } from 'react-native'
import { Trash2 } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Screen, Title, Body, Muted, Button } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { OfflineBanner } from '../../src/components/Banners'
import { CatalogTile } from '../../src/components/CatalogTile'
import { Skeleton } from '../../src/components/Skeleton'
import { ConfirmDialog } from '../../src/components/ConfirmDialog'
import { ids, tid, tidWith } from '../../src/lib/testid'
import { haptics } from '../../src/lib/haptics'
import { space, radius, typeStyles, hit } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useApi } from '../../src/lib/api'
import { useOffline, isOfflineError } from '../../src/lib/useOffline'
import { useRevisitThread } from '../../src/lib/useRevisitThread'
import { threadsKey } from '../../src/lib/queryKeys'
import { orderThreads } from '../../src/lib/collectionOrder'
import { buildRows, groupByDate, type CollectionRow } from '../../src/lib/collectionRows'
import { bulkDeleteThreads } from '../../src/lib/bulkDelete'
import { evictReveal } from '../../src/lib/revealCache'
import { forgetDeepDive } from '../../src/state/deepDiveStore'
import { useCaptureStore } from '../../src/state/captureStore'
import type { ThreadSummary } from '../../src/lib/apiClient'

/** Tiles revealed per infinite-scroll page (grows `visibleCount` on onEndReached). */
const PAGE = 12
/** Pair rows shown in the cold-load skeleton — mirrors one full page (PAGE/2) so the loading grid reads
 *  with the same density + geometry as the real photo-book grid that's about to replace it. */
const SKELETON_PAIRS = PAGE / 2

/**
 * The bulk-delete destructive fill — a clear RED, per explicit product direction ("Delete should be red").
 * SURGICAL: only the bulk-delete flow (the bottom-bar Delete pill + the confirm pill via `destructiveColor`).
 * The theme's `surface.danger` (terracotta) stays untouched — it's shared by the reveal ⋯ Delete, the refusal /
 * safety UI, and the existing single-delete confirm, none of which the user flagged.
 */
const DELETE_RED = '#E5484D'

export default function Threads(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const queryClient = useQueryClient()
  const { surface, reduceMotion } = useTheme()
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
  // menu hamburger that opens the drawer, NOT a back chevron. On the POPULATED grid, a "Select" right-action is
  // the visible door into multi-select (long-press a tile is the shortcut); the other three states stay plain.
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

  // ---- MULTI-SELECT bulk delete (Google/Apple-Photos pattern). Long-press a tile OR the header "Select" button
  // enters selection mode; taps then toggle membership; the bottom action bar's Delete opens a two-step confirm.
  // The selection set lives here (a Set<threadId>); the per-tile selected state rides on the EXISTING
  // threads.item testID via data-selected (deterministic for E2E) + accessibilityState.selected (VoiceOver).
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [partialFail, setPartialFail] = useState(0)

  const enterSelection = useCallback((threadId: string) => {
    haptics.tick()
    setSelected(new Set([threadId]))
    setSelectionMode(true)
    setPartialFail(0)
  }, [])
  const toggleSelected = useCallback((threadId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
    setPartialFail(0) // editing the selection clears any prior partial-failure retry line
  }, [])
  const exitSelection = useCallback(() => {
    setSelected(new Set())
    setSelectionMode(false)
    setPartialFail(0)
  }, [])
  // If an external refetch empties the grid while selection mode is active, exit selection (no tiles to select;
  // the bottom bar + selection header would otherwise sit over the empty state).
  useEffect(() => {
    if (selectionMode && !isLoading && threads.length === 0) exitSelection()
  }, [selectionMode, isLoading, threads.length, exitSelection])
  const allSelected = ordered.length > 0 && selected.size === ordered.length
  const toggleSelectAll = useCallback(() => {
    haptics.tick()
    setSelected(allSelected ? new Set() : new Set(ordered.map((t) => t.threadId)))
    setPartialFail(0)
  }, [allSelected, ordered])

  // The bulk-delete commit. Mirrors the single-delete cleanup (reveal.tsx onConfirmDelete) PER deleted id
  // (evictReveal + forgetDeepDive), but ONE optimistic setQueryData (filter all deleted) + ONE invalidate.
  // 404 (already gone) is success-equivalent; any other error keeps the id selected + surfaced for retry.
  const commitBulkDelete = useCallback(async (): Promise<void> => {
    if (selected.size === 0 || deleteBusy) return
    setDeleteBusy(true)
    const ids = [...selected]
    const { deleted, failed } = await bulkDeleteThreads(ids, {
      deleteThread: (id) => api.deleteThread(id),
      evictReveal,
      forgetDeepDive,
    })
    setConfirmOpen(false)
    const deletedSet = new Set(deleted)
    // Defensive: if the currently-loaded captureStore thread was among the deleted set, reset it (the reveal
    // re-resolves on next visit; the revealCache entry was evicted above so it re-streams cleanly).
    const cur = useCaptureStore.getState().threadId
    if (cur && deletedSet.has(cur)) useCaptureStore.getState().reset()
    // ONE optimistic filter — tiles vanish instantly, the empty state (if all deleted) mounts deterministically.
    queryClient.setQueryData<{ threads: ThreadSummary[] }>(threadsKey, (old) =>
      old ? { threads: old.threads.filter((t) => !deletedSet.has(t.threadId)) } : old,
    )
    // Tidy: drop any orphaned per-thread deepDiveReady query-cache entries (harmless — GC eventually evicts —
    // but a deleted thread's player never mounts to reconcile them).
    for (const id of deleted) queryClient.removeQueries({ queryKey: ['deepDiveReady', id], exact: true })
    if (failed.length > 0) {
      // Partial failure: keep the FAILED ids selected + stay in selection mode + surface a retry line. The
      // deleted ids are gone (optimistic filter); the failed ones remain. Never a fake-success.
      setSelected(new Set(failed.map((f) => f.id)))
      setPartialFail(failed.length)
    } else {
      setSelected(new Set())
      setSelectionMode(false)
      setPartialFail(0)
    }
    setDeleteBusy(false)
    // ONE invalidate for server-truth reconcile.
    void queryClient.invalidateQueries({ queryKey: threadsKey })
    haptics.tick()
  }, [selected, deleteBusy, api, queryClient])

  // The header is the SAME bar in both modes — only the right-action swaps. "Select" (entry) becomes a compact
  // RED Delete + "Done" (exit), with Delete to the LEFT of Done. The title, the count, and the grid STAY (select
  // mode must NOT redraw the screen — only the circles appear on tiles; no bottom bar). The rightmost label
  // (Select / Done) is aligned to the grid's right gutter (space.xl): AppHeader drops its empty trailing ctrl when
  // a rightAccessory is set, so a small positive marginRight = (space.xl − space.lg) closes the bar-pad vs gutter
  // gap (mirroring the hamburger's left `menuNudge`). No negative margin (that overlapped the ctrl + intercepted
  // clicks on web).
  const headerAlign = { marginRight: space.xl - space.lg }
  const headerRight = selectionMode ? (
    <View style={[styles.headerRightRow, headerAlign]}>
      <Pressable
        {...tid(ids.threads.bulkDelete, 'Delete')}
        accessibilityRole="button"
        accessibilityState={{ disabled: selected.size === 0 || deleteBusy }}
        disabled={selected.size === 0 || deleteBusy}
        onPress={() => { haptics.tick(); setConfirmOpen(true) }}
        style={({ pressed }) => [styles.headerDeleteBtn, { backgroundColor: DELETE_RED, opacity: pressed || selected.size === 0 ? 0.5 : 1 }]}
      >
        <Trash2 size={15} color="#FFFFFF" strokeWidth={2.4} />
        <Text style={styles.headerDeleteLabel}>Delete{selected.size > 0 ? ` ${selected.size}` : ''}</Text>
      </Pressable>
      <Pressable
        {...tid(ids.threads.cancelSelect, 'Done')}
        accessibilityRole="button"
        onPress={() => { haptics.tick(); exitSelection() }}
        hitSlop={8}
        style={styles.headerAction}
      >
        <Text style={[typeStyles.headline, { color: surface.accentSecondary }]}>Done</Text>
      </Pressable>
    </View>
  ) : (
    <Pressable
      {...tid(ids.threads.selectEntry, 'Select')}
      accessibilityRole="button"
      onPress={() => { haptics.tick(); setSelectionMode(true) }}
      hitSlop={8}
      style={[styles.headerAction, headerAlign]}
    >
      <Text style={[typeStyles.headline, { color: surface.accentSecondary }]}>Select</Text>
    </Pressable>
  )
  const populatedHeader = <AppHeader leading="menu" rightAccessory={headerRight} />

  // Revisit → resume the durable eve session behind this thread (shared with the camera-home recent carousel via
  // useRevisitThread): /processing STREAMS the thread, the BFF REPLAYS the persisted reveal (no re-run/re-bill),
  // and the photo is seeded so the image shows immediately instead of a blank card. In selection mode the tap
  // TOGGLES selection instead of opening.
  const renderRow = useCallback(
    ({ item: row }: { item: CollectionRow }) => {
      if (row.kind === 'header') {
        return <Text style={[typeStyles.overline, styles.groupLabel, { color: surface.textMuted }]}>{row.label}</Text>
      }
      return (
        <View style={styles.pairRow}>
          {row.items.map((item) => (
            <CatalogTile
              key={item.threadId}
              variant="grid"
              item={item}
              onPress={() => openThread(item)}
              selectionMode={selectionMode}
              selected={selected.has(item.threadId)}
              onToggleSelect={() => toggleSelected(item.threadId)}
              onLongPress={() => enterSelection(item.threadId)}
            />
          ))}
          {row.items.length === 1 ? <View style={styles.spacer} /> : null}
        </View>
      )
    },
    [surface.textMuted, openThread, selectionMode, selected, toggleSelected, enterSelection],
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
  // the single canonical `threads.item` (one per thread, so the selector matches exactly `shown`). Selection mode
  // only swaps the header right-action (Select → Delete + Done) + shows the tile circles; the title/count/grid
  // stay put (no bottom bar, no inset).
  return (
    <Screen id={ids.threads.screen} header={populatedHeader} padded={false}>
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
          // The title + count STAY in select mode (the screen must not change when entering select mode — only the
          // tile circles + the header right-action swap). The partial-failure retry line, when present, sits here.
          <View style={styles.listHeader}>
            <Title>Your collection</Title>
            <View {...tid(ids.threads.count)} style={styles.countRow}>
              <Text style={[typeStyles.calloutBold, { color: surface.text }]}>{total}</Text>
              <Muted> catalogued</Muted>
            </View>
            {partialFail > 0 ? (
              <Muted {...tid(ids.threads.bulkFail)} style={styles.bulkFail}>
                {partialFail} item{partialFail === 1 ? '' : 's'} proved stubborn. Worth another go.
              </Muted>
            ) : null}
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
      {/* Two-step delete confirm (step 2). The header Delete only OPENS this; the destructive commit is the dialog's
        second tap. The pill is RED (destructiveColor override) to match the header Delete — surgical: the global
        surface.danger (terracotta) used by reveal/refusal/safety is untouched. */}
      <ConfirmDialog
        visible={confirmOpen}
        title={selected.size === 1 ? 'Delete 1 item?' : `Delete ${selected.size} items?`}
        message={
          selected.size === 1
            ? "This removes the photo, its identification, and any story or conversation. It can't be undone."
            : `This removes ${selected.size} photos, their identifications, and any stories or conversations. It can't be undone.`
        }
        confirmLabel="Delete"
        destructive
        destructiveColor={DELETE_RED}
        busy={deleteBusy}
        onConfirm={() => void commitBulkDelete()}
        onCancel={() => setConfirmOpen(false)}
        reduceMotion={reduceMotion}
        surface={surface}
        dialogTestId={ids.threads.deleteConfirm}
        cancelTestId={ids.threads.deleteConfirmCancel}
        confirmTestId={ids.threads.deleteConfirmAccept}
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
  // header right-action: a text label (Select / Done) in a ≥44pt Pressable, PLUS the compact RED Delete pill that
  // replaces the retired bottom-bar Delete (Delete lives in the header now, left of Done). The row hugs the right
  // gutter via the negative marginRight on the row (set inline where headerRight is built).
  headerAction: { minHeight: hit.min, justifyContent: 'center', paddingHorizontal: space.sm },
  headerRightRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerDeleteBtn: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill },
  headerDeleteLabel: { fontFamily: typeStyles.subhead.fontFamily, fontSize: typeStyles.subhead.fontSize, fontWeight: '700', color: '#FFFFFF' },
  bulkFail: { marginTop: space.xs },
})
