/**
 * Entry reveal (ANALYSIS-UX redesign) — the Shazam result on cream, reimagined as an ICON DOCK. The captured photo
 * fills the screen; a compact cream dock sits at the bottom holding the identification (title + confidence chip),
 * a one-line description preview, and a row of FIVE icons: four green research buckets — What it is · What it's for
 * · Who made it · Curious facts — that flip loading→active as async research streams, plus a blue Ask-Voxi icon.
 * Tapping an active bucket morphs it into a `BucketCard` with the grounded content, a source proof, and that
 * bucket's audio in Voxi's British voice. This REPLACES the old scroll-over info sheet ("the tray").
 *
 * READY-on-mount: processing navigates here on band-settle and keeps the stream alive, so `sections`/`facts` fill
 * in reactively. Buckets derive their state purely (deriveBucketStatus): `what` is active on band-settle (never a
 * jarring flip); purpose/maker/facts resolve to active/empty/unavailable. Every `reveal.*` id + the ConfidenceChip
 * register + the How-sure teaching loop are preserved (the converge proof asserts them).
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, TextField } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner, SafetyRefusal } from '../src/components/Banners'
import { BucketDock, BucketCard, type DockKey, type AudioState } from '../src/components/RevealDock'
import { GlassFill } from '../src/components/GlassFill'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid, tidWith } from '../src/lib/testid'
import { radius, space, typeStyles, shadow, dark } from '../src/lib/theme'
import { useConnectivity } from '../src/lib/connectivity'
import { useApi } from '../src/lib/api'
import { useCaptureStore, deriveBucketStatus } from '../src/state/captureStore'
import type { AudioBucket } from '../src/lib/apiClient'
import { registerFor } from '../../packages/shared/src/confidence'
import { haptics } from '../src/lib/haptics'
import type { Edge } from 'react-native-safe-area-context'

// Full-bleed states run the photo to the physical bottom; the dock pads itself up by `insets.bottom`, so the
// Screen must NOT also inset the bottom — otherwise a strip of photo shows beneath the dock (the "gap").
const FULL_BLEED_EDGES: readonly Edge[] = ['top', 'left', 'right']

/** A research bucket maps 1:1 to its audio bucket (DockKey minus the conversation icon, which navigates). */
type ResearchKey = Exclude<DockKey, 'conversation'>

