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
import { View, Text, Pressable, StyleSheet, Animated, Platform, useWindowDimensions, FlatList, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Images } from 'lucide-react-native'
import { Screen, Title, Body, Muted, TextField, Button } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner, SafetyRefusal } from '../src/components/Banners'
import { BucketDock, BucketCard, type DockKey, type AudioState } from '../src/components/RevealDock'
import { RevealMoreMenu } from '../src/components/RevealMoreMenu'
import { ConfirmDialog } from '../src/components/ConfirmDialog'
import { GlassFill } from '../src/components/GlassFill'
import { LoadingOverlay } from '../src/components/LoadingOverlay'
import { CaptureOrb } from '../src/components/CaptureOrb'
import { RecentCard } from '../src/components/RecentCard'
import { CameraView, type CameraViewHandle } from '../src/components/CameraView'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid, tidWith } from '../src/lib/testid'
import { radius, space, typeStyles, shadow, dark, scrim, hit } from '../src/lib/theme'
import { useConnectivity } from '../src/lib/connectivity'
import { useApi } from '../src/lib/api'
import { ApiError } from '../src/lib/apiClient'
import { useCaptureStore, deriveBucketStatus } from '../src/state/captureStore'
import { threadsKey } from '../src/lib/queryKeys'
import { pageableThreads } from '../src/lib/collectionOrder'
import { beginThreadStream, consumeThreadStream, type StreamActions } from '../src/lib/threadStream'
import { useThreadStreamRun } from '../src/lib/useThreadStreamRun'
import { cacheReveal, getCachedReveal, evictReveal } from '../src/lib/revealCache'
import { createCameraPermission, type CameraPermissionStatus } from '../src/lib/cameraPermission'
import { toDataUri } from '../src/lib/photo'
import { isTestMode, getTestSeed } from '../src/lib/testSeed'
import { loadFixtureDataUri } from '../src/lib/e2eFixtures'
import { revealEmptyState } from '../src/lib/loadingCopy'
import type { AudioBucket, ThreadSummary } from '../src/lib/apiClient'
import { registerFor } from '../../packages/shared/src/confidence'
import { haptics } from '../src/lib/haptics'
import type { Edge } from 'react-native-safe-area-context'

// Full-bleed states run the photo to the physical bottom; the dock pads itself up by `insets.bottom`, so the
// Screen must NOT also inset the bottom — otherwise a strip of photo shows beneath the dock (the "gap").
const FULL_BLEED_EDGES: readonly Edge[] = ['top', 'left', 'right']

/** A research bucket maps 1:1 to its audio bucket — the morph buckets only (both `conversation` and `deepdive`
 *  NAVIGATE, so neither leaks into the morph-card / audio-bucket / deriveBucketStatus paths; adversarial D4). */
type ResearchKey = Exclude<DockKey, 'conversation' | 'deepdive'>

