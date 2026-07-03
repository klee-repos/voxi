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
import { BookOpen, Target, Stamp, Lightbulb, Sparkles, MessageCircle, Play, Pause, RotateCcw, X } from 'lucide-react-native'
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

// Dock layout: the icons lay out as a SINGLE flush row of equal `flex:1` slots (see styles.dockRow / iconWrap),
// evenly distributed edge-to-edge — the Apple/Google Photos bottom-bar pattern. Each slot centers its glyph
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

const ICON = { what: BookOpen, purpose: Target, maker: Stamp, facts: Lightbulb, deepdive: Sparkles, conversation: MessageCircle } as const
// One word per slot (the a11yLabel keeps the full "Deep Dive" for screen readers).
const CAPTION: Record<DockKey, string> = { what: 'What', purpose: 'Purpose', maker: 'Maker', facts: 'Facts', deepdive: 'Explore', conversation: 'Ask' }
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

/** The research buckets shown in the DOCK, in order. `facts` ("Curious facts") is intentionally OMITTED so the dock
 *  stays a single flush row: the facts still stream and stay reachable as a morph-card tab. Add 'facts' back here to
 *  restore its dock icon. */
const DOCK_RESEARCH: readonly MorphKey[] = ['what', 'purpose', 'maker']

/** Accessible, state-bearing label for a dock icon (never colour/motion alone — a11y §4.9). */
function a11yLabel(key: DockKey, status: BucketStatus, ready?: boolean, generating?: boolean, unread?: boolean): string {
  if (key === 'conversation') return 'Ask Voxi about this'
  // Deep Dive is a nav affordance, not a research bucket — its label states the COST outcome a tap triggers
  // (generate vs replay vs a compose already in flight), so the user knows before tapping (adversarial D7).
  if (key === 'deepdive') {
    if (generating) return 'Deep Dive — generating its story, tap to check on it'
    return ready ? 'Deep Dive — ready to play its story' : 'Deep Dive — tap to generate its story'
  }
  const q = CARD_EYEBROW[key]
  if (status === 'loading') return `${q} — still researching`
  if (status === 'empty') return `${q} — no information found`
  if (status === 'unavailable') return `${q} — couldn't reach the Guide, tap to retry`
  return unread ? `${q} — new, unread` : `${q} — read`
}

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
        {dkey === 'deepdive' && ready && !generating ? <View style={[styles.dot, { backgroundColor: surface.accent }]} /> : null}
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

  // One flush row of equal `flex:1` slots: the research buckets, then Deep Dive + Ask. Each BucketIcon Pressable IS
  // a slot (role=button, a DIRECT child), so the row hugs its container's edges with no bunching. An active research
  // bucket the user hasn't read yet carries the unread dot; an empty one carries the small "?" (missing info).
  return (
    <View {...tid(ids.reveal.buckets)} style={styles.dockRow}>
      {DOCK_RESEARCH.filter((k) => statuses[k] !== 'hidden').map((k) => (
        <BucketIcon key={k} dkey={k} status={statuses[k]} unread={statuses[k] === 'active' && !read[k]} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen(k)} />
      ))}
      <BucketIcon dkey="deepdive" status="active" ready={deepDiveState === 'ready'} generating={deepDiveState === 'generating'} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('deepdive')} />
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
 *  The header is a horizontally-scrollable SECTION-TITLE tab bar (the heading AND the in-place section switch — a
 *  tap, never a swipe); below it the grounded body (or the fact rows + per-fact sources), and a pinned audio
 *  transport (a filled play/pause + label + a calm level ornament). */
export function BucketCard({
  bucket,
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
                  {CARD_EYEBROW[k]}
                </Text>
                <View style={[styles.tabUnderline, { backgroundColor: selected ? surface.text : 'transparent' }]} />
              </Pressable>
            )
          })}
        </ScrollView>
        <View style={[styles.headerHairline, { backgroundColor: surface.border }]} />

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
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  // Flush dock: a SINGLE row of equal `flex:1` slots, evenly distributed edge-to-edge (Apple/Google Photos
  // bottom-bar pattern). Each BucketIcon Pressable IS a slot (role=button, direct child), so the row hugs its
  // container's left/right edges with no bunching — no wrap, no fixed width; the caption is single-line (no reflow).
  dockRow: { flexDirection: 'row', alignItems: 'flex-start' },
  iconWrap: { flex: 1, alignItems: 'center' },
  iconCircleWrap: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  iconCircle: { width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: ICON_CIRCLE, height: ICON_CIRCLE, borderRadius: radius.pill, borderWidth: 2, backgroundColor: 'transparent' },
  badge: { position: 'absolute', top: -2, right: 2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 2, right: 6, width: 6, height: 6, borderRadius: 3 },
  unreadDot: { position: 'absolute', top: -1, right: 2, width: 10, height: 10, borderRadius: 5 }, // "new / unread" — an active bucket the user hasn't opened yet
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
  tab: { alignItems: 'center', paddingTop: space.xs },
  tabLabel: { fontSize: 16, lineHeight: 21 }, // the section title IS the tab — larger + readable, not a tiny caption
  tabUnderline: { alignSelf: 'stretch', height: 2.5, borderRadius: 2, marginTop: space.sm }, // active-tab indicator on the hairline
  headerHairline: { height: StyleSheet.hairlineWidth },
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
