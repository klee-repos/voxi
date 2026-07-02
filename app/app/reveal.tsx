/**
 * Entry reveal (ANALYSIS-UX redesign) — a full-bleed photo with a compact dock at the bottom: the identification
 * plus five icons (four green research buckets — What it is · What it's for · Who made it · Curious facts — that
 * flip loading→active as async research streams, plus a blue Ask-Voxi icon). Tapping an active bucket morphs it
 * into a `BucketCard` with grounded content, a source proof, and that bucket's audio.
 *
 * READY-on-mount: processing navigates here on band-settle and keeps the stream alive, so `sections`/`facts` fill
 * in reactively. Buckets derive their state purely (deriveBucketStatus). Every `reveal.*` id + the ConfidenceChip
 * register + the How-sure teaching loop are preserved (the converge proof asserts them).
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions, FlatList, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { Camera } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { Screen, Title, Body, Muted, TextField } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner, SafetyRefusal } from '../src/components/Banners'
import { BucketDock, BucketCard, type DockKey, type AudioState } from '../src/components/RevealDock'
import { GlassFill } from '../src/components/GlassFill'
import { LoadingPill } from '../src/components/LoadingPill'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid, tidWith } from '../src/lib/testid'
import { radius, space, typeStyles, shadow, dark } from '../src/lib/theme'
import { useConnectivity } from '../src/lib/connectivity'
import { useApi } from '../src/lib/api'
import { useCaptureStore, deriveBucketStatus } from '../src/state/captureStore'
import { threadsKey } from '../src/lib/queryKeys'
import { pageableThreads } from '../src/lib/collectionOrder'
import { beginThreadStream, consumeThreadStream, isThreadStreaming, type StreamActions } from '../src/lib/threadStream'
import { revealLoadingPill, revealEmptyState } from '../src/lib/loadingCopy'
import type { AudioBucket, ThreadSummary } from '../src/lib/apiClient'
import { registerFor } from '../../packages/shared/src/confidence'
import { haptics } from '../src/lib/haptics'
import type { Edge } from 'react-native-safe-area-context'

// Full-bleed states run the photo to the physical bottom; the dock pads itself up by `insets.bottom`, so the
// Screen must NOT also inset the bottom — otherwise a strip of photo shows beneath the dock (the "gap").
const FULL_BLEED_EDGES: readonly Edge[] = ['top', 'left', 'right']

/** A research bucket maps 1:1 to its audio bucket (DockKey minus the conversation icon, which navigates). */
type ResearchKey = Exclude<DockKey, 'conversation'>

// The sentinel "camera" page prepended to the pager at the newest edge — swiping past the newest opens capture.
const CAMERA_KEY = '__camera__'
const CAMERA_PAGE: ThreadSummary = { threadId: CAMERA_KEY, title: '', createdAt: 0 }

