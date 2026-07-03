/**
 * The reveal DOCK (ANALYSIS-UX redesign) — four green research icons (What it is · What it's for · Who made it ·
 * Curious facts) plus a blue Ask-Voxi conversation icon (design.md's green=audio / blue=people lanes). Each
 * research icon carries `bucket.state` (loading|active|empty|unavailable) via `tidWith`; tapping an active one
 * morphs it into a `BucketCard` — the grounded content + a source proof + per-bucket audio.
 *
 * Converge-safe by construction: JS-driven `Animated` (`useNativeDriver:false`), lucide-only iconography, and NO
 * `react-native-gesture-handler` (between-bucket nav is a tappable labeled tab strip, never a swipe). State rides
 * `data-*` (via `tidWith`), never colour/glyph alone, so the E2E proof reads it deterministically.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, Easing, StyleSheet, ScrollView, Linking, type ViewStyle } from 'react-native'
import { BookOpen, Target, Stamp, Lightbulb, AudioLines, MessageCircle, Play, Pause, RotateCcw, X } from 'lucide-react-native'
import { AudioElement } from './AudioElement'
import { GlassFill } from './GlassFill'
import { ids, tid, tidWith } from '../lib/testid'
import { radius, space, typeStyles, type, hit, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { sourceLabel } from '../lib/sourceLabel'
import type { BucketStatus, RevealFact } from '../state/captureStore'

/** Dock affordances. The four research buckets morph into a card (green lane); `deepdive` navigates to the Deep
 *  Dive player (green audio lane, on-demand); `conversation` navigates (blue people lane, pinned). */
export type DockKey = 'what' | 'purpose' | 'maker' | 'facts' | 'deepdive' | 'conversation'
/** The morph/audio buckets — the ones that open a `BucketCard` + have per-bucket status/audio. Excludes the two
 *  NAV affordances (`deepdive` opens the Deep Dive screen; `conversation` opens the chat), so their union never
 *  leaks into the morph-card / audio-bucket / deriveBucketStatus paths (adversarial D4). */
export type MorphKey = 'what' | 'purpose' | 'maker' | 'facts'

type Surface = ReturnType<typeof useTheme>['surface']

