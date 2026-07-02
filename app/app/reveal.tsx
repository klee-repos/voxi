/**
 * Entry reveal (PLAN §10.2 screen 5 / D5) — the Shazam result, on cream: the captured photo fills the screen,
 * and the museum entry is a cream INFO SHEET (grab handle + rounded top) that overlays the bottom of the image
 * and rises as you scroll (Shazam's result pattern). The sheet holds the specific TITLE + a band-treated
 * confidence CHIP + a quip, a circular green PLAY orb (`reveal.playNarration`), ONE green pill primary
 * (`reveal.primaryAction`, band-labelled), then the detail (what-it-is → blue secondary links → the
 * auto-elevating how-sure evidence panel with candidate choices + correct-id). A circular close (`nav.close`)
 * floats over the photo.
 *
 * READY-on-mount: processing drains the whole stream before routing here, so `whatItIs`/`band`/`title` are
 * already complete. State matrix ({empty, error/refusal, loading, offline}) and every `reveal.*` id + the
 * ConfidenceChip register are preserved (the converge proof asserts them). The single pill carries
 * `reveal.primaryAction`; the band id (`reveal.askVoxi`/`reveal.generateStory`) is co-located on the pill label
 * so a tap bubbles to the same navigation.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet, useWindowDimensions, Linking } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { Play, Pause } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, Button, TextField } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { AudioElement } from '../src/components/AudioElement'
import { ConfidenceChip } from '../src/components/ConfidenceChip'
import { OfflineBanner, SafetyRefusal } from '../src/components/Banners'
import { SurfaceProvider, useTheme } from '../src/lib/themeProvider'
import { ids, tid } from '../src/lib/testid'
import { radius, space, typeStyles } from '../src/lib/theme'
import { useConnectivity } from '../src/lib/connectivity'
import { useApi } from '../src/lib/api'
import { useCaptureStore, type RevealFact } from '../src/state/captureStore'
import { registerFor } from '../../packages/shared/src/confidence'
import { haptics } from '../src/lib/haptics'
import type { Edge } from 'react-native-safe-area-context'

// Full-bleed states run the photo to the physical bottom and pad the sheet up by `insets.bottom` themselves, so
// the Screen must NOT also inset the bottom — otherwise a strip of photo shows beneath the sheet (the "gap").
const FULL_BLEED_EDGES: readonly Edge[] = ['top', 'left', 'right']

/** One verified research fact, rendered as its own chip with a tappable SOURCE PROOF (the verbatim quote + link
 *  it was grounded on — the durable "proof if challenged"). Multiple chips appear progressively as facts land. */
function FactChip({ fact, surface }: { fact: RevealFact; surface: ReturnType<typeof useTheme>['surface'] }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <View {...tid(ids.reveal.fact)} style={[styles.factChip, { backgroundColor: surface.sunken, borderColor: surface.border }]}>
      <Body style={{ color: surface.text }}>{fact.text}</Body>
      <Pressable
        {...tid(ids.reveal.factSource, `Source: ${fact.sourceTitle || fact.sourceUrl}`)}
        accessibilityRole="button"
        onPress={() => setOpen((o) => !o)}
        style={styles.factSourceBtn}
      >
        <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]}>{open ? 'Hide source' : 'Source'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.factProof}>
          <Muted style={{ fontStyle: 'italic' }}>“{fact.quote}”</Muted>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(fact.sourceUrl).catch(() => {})} style={styles.link}>
            <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]}>{fact.sourceTitle || fact.sourceUrl}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