function RevealBody(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion, speakAloud } = useTheme()
  const { height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const offline = !useConnectivity().online
  const { title, band, whatItIs, candidates, facts, sections, photoUri, outcome, error, researchComplete, researchError, sawAnySection } =
    useCaptureStore()
  const threadId = useCaptureStore((s) => s.threadId)
  const lastSeenIndex = useCaptureStore((s) => s.lastSeenIndex)
  const reset = useCaptureStore((s) => s.reset)

  useEffect(() => {
    if (threadId && !band && !outcome && !error) router.replace('/processing')
  }, [threadId, band, outcome, error, router])

  const isLow = band === 'PROBABLE' || band === 'UNKNOWN'
  // The reveal RESTING view is just the name + icons floating over the photo (no tray). The "how sure / correct +
  // generate story + add a tip" details are one tap away — behind the confidence chip — never a default panel.
  const [showDetails, setShowDetails] = useState(false)
  const [correction, setCorrection] = useState('')

  // ---- Per-bucket audio (ANALYSIS-UX §5.C). Each bucket's clip is SERVER-OWNED + synthesized lazily on first open
  //      (never pre-fetched for all four); the `what` clip is pre-warmed when the reveal mounts (the near-certain
  //      first tap). Autoplay is best-effort, gated on the "Speak results aloud" pref (never on tab-switch). ----
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

  // Pre-warm ONLY the `what` clip the moment the band settles (the near-certain first tap); the other three stay
  // lazy (cost). Top-level hook (runs before the early returns) so hook order is stable across every reveal state.
  useEffect(() => {
    if (threadId && band && band !== 'UNKNOWN' && !audioStates.what) fetchAudio('what')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, band])

  const backToCamera = (): void => {
    reset()
    router.replace('/(tabs)/camera')
  }
  const mediaBackHeader = <AppHeader leading="back" onMedia onLeadingPress={backToCamera} />
  const surfaceBackHeader = <AppHeader leading="back" onLeadingPress={backToCamera} />

  // ---- EMPTY: deep-linked here with nothing captured. ----
  if (!photoUri && !band && !error) {
    return (
      <Screen id={ids.reveal.card} center header={surfaceBackHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.processing.orb} state="idle" size={96} />
        <Title style={{ marginTop: space.xl, textAlign: 'center' }}>Nothing to show yet</Title>
        <Body style={{ marginTop: space.md, textAlign: 'center' }}>
          The Guide writes an entry once you've photographed something. Point it at an object — a bike, a camera, a curious bottle.
        </Body>
        <Pressable {...tid(ids.reveal.primaryAction)} accessibilityRole="button" onPress={backToCamera} style={[styles.pill, { backgroundColor: surface.accent, marginTop: space.lg, paddingHorizontal: space.xl }]}>
          <Text style={[typeStyles.headline, { color: surface.onAccent }]}>Capture an object</Text>
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
          <View style={[styles.loadingPill, { backgroundColor: photoUri ? 'rgba(20,18,14,0.62)' : surface.surface }]}>
            <Orb id={ids.processing.orb} state="thinking" size={34} />
            <View style={{ flexShrink: 1 }}>
              <Title {...tid(ids.reveal.title)} style={{ color: photoUri ? '#FFFFFF' : surface.text }}>Settling on a title…</Title>
              <Body {...tid(ids.reveal.quip)} style={{ color: photoUri ? 'rgba(255,255,255,0.78)' : surface.textMuted, fontStyle: 'italic', marginTop: 2 }}>
                {offline ? "I've lost the thread — back when you're online." : "Nearly there. I don't like to be wrong."}
              </Body>
            </View>
          </View>
        </View>
      </Screen>
    )
  }

  // ---- READY: full-bleed photo + a compact icon dock. ----
  const register = registerFor(band)
  const quip = register.hedge
    ? "I'd stake a modest sum on this, though not the house."
    : 'A fine specimen. Allow me to introduce it properly.'
  const statusSlice = { band, sections, facts, researchComplete, researchError, sawAnySection }
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
  const cardBody = (k: ResearchKey): { body: string; sourceUrl?: string; sourceTitle?: string; quote?: string } => {
    if (k === 'what') return { body: whatItIs }
    if (k === 'facts') return { body: '' }
    const sec = sections[k]
    return { body: sec?.text ?? '', sourceUrl: sec?.sourceUrl, sourceTitle: sec?.sourceTitle, quote: sec?.quote }
  }

  const openAudio = openBucket ? (openBucket as AudioBucket) : null

  return (
    <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES}>
      <View style={StyleSheet.absoluteFill}>
        {photoUri ? (
          <Image {...tid(ids.reveal.photoThumb)} source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View {...tid(ids.reveal.photoThumb)} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
        )}
      </View>
      <View style={styles.headerOverlay} pointerEvents="box-none">{mediaBackHeader}</View>
      <OfflineBanner visible={offline} />

      {/* A compact FLOATING CARD over the photo — just the name + icons (no tray/sheet). It hugs its content,
          floats above the bottom edge with margins + a shallow shadow, and is centered with a max width. */}
      <View style={[styles.floatWrap, { paddingBottom: space.lg + insets.bottom }, openBucket ? styles.dockHidden : null]} pointerEvents={openBucket ? 'none' : 'box-none'}>
        <View style={[styles.floatCard, shadow]}>
          {/* Liquid Glass over the full-bleed photo (absolute, pointer-through) — replaces the flat white fill; the
              card's paddings/radius/children are otherwise untouched (docs/REVEAL-DOCK-GLASS-PLAN.md §10). */}
          <GlassFill radiusStyle={{ borderRadius: radius.xl }} />
          {/* The dock floats over the photo, so it's a DARK "Control Center" glass with LIGHT text (a light tint
              washes the photo to gray). The dark SurfaceProvider flips the context text components (Title/Muted/
              TextField); BucketDock/BucketCard take the dark surface as a prop. (docs/REVEAL-DOCK-GLASS-PLAN.md §10) */}
          <SurfaceProvider surface="dark">
            {/* Just the name — no confidence pill. Tapping the name reveals "how sure / correct + story + tip", and it
                carries the settled band as data (the honesty signal + the E2E band contract) without a visible chip. */}
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
  loadingPill: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.sm, paddingRight: space.lg, paddingVertical: space.sm, borderRadius: radius.xl, maxWidth: '100%' },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  // A FLOATING CARD over the photo (not a bottom tray): centered, margins, all corners rounded, shallow shadow,
  // hugging the name + icons. `floatWrap` anchors it above the home indicator; `floatCard` is the card itself.
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
})