// Dock layout: FIVE fixed slots, each `ICON_WRAP` wide; the glyph circle (`ICON_CIRCLE`) is centered inside its
// wrap, so a symmetric negative horizontal margin flushes the OUTER circles (not the invisible wrap boxes) to the
// title's left/right edges — the alignment the redesign asks for. Derived, not a magic number.
const ICON_WRAP = 56
const ICON_CIRCLE = 44
const DOCK_EDGE_INSET = -(ICON_WRAP - ICON_CIRCLE) / 2 // = -6
// The morph card is a bottom-flush sheet: round ONLY the top corners (the bottom sits on the screen edge). Passed to
// GlassFill so the glass clips to the same rounded rect — never rounding the bottom corners open onto the scrim.
const CARD_RADIUS: ViewStyle = { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
// A deeper scrim than the shared drawer scrim (0.35): the morph card is a translucent glass sheet, so the dock
// behind it must be dimmed enough that it doesn't bleed through the material.
const CARD_SCRIM = 'rgba(20,18,14,0.55)'

const ICON = { what: BookOpen, purpose: Target, maker: Stamp, facts: Lightbulb, deepdive: AudioLines, conversation: MessageCircle } as const
const CAPTION: Record<DockKey, string> = { what: 'What', purpose: 'Purpose', maker: 'Maker', facts: 'Facts', deepdive: 'Deep Dive', conversation: 'Ask' }
const TEST_ID: Record<DockKey, string> = {
  what: ids.reveal.bucketWhat,
  purpose: ids.reveal.bucketPurpose,
  maker: ids.reveal.bucketWho,
  facts: ids.reveal.bucketFacts,
  deepdive: ids.reveal.deepDiveIcon,
  conversation: ids.reveal.conversationIcon,
}
/** The full question a morph bucket's card announces as its eyebrow (dock captions are short; no meaning lost). */
export const CARD_EYEBROW: Record<MorphKey, string> = {
  what: 'What it is',
  purpose: "What it's for",
  maker: 'Who made it',
  facts: 'Curious facts',
}

/** Accessible, state-bearing label for a dock icon (never colour/motion alone — a11y §4.9). */
function a11yLabel(key: DockKey, status: BucketStatus, ready?: boolean): string {
  if (key === 'conversation') return 'Ask Voxi about this'
  // Deep Dive is a nav affordance, not a research bucket — its label states the COST outcome a tap triggers
  // (generate vs replay), so the user knows before tapping (adversarial D7 / cost transparency).
  if (key === 'deepdive') return ready ? 'Deep Dive — ready to play its story' : 'Deep Dive — tap to generate its story'
  const q = CARD_EYEBROW[key]
  if (status === 'loading') return `${q} — still researching`
  if (status === 'empty') return `${q} — nothing grounded to add`
  if (status === 'unavailable') return `${q} — couldn't reach the Guide, tap to retry`
  return `${q} — ready`
}

/** One dock icon. Loading → a single green pulse ring (shared driver) around a dimmed glyph; active → full-ink
 *  glyph (green reserved for the audio/play control, not "active"); empty → muted glyph + a small answered dot;
 *  unavailable → muted glyph + a retry glyph; facts active → a count badge. Conversation is the blue lane. */
function BucketIcon({
  dkey,
  status,
  count,
  ready,
  pulse,
  reduceMotion,
  surface,
  onPress,
}: {
  dkey: DockKey
  status: BucketStatus
  count?: number
  /** Deep Dive only: a durable episode already exists → show the green ready dot + "ready to play" a11y. */
  ready?: boolean
  pulse: Animated.Value
  reduceMotion: boolean
  surface: Surface
  onPress: () => void
}): React.ReactElement | null {
  if (status === 'hidden') return null
  const Glyph = ICON[dkey]
  const isConv = dkey === 'conversation'
  // Deep Dive rides the same active-ink treatment as an answered research bucket (green stays the play control);
  // its state carries `ready` so the agentic proof can assert generate-vs-replay deterministically.
  const iconState = isConv ? 'active' : dkey === 'deepdive' ? (ready ? 'ready' : 'active') : status
  const glyphColor = isConv
    ? surface.accentSecondary // blue people lane
    : status === 'active'
      ? surface.text // full-ink = "answered / readable" (green stays the audio colour)
      : surface.textTertiary // loading/empty/unavailable = muted
  // Loading = a green arc SPINNING around the icon's border (a classic loading ring), not a pulse: a bright accent
  // HEAD on a faint full track, rotated 0→360° by the shared driver. Reduce-motion → a static faint accent ring.
  const spin = pulse.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })

  return (
    <Pressable
      {...tidWith(TEST_ID[dkey], { state: iconState }, a11yLabel(dkey, status, ready))}
      accessibilityRole="button"
      accessibilityState={{ busy: status === 'loading', disabled: false }}
      onPress={onPress}
      style={({ pressed }) => [styles.iconWrap, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.iconCircleWrap}>
        <View style={[styles.iconCircle, { backgroundColor: surface.sunken, borderColor: isConv ? surface.accentSecondary : surface.border }]}>
          <Glyph size={22} color={glyphColor} strokeWidth={2} />
        </View>
        {status === 'loading' ? (
          <Animated.View
            aria-hidden
            style={[
              styles.ring,
              reduceMotion
                ? { borderColor: surface.accent, opacity: 0.5 }
                : { borderColor: surface.border, borderTopColor: surface.accent, transform: [{ rotate: spin }] },
            ]}
          />
        ) : null}
        {status === 'active' && dkey === 'facts' && count ? (
          <View style={[styles.badge, { backgroundColor: surface.accent }]}>
            <Text style={[typeStyles.caption, { color: surface.onAccent }]}>{count}</Text>
          </View>
        ) : null}
        {status === 'empty' ? <View style={[styles.dot, { backgroundColor: surface.textTertiary }]} /> : null}
        {dkey === 'deepdive' && ready ? <View style={[styles.dot, { backgroundColor: surface.accent }]} /> : null}
        {status === 'unavailable' ? (
          <View style={[styles.badge, { backgroundColor: surface.sunken, borderColor: surface.border, borderWidth: 1 }]}>
            <RotateCcw size={11} color={surface.textTertiary} strokeWidth={2.5} />
          </View>
        ) : null}
      </View>
      <Text style={[typeStyles.caption, styles.caption, { color: isConv ? surface.accentSecondary : surface.textMuted }]}>{CAPTION[dkey]}</Text>
    </Pressable>
  )
}