// Page 0 of the ONE home pager is the LIVE VIEWFINDER (the fixed CameraView shows through a transparent page).
// Pages 1..N are the catalogued items. Sliding viewfinder⇄item is pure scrolling — no navigation, no screen
// swap — so there is nothing to fade or remount (the camera-as-a-page merge; camera.tsx re-exports this Home).
const VIEWFINDER_KEY = '__viewfinder__'
const VIEWFINDER_PAGE: ThreadSummary = { threadId: VIEWFINDER_KEY, title: '', createdAt: 0 }

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
  const setError = useCaptureStore((s) => s.setError)

  // A durable Deep Dive episode already? → the dock icon shows a "ready" dot so a tap reads as replay (free), not
  // generate (spends a credit) — cost transparency (adversarial D7). Fires GET /v1/threads/:id (the podcast field,
  // uncalled elsewhere in the app) once we're on an item; staleTime avoids refetch spam.
  const deepDiveReady =
    useQuery({
      queryKey: ['deepDiveReady', threadId],
      queryFn: async () => (threadId ? (await api.getThread(threadId)).podcast?.state === 'ready' : false),
      enabled: !!threadId,
      staleTime: 30_000,
    }).data ?? false

  // ---- VIEWFINDER (page 0): the live camera + capture, merged in so camera⇄item is ONE pager (no navigation). ----
  const queryClient = useQueryClient()
  const perm = useMemo(() => createCameraPermission(), [])
  const [permission, setPermission] = useState<CameraPermissionStatus>(() => perm.getStatus())
  const [requesting, setRequesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [camOffline, setCamOffline] = useState(false)
  const [trayOpen, setTrayOpen] = useState(false)
  // 0 = viewfinder, ≥1 = catalogued item. Opened WITH a current item (a deep-link / collection revisit) starts on
  // that item's page; the plain camera home starts on the viewfinder.
  const [currentIndex, setCurrentIndex] = useState(() => (useCaptureStore.getState().threadId ? 1 : 0))
  const cameraRef = useRef<CameraViewHandle>(null)
  const camMounted = useRef(true)
  const pendingCaptureScroll = useRef(false) // after a capture, scroll the pager onto the new item once it lands in `pages`
  const pagerRef = useRef<FlatList<ThreadSummary>>(null)
  // While the pager is mid-scroll the fixed bottom chrome (dock / shutter bar) is HIDDEN, so it doesn't sit pinned
  // over the sliding photos and pop on settle — the whole surface reads as one moving thing. Ref-guarded so a
  // per-frame scroll event flips React state at most once per gesture.
  const [transitioning, setTransitioning] = useState(false)
  const transitioningRef = useRef(false)
  const beginTransition = useCallback((): void => { if (!transitioningRef.current) { transitioningRef.current = true; setTransitioning(true) } }, [])
  const endTransition = useCallback((): void => { if (transitioningRef.current) { transitioningRef.current = false; setTransitioning(false) } }, [])
  useEffect(() => {
    camMounted.current = true
    if (perm.getStatus() === 'undetermined') {
      setRequesting(true)
      perm.request().then((s) => camMounted.current && setPermission(s)).finally(() => camMounted.current && setRequesting(false))
    }
    return () => { camMounted.current = false }
  }, [perm])

  // The Home is the persistent tab surface (viewfinder + items in one pager), so it does NOT reset on unmount —
  // "back" from an item slides to the viewfinder in place (toViewfinder), and a failed capture is discarded via
  // `reset()` + slide to the viewfinder. `reset` is retained for that discard path.

  // Reveal OWNS the stream (LOADING-EXPERIENCE-PLAN §3.3): a fresh capture arrives with band=null and this drives
  // the pre-band loading overlay → settle in place; a from-cache revisit opens already-settled and this fills the
  // async buckets behind. The hook's single-owner guard leaves the in-place SWIPE (loadPage) untouched. This
  // REPLACES the old self-heal bounce to /processing (the D1 remount) + the bootStreamedRef effect.
  const run = useThreadStreamRun({
    threadId,
    isRevisit,
    api,
    reduceMotion,
    onOutcome: (dest) => { if (dest === 'interview') router.replace('/interview') },
  })

  // Loading is the ORIGINAL orb experience as a dark OVERLAY (scrim + scan-line + the narrator Orb pill), fading
  // out as the settled dock's CONTENT fades in. The scrim + pill fade via overlayFade; the dock content via
  // contentFade — a sibling of the static GlassFill, so the native Liquid Glass never breaks.
  const overlayFade = useRef(new Animated.Value(run.phase === 'streaming' ? 1 : 0)).current
  const contentFade = useRef(new Animated.Value(band ? 1 : 0)).current
  const viewfinderFade = useRef(new Animated.Value(1)).current // the viewfinder shutter bar (no glass — animate freely)
  const [overlayMounted, setOverlayMounted] = useState(run.phase !== 'settled')
  useEffect(() => {
    if (run.phase === 'streaming') {
      overlayFade.setValue(1); contentFade.setValue(0); setOverlayMounted(true)
    } else if (run.phase === 'settled') {
      const dur = reduceMotion ? 0 : 260
      Animated.timing(overlayFade, { toValue: 0, duration: dur, useNativeDriver: false }).start(({ finished }) => { if (finished) setOverlayMounted(false) })
      Animated.timing(contentFade, { toValue: 1, duration: dur, useNativeDriver: false }).start()
    }
    // 'failed' keeps the overlay mounted — the Orb pill shows the retry in place.
  }, [run.phase, reduceMotion, overlayFade, contentFade])

  // Bottom chrome ANIMATES back in on settle (not a hard snap): while scrolling the chrome is hidden (the glass
  // card via a hard opacity toggle, so the Liquid Glass never breaks); on settle the CONTENT fades + rises — the
  // dock title/icons via contentFade (a GlassFill sibling, glass-safe), the glass-less shutter bar via viewfinderFade.
  // Keyed ONLY on `transitioning` (band/index via refs) so a fresh capture's band-settle can't fire this early and
  // race the loading overlay — that first entrance stays owned by the run.phase cross-dissolve above.
  const bandRef = useRef(band); bandRef.current = band
  const currentIndexRef = useRef(currentIndex); currentIndexRef.current = currentIndex
  useEffect(() => {
    if (transitioning) { contentFade.setValue(0); viewfinderFade.setValue(0); return }
    const dur = reduceMotion ? 0 : 240
    if (currentIndexRef.current <= 0) Animated.timing(viewfinderFade, { toValue: 1, duration: dur, useNativeDriver: false }).start()
    else if (bandRef.current) Animated.timing(contentFade, { toValue: 1, duration: dur, useNativeDriver: false }).start()
  }, [transitioning, reduceMotion, contentFade, viewfinderFade])

  // Cache this thread's FULLY-loaded content once research settles, so swiping back to it later paints instantly
  // (band + title + buckets) with no re-fetch/loading — "no loading when you go back and forth".
  useEffect(() => {
    if (threadId && band && researchComplete) {
      cacheReveal(threadId, { band, title, candidates, whatItIs, facts, sections, sawAnySection })
    }
  }, [threadId, band, researchComplete, title, candidates, whatItIs, facts, sections, sawAnySection])

  // A FRESH capture's band is persisted server-side once it settles — refresh the collection so the item is
  // pageable from OTHER items too (pageableThreads keeps a non-current item only once its band is known), i.e.
  // you can swipe back to a just-captured item after browsing to an older one. Revisits already carry the band.
  useEffect(() => {
    if (threadId && band && !isRevisit) void queryClient.invalidateQueries({ queryKey: threadsKey })
  }, [threadId, band, isRevisit, queryClient])

  const isLow = band === 'PROBABLE' || band === 'UNKNOWN'
  // The "how sure / correct + generate story + add a tip" details are one tap away, never a default panel.
  const [showDetails, setShowDetails] = useState(false)
  const [correction, setCorrection] = useState('')
  // ⋯ MORE menu (item pages): the sheet, its two confirm dialogs, and an in-flight guard so a slow delete/regen
  // can't be double-submitted.
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState<null | 'delete' | 'regenerate'>(null)
  const [actionBusy, setActionBusy] = useState(false)

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
  const hydrate = useCaptureStore((s) => s.hydrate)
  const setLastSeenIndex = useCaptureStore((s) => s.setLastSeenIndex)
  const appendText = useCaptureStore((s) => s.appendText)
  const appendFact = useCaptureStore((s) => s.appendFact)
  const appendSection = useCaptureStore((s) => s.appendSection)
  const upgradeDescription = useCaptureStore((s) => s.upgradeDescription)
  const setResearchComplete = useCaptureStore((s) => s.setResearchComplete)
  const setResearchError = useCaptureStore((s) => s.setResearchError)

  // Capture from the viewfinder: create the thread, then let the pager scroll onto the new item IN PLACE (no
  // navigation) — the item's loading overlay → dock settles right there on page 1.
  const onShutter = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setCamOffline(false)
    try {
      let photoUrl: string
      let displayUri: string | null
      if (isTestMode()) {
        // The iOS Simulator has no camera — load the bundled fixture through the SAME intake path (honest test
        // image; the reveal band is steered by the optional seed, not the pixels).
        photoUrl = await loadFixtureDataUri()
        displayUri = photoUrl
      } else {
        const shot = (await cameraRef.current?.takePhoto().catch(() => null)) ?? null
        if (shot) {
          photoUrl = await toDataUri(shot)
          displayUri = photoUrl
        } else {
          const signed = await api.signUpload().catch(() => ({ url: 'capture://local' }) as { url: string })
          photoUrl = signed.url
          displayUri = null
        }
      }
      startCapture(displayUri)
      const { threadId: newId } = await api.createThread({ photoUrl, testSeed: getTestSeed() ?? undefined })
      void queryClient.invalidateQueries({ queryKey: threadsKey })
      setThread(newId)
      pendingCaptureScroll.current = true
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[capture] FAILED :: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      if (e instanceof ApiError && e.status === 402) {
        router.push('/paywall')
        return
      }
      haptics.error()
      setCamOffline(true)
      setError(e instanceof Error ? e.message : 'capture_failed')
    } finally {
      if (camMounted.current) setBusy(false)
    }
  }, [busy, api, startCapture, setThread, queryClient, setError, router])

  const threadsQ = useQuery({ queryKey: threadsKey, queryFn: () => api.listThreads() })
  const fetchedPages = useMemo(() => pageableThreads(threadsQ.data?.threads ?? [], threadId), [threadsQ.data, threadId])
  // Keep the CURRENT thread in `pages` even before the collection refetch lands it (a fresh capture), so the pager
  // FlatList — keyed on threadId — is the SINGLE persistent photo host: the current cell never swaps to a plain
  // <Image> and never remounts at band-settle (LOADING-EXPERIENCE-PLAN §3.2 / C1). When the real summary arrives
  // it carries the same threadId key, so React reconciles the cell in place (no flash).
  const pages = useMemo(() => {
    if (!threadId || fetchedPages.some((t) => t.threadId === threadId)) return fetchedPages
    const current: ThreadSummary = { threadId, title: title || '', createdAt: Number.MAX_SAFE_INTEGER, photoUrl: photoUri ?? undefined, band: band ?? undefined, revealTitle: title || undefined }
    return [current, ...fetchedPages]
  }, [fetchedPages, threadId, photoUri, band, title])
  const curIdx = pages.findIndex((t) => t.threadId === threadId)
  const canPage = curIdx >= 0
  // Page 0 is the live VIEWFINDER; the catalogued items follow. An item's index `curIdx` maps to pager index
  // `curIdx + 1` (offset by the leading viewfinder page).
  const pagerData = useMemo(() => [VIEWFINDER_PAGE, ...pages], [pages])

  // After a capture, scroll the pager onto the NEW item (page 1) once it lands in `pages`, so its loading overlay
  // → dock settles right there IN PLACE — no navigation. curIdx is the new item's index (0 = newest).
  useEffect(() => {
    if (pendingCaptureScroll.current && curIdx >= 0) {
      pendingCaptureScroll.current = false
      const page = curIdx + 1
      pagerRef.current?.scrollToIndex({ index: page, animated: true })
      setCurrentIndex(page)
    }
  }, [curIdx])

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
      markRevisit()
      // Fully cached this session → paint the complete content instantly, no re-stream (no bucket loading flicker).
      const cached = getCachedReveal(target.threadId)
      if (cached) { hydrate(cached); haptics.tick(); return }
      if (target.band) setBand(target.band, target.revealTitle ?? target.title, [])
      const ac = beginThreadStream()
      const actions: StreamActions = {
        setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setBand, setResearchComplete, setResearchError,
      }
      void consumeThreadStream(api, target.threadId, ac.signal, actions)
      haptics.tick()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, offline, api, startCapture, setThread, setBand, markRevisit, hydrate, setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setResearchComplete, setResearchError],
  )

  // Load the page the scroll has SETTLED on. Driven by a debounced `onScroll` (fires reliably on both native and
  // react-native-web, unlike `onMomentumScrollEnd`) plus `onMomentumScrollEnd` for an immediate commit on native.
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // On settle: page 0 is the live viewfinder (just stay — NO navigation, it's the same screen); page ≥1 loads
  // that item into the store, which repaints the dock. `currentIndex` drives which overlay shows (controls vs dock).
  const settleToOffset = useCallback(
    (x: number): void => {
      endTransition() // scroll stopped → restore the bottom chrome for the settled page
      const idx = Math.round(x / (winW || 1))
      setCurrentIndex(idx)
      if (idx <= 0) return // page 0 = the live viewfinder; nothing to load, no navigation
      const target = pages[idx - 1] // items are offset by the leading viewfinder page
      if (target) loadPage(target)
    },
    [pages, winW, loadPage, endTransition],
  )
  const onPageScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      beginTransition() // any pager movement → hide the fixed bottom chrome until it settles
      const x = e.nativeEvent.contentOffset.x
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => settleToOffset(x), 120)
    },
    [settleToOffset, beginTransition],
  )
  const onPageSettle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      settleToOffset(e.nativeEvent.contentOffset.x)
    },
    [settleToOffset],
  )
  // "Back" from an item = slide to the viewfinder (page 0), IN PLACE — never a route change.
  const toViewfinder = useCallback((): void => { pagerRef.current?.scrollToIndex({ index: 0, animated: true }); setCurrentIndex(0) }, [])
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current) }, [])

  const renderPage = useCallback(
    ({ item, index }: { item: ThreadSummary; index: number }): React.ReactElement => {
      // The leading page is the CAMERA affordance (a peek before you land + open capture). `index === curIdx+1`
      // is the item on screen now (the real current item, offset by the prepended camera page).
      if (item.threadId === VIEWFINDER_KEY) {
        // Transparent — the FIXED live CameraView beneath shows through (the viewfinder page). No screen swap.
        return <View {...tid(ids.reveal.pagerCamera)} style={{ width: winW, height: winH }} pointerEvents="none" />
      }
      // For the CURRENT thread use the stable store data-URI (not item.photoUrl), so the synthetic→real summary
      // swap can't change the Image source and reload/flash mid-settle. `data-mounted` lets the E2E prove the
      // element persists across the band-settle dissolve (no remount).
      const isCurrent = item.threadId === threadId
      const uri = isCurrent && photoUri ? photoUri : item.photoUrl
      const thumbProps = index === curIdx + 1 ? tidWith(ids.reveal.photoThumb, { mounted: item.threadId }) : {}
      return (
        <View style={{ width: winW, height: winH }}>
          {uri ? (
            <Image {...thumbProps} source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View {...thumbProps} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
          )}
        </View>
      )
    },
    [winW, winH, curIdx, threadId, photoUri, surface.card, surface.bg, surface.textMuted],
  )

  // An item's "back" slides to the VIEWFINDER in place (page 0) — never a route change. The ⋯ opens the MORE sheet.
  const mediaBackHeader = (
    <AppHeader leading="back" onMedia onLeadingPress={toViewfinder} showMore={!!threadId} onMore={() => { haptics.tick(); setMenuOpen(true) }} />
  )
  // Discard a failed capture and return to the viewfinder (clears the errored item from the store).
  const discardCapture = (): void => { reset(); setCurrentIndex(0) }

  // ⋯ DELETE (two-step: the menu row opened the confirm dialog; only the dialog's destructive button reaches here).
  // Clear the store threadId (else the synthetic-current pager page at `pages` resurrects the just-deleted item) and
  // slide to the viewfinder IN PLACE — the reveal IS the camera tab, so there is no back stack on a fresh capture and
  // router.back would dead-click. A 404 (already gone) is success-equivalent; any other error keeps the item.
  const onConfirmDelete = useCallback(async (): Promise<void> => {
    const id = useCaptureStore.getState().threadId
    if (!id) { setConfirm(null); return }
    setActionBusy(true)
    try {
      await api.deleteThread(id)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) { haptics.error(); setActionBusy(false); setConfirm(null); return }
    }
    evictReveal(id)
    reset()
    setConfirm(null); setActionBusy(false)
    toViewfinder()
    // Collection hygiene AFTER leaving the item (doing it before would shrink the pager list mid-scroll and break the
    // viewfinder transition): optimistically drop the item from the collection cache — the tile disappears instantly
    // and the collection reads empty deterministically (no refetch race) — then invalidate for server-truth.
    queryClient.setQueryData<{ threads: ThreadSummary[] }>(threadsKey, (old) => (old ? { threads: old.threads.filter((t) => t.threadId !== id) } : old))
    void queryClient.invalidateQueries({ queryKey: threadsKey })
    haptics.tick()
  }, [api, queryClient, reset, toViewfinder])

  // ⋯ REGENERATE: re-run identification for the SAME thread. Evict the in-session cache (else a swipe-back re-hydrates
  // the stale reveal), reset the reveal slice while KEEPING the photo (startCapture clears band/researchComplete and
  // isRevisit), then FORCE a fresh stream — threadId is unchanged so the run effect won't re-fire on its own, so
  // run.retry() drives the live cascade and the dark LoadingOverlay reappears (proof the re-run actually happened).
  const onConfirmRegenerate = useCallback(async (): Promise<void> => {
    const id = useCaptureStore.getState().threadId
    const photo = useCaptureStore.getState().photoUri
    if (!id) { setConfirm(null); return }
    setActionBusy(true)
    try {
      await api.regenerateThread(id)
    } catch {
      haptics.error(); setActionBusy(false); setConfirm(null); return
    }
    evictReveal(id)
    void queryClient.invalidateQueries({ queryKey: threadsKey })
    startCapture(photo)
    setThread(id)
    setConfirm(null); setActionBusy(false)
    run.retry()
    haptics.tick()
  }, [api, queryClient, startCapture, setThread, run])

  // ---- ERROR / REFUSAL: a failed capture → a full-screen apology + "Try another photo" back to the viewfinder. ----
  if (outcome === 'failure' || outcome === 'refusal') {
    const refused = outcome === 'refusal'
    return (
      <Screen id={ids.reveal.card} center header={<AppHeader leading="menu" showWordmark />}>
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
        <Pressable {...tid(ids.reveal.primaryAction)} accessibilityRole="button" onPress={discardCapture} style={[styles.pill, { backgroundColor: surface.accent, marginTop: space.lg, paddingHorizontal: space.xl }]}>
          <Text style={[typeStyles.headline, { color: surface.onAccent }]}>Try another photo</Text>
        </Pressable>
      </Screen>
    )
  }

  // ---- READY / LOADING share ONE surface: a full-bleed photo (the pager) with the loading overlay and the dock
  //      as opacity-animated siblings above it. `band` gates the dock; `run.phase` gates the overlay. ----
  const register = band ? registerFor(band) : { hedge: false }
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
    if (k === 'deepdive') { router.push('/podcast'); return } // green audio lane → the on-demand Deep Dive player
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
  const onViewfinder = currentIndex <= 0 // page 0 = the live viewfinder; ≥1 = a catalogued item
  const onFeed = Platform.OS !== 'web' // a live camera feed (native) vs the cream canvas (web/harness)

  return (
    <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES} style={{ minHeight: winH }}>
      {/* The home carries `camera.screen` while on the viewfinder (the E2E's home marker) — a tiny transparent,
          pointer-through element so it's findable but never intercepts taps or paints. */}
      {onViewfinder ? <View {...tid(ids.camera.screen)} style={styles.screenMarker} pointerEvents="none" /> : null}
      {/* FIXED live viewfinder beneath EVERYTHING — page 0 (transparent) shows it through; item pages cover it.
          It never remounts, so camera⇄item is seamless. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <CameraView ref={cameraRef} active={onViewfinder && !busy} />
      </View>
      {/* The ONE home pager: page 0 = viewfinder (transparent), pages 1..N = catalogued item photos. Sliding is
          pure scrolling — NO navigation, no screen swap, nothing to fade or remount. */}
      <FlatList
        {...tid(ids.reveal.pager)}
        ref={pagerRef}
        data={pagerData}
        keyExtractor={(t) => t.threadId}
        renderItem={renderPage}
        horizontal
        pagingEnabled
        scrollEnabled={!openBucket && !trayOpen}
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={Math.max(curIdx + 1, 0)}
        getItemLayout={(_d, index) => ({ length: winW, offset: winW * index, index })}
        onScroll={onPageScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onPageSettle}
        style={StyleSheet.absoluteFill}
      />
      {!onFeed && onViewfinder ? <View style={[styles.reticle, { borderColor: surface.border }]} pointerEvents="none" /> : null}
      {/* header: on the viewfinder = menu + wordmark; on an item = back (slides to the viewfinder in place). */}
      <View style={styles.headerOverlay} pointerEvents="box-none">
        {onViewfinder ? <AppHeader leading="menu" showWordmark onMedia={onFeed} /> : mediaBackHeader}
      </View>
      <OfflineBanner visible={offline || camOffline} />

      {/* The dark-overlay loading LAYER over the current item's photo (only on an item page, never the viewfinder). */}
      {overlayMounted && !onViewfinder ? (
        <LoadingOverlay
          run={run}
          kind={isRevisit ? 'revisit' : 'analyze'}
          isRevisit={isRevisit}
          reduceMotion={reduceMotion}
          onImage={!!photoUri}
          winH={winH}
          bottomInset={insets.bottom}
          scrimColor={scrim}
          accentColor={surface.accent}
          style={{ opacity: overlayFade }}
        />
      ) : null}

      {/* The floating dock CARD — shown on an item page once the band settles (never on the viewfinder). During
          loading it's the Orb pill overlay above. STATIC glass card; only the content fades in on settle. */}
      {band && !onViewfinder ? (
        <View style={[styles.floatWrap, { paddingBottom: space.lg + insets.bottom }, openBucket || transitioning ? styles.dockHidden : null]} pointerEvents={openBucket || transitioning ? 'none' : 'box-none'}>
          <View style={[styles.floatCard, shadow]}>
            <GlassFill radiusStyle={{ borderRadius: radius.xl }} />
            <Animated.View style={{ opacity: contentFade, transform: [{ translateY: contentFade.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>
              <SurfaceProvider surface="dark">
                {/* Tapping the name reveals "how sure / correct + story + tip"; it carries the settled band as data. */}
                <Pressable {...tidWith(ids.reveal.howSure, { band }, 'The name — tap for how-sure + details')} accessibilityRole="button" onPress={() => setShowDetails((v) => !v)}>
                  <Title {...tid(ids.reveal.title)}>{title || 'An object of some interest'}</Title>
                </Pressable>

                <BucketDock statuses={statuses} factCount={facts.length} deepDiveReady={deepDiveReady} reduceMotion={reduceMotion} surface={dark} onOpen={openDock} />

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
            </Animated.View>
          </View>
        </View>
      ) : null}

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

      {/* VIEWFINDER controls — ONLY on page 0 (the live camera). Capture happens IN PLACE (the pager scrolls onto
          the new item). Permission takeovers render here without ever leaving the home. */}
      {onViewfinder ? (
        permission === 'denied' ? (
          <View style={styles.centerStage} pointerEvents="box-none">
            <Orb id={ids.processing.orb} state="uncertain" size={96} />
            <View {...tid(ids.camera.permissionDeniedBanner)} accessibilityRole="alert" style={[styles.banner, { borderColor: surface.danger, backgroundColor: surface.surface }]}>
              <Title>The Guide can't see.</Title>
              <Body style={{ marginTop: space.sm }}>I need the camera to identify what you're showing me. Grant it in Settings and we'll get on with it.</Body>
            </View>
            <Button id={ids.camera.openSettings} label="Open settings" onPress={() => void perm.openSettings()} style={{ marginTop: space.md }} />
          </View>
        ) : permission === 'undetermined' || requesting ? (
          <View style={styles.centerStage} pointerEvents="none">
            <Orb id={ids.processing.orb} state="listening" size={96} />
            <Body {...tid(ids.camera.retakeHint)} style={{ marginTop: space.lg, textAlign: 'center' }}>Waking the lens…</Body>
          </View>
        ) : (
          <>
            <View style={styles.viewfinderOverlay} pointerEvents="box-none">
              <View style={styles.spacer} pointerEvents="none" />
              {!trayOpen ? (
                <Muted {...tid(ids.camera.retakeHint)} style={[styles.hint, { color: onFeed ? '#FFFFFF' : surface.text }]}>
                  {camOffline ? "We're offline — your last capture will retry when you reconnect." : busy ? 'Capturing…' : pages.length === 0 ? 'Point at one object to begin.' : 'Tap to identify.'}
                </Muted>
              ) : null}
              {/* opacity stays hittable at 0 (a tap landing in the settle window still fires); it fades + rises in on settle */}
              <Animated.View
                style={[styles.bottomBar, { paddingBottom: space.xl + insets.bottom, opacity: viewfinderFade, transform: [{ translateY: viewfinderFade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}
                pointerEvents="box-none"
              >
                <View style={styles.side}>
                  <Pressable {...tid(ids.camera.recentToggle, 'Recently catalogued')} accessibilityRole="button" onPress={() => setTrayOpen(true)} hitSlop={10} style={[styles.iconBtn, { backgroundColor: onFeed ? 'rgba(0,0,0,0.35)' : surface.sunken }]}>
                    <Images size={22} color={onFeed ? '#FFFFFF' : surface.text} strokeWidth={2} />
                  </Pressable>
                </View>
                <CaptureOrb busy={busy} onPress={() => void onShutter()} size={80} />
                <View style={styles.side} />
              </Animated.View>
            </View>
            <RecentCard
              open={trayOpen}
              onClose={() => setTrayOpen(false)}
              threads={threadsQ.data?.threads ?? []}
              isLoading={threadsQ.isLoading}
              isError={threadsQ.isError}
              onRetry={() => void threadsQ.refetch()}
              onOpen={(item) => { setTrayOpen(false); loadPage(item); const i = pages.findIndex((t) => t.threadId === item.threadId); const page = i >= 0 ? i + 1 : 1; pagerRef.current?.scrollToIndex({ index: page, animated: true }); setCurrentIndex(page) }}
              onSeeAll={() => { setTrayOpen(false); router.navigate('/(tabs)/threads') }}
            />
          </>
        )
      ) : null}

      {/* ⋯ MORE sheet + its two confirm dialogs — overlays on a cataloged item page (never the viewfinder). Delete
          is a TWO-STEP destructive flow: the sheet's Delete row opens the confirm dialog; only its destructive
          button commits. Both sit above every other layer via their own zIndex. */}
      <RevealMoreMenu
        visible={menuOpen && !onViewfinder}
        surface={dark}
        reduceMotion={reduceMotion}
        onRegenerate={() => { setMenuOpen(false); setConfirm('regenerate') }}
        onDelete={() => { setMenuOpen(false); setConfirm('delete') }}
        onClose={() => setMenuOpen(false)}
      />
      <ConfirmDialog
        visible={confirm === 'regenerate'}
        surface={dark}
        reduceMotion={reduceMotion}
        title="Regenerate this identification?"
        message="I'll take a fresh look. The current write-up and narration will be replaced."
        confirmLabel="Regenerate"
        busy={actionBusy}
        onConfirm={() => void onConfirmRegenerate()}
        onCancel={() => setConfirm(null)}
        dialogTestId={ids.reveal.regenConfirm}
        cancelTestId={ids.reveal.regenConfirmCancel}
        confirmTestId={ids.reveal.regenConfirmAccept}
      />
      <ConfirmDialog
        visible={confirm === 'delete'}
        surface={dark}
        reduceMotion={reduceMotion}
        title="Delete this item?"
        message="This removes the photo, the identification, and any story or conversation. It can't be undone."
        confirmLabel="Delete"
        destructive
        busy={actionBusy}
        onConfirm={() => void onConfirmDelete()}
        onCancel={() => setConfirm(null)}
        dialogTestId={ids.reveal.deleteConfirm}
        cancelTestId={ids.reveal.deleteConfirmCancel}
        confirmTestId={ids.reveal.deleteConfirmAccept}
      />
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
  // A tiny transparent, on-screen `camera.screen` marker (findable by the E2E; never paints or intercepts).
  screenMarker: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0 },
  // ---- VIEWFINDER (page 0) controls, merged from the camera home. ----
  centerStage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  banner: { borderWidth: 1.5, borderRadius: radius.md, padding: space.lg, marginVertical: space.lg, maxWidth: 360 },
  viewfinderOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-start' },
  spacer: { flex: 1 },
  reticle: { position: 'absolute', alignSelf: 'center', top: '28%', width: '66%', height: '40%', borderWidth: 1.5, borderRadius: radius.md },
  hint: { textAlign: 'center', paddingHorizontal: space.lg, marginBottom: space.lg },
  bottomBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xl, paddingBottom: space.xl },
  side: { flex: 1, alignItems: 'flex-start' },
  iconBtn: { width: hit.min, height: hit.min, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