function RevealBody(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion, speakAloud } = useTheme()
  const { width: winW, height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const offline = !useConnectivity().online
  const { title, band, whatItIs, candidates, facts, sections, photoUri, outcome, error, researchComplete, researchError, sawAnySection } =
    useCaptureStore()
  const threadId = useCaptureStore((s) => s.threadId)
  const lastSeenIndex = useCaptureStore((s) => s.lastSeenIndex)
  const isRevisit = useCaptureStore((s) => s.isRevisit)
  const reset = useCaptureStore((s) => s.reset)

  // Clear the shared capture store ONLY when reveal unmounts AS A CAMERA EXIT (back chevron / swipe-to-camera).
  // Deferring the reset to unmount — instead of running it in the handler before navigating — means the store is
  // cleared after reveal has left the tree, so it can never repaint the error-styled empty branch during the fade
  // (the "Nothing to show yet" flash). Gating on the ref keeps the store intact for the two reveal→/processing
  // replaces below (self-heal + the unavailable-bucket retry), which also unmount reveal but must resume the stream.
  const exitingToCamera = useRef(false)
  useEffect(() => () => { if (exitingToCamera.current) reset() }, [reset])

  useEffect(() => {
    if (threadId && !band && !outcome && !error) router.replace('/processing')
  }, [threadId, band, outcome, error, router])

  const isLow = band === 'PROBABLE' || band === 'UNKNOWN'
  // The "how sure / correct + generate story + add a tip" details are one tap away, never a default panel.
  const [showDetails, setShowDetails] = useState(false)
  const [correction, setCorrection] = useState('')

  // ---- Per-bucket audio (ANALYSIS-UX §5.C). Each clip is server-owned + synthesized lazily on first open (never
  //      pre-fetched for all four). Autoplay is best-effort, gated on the "Speak results aloud" pref. ----
  const [openBucket, setOpenBucket] = useState<ResearchKey | null>(null)
  const [audioUrls, setAudioUrls] = useState<Partial<Record<AudioBucket, string>>>({})
  const [audioStates, setAudioStates] = useState<Partial<Record<AudioBucket, AudioState>>>({})
  const [playing, setPlaying] = useState<AudioBucket | null>(null)
  const pollRef = useRef<Partial<Record<AudioBucket, number>>>({})

  const fetchAudio = useCallback(
    (bucket: AudioBucket): void => {
      if (!threadId) return
      setAudioStates((s) => (s[bucket] === 'ready' || s[bucket] === 'loading' ? s : { ...s, [bucket]: 'loading' }))
      const attempt = (): void => {
        void api.speakNarration(threadId, bucket).then((url) => {
          if (url) {
            pollRef.current[bucket] = 0
            setAudioUrls((s) => ({ ...s, [bucket]: url }))
            setAudioStates((s) => ({ ...s, [bucket]: 'ready' }))
            return
          }
          const n = (pollRef.current[bucket] ?? 0) + 1
          pollRef.current[bucket] = n
          if (n < 6) setTimeout(attempt, 700)
          else setAudioStates((s) => ({ ...s, [bucket]: 'failed' }))
        })
      }
      attempt()
    },
    [api, threadId],
  )

  // Pre-warm ONLY the `what` clip on band-settle (the near-certain first tap); the other three stay lazy (cost).
  // Top-level hook (runs before the early returns) so hook order is stable across every reveal state.
  useEffect(() => {
    if (threadId && band && band !== 'UNKNOWN' && !audioStates.what) fetchAudio('what')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, band])

  // ---- Swipe paging across catalogued items (Feature A): a horizontal paging FlatList (the standard RN pager). ----
  // `pages` is the newest-first REVEALABLE subset from the same `['threads']` cache the collection uses (skips
  // UNKNOWN/failed so a page never lands in the interview form). Swiping is the native scroll's paging; on settle
  // we load the landed item into the store, which repaints the dock. No PanResponder, no responder negotiation.
  const startCapture = useCaptureStore((s) => s.startCapture)
  const setThread = useCaptureStore((s) => s.setThread)
  const setBand = useCaptureStore((s) => s.setBand)
  const markRevisit = useCaptureStore((s) => s.markRevisit)
  const setLastSeenIndex = useCaptureStore((s) => s.setLastSeenIndex)
  const appendText = useCaptureStore((s) => s.appendText)
  const appendFact = useCaptureStore((s) => s.appendFact)
  const appendSection = useCaptureStore((s) => s.appendSection)
  const upgradeDescription = useCaptureStore((s) => s.upgradeDescription)
  const setResearchComplete = useCaptureStore((s) => s.setResearchComplete)
  const setResearchError = useCaptureStore((s) => s.setResearchError)

  const threadsQ = useQuery({ queryKey: threadsKey, queryFn: () => api.listThreads() })
  const pages = useMemo(() => pageableThreads(threadsQ.data?.threads ?? [], threadId), [threadsQ.data, threadId])
  const curIdx = pages.findIndex((t) => t.threadId === threadId)
  const canPage = curIdx >= 0
  // A CAMERA page sits at the newest edge (before the newest item): swiping past the newest toward a newer item
  // — which doesn't exist — lands here and opens the capture screen (the Instagram/Snap "camera as a page"
  // pattern). Real items follow it, so browsing older is unchanged. `curIdx` maps to pager index `curIdx + 1`.
  const pagerData = useMemo(() => [CAMERA_PAGE, ...pages], [pages])

  // Load the item the user paged to: paint the resting reveal INSTANTLY from the cached summary (setBand keeps
  // `band` non-null so READY renders and the self-heal guard never fires), then stream its buckets in behind —
  // exactly like a fresh capture. startCapture aborts the prior in-flight stream (single-owner). Audio is reset
  // so the previous item's clip can't play for the next.
  const loadPage = useCallback(
    (target: ThreadSummary): void => {
      if (target.threadId === threadId || offline) return
      setOpenBucket(null); setPlaying(null); setAudioUrls({}); setAudioStates({}); pollRef.current = {}
      startCapture(target.photoUrl ?? null)
      setThread(target.threadId)
      if (target.band) setBand(target.band, target.revealTitle ?? target.title, [])
      markRevisit()
      const ac = beginThreadStream()
      const actions: StreamActions = {
        setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setBand, setResearchComplete, setResearchError,
      }
      void consumeThreadStream(api, target.threadId, ac.signal, actions)
      haptics.tick()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, offline, api, startCapture, setThread, setBand, markRevisit, setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setResearchComplete, setResearchError],
  )

  // A revisit that skipped /processing (band seeded from the cached summary → READY paints instantly): OWN the
  // stream here so the durable buckets fill in behind the instant paint. Gated on `!isThreadStreaming()` so the
  // fresh-capture and UNKNOWN-revisit paths — which arrive via /processing with its keepAlive stream still running —
  // are untouched, and a swipe (which starts its own stream in `loadPage`) doesn't double-start. This is the fix for
  // "first open from the collection loads slowly while swiping is instant": both now paint from cache + stream behind.
  const bootStreamedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isRevisit || !threadId || !band || isThreadStreaming() || bootStreamedRef.current === threadId) return
    bootStreamedRef.current = threadId
    const ac = beginThreadStream()
    const actions: StreamActions = { setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setBand, setResearchComplete, setResearchError }
    void consumeThreadStream(api, threadId, ac.signal, actions)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevisit, threadId, band])

  // Load the page the scroll has SETTLED on. Driven by a debounced `onScroll` (fires reliably on both native and
  // react-native-web, unlike `onMomentumScrollEnd`) plus `onMomentumScrollEnd` for an immediate commit on native.
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Swiping onto the leading CAMERA page opens the capture screen (fresh state). Mark this as a camera exit so the
  // unmount cleanup clears the store AFTER reveal leaves (never a pre-nav reset — that repaints the empty branch).
  const goToCamera = useCallback((): void => { exitingToCamera.current = true; router.replace('/(tabs)/camera') }, [router])
  const settleToOffset = useCallback(
    (x: number): void => {
      const idx = Math.round(x / (winW || 1))
      if (idx <= 0) { goToCamera(); return } // pager index 0 is the camera page (before the newest item)
      const target = pages[idx - 1] // real items are offset by the prepended camera page
      if (target) loadPage(target)
    },
    [pages, winW, loadPage, goToCamera],
  )
  const onPageScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const x = e.nativeEvent.contentOffset.x
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => settleToOffset(x), 120)
    },
    [settleToOffset],
  )
  const onPageSettle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      settleToOffset(e.nativeEvent.contentOffset.x)
    },
    [settleToOffset],
  )
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current) }, [])

  const renderPage = useCallback(
    ({ item, index }: { item: ThreadSummary; index: number }): React.ReactElement => {
      // The leading page is the CAMERA affordance (a peek before you land + open capture). `index === curIdx+1`
      // is the item on screen now (the real current item, offset by the prepended camera page).
      if (item.threadId === CAMERA_KEY) {
        return (
          <View {...tid(ids.reveal.pagerCamera)} style={[{ width: winW, height: winH, backgroundColor: surface.bg }, styles.cameraPage]}>
            <Camera size={40} color={surface.textMuted} strokeWidth={2} />
            <Muted style={{ marginTop: space.md }}>New capture</Muted>
          </View>
        )
      }
      return (
        <View style={{ width: winW, height: winH }}>
          {item.photoUrl ? (
            <Image {...(index === curIdx + 1 ? tid(ids.reveal.photoThumb) : {})} source={{ uri: item.photoUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View {...(index === curIdx + 1 ? tid(ids.reveal.photoThumb) : {})} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
          )}
        </View>
      )
    },
    [winW, winH, curIdx, surface.card, surface.bg, surface.textMuted],
  )

  const backToCamera = (): void => {
    exitingToCamera.current = true // clear the store on unmount (a camera exit), not before nav — avoids the flash
    router.replace('/(tabs)/camera')
  }
  const mediaBackHeader = <AppHeader leading="back" onMedia onLeadingPress={backToCamera} />
  const surfaceBackHeader = <AppHeader leading="back" onLeadingPress={backToCamera} />

  // ---- EMPTY: opened here with nothing captured (a deep link). A calm, on-brand INVITATION — the Orb at rest,
  //      a warm one-liner, and a single "open the camera" action — never an error-styled "nothing to show". ----
  if (!photoUri && !band && !error) {
    const empty = revealEmptyState()
    return (
      <Screen id={ids.reveal.card} center header={surfaceBackHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>{empty.title}</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center' }}>{empty.body}</Body>
        <Pressable {...tid(ids.reveal.primaryAction)} accessibilityRole="button" onPress={backToCamera} style={[styles.pill, { backgroundColor: surface.accent, marginTop: space.lg, paddingHorizontal: space.xl }]}>
          <Text style={[typeStyles.headline, { color: surface.onAccent }]}>{empty.cta}</Text>
        </Pressable>
      </Screen>
    )
  }

  // ---- ERROR / REFUSAL. ----
  if (outcome === 'failure' || outcome === 'refusal') {
    const refused = outcome === 'refusal'
    return (
      <Screen id={ids.reveal.card} center header={surfaceBackHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="uncertain" size={96} />
        {refused ? (
          <SafetyRefusal visible message={error ?? undefined} />
        ) : (
          <View style={styles.errorBlock}>
            <Title {...tid(ids.reveal.title)} style={{ textAlign: 'center' }}>That one got away</Title>
            <Body {...tid(ids.reveal.quip)} style={{ marginTop: space.md, textAlign: 'center', fontStyle: 'italic' }}>
              {error ?? "I couldn't get a clear read. The fault is mine, not the object's."}
            </Body>
          </View>
        )}
        <Pressable {...tid(ids.reveal.primaryAction)} accessibilityRole="button" onPress={backToCamera} style={[styles.pill, { backgroundColor: surface.accent, marginTop: space.lg, paddingHorizontal: space.xl }]}>
          <Text style={[typeStyles.headline, { color: surface.onAccent }]}>Try another photo</Text>
        </Pressable>
      </Screen>
    )
  }

  // ---- LOADING: subject present, band not settled yet. ----
  if (!band) {
    return (
      <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES} style={{ minHeight: winH }}>
        <View style={StyleSheet.absoluteFill}>
          {photoUri ? (
            <Image {...tid(ids.reveal.photoThumb)} source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View {...tid(ids.reveal.photoThumb)} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
          )}
        </View>
        <View style={styles.headerOverlay} pointerEvents="box-none">{mediaBackHeader}</View>
        <OfflineBanner visible={offline} />
        <View style={[styles.loadingWrap, { paddingBottom: space.xxl + insets.bottom }]}>
          <LoadingPill
            text={revealLoadingPill(isRevisit ? 'revisit' : 'analyze').title}
            ack={offline ? "I've lost the thread — back when you're online." : revealLoadingPill(isRevisit ? 'revisit' : 'analyze').sub}
            onImage={!!photoUri}
            textTestId={ids.reveal.title}
            ackTestId={ids.reveal.quip}
          />
        </View>
      </Screen>
    )
  }

  // ---- READY: full-bleed photo + a compact icon dock. ----
  const register = registerFor(band)
  const quip = register.hedge
    ? "I'd stake a modest sum on this, though not the house."
    : 'A fine specimen. Allow me to introduce it properly.'
  const statusSlice = { band, whatItIs, sections, facts, researchComplete, researchError, sawAnySection }
  const statuses: Record<ResearchKey, ReturnType<typeof deriveBucketStatus>> = {
    what: deriveBucketStatus('what', statusSlice, offline),
    purpose: deriveBucketStatus('purpose', statusSlice, offline),
    maker: deriveBucketStatus('maker', statusSlice, offline),
    facts: deriveBucketStatus('facts', statusSlice, offline),
  }

  const openDock = (k: DockKey): void => {
    haptics.tick()
    if (k === 'conversation') { router.push('/conversation'); return } // blue lane → the full conversation screen
    const status = statuses[k]
    if (status === 'hidden' || status === 'loading') return // nothing to open yet
    if (status === 'unavailable') { router.replace('/processing') ; return } // resume the dropped research stream
    setOpenBucket(k)
    if (status === 'active') {
      fetchAudio(k)
      if (speakAloud) setPlaying(k) // best-effort autoplay on OPEN only (never on tab-switch), gated on the pref
    }
  }
  const switchTab = (k: ResearchKey): void => {
    setPlaying(null) // stop the previous clip; do NOT auto-play on a tab switch (hostile) — manual control only
    setOpenBucket(k)
    if (statuses[k] === 'active') fetchAudio(k)
  }
  const closeCard = (): void => { setPlaying(null); setOpenBucket(null) }

  const activeTabs = (['what', 'purpose', 'maker', 'facts'] as const).filter((k) => statuses[k] === 'active')
  // Prose buckets show ONLY their grounded text (no source row, no quote); facts carry their own per-fact source
  // under each fact (via the `facts` prop). `what` rides `whatItIs`; purpose/maker ride their section text.
  const cardBody = (k: ResearchKey): { body: string } => {
    if (k === 'what') return { body: whatItIs }
    if (k === 'facts') return { body: '' }
    return { body: sections[k]?.text ?? '' }
  }

  const openAudio = openBucket ? (openBucket as AudioBucket) : null

  return (
    <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES} style={{ minHeight: winH }}>
      {/* Full-bleed photo layer. It is a horizontal paging FlatList (the standard RN pager — native scroll paging
          on iOS/Android/web): a leading CAMERA page then the catalogued photos newest→oldest. Swiping pages the
          photos; a debounced onScroll loads the landed item (or opens capture on the camera page). Fallback (the
          just-captured item not yet in the collection cache) is the plain store photo. The dock + header overlay. */}
      {canPage ? (
        <FlatList
          {...tid(ids.reveal.pager)}
          data={pagerData}
          keyExtractor={(t) => t.threadId}
          renderItem={renderPage}
          horizontal
          pagingEnabled
          scrollEnabled={!openBucket}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={curIdx + 1}
          getItemLayout={(_d, index) => ({ length: winW, offset: winW * index, index })}
          onScroll={onPageScroll}
          scrollEventThrottle={16}
          onMomentumScrollEnd={onPageSettle}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={StyleSheet.absoluteFill}>
          {photoUri ? (
            <Image {...tid(ids.reveal.photoThumb)} source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View {...tid(ids.reveal.photoThumb)} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
          )}
        </View>
      )}
      <View style={styles.headerOverlay} pointerEvents="box-none">{mediaBackHeader}</View>
      <OfflineBanner visible={offline} />

      {/* A compact FLOATING CARD over the photo — the name + icons, hidden while a bucket card is open. */}
      <View style={[styles.floatWrap, { paddingBottom: space.lg + insets.bottom }, openBucket ? styles.dockHidden : null]} pointerEvents={openBucket ? 'none' : 'box-none'}>
        <View style={[styles.floatCard, shadow]}>
          {/* Liquid Glass over the full-bleed photo (absolute, pointer-through) — replaces the flat white fill; the
              card's paddings/radius/children are otherwise untouched (docs/REVEAL-DOCK-GLASS-PLAN.md §10). */}
          <GlassFill radiusStyle={{ borderRadius: radius.xl }} />
          {/* Floating over the photo → DARK glass with LIGHT text (a light tint washes the photo gray). The dark
              SurfaceProvider flips the context text components; BucketDock/BucketCard take the dark surface as a
              prop. (docs/REVEAL-DOCK-GLASS-PLAN.md §10) */}
          <SurfaceProvider surface="dark">
            {/* Tapping the name reveals "how sure / correct + story + tip". It carries the settled band as data
                (the honesty signal + the E2E band contract) without a visible chip. */}
            <Pressable {...tidWith(ids.reveal.howSure, { band }, 'The name — tap for how-sure + details')} accessibilityRole="button" onPress={() => setShowDetails((v) => !v)}>
              <Title {...tid(ids.reveal.title)}>{title || 'An object of some interest'}</Title>
            </Pressable>

            <BucketDock statuses={statuses} factCount={facts.length} reduceMotion={reduceMotion} surface={dark} onOpen={openDock} />

            {showDetails ? (
              <View style={styles.details}>
                <View {...tid(ids.reveal.evidencePanel)} style={[styles.evidence, { borderColor: dark.border }]}>
                  <Muted>
                    {isLow
                      ? "I narrowed it to a few candidates. Tell me which is right — it teaches the Guide."
                      : "Here's my working. Correct me if the Guide and I have it wrong."}
                  </Muted>
                  {candidates.map((name) => (
                    <Pressable
                      key={name}
                      {...tid(ids.reveal.candidateOption)}
                      accessibilityRole="button"
                      onPress={() => setCorrection(name)}
                      style={[styles.candidate, { backgroundColor: correction === name ? dark.accentSecondary : dark.sunken, borderColor: correction === name ? dark.accentSecondary : dark.border }]}
                    >
                      <Text style={[typeStyles.body, { color: correction === name ? dark.onAccent : dark.text }]}>{name}</Text>
                    </Pressable>
                  ))}
                  <TextField id={ids.reveal.correctId} value={correction} onChangeText={setCorrection} placeholder="Actually, it's…" />
                </View>
                <View style={styles.detailsLinks}>
                  {band === 'CONFIDENT' ? (
                    <Pressable {...tid(ids.nav.openPodcast)} accessibilityRole="link" onPress={() => router.push('/podcast')} style={styles.link}>
                      <Text {...tid(ids.reveal.generateStory, 'Generate story')} style={[typeStyles.subhead, { color: dark.accentSecondary }]}>Generate story</Text>
                    </Pressable>
                  ) : null}
                  <Pressable {...tid(ids.nav.openContribute)} accessibilityRole="link" onPress={() => router.push('/contribute')} style={styles.link}>
                    <Text {...tid(ids.reveal.addTip)} style={[typeStyles.subhead, { color: dark.accentSecondary }]}>Add a tip</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </SurfaceProvider>
        </View>
      </View>

      {/* quip retained for the converge register check (kept off-screen so the resting view is just name + icons) */}
      <Text {...tid(ids.reveal.quip)} style={styles.srQuip}>{quip}</Text>

      {/* Hidden paging anchor (off-layout, like srQuip): the E2E reads the current index / count + whether this
          reveal was opened by analysis or revisit off its data-* attributes. No user-facing counter. */}
      <View
        {...tidWith(ids.reveal.position, { index: String(curIdx), count: String(pages.length), openedvia: isRevisit ? 'revisit' : 'analyze' })}
        style={styles.srQuip}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />

      {openBucket && openAudio ? (
        <BucketCard
          bucket={openBucket}
          {...cardBody(openBucket)}
          facts={openBucket === 'facts' ? facts : undefined}
          audioUrl={audioUrls[openAudio] ?? null}
          audioState={audioStates[openAudio] ?? 'idle'}
          playing={playing === openAudio}
          reduceMotion={reduceMotion}
          surface={dark}
          tabs={activeTabs}
          onTab={switchTab}
          onPlayToggle={() => {
            if (audioUrls[openAudio]) setPlaying((p) => (p === openAudio ? null : openAudio))
            else if (audioStates[openAudio] === 'failed') { pollRef.current[openAudio] = 0; fetchAudio(openAudio) }
          }}
          onClose={closeCard}
        />
      ) : null}
    </Screen>
  )
}

export default function Reveal(): React.ReactElement {
  return (
    <SurfaceProvider surface="parchment">
      <RevealBody />
    </SurfaceProvider>
  )
}

const styles = StyleSheet.create({
  loadingWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: space.lg },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  // `floatWrap` anchors the card above the home indicator; `floatCard` is the card itself.
  floatWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.md, alignItems: 'center' },
  floatCard: { width: '100%', maxWidth: 460, borderRadius: radius.xl, paddingHorizontal: space.lg, paddingVertical: space.lg },
  // While a morph card is open it fully replaces the dock — hide the dock so it doesn't bleed through the card's
  // translucent glass (and so the card's backdrop-filter isn't sampling a second glass layer beneath it).
  dockHidden: { opacity: 0 },
  chipRow: { flexDirection: 'row', marginTop: space.sm, alignSelf: 'flex-start' },
  pill: { height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  details: { marginTop: space.md, gap: space.sm },
  detailsLinks: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.xs },
  link: { minHeight: 44, justifyContent: 'center' },
  evidence: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, marginTop: space.xs, gap: space.sm },
  candidate: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  errorBlock: { marginVertical: space.lg, maxWidth: 360 },
  // Off-layout but present so the converge register check for reveal.quip resolves without cluttering the dock.
  srQuip: { position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 },
  // The leading CAMERA pager page — a calm centered affordance you glimpse as you swipe past the newest.
  cameraPage: { alignItems: 'center', justifyContent: 'center' },
})