/** The dock row: four research icons (green lane) + a blue Ask-Voxi icon set off by a gap. One shared pulse driver
 *  runs while ANY bucket is loading (keeps within the Orb/Drawer animation budget — no N concurrent loops). */
export function BucketDock({
  statuses,
  factCount,
  deepDiveReady,
  reduceMotion,
  surface,
  onOpen,
}: {
  statuses: Record<MorphKey, BucketStatus>
  factCount: number
  /** A durable Deep Dive episode already exists → the Deep Dive icon shows a green "ready" dot (cost transparency). */
  deepDiveReady?: boolean
  reduceMotion: boolean
  surface: Surface
  onOpen: (k: DockKey) => void
}): React.ReactElement {
  const pulse = useRef(new Animated.Value(0)).current
  const anyLoading = (['what', 'purpose', 'maker', 'facts'] as const).some((k) => statuses[k] === 'loading')
  useEffect(() => {
    if (reduceMotion || !anyLoading) {
      pulse.stopAnimation()
      pulse.setValue(0)
      return
    }
    // A single continuous 0→1 ramp (Animated.loop resets to 0 each iteration) → a constant-speed 0→360° spin (360°
    // == 0°, so the reset is invisible). Linear easing keeps the arc travelling at an even pace, like a spinner.
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: false }),
    )
    loop.start()
    return () => loop.stop()
  }, [anyLoading, reduceMotion, pulse])

  // One-time NUDGE (reduce-motion-gated): flick the content row ~16px and settle so the horizontal-scroll
  // affordance is discoverable — the Deep Dive icon is the trailing item and can sit past the edge on a narrow
  // screen. With reduce-motion, the natural half-cut peek of the trailing icon is the static affordance instead.
  const scrollRef = useRef<ScrollView>(null)
  const nudged = useRef(false)
  useEffect(() => {
    if (reduceMotion || nudged.current) return
    nudged.current = true
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ x: 16, animated: true })
      setTimeout(() => scrollRef.current?.scrollTo({ x: 0, animated: true }), 320)
    }, 420)
    return () => clearTimeout(t)
  }, [reduceMotion])

  return (
    <View {...tid(ids.reveal.buckets)} style={styles.dock}>
      {/* The CONTENT icons scroll horizontally (What · Purpose · Maker · Facts · Deep Dive). On a narrow screen the
          trailing Deep Dive icon half-cuts at the scroll edge — the affordance — while the pinned Ask icon (right of
          the divider) never scrolls. Hidden buckets render null: the row scrolls, so no column-holding spacers. */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {(['what', 'purpose', 'maker', 'facts'] as const).map((k) =>
          statuses[k] === 'hidden' ? null : (
            <BucketIcon key={k} dkey={k} status={statuses[k]} count={k === 'facts' ? factCount : undefined} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen(k)} />
          ),
        )}
        <BucketIcon dkey="deepdive" status="active" ready={deepDiveReady} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('deepdive')} />
      </ScrollView>
      {/* A hairline sets the special, always-present chat lane apart from the scrollable content icons (Marvin's
          scroll-tools-with-a-pinned-action pattern). Aria-hidden — decorative. */}
      <View style={[styles.divider, { backgroundColor: surface.border }]} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <View style={styles.pinned}>
        <BucketIcon dkey="conversation" status="active" pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('conversation')} />
      </View>
    </View>
  )
}

/** One verified fact: the fact text, and directly under it its OWN source — the webpage TITLE (a prettified site
 *  name when the page has no title), a tappable link that opens the page. No box, no toggle, no quote; a hairline
 *  separates facts (IMDb-trivia list). No source link when there is no usable URL. */
