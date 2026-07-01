/**
 * Threads / collection (PLAN §10.2 screen 9) — the retention engine, X "Chat History" model (design-notes
 * §Threads): a GRID of captured-object thumbnails (the proto-Pokédex "collection") up top, then the same
 * captures as AUTO-TITLED threads GROUPED BY DATE (Today / Yesterday / earlier), each row revisiting the
 * durable eve session. Loads via TanStack Query against the owner-scoped GET /v1/threads.
 *
 * State matrix (PLAN §10.2): loading = a spinner while the collection fetches; empty = the DESIGNED first-run
 * state ("0 of ∞ catalogued — the Guide is vast…", prominent "Capture your first object"); error = an
 * in-persona failure with retry; offline = global.offlineBanner (cached list still shown if present).
 * Revisit = tap a capture/thread → resume that thread (reveal). testids: threads.screen / emptyState /
 * captureCta / grid / item.
 */
import React, { useMemo } from 'react'
import { View, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { Screen, Title, Body, Muted, Button, PressableTile } from '../../src/components/ui'
import { AppHeader } from '../../src/components/AppHeader'
import { OfflineBanner } from '../../src/components/Banners'
import { ids, tid } from '../../src/lib/testid'
import { radius, space } from '../../src/lib/theme'
import { useTheme } from '../../src/lib/themeProvider'
import { useApi } from '../../src/lib/api'
import { useOffline, isOfflineError } from '../../src/lib/useOffline'
import { useCaptureStore } from '../../src/state/captureStore'
import type { ThreadSummary } from '../../src/lib/apiClient'

/** Date buckets for the "chat history" grouping (newest first). */
const DAY = 86_400_000
function bucketLabel(createdAt: number, now: number): string {
  const days = Math.floor((startOfDay(now) - startOfDay(createdAt)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Earlier this week'
  if (days < 30) return 'Earlier this month'
  return 'Earlier'
}
function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface DateGroup {
  label: string
  items: ThreadSummary[]
}
function groupByDate(threads: ThreadSummary[]): DateGroup[] {
  const now = Date.now()
  const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt)
  const out: DateGroup[] = []
  for (const t of sorted) {
    const label = bucketLabel(t.createdAt, now)
    const last = out[out.length - 1]
    if (last && last.label === label) last.items.push(t)
    else out.push({ label, items: [t] })
  }
  return out
}

export default function Threads(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface } = useTheme()
  const setThread = useCaptureStore((s) => s.setThread)
  const startCapture = useCaptureStore((s) => s.startCapture)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['threads'],
    queryFn: () => api.listThreads(),
  })

  // offline = passive navigator signal OR an active network-failed fetch (vs an HTTP/app error, which is an
  // in-persona error block, not the offline banner).
  const offline = useOffline(isOfflineError(error))

  const threads = data?.threads ?? []
  const groups = useMemo(() => groupByDate(threads), [threads])

  // Collection is a top-level drawer destination → its back returns HOME (camera), not to whichever other
  // destination you came from. Same header across all four states (loading/error/empty/populated).
  const backHeader = <AppHeader leading="back" onLeadingPress={() => router.navigate('/(tabs)/camera')} />

  function openThread(item: ThreadSummary): void {
    // Revisit → resume the durable eve session behind this thread. Route through /processing, which STREAMS the
    // thread (the BFF REPLAYS the persisted reveal — deterministic, no re-run/re-bill) then hands off to /reveal
    // or /interview. startCapture() resets any prior scan's state AND seeds the durable photo so the image shows
    // immediately (the content is re-derived by the replayed stream), instead of a blank card.
    startCapture(item.photoUrl ?? null)
    setThread(item.threadId)
    router.push('/processing')
  }

  // ---- loading: first fetch with nothing cached ----
  if (isLoading) {
    return (
      <Screen id={ids.threads.screen} center header={backHeader}>
        <ActivityIndicator color={surface.accent} />
        <Muted style={{ marginTop: space.md }}>Opening your collection…</Muted>
      </Screen>
    )
  }

  // ---- error: fetch failed and we have nothing to show ----
  if (isError && threads.length === 0) {
    return (
      <Screen id={ids.threads.screen} center header={backHeader}>
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
      <Screen id={ids.threads.screen} center header={backHeader}>
        <OfflineBanner visible={offline} />
        <View {...tid(ids.threads.emptyState)} style={styles.empty}>
          <Title style={{ textAlign: 'center' }}>0 of ∞ catalogued.</Title>
          <Body style={{ textAlign: 'center', marginTop: space.md }}>
            The Guide is vast, and presently rather empty on your account. Photograph your first object and
            we'll begin filling it in — a bike, a camera, a curious bottle.
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

  // ---- populated: collection grid + date-grouped titled threads ----
  return (
    <Screen id={ids.threads.screen} header={backHeader}>
      <OfflineBanner visible={offline} />
      <Title>Your collection</Title>
      <Muted style={{ marginBottom: space.md }}>{threads.length} catalogued · ∞ to go</Muted>

      {/* The collection is the GRID of captures (the proto-Pokédex), organised into DATE-GROUPED titled
          sections (Today / Yesterday / earlier — the X "Chat History" model). `threads.grid` marks the whole
          collection container; each capture tile is the single canonical `threads.item` (one per thread, so
          the selector matches exactly N), titled by its auto-title and tappable to REVISIT the durable eve
          session. This unifies "grid of captures" + "date-grouped titled threads" without duplicating ids. */}
      <ScrollView
        {...tid(ids.threads.grid)}
        contentContainerStyle={{ paddingBottom: space.xl }}
        showsVerticalScrollIndicator={false}
      >
        {groups.map((g) => (
          <View key={g.label} style={{ marginBottom: space.lg }}>
            <Muted style={styles.groupLabel}>{g.label}</Muted>
            <View style={styles.grid}>
              {g.items.map((item) => (
                <PressableTile
                  key={item.threadId}
                  id={ids.threads.item}
                  onPress={() => openThread(item)}
                  style={[styles.tile, { backgroundColor: surface.card, borderColor: surface.border, overflow: 'hidden' }]}
                >
                  {/* durable capture thumbnail — the persisted photo, loaded via its signed URL. */}
                  {item.photoUrl ? (
                    <Image {...tid(ids.threads.itemPhoto)} source={{ uri: item.photoUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : null}
                  {item.photoUrl ? <View style={[StyleSheet.absoluteFill, styles.scrim]} pointerEvents="none" /> : null}
                  {/* the identified label (falls back to the auto-title until the reveal settles). */}
                  <Body numberOfLines={2} style={item.photoUrl ? styles.tileTextOnPhoto : undefined}>
                    {item.revealTitle || item.title}
                  </Body>
                  <Muted style={[{ marginTop: space.xs }, item.photoUrl ? styles.tileTextOnPhoto : undefined]}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </Muted>
                </PressableTile>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>

      <Button
        id={ids.threads.captureCta}
        label={isFetching ? 'Refreshing…' : 'Capture another'}
        onPress={() => router.replace('/(tabs)/camera')}
        style={{ marginTop: space.md }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  empty: { maxWidth: 420 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: {
    minHeight: 120,
    width: '47%',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    justifyContent: 'flex-end',
  },
  scrim: { backgroundColor: 'rgba(20,18,14,0.42)' }, // legibility under the identified label
  tileTextOnPhoto: { color: '#FFFFFF' },
  groupLabel: { textTransform: 'uppercase', letterSpacing: 1, marginBottom: space.sm, marginTop: space.md },
})