function RevealBody(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion, speakAloud } = useTheme()
  const { height: winH } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const offline = !useConnectivity().online
  const { title, band, whatItIs, candidates, facts, photoUri, outcome, error } = useCaptureStore()
  const threadId = useCaptureStore((s) => s.threadId)
  const reset = useCaptureStore((s) => s.reset)

  useEffect(() => {
    if (threadId && !band && !outcome && !error) router.replace('/processing')
  }, [threadId, band, outcome, error, router])

  const isProbable = band === 'PROBABLE'
  const isLow = band === 'PROBABLE' || band === 'UNKNOWN'
  const [showEvidence, setShowEvidence] = useState(isLow)
  useEffect(() => {
    if (isLow) setShowEvidence(true)
  }, [isLow])
  const [correction, setCorrection] = useState('')

  // ---- Spoken reveal (ANALYSIS-VOICE-PLAN B): hear the narration in Voxi's British voice. ----
  // The narration exists only on a settled CONFIDENT/PROBABLE reveal (UNKNOWN hands off to the interview), so the
  // whole audio affordance is gated on it — no dead play orb (A14). The text is server-owned; the client only
  // asks the BFF to voice it. Autoplay is best-effort, gated on the "Speak results aloud" pref (A13, NOT
  // reduce-motion); the orb is always the manual play/stop control (and the guaranteed trigger where a browser
  // blocks gesture-less autoplay).
  const hasNarration = (band === 'CONFIDENT' || band === 'PROBABLE') && !!whatItIs
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [narrationFailed, setNarrationFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const autoStarted = useRef(false)
  const speechAttempts = useRef(0)
  // Fetch the server-synthesized narration. Extracted so the "unavailable" state can retry — and so a failure is
  // HONEST: we never fall back to a silent placeholder that only LOOKS like it played (the exact trap when the
  // BFF is stale / missing the new /speech route). speakNarration also console.warns the status for diagnosis.
  // The server pins the narration the instant the reveal's clauses stream — which can land a beat AFTER this screen
  // first requests it — so a first miss (404 no_narration) usually self-heals within a second. Poll briefly before
  // surfacing "unavailable" (+ manual retry), so the common timing gap doesn't read as a dead affordance while a
  // genuinely-absent narration still fails honestly.
  const loadNarration = useCallback(() => {
    if (!threadId) return
    setNarrationFailed(false)
    void api.speakNarration(threadId).then((url) => {
      if (url) { speechAttempts.current = 0; setAudioUrl(url); return }
      if (speechAttempts.current < 6) {
        speechAttempts.current += 1
        setTimeout(loadNarration, 700)
      } else {
        setNarrationFailed(true)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, threadId])
  useEffect(() => {
    if (hasNarration && threadId && !audioUrl) loadNarration()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNarration, threadId])
  useEffect(() => {
    if (audioUrl && speakAloud && !autoStarted.current) { autoStarted.current = true; setPlaying(true) }
  }, [audioUrl, speakAloud])

  const backToCamera = (): void => {
    reset()
    router.replace('/(tabs)/camera')
  }
  // Detail screen → a back chevron that resets capture state and returns to camera. Two tints: over the
  // parchment error/empty states (onSurface), and scrim-white over the full-bleed photo (onMedia). The
  // hamburger is dropped here (drawer is a camera-root affordance; back → camera → menu).
  const surfaceBackHeader = <AppHeader leading="back" onLeadingPress={backToCamera} />
  const mediaBackHeader = <AppHeader leading="back" onMedia onLeadingPress={backToCamera} />

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
        <Button id={ids.reveal.primaryAction} label="Capture an object" onPress={backToCamera} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- ERROR / REFUSAL: distinct from the chip. ----
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
        <Button id={ids.reveal.primaryAction} label="Try another photo" onPress={backToCamera} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // ---- LOADING: subject present, band not settled yet. ----
  if (!band) {
    // Same full-bleed photo backdrop as READY, so the image never shrinks to a thumbnail between states (the
    // "no visible difference" promise) on a deep-link/reconnect where the band hasn't settled yet.
    return (
      <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES} style={{ minHeight: winH }}>
        <View style={StyleSheet.absoluteFill}>
          {photoUri ? (
            <Image {...tid(ids.reveal.photoThumb)} source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <View {...tid(ids.reveal.photoThumb)} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
          )}
        </View>
        {/* same back chevron as READY, so it holds its place while the band settles (scrim-white over the photo) */}
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

  // ---- READY: full-bleed photo + scroll-over info sheet. ----
  const register = registerFor(band)
  const primary = isProbable
    ? { id: ids.reveal.askVoxi, label: 'Ask Voxi', go: () => router.push('/conversation') }
    : { id: ids.reveal.generateStory, label: 'Generate story', go: () => router.push('/podcast') }
  const quip = register.hedge
    ? "I'd stake a modest sum on this, though not the house."
    : 'A fine specimen. Allow me to introduce it properly.'
  const imgPeek = winH > 0 ? Math.round(winH * 0.5) : 380

  return (
    <Screen id={ids.reveal.card} padded={false} edges={FULL_BLEED_EDGES}>
      {/* fixed full-bleed captured photo behind everything */}
      <View style={StyleSheet.absoluteFill}>
        {photoUri ? (
          // cover full-bleed — the SAME framing the viewfinder + processing showed, so there is no jarring
          // change from before-capture → capture → analysis → reveal (the image is one continuous backdrop).
          <Image {...tid(ids.reveal.photoThumb)} source={{ uri: photoUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View {...tid(ids.reveal.photoThumb)} style={[StyleSheet.absoluteFill, { backgroundColor: surface.card }]} />
        )}
      </View>

      {/* single back chevron over the photo (scrim-white); stays fixed above the info sheet as it scrolls up. */}
      <View style={styles.headerOverlay} pointerEvents="box-none">{mediaBackHeader}</View>

      <OfflineBanner visible={offline} />

      {/* the info sheet rises over the photo as you scroll (Shazam result) */}
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={{ height: imgPeek }} pointerEvents="none" />
        <View style={[styles.sheet, { backgroundColor: surface.bg, paddingBottom: space.xxl + insets.bottom }]}>
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Title {...tid(ids.reveal.title)}>{title || 'An object of some interest'}</Title>
              <View style={styles.chipRow}>
                <ConfidenceChip band={band} />
              </View>
            </View>
          </View>

          <Body {...tid(ids.reveal.quip)} style={styles.quip}>{quip}</Body>

          {/* "Hear it" — speaks the reveal narration in Voxi's British voice. Autoplay is best-effort (browsers /
              iOS often block gesture-less audio), so THIS is the guaranteed control: one tap plays it from the
              start; tap again to stop. Rendered only when there IS narration (A14). The audio element reports its
              real playing state back via onPlayingChange, so the label always matches reality. */}
          {hasNarration ? (
            <>
              <Pressable
                {...tid(
                  ids.reveal.playNarration,
                  narrationFailed ? 'Narration unavailable — tap to retry' : playing ? 'Stop narration' : 'Hear it — play narration',
                )}
                accessibilityRole="button"
                onPress={() => {
                  haptics.tick()
                  if (audioUrl) setPlaying((p) => !p) // ready → play/stop
                  else if (narrationFailed) { speechAttempts.current = 0; loadNarration() } // failed → retry the poll fresh (no silent fake)
                  // still loading → no-op (the label says so); autoplay/render will catch up when it lands
                }}
                style={({ pressed }) => [styles.hearBtn, { borderColor: narrationFailed ? surface.textTertiary : surface.accent, opacity: pressed ? 0.7 : 1 }]}
              >
                {playing
                  ? <Pause size={18} color={surface.accent} fill={surface.accent} />
                  : <Play size={18} color={narrationFailed ? surface.textTertiary : surface.accent} fill={narrationFailed ? surface.textTertiary : surface.accent} />}
                <Text style={[typeStyles.subhead, { color: narrationFailed ? surface.textTertiary : surface.accent, marginLeft: space.sm }]}>
                  {audioUrl ? (playing ? 'Stop' : 'Hear it') : narrationFailed ? 'Narration unavailable — retry' : 'Preparing…'}
                </Text>
              </Pressable>
              {/* Only mount the audio when we have REAL synth output — never the silent placeholder (no fake play). */}
              {audioUrl ? (
                <AudioElement
                  id={ids.reveal.narrationAudio}
                  src={audioUrl}
                  playing={playing}
                  seekToStartOnPlay
                  onPlayingChange={setPlaying}
                />
              ) : null}
            </>
          ) : null}

          {/* ONE primary — the 52pt green pill (reveal.primaryAction); band id co-located on its label */}
          <Pressable
            {...tid(ids.reveal.primaryAction)}
            accessibilityRole="button"
            onPress={primary.go}
            style={({ pressed }) => [styles.pill, { backgroundColor: surface.accent, opacity: pressed ? 0.85 : 1 }]}
          >
            <Text {...tid(primary.id, primary.label)} style={[typeStyles.headline, { color: surface.onAccent }]}>{primary.label}</Text>
          </Pressable>

          <Text style={[typeStyles.overline, styles.eyebrow, { color: surface.textTertiary }]}>What it is</Text>
          <Body {...tid(ids.reveal.whatItIs)} style={styles.what}>
            {whatItIs || 'What it is and what it is for, told plainly and without embellishment beyond the evidence.'}
          </Body>

          {/* Curious facts — the async deep-research facts appear one-by-one as each is found + VERIFIED (each
              carries a tappable source proof: the sourceUrl + verbatim quote it was grounded on). Rendered only
              once at least one fact has landed (it fills in AFTER the instant reveal). */}
          {facts.length > 0 ? (
            <>
              <Text style={[typeStyles.overline, styles.eyebrow, { color: surface.textTertiary }]}>Curious facts</Text>
              <View {...tid(ids.reveal.facts)} style={styles.factsWrap}>
                {facts.map((f, i) => (
                  <FactChip key={`${f.sourceUrl}:${i}`} fact={f} surface={surface} />
                ))}
              </View>
            </>
          ) : null}

          <View style={styles.secondaryRow}>
            <Pressable {...tid(ids.nav.openConversation)} accessibilityRole="link" onPress={() => router.push('/conversation')} style={styles.link}>
              <Text style={[typeStyles.subhead, { color: surface.accentSecondary }]}>Ask Voxi</Text>
            </Pressable>
            <Text style={[typeStyles.subhead, { color: surface.textTertiary }]}> · </Text>
            <Pressable {...tid(ids.nav.openPodcast)} accessibilityRole="link" onPress={() => router.push('/podcast')} style={styles.link}>
              <Text style={[typeStyles.subhead, { color: surface.accentSecondary }]}>Podcast</Text>
            </Pressable>
            <Text style={[typeStyles.subhead, { color: surface.textTertiary }]}> · </Text>
            <Pressable {...tid(ids.nav.openContribute)} accessibilityRole="link" onPress={() => router.push('/contribute')} style={styles.link}>
              <Text {...tid(ids.reveal.addTip)} style={[typeStyles.subhead, { color: surface.accentSecondary }]}>Add a tip</Text>
            </Pressable>
          </View>

          <Text style={[typeStyles.overline, styles.eyebrow, { color: surface.textTertiary }]}>How sure</Text>
          <Pressable {...tid(ids.reveal.howSure)} accessibilityRole="button" onPress={() => setShowEvidence((v) => !v)} style={styles.link}>
            <Muted>{isLow ? "How sure am I? Here's my working." : 'How sure are you?'}</Muted>
          </Pressable>

          {showEvidence ? (
            <View {...tid(ids.reveal.evidencePanel)} style={[styles.evidence, { borderColor: surface.border }]}>
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
                  style={[styles.candidate, { backgroundColor: correction === name ? surface.accentSecondary : surface.sunken, borderColor: correction === name ? surface.accentSecondary : surface.border }]}
                >
                  <Text style={[typeStyles.body, { color: correction === name ? surface.onAccent : surface.text }]}>{name}</Text>
                </Pressable>
              ))}
              <TextField id={ids.reveal.correctId} value={correction} onChangeText={setCorrection} placeholder="Actually, it's…" />
            </View>
          ) : null}
        </View>
      </ScrollView>
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
  thumb: { width: 88, height: 88, borderRadius: radius.md },
  loadingWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: space.lg },
  loadingPill: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.sm, paddingRight: space.lg, paddingVertical: space.sm, borderRadius: radius.xl, maxWidth: '100%' },
  // The universal AppHeader's back chevron floats over the full-bleed photo, fixed above the rising info sheet.
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },
  scroll: { flexGrow: 1 },
  // flexGrow:1 lets the cream sheet absorb any free space below its content so it always reaches the bottom of
  // the viewport. Without it, a short reveal (e.g. a CONFIDENT card with the evidence panel collapsed) leaves the
  // full-bleed photo peeking through beneath the sheet — the "gap at the bottom". When content is tall the sheet
  // exceeds its basis, there is no free space to distribute, and the ScrollView scrolls normally.
  sheet: { flexGrow: 1, minHeight: 460, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', marginBottom: space.md },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  chipRow: { flexDirection: 'row', marginTop: space.sm },
  hearBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, marginTop: space.md },
  quip: { marginTop: space.md, fontStyle: 'italic' },
  pill: { height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', marginTop: space.lg },
  eyebrow: { marginTop: space.lg, marginBottom: space.xs },
  what: { lineHeight: 24 },
  factsWrap: { marginTop: space.xs, gap: space.sm },
  factChip: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  factSourceBtn: { minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start', marginTop: space.xs },
  factProof: { marginTop: space.xs, gap: space.xs },
  secondaryRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md, flexWrap: 'wrap' },
  link: { minHeight: 44, justifyContent: 'center' },
  evidence: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, marginTop: space.sm, gap: space.sm },
  candidate: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  errorBlock: { marginVertical: space.lg, maxWidth: 360 },
})