function FactRow({ fact, surface, first }: { fact: RevealFact; surface: Surface; first: boolean }): React.ReactElement {
  const label = sourceLabel(fact.sourceUrl, fact.sourceTitle) // '' for empty / voxi: / grounding-redirect URLs
  return (
    <View {...tid(ids.reveal.fact)} style={[styles.factRow, first ? null : { borderTopWidth: 1, borderTopColor: surface.border }]}>
      <Text style={[typeStyles.body, { color: surface.text }]}>{fact.text}</Text>
      {label ? (
        <Pressable
          {...tid(ids.reveal.factSource, `Source: ${label}, opens in browser`)}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(fact.sourceUrl).catch(() => {})}
          style={styles.factSourceRow}
        >
          <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]} numberOfLines={1}>{label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export type AudioState = 'idle' | 'loading' | 'ready' | 'failed'

/** The morph CARD: a scrim-backed overlay that rises + scales in from the dock (single-node transform+opacity on
 *  the JS driver — not an expensive per-node shared-element morph, adversarial 7b; reduce-motion → cross-fade).
 *  Holds the full-question eyebrow, the grounded body (or the fact rows), a deduped Sources list, the per-bucket
 *  audio control, and a LABELED tab strip to switch buckets (never a swipe). */
export function BucketCard({
  bucket,
  body,
  facts,
  audioUrl,
  audioState,
  playing,
  reduceMotion,
  surface,
  tabs,
  onTab,
  onPlayToggle,
  onClose,
}: {
  bucket: MorphKey
  body: string
  facts?: RevealFact[]
  audioUrl: string | null
  audioState: AudioState
  playing: boolean
  reduceMotion: boolean
  surface: Surface
  tabs: MorphKey[]
  onTab: (k: MorphKey) => void
  onPlayToggle: () => void
  onClose: () => void
}): React.ReactElement {
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current
  useEffect(() => {
    if (reduceMotion) { enter.setValue(1); return }
    enter.setValue(0)
    Animated.timing(enter, { toValue: 1, duration: 240, useNativeDriver: false }).start()
  }, [bucket, reduceMotion, enter])
  const cardStyle = {
    opacity: enter,
    transform: reduceMotion
      ? []
      : [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
        ],
  }
  const isEmpty = !body && (!facts || facts.length === 0)
  const hasAudio = !isEmpty
  const playLabel = audioState === 'failed' ? 'Audio unavailable — retry' : audioState === 'loading' ? 'Preparing…' : playing ? 'Stop' : 'Hear it'
  const playFilled = audioState === 'failed' ? surface.sunken : surface.accent // filled audio pill (green = audio lane)
  const playFg = audioState === 'failed' ? surface.textMuted : surface.onAccent // its icon + label colour

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable {...tid(ids.reveal.bucketCardScrim)} accessibilityLabel="Close" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: CARD_SCRIM }]} />
      <Animated.View {...tidWith(ids.reveal.bucketCard, { bucket })} style={[styles.card, shadow, cardStyle]}>
        {/* Liquid Glass BEHIND the card content (absolute, pointer-through): keeps the card's exact paddings +
            maxHeight + top-only radius + the ScrollView height chain untouched (adversarial AF6/AF7). */}
        <GlassFill strong radiusStyle={CARD_RADIUS} />
        <View style={styles.cardHead}>
          <Text style={[typeStyles.overline, { color: surface.text, fontFamily: type.family.sans['800'] }]}>{CARD_EYEBROW[bucket]}</Text>
          <Pressable {...tid(ids.nav.close, 'Close')} accessibilityRole="button" onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <X size={22} color={surface.textMuted} strokeWidth={2.5} />
          </Pressable>
        </View>

        <ScrollView style={styles.cardScroll} contentContainerStyle={{ paddingBottom: space.md }} showsVerticalScrollIndicator={false}>
          {bucket === 'facts' && facts && facts.length ? (
            <View {...tid(ids.reveal.facts)}>
              {facts.map((f, i) => (
                <FactRow key={`${f.sourceUrl}:${i}`} fact={f} surface={surface} first={i === 0} />
              ))}
            </View>
          ) : body ? (
            // Prose buckets (what / purpose / maker) show ONLY the grounded text — no source row, no quote.
            <Text {...(bucket === 'what' ? tid(ids.reveal.whatItIs) : {})} style={[typeStyles.body, { color: surface.text, lineHeight: 24 }]}>{body}</Text>
          ) : (
            // Honest empty — an ANSWER, not a broken icon (design review 3a).
            <Text style={[typeStyles.body, { color: surface.textMuted, fontStyle: 'italic' }]}>
              {bucket === 'maker' ? 'The maker keeps their counsel — nothing I can prove.' : 'Nothing grounded to add on this one.'}
            </Text>
          )}
        </ScrollView>

        {hasAudio ? (
          <>
            <Pressable
              {...tid(ids.reveal.playNarration, playLabel)}
              accessibilityRole="button"
              onPress={onPlayToggle}
              style={({ pressed }) => [styles.playBtn, { backgroundColor: playFilled, opacity: pressed ? 0.85 : 1 }]}
            >
              {playing ? <Pause size={18} color={playFg} fill={playFg} /> : <Play size={18} color={playFg} fill={playFg} />}
              <Text style={[typeStyles.subhead, { color: playFg, marginLeft: space.sm, fontFamily: type.family.sans['700'] }]}>{playLabel}</Text>
            </Pressable>
            {audioUrl ? <AudioElement id={ids.reveal.narrationAudio} src={audioUrl} playing={playing} seekToStartOnPlay onPlayingChange={() => {}} /> : null}
          </>
        ) : null}

        {tabs.length > 1 ? (
          <View style={styles.tabs}>
            {tabs.map((k) => (
              <Pressable key={k} {...tid(TEST_ID[k], `Show ${CARD_EYEBROW[k]}`)} accessibilityRole="tab" accessibilityState={{ selected: k === bucket }} onPress={() => onTab(k)} style={[styles.tab, { backgroundColor: k === bucket ? surface.accentSecondary : surface.sunken }]}>
                <Text style={[typeStyles.caption, { color: k === bucket ? surface.onAccent : surface.textMuted }]}>{CAPTION[k]}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  // The content icons scroll (flexShrink so they yield room to the pinned lane); the divider + Ask are fixed-width.
  dock: { flexDirection: 'row', alignItems: 'flex-start', marginTop: space.md },
  scroll: { flexShrink: 1 }, // shrinks + scrolls its overflow, leaving the divider + pinned Ask always visible
  scrollContent: { flexDirection: 'row', alignItems: 'flex-start', marginLeft: DOCK_EDGE_INSET, paddingRight: space.xs }, // leading inset flushes What's CIRCLE to the title's left edge
  divider: { width: 1, height: ICON_CIRCLE, alignSelf: 'flex-start', marginTop: Math.max(0, (hit.min - ICON_CIRCLE) / 2), marginHorizontal: space.sm }, // centered on the 44px circle band, not the caption
  pinned: { marginRight: DOCK_EDGE_INSET }, // trailing inset flushes Ask's CIRCLE to the title's right edge
  iconWrap: { alignItems: 'center', width: ICON_WRAP },
  iconCircleWrap: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  iconCircle: { width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 2, backgroundColor: 'transparent' },
  badge: { position: 'absolute', top: -2, right: 2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 2, right: 6, width: 6, height: 6, borderRadius: 3 },
  caption: { marginTop: space.xs, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 20 },
  card: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xl, maxHeight: '80%' },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeBtn: { width: hit.min, height: hit.min, alignItems: 'flex-end', justifyContent: 'center' },
  // flexShrink:1 (NOT flex:1 — the card is maxHeight:'80%' with no explicit height) so short content lays out fully
  // and the card hugs it, but on overflow only the ScrollView shrinks+scrolls — the pinned audio pill + tab strip
  // never fall below the screen edge (RN's default flexShrink is 0; docs/REVEAL-CARD-CLEANUP-PLAN.md §2a).
  cardScroll: { marginTop: space.sm, flexShrink: 1 },
  factRow: { paddingVertical: space.sm, gap: space.xs }, // divider list (IMDb-trivia): fact text + its own source link
  factSourceRow: { alignSelf: 'flex-start', minHeight: hit.min, justifyContent: 'center' }, // per-fact source link
  playBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm, marginTop: space.md },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg, flexWrap: 'wrap' },
  tab: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
})
