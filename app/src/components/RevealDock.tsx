/**
 * The reveal DOCK — three icons: Explore (Deep Dive, green audio lane, featured first), Details (the research lane
 * — what/purpose/maker/facts — collapsed to one icon that opens the morph `BucketCard` with all four tabs), and Ask
 * (blue people lane). Details carries the AGGREGATE state of the research buckets via `tidWith`
 * (loading|active|empty); Explore carries its Deep Dive state (generating|ready|active). design.md's green=audio /
 * blue=people lanes.
 *
 * Converge-safe by construction: JS-driven `Animated` (`useNativeDriver:false`), lucide-only iconography, and NO
 * `react-native-gesture-handler` — section nav is a tappable labeled tab strip PLUS a core-RN `PanResponder` swipe
 * over the card body (the same converge-safe gesture path Drawer.tsx/Scrubber.tsx use). State rides `data-*` (via
 * `tidWith`), never colour/glyph alone, so the E2E proof reads it deterministically.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, Easing, StyleSheet, ScrollView, Linking, PanResponder, type ViewStyle, type PanResponderGestureState } from 'react-native'
import { BookOpen, Target, Stamp, Lightbulb, Sparkles, MessageCircle, Play, Pause, RotateCcw, X, ScrollText } from 'lucide-react-native'
import { AudioElement } from './AudioElement'
import { GlassFill } from './GlassFill'
import { ids, tid, tidWith } from '../lib/testid'
import { radius, space, typeStyles, type, hit, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { sourceLabel } from '../lib/sourceLabel'
import { deriveDetailsStatus, deriveDetailsUnread, type BucketStatus, type RevealFact } from '../state/captureStore'
import { nextTab, type TabDir } from '../lib/cardTabs'

/** Dock affordances. The four research buckets morph into a card (green lane); `deepdive` navigates to the Deep
 *  Dive player (green audio lane, on-demand); `conversation` navigates (blue people lane, pinned). */
export type DockKey = 'what' | 'purpose' | 'maker' | 'facts' | 'deepdive' | 'details' | 'conversation'
/** The morph/audio buckets — the ones that open a `BucketCard` + have per-bucket status/audio. Excludes the two
 *  NAV affordances (`deepdive` opens the Deep Dive screen; `conversation` opens the chat), so their union never
 *  leaks into the morph-card / audio-bucket / deriveBucketStatus paths (adversarial D4). */
export type MorphKey = 'what' | 'purpose' | 'maker' | 'facts'

type Surface = ReturnType<typeof useTheme>['surface']

// Dock layout: THREE icons (Explore · Details · Ask) as equal `flex:1` slots with a real `gap` between them (see
// styles.dockRow / iconWrap) — the Apple/Google Photos bottom-bar pattern, spaced. Each slot centers its glyph
// circle (`ICON_CIRCLE`) plus a one-word caption; a bucket's corner badge (unread dot / "?") pokes just above the
// glyph. It's a plain View (not a ScrollView), so nothing scrolls.
const ICON_CIRCLE = 44
// The morph card is a bottom-flush sheet: round ONLY the top corners (the bottom sits on the screen edge). Passed to
// GlassFill so the glass clips to the same rounded rect — never rounding the bottom corners open onto the scrim.
const CARD_RADIUS: ViewStyle = { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
// A deeper scrim than the shared drawer scrim (0.35): the morph card is a translucent glass reading sheet, so the
// dock behind it must be dimmed enough that it doesn't bleed through the material. Kept in sync with the hardcoded
// copy in theme.test.ts (the blue-source-link AA guard composites over this exact value).
const CARD_SCRIM = 'rgba(20,18,14,0.60)'

const ICON = { what: BookOpen, purpose: Target, maker: Stamp, facts: Lightbulb, deepdive: Sparkles, details: ScrollText, conversation: MessageCircle } as const
// One word per slot (the a11yLabel keeps the full "Deep Dive" for screen readers).
const CAPTION: Record<DockKey, string> = { what: 'What', purpose: 'Purpose', maker: 'Maker', facts: 'Facts', deepdive: 'Explore', details: 'Details', conversation: 'Ask' }
const TEST_ID: Record<DockKey, string> = {
  what: ids.reveal.bucketWhat,
  purpose: ids.reveal.bucketPurpose,
  maker: ids.reveal.bucketWho,
  facts: ids.reveal.bucketFacts,
  deepdive: ids.reveal.deepDiveIcon,
  details: ids.reveal.detailsIcon,
  conversation: ids.reveal.conversationIcon,
}
/** The descriptive phrase retained for each tab's aria-label (the VISIBLE tab is the single-word CAPTION — sighted users see short, screen readers hear long). */
export const CARD_EYEBROW: Record<MorphKey, string> = {
  what: 'What it is',
  purpose: "What it's for",
  maker: 'Who made it',
  facts: 'Curious facts',
}

// A horizontal swipe over the card body switches sections (core-RN PanResponder — converge-safe, no gesture-handler).
// The predicate gates BOTH the responder claim (capture + bubble) AND the release commit, so a gesture that ended
// vertical-dominant, or drifted back inside the deadzone, is a no-op — never a wrong-way switch (Drawer.tsx:78 gates
// at release for the same reason).
const SWIPE_MIN_PX = 20
const isHorizontalSwipe = (g: PanResponderGestureState): boolean =>
  Math.abs(g.dx) > SWIPE_MIN_PX && Math.abs(g.dx) > Math.abs(g.dy) * 1.5

/** Accessible, state-bearing label for a dock icon (never colour/motion alone — a11y §4.9). */
function a11yLabel(key: DockKey, status: BucketStatus, ready?: boolean, generating?: boolean, unread?: boolean): string {
  if (key === 'conversation') return 'Ask Voxi about this'
  // Deep Dive is a nav affordance, not a research bucket — its label states the COST outcome a tap triggers
  // (generate vs replay vs a compose already in flight), so the user knows before tapping (adversarial D7).
  if (key === 'deepdive') {
    if (generating) return 'Deep Dive — generating its story, tap to check on it'
    return ready ? 'Deep Dive — ready to play its story' : 'Deep Dive — tap to generate its story'
  }
  if (key === 'details') {
    // The research lane collapsed to one icon; its state is the aggregate of what/purpose/maker. 'active' with an
    // unread bucket → "new"; all-empty (none active/loading) → "nothing grounded yet"; else loading/read.
    const q = "Details — what it is, what it's for, who made it"
    if (status === 'loading') return `${q} — still researching`
    if (status === 'empty') return `${q} — nothing grounded yet`
    return unread ? `${q} — new, unread` : `${q} — read`
  }
  const q = CARD_EYEBROW[key]
  if (status === 'loading') return `${q} — still researching`
  if (status === 'empty') return `${q} — no information found`
  if (status === 'unavailable') return `${q} — couldn't reach the Guide, tap to retry`
  return unread ? `${q} — new, unread` : `${q} — read`
}

/** The research buckets rolled up under the single Details dock icon (the dock's research lane collapses to one
 *  slot; all four stay reachable as morph-card tabs). The aggregate is derived in `captureStore`
 *  (`deriveDetailsStatus` / `deriveDetailsUnread`) so the dock-face contract is unit-pinned. */

/** One dock icon. Loading → a single green pulse ring (shared driver) around a dimmed glyph; active → full-ink
 *  glyph (green reserved for the audio/play control, not "active"); an active research bucket the user hasn't read
 *  carries an unread dot; empty → the small "?" (missing info); unavailable → a retry glyph. Conversation = blue. */
function BucketIcon({
  dkey,
  status,
  unread,
  ready,
  generating,
  pulse,
  reduceMotion,
  surface,
  onPress,
}: {
  dkey: DockKey
  status: BucketStatus
  /** A research bucket whose content has loaded but the user hasn't read yet → show the unread dot. */
  unread?: boolean
  /** Deep Dive only: a durable episode already exists → show the green ready dot + "ready to play" a11y. */
  ready?: boolean
  /** Deep Dive only: a compose is in flight → show the spinning "generating" ring (reuses the bucket-loading cue). */
  generating?: boolean
  pulse: Animated.Value
  reduceMotion: boolean
  surface: Surface
  onPress: () => void
}): React.ReactElement | null {
  if (status === 'hidden') return null
  const Glyph = ICON[dkey]
  const isConv = dkey === 'conversation'
  // Deep Dive rides the same active-ink treatment as an answered research bucket (green stays the play control);
  // its state carries `generating`/`ready` so the agentic proof can assert generate-vs-in-flight-vs-replay.
  const iconState = isConv ? 'active' : dkey === 'deepdive' ? (generating ? 'generating' : ready ? 'ready' : 'active') : status
  // The spinning ring shows for a research bucket that's loading OR a Deep Dive that's generating (same cue).
  const showRing = status === 'loading' || !!generating
  const glyphColor = isConv
    ? surface.accentSecondary // blue people lane
    : status === 'active' || (dkey === 'deepdive' && !generating)
      ? surface.text // full-ink = "answered / readable" (green stays the audio colour)
      : surface.textTertiary // loading/empty/unavailable/generating = muted
  // Loading = a green arc SPINNING around the icon's border (a classic loading ring), not a pulse: a bright accent
  // HEAD on a faint full track, rotated 0→360° by the shared driver. Reduce-motion → a static faint accent ring.
  const spin = pulse.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })

  return (
    <Pressable
      {...tidWith(TEST_ID[dkey], { state: iconState, unread: unread ? 'yes' : 'no' }, a11yLabel(dkey, status, ready, generating, unread))}
      accessibilityRole="button"
      accessibilityState={{ busy: status === 'loading' || !!generating, disabled: false }}
      onPress={onPress}
      style={({ pressed }) => [styles.iconWrap, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.iconCircleWrap}>
        <View style={[styles.iconCircle, { backgroundColor: surface.sunken, borderColor: isConv ? surface.accentSecondary : surface.border }]}>
          <Glyph size={22} color={glyphColor} strokeWidth={2} />
        </View>
        {showRing ? (
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
        {unread ? <View style={[styles.unreadDot, { backgroundColor: surface.accent }]} /> : null}
        {status === 'empty' ? (
          <View style={[styles.badge, { backgroundColor: surface.sunken, borderColor: surface.border, borderWidth: 1 }]}>
            <Text style={[typeStyles.caption, { color: surface.textTertiary }]}>?</Text>
          </View>
        ) : null}
        {/* Deep Dive "ready": the same green indicator dot as an unread research bucket (design.md's single 10px
            unread-dot) — same size + position, so the Explore icon's dot never reads as a different shape. */}
        {dkey === 'deepdive' && ready && !generating ? <View style={[styles.unreadDot, { backgroundColor: surface.accent }]} /> : null}
        {status === 'unavailable' ? (
          <View style={[styles.badge, { backgroundColor: surface.sunken, borderColor: surface.border, borderWidth: 1 }]}>
            <RotateCcw size={11} color={surface.textTertiary} strokeWidth={2.5} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[typeStyles.caption, styles.caption, { color: isConv ? surface.accentSecondary : surface.textMuted }]}>{CAPTION[dkey]}</Text>
    </Pressable>
  )
}

/** The dock: the research icons + the Deep Dive icon (green lane) + the blue Ask-Voxi icon lay out as ONE flush
 *  row of equal slots (Facts is omitted — see DOCK_RESEARCH). One shared pulse driver runs while ANY bucket is
 *  loading (no N loops). */
export function BucketDock({
  statuses,
  read,
  deepDiveState = 'active',
  reduceMotion,
  surface,
  onOpen,
}: {
  statuses: Record<MorphKey, BucketStatus>
  /** Per research bucket: has the user READ it yet? An active bucket the user hasn't read shows the unread dot. */
  read: Record<MorphKey, boolean>
  /** The Deep Dive icon's state: `generating` (a compose is in flight → spinning ring), `ready` (a durable episode
   *  exists → green dot), or `active` (tap to generate). Derived from the deepDiveStore (cost transparency). */
  deepDiveState?: 'active' | 'generating' | 'ready'
  reduceMotion: boolean
  surface: Surface
  onOpen: (k: DockKey) => void
}): React.ReactElement {
  const pulse = useRef(new Animated.Value(0)).current
  // The shared spin driver runs while ANY research bucket is loading OR the Deep Dive is generating (one loop).
  const anyLoading = deepDiveState === 'generating' || (['what', 'purpose', 'maker', 'facts'] as const).some((k) => statuses[k] === 'loading')
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

  // Three dock icons, in order: Explore (Deep Dive — featured first, the most compelling content) · Details (the
  // research lane collapsed to one icon; opens the morph card whose tabs are what/purpose/maker/facts) · Ask. Each
  // BucketIcon Pressable IS a slot (role=button, a direct child); styles.dockRow gives them flex:1 + a real gap, so
  // the row reads as three clearly-spaced affordances (not the old five-up flush row).
  // Details carries the AGGREGATE state of what/purpose/maker (derived in captureStore, unit-pinned): a loading
  // bucket → the spinning ring; any active → full ink (an unread one adds the dot — but ONLY once the lane has
  // finished streaming); none active/loading → the small "?" (nothing grounded yet).
  const detailsStatus = deriveDetailsStatus(statuses)
  const detailsUnread = deriveDetailsUnread(statuses, read)
  return (
    <View {...tid(ids.reveal.buckets)} style={styles.dockRow}>
      <BucketIcon dkey="deepdive" status="active" ready={deepDiveState === 'ready'} generating={deepDiveState === 'generating'} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('deepdive')} />
      <BucketIcon dkey="details" status={detailsStatus} unread={detailsUnread} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('details')} />
      <BucketIcon dkey="conversation" status="active" pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('conversation')} />
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
      <Text style={[typeStyles.body, { color: surface.text, fontSize: 16, lineHeight: 24 }]}>{fact.text}</Text>
      {label ? (
        <Pressable
          {...tid(ids.reveal.factSource, `Source: ${label}, opens in browser`)}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(fact.sourceUrl).catch(() => {})}
          style={styles.factSourceRow}
        >
          {/* source link nudged to 14 so the honesty signifier isn't the smallest text under the enlarged body */}
          <Text style={[typeStyles.footnote, { color: surface.accentSecondary, fontSize: 14, lineHeight: 18 }]} numberOfLines={1}>{label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export type AudioState = 'idle' | 'loading' | 'ready' | 'failed'

// A calm, STATIC level ornament for the audio transport — a frozen bar meter that only brightens while playing
// (design.md keeps chrome quiet: no looping equalizer). The varied heights read as "audio" without any motion.
const WAVE_BARS = [7, 15, 10, 18, 12] as const
function Waveform({ playing, color }: { playing: boolean; color: string }): React.ReactElement {
  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.wave}>
      {WAVE_BARS.map((h, i) => (
        <View key={i} style={[styles.waveBar, { height: h, backgroundColor: color, opacity: playing ? 1 : 0.4 }]} />
      ))}
    </View>
  )
}

/** The morph CARD: a scrim-backed reading sheet that rises + scales in from the dock (single-node transform+opacity
 *  on the JS driver — not an expensive per-node shared-element morph, adversarial 7b; reduce-motion → cross-fade).
 *  Sections switch TWO ways: a TAP on a labeled tab in the header strip, OR a horizontal SWIPE over the card body
 *  (core-RN PanResponder — converge-safe, no gesture-handler). Below the strip: the grounded prose (or fact rows +
 *  per-fact sources), and a pinned audio transport (a filled play/pause + label + a calm level ornament). */
export function BucketCard({
  bucket,
  /** the section's dock status — drives the honest loading vs empty body (loading → "Still researching…"). */
  status,
  body,
  whenMade,
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
  /** the section's dock status — loading → "Still researching…" (not the failed-looking empty prose). */
  status: BucketStatus
  body: string
  /** the "when it was made" grounded date (maker card only) — a muted line beside the maker prose; '' when absent. */
  whenMade?: string
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
  // Swipe-between-tabs: a horizontal drag over the card body commits the next/prev section. The PanResponder is
  // built once; `live` is refreshed every render so the release handler never closes over a stale bucket/tabs/onTab
  // (the same ref-refresh Scrubber.tsx uses for its long-lived seek PanResponder). onMoveShouldSet… claims ONLY
  // horizontal-dominant moves, so the inner vertical ScrollView keeps vertical scroll and every Pressable (tab /
  // transport / source link) keeps its tap. The handlers live on a wrapper around the body + transport ONLY — the
  // tab strip keeps its OWN horizontal responder (so it still scrolls on overflow at accessibility font scales).
  const live = useRef({ bucket, tabs, onTab })
  live.current = { bucket, tabs, onTab }
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false, // never steal taps — Pressables inside keep them
      onMoveShouldSetPanResponder: (_e, g) => isHorizontalSwipe(g),
      // capture too, so the parent robustly preempts the inner vertical ScrollView for a horizontal gesture (the
      // bubble handler covers the converge-proven RNW path; capture covers native + the greedy-ScrollView case).
      onMoveShouldSetPanResponderCapture: (_e, g) => isHorizontalSwipe(g),
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dx) <= SWIPE_MIN_PX) return // deadzone: a backtrack/drift that collapsed below threshold
        if (Math.abs(g.dx) <= Math.abs(g.dy) * 1.5) return // ended vertical-dominant (a curved scroll attempt)
        const dir: TabDir = g.dx < 0 ? 1 : -1 // leftward swipe → next tab; rightward → previous
        const t = nextTab(live.current.bucket, dir, live.current.tabs)
        if (t) live.current.onTab(t)
      },
      onPanResponderTerminate: () => { /* a contended/cancelled gesture never switches tabs */ },
    }),
  ).current
  const cardStyle = {
    opacity: enter,
    transform: reduceMotion
      ? []
      : [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
        ],
  }
  // The grounded "when it was made" date, maker card only (trimmed; '' when absent). It does NOT enter `isEmpty` —
  // an empty maker with only a date has no voiced audio, and the date is a visual sibling, not the maker prose.
  const makerDate = bucket === 'maker' ? (whenMade ?? '').trim() : ''
  const isEmpty = !body && (!facts || facts.length === 0)
  const hasAudio = !isEmpty
  const playLabel = audioState === 'failed' ? 'Audio unavailable — retry' : audioState === 'loading' ? 'Preparing…' : playing ? 'Stop' : 'Hear it'
  // The filled circular play/pause is green (the audio lane, design.md); a failed clip → a neutral circle + retry glyph.
  const playCircleBg = audioState === 'failed' ? surface.textTertiary : surface.accent
  const playCircleFg = audioState === 'failed' ? surface.text : surface.onAccent

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable {...tid(ids.reveal.bucketCardScrim)} accessibilityLabel="Close" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: CARD_SCRIM }]} />
      <Animated.View {...tidWith(ids.reveal.bucketCard, { bucket })} style={[styles.card, shadow, cardStyle]}>
        {/* Liquid Glass BEHIND the card content (absolute, pointer-through): keeps the card's exact paddings +
            maxHeight + top-only radius + the ScrollView height chain untouched (adversarial AF6/AF7). */}
        <GlassFill card radiusStyle={CARD_RADIUS} />

        {/* Sheet chrome: a centred grab handle with the close affordance pinned top-right (design.md bottom-sheet). */}
        <View style={styles.sheetHeader}>
          <View style={[styles.grab, { backgroundColor: surface.textTertiary }]} />
          <Pressable {...tid(ids.nav.close, 'Close')} accessibilityRole="button" onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <X size={22} color={surface.textMuted} strokeWidth={2.5} />
          </Pressable>
        </View>
        {/* The section TITLES are the tabs — a FULL-WIDTH row that scrolls horizontally on overflow (the close X sits
            in the header row above, so the tabs own the whole width and never push it off). This bar IS the card
            heading AND the in-place section switch (replacing the old eyebrow + bottom strip). Always rendered; a
            single tab is the heading-only state. Active = full-ink label + a near-white underline; inactive = muted. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
          {tabs.map((k) => {
            const selected = k === bucket
            return (
              <Pressable
                key={k}
                {...tidWith(ids.reveal.cardTab, { bucket: k, selected: String(selected) }, `Show ${CARD_EYEBROW[k]}`)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => onTab(k)}
                style={styles.tab}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.tabLabel, { color: selected ? surface.text : surface.textMuted, fontFamily: selected ? type.family.sans['800'] : type.family.sans['600'] }]}
                >
                  {CAPTION[k]}
                </Text>
                <View style={[styles.tabUnderline, { backgroundColor: selected ? surface.text : 'transparent' }]} />
              </Pressable>
            )
          })}
        </ScrollView>
        <View style={[styles.headerHairline, { backgroundColor: surface.border }]} />

        <View style={styles.body} {...pan.panHandlers}>
        <ScrollView style={styles.cardScroll} contentContainerStyle={{ paddingBottom: space.md }} showsVerticalScrollIndicator={false}>
          {bucket === 'facts' && facts && facts.length ? (
            <View {...tid(ids.reveal.facts)}>
              {facts.map((f, i) => (
                <FactRow key={`${f.sourceUrl}:${i}`} fact={f} surface={surface} first={i === 0} />
              ))}
            </View>
          ) : body ? (
            // Prose buckets (what / purpose / maker) show ONLY the grounded text — larger + looser for reading.
            <Text {...(bucket === 'what' ? tid(ids.reveal.whatItIs) : {})} style={[typeStyles.body, { color: surface.text, fontSize: 17, lineHeight: 26 }]}>{body}</Text>
          ) : status === 'loading' ? (
            // The section is still streaming — an honest IN-PROGRESS state, NOT the failed-looking "nothing grounded"
            // prose (a still-researching tab must read as in-progress, not as an answer of absence).
            <Text style={[typeStyles.body, { color: surface.textMuted, fontStyle: 'italic', fontSize: 16, lineHeight: 24 }]}>Still researching this one…</Text>
          ) : bucket === 'maker' && makerDate ? (
            // Date-known / maker-unknown (Lviv "Painter unknown, 1830"): the date LEADS below, so the one grounded
            // fact isn't buried under a negation. The made block (rendered next) carries the softened maker note.
            null
          ) : (
            // Honest empty — an ANSWER, not a broken icon (design review 3a).
            <Text style={[typeStyles.body, { color: surface.textMuted, fontStyle: 'italic', fontSize: 16, lineHeight: 24 }]}>
              {bucket === 'maker' ? 'The maker keeps their counsel — nothing I can prove.' : 'Nothing grounded to add on this one.'}
            </Text>
          )}
          {/* "When it was made" — a compact, muted date line beside the maker prose (no dock slot; design.md
              maker-adjacent metadata, Mobbin museum pattern). LAST child inside cardScroll so it scrolls with the
              prose and never competes with the pinned transport. textMuted (AA over the card scrim), never
              textTertiary (sub-AA). When the maker prose is present the date follows it under a hairline; when the
              maker is unknown the date LEADS and a softened note follows. */}
          {bucket === 'maker' && makerDate ? (
            <View style={[styles.madeBlock, body ? { marginTop: space.md, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: surface.border } : null]}>
              <Text {...tid(ids.reveal.whenMade)} style={[typeStyles.body, { color: surface.textMuted, fontSize: 15, lineHeight: 22 }]}>{makerDate}</Text>
              {!body ? (
                <Text style={[typeStyles.body, { color: surface.textMuted, fontStyle: 'italic', fontSize: 15, lineHeight: 22, marginTop: space.sm }]}>
                  Who made it isn't something I can prove.
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        {hasAudio ? (
          <>
            {/* The audio TRANSPORT (pinned): a filled green play/pause + the state label + a calm level ornament.
                The WHOLE bar is the play control (a big target); testID + onPlayToggle are unchanged. */}
            <Pressable
              {...tid(ids.reveal.playNarration, playLabel)}
              accessibilityRole="button"
              onPress={onPlayToggle}
              style={({ pressed }) => [styles.transport, { backgroundColor: surface.sunken, borderColor: surface.border, opacity: pressed ? 0.9 : 1 }]}
            >
              <View style={[styles.transportBtn, { backgroundColor: playCircleBg }]}>
                {playing ? (
                  <Pause size={20} color={playCircleFg} fill={playCircleFg} />
                ) : audioState === 'failed' ? (
                  <RotateCcw size={20} color={playCircleFg} strokeWidth={2.5} />
                ) : (
                  <Play size={20} color={playCircleFg} fill={playCircleFg} />
                )}
              </View>
              <Text style={[styles.transportLabel, { color: audioState === 'failed' ? surface.textMuted : surface.text }]} numberOfLines={1}>{playLabel}</Text>
              <Waveform playing={playing} color={audioState === 'failed' ? surface.textTertiary : surface.accent} />
            </Pressable>
            {audioUrl ? <AudioElement id={ids.reveal.narrationAudio} src={audioUrl} playing={playing} seekToStartOnPlay onPlayingChange={() => {}} /> : null}
          </>
        ) : null}
        </View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  // Three spaced dock icons: equal `flex:1` slots (Apple/Google Photos bottom-bar pattern) with a real `gap`
  // between them so the row reads as three distinct affordances, not a flush cluster. Each BucketIcon Pressable IS
  // a slot (role=button, direct child) hugging the container's left/right edges; the caption is single-line.
  dockRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  iconWrap: { flex: 1, alignItems: 'center' },
  iconCircleWrap: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  iconCircle: { width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 2, backgroundColor: 'transparent' },
  badge: { position: 'absolute', top: -2, right: 2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  unreadDot: { position: 'absolute', top: -1, right: 2, width: 10, height: 10, borderRadius: 5 }, // the dock's ONE green "new content" indicator (design.md unread-dot, 10px): an unread research bucket OR a ready Deep Dive
  caption: { marginTop: space.xs, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 20 },
  // paddingTop trimmed — the grab handle carries the top breathing room; the card hugs its content up to 82% height.
  card: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl, maxHeight: '82%' },
  // Header row: the grab handle is centred; the close X is pinned top-right (absolute, so the full-width tab bar
  // below it can scroll edge-to-edge without the X ever pushing off-screen).
  sheetHeader: { height: 30, alignItems: 'center', justifyContent: 'center' },
  grab: { width: 36, height: 4, borderRadius: 2, opacity: 0.55 },
  closeBtn: { position: 'absolute', top: 0, right: 0, width: 40, height: 30, alignItems: 'flex-end', justifyContent: 'center' },
  // Full-width, horizontally-scrolling section-title tabs (flexGrow:0 → its height hugs the labels, not the column).
  tabBar: { flexGrow: 0, marginTop: space.xs },
  tabBarContent: { flexDirection: 'row', alignItems: 'flex-end', gap: space.lg, paddingRight: space.md },
  tab: { alignItems: 'center', paddingTop: space.xs, paddingHorizontal: space.sm, minHeight: hit.min }, // 44pt hit-target holds even for the shortest single-word label ('What')
  tabLabel: { fontSize: 16, lineHeight: 21 }, // the section title IS the tab — larger + readable, not a tiny caption
  tabUnderline: { alignSelf: 'stretch', height: 2.5, borderRadius: 2, marginTop: space.sm }, // active-tab indicator on the hairline
  headerHairline: { height: StyleSheet.hairlineWidth },
  // The swipe-able body wrapper (cardScroll + transport). flexShrink:1 so it shrinks within the card on overflow
  // (matching cardScroll below) — short content still hugs. The swipe PanResponder lives here, scoped AWAY from the
  // tab strip so the strip keeps its own horizontal responder at every font scale.
  body: { flexShrink: 1 },
  // flexShrink:1 (NOT flex:1 — the card is maxHeight:'82%' with no explicit height) so short content lays out fully
  // and the card hugs it, but on overflow only the ScrollView shrinks+scrolls — the fixed tab bar + pinned transport
  // never fall below the screen edge (RN's default flexShrink is 0).
  cardScroll: { marginTop: space.md, flexShrink: 1 },
  madeBlock: {}, // "when it was made" line; the hairline + top spacing are applied inline only when maker prose precedes it
  factRow: { paddingVertical: space.sm, gap: space.xs }, // divider list (IMDb-trivia): fact text + its own source link
  factSourceRow: { alignSelf: 'flex-start', minHeight: hit.min, justifyContent: 'center' }, // per-fact source link
  // The pinned audio transport: a filled circular play/pause + the state label + a calm static level ornament.
  transport: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingVertical: space.sm, paddingHorizontal: space.sm, marginTop: space.md },
  transportBtn: { width: hit.min, height: hit.min, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  transportLabel: { flex: 1, fontFamily: type.family.sans['700'], fontSize: 15, lineHeight: 20 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 20, marginRight: space.xs },
  waveBar: { width: 3, borderRadius: 2 },
})
