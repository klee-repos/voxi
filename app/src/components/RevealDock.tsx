/**
 * The reveal DOCK (ANALYSIS-UX redesign) — replaces the scroll-over info sheet. Voxi answers four fixed questions
 * about any object as four green research icons (What it is · What it's for · Who made it · Curious facts) plus a
 * blue Ask-Voxi conversation icon (design.md's green=audio / blue=people lanes). Each research icon carries
 * `bucket.state` (loading|active|empty|unavailable) via `tidWith`; tapping an active one morphs it into a
 * `BucketCard` — the grounded content + a source proof + per-bucket audio.
 *
 * Converge-safe by construction: JS-driven `Animated` (`useNativeDriver:false`), lucide-only iconography, and NO
 * `react-native-gesture-handler` (between-bucket nav is a tappable labeled tab strip, never a swipe). State rides
 * `data-*` (via `tidWith`), never colour/glyph alone, so the E2E proof reads it deterministically.
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, Animated, StyleSheet, ScrollView, Linking, type ViewStyle } from 'react-native'
import { BookOpen, Target, Stamp, Lightbulb, MessageCircle, Play, Pause, RotateCcw, X } from 'lucide-react-native'
import { AudioElement } from './AudioElement'
import { GlassFill } from './GlassFill'
import { ids, tid, tidWith } from '../lib/testid'
import { radius, space, typeStyles, type, hit, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { BucketStatus, RevealFact } from '../state/captureStore'

/** The five dock affordances. The four research buckets play audio (green lane); `conversation` navigates (blue). */
export type DockKey = 'what' | 'purpose' | 'maker' | 'facts' | 'conversation'

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

const ICON = { what: BookOpen, purpose: Target, maker: Stamp, facts: Lightbulb, conversation: MessageCircle } as const
const CAPTION: Record<DockKey, string> = { what: 'What', purpose: 'Purpose', maker: 'Maker', facts: 'Facts', conversation: 'Ask' }
const TEST_ID: Record<DockKey, string> = {
  what: ids.reveal.bucketWhat,
  purpose: ids.reveal.bucketPurpose,
  maker: ids.reveal.bucketWho,
  facts: ids.reveal.bucketFacts,
  conversation: ids.reveal.conversationIcon,
}
/** The full question a bucket's card announces as its eyebrow (dock captions are short; no meaning lost). */
export const CARD_EYEBROW: Record<Exclude<DockKey, 'conversation'>, string> = {
  what: 'What it is',
  purpose: "What it's for",
  maker: 'Who made it',
  facts: 'Curious facts',
}

/** Accessible, state-bearing label for a research icon (never colour/motion alone — a11y §4.9). */
function a11yLabel(key: DockKey, status: BucketStatus): string {
  if (key === 'conversation') return 'Ask Voxi about this'
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
  pulse,
  reduceMotion,
  surface,
  onPress,
}: {
  dkey: DockKey
  status: BucketStatus
  count?: number
  pulse: Animated.Value
  reduceMotion: boolean
  surface: Surface
  onPress: () => void
}): React.ReactElement | null {
  if (status === 'hidden') return null
  const Glyph = ICON[dkey]
  const isConv = dkey === 'conversation'
  const glyphColor = isConv
    ? surface.accentSecondary // blue people lane
    : status === 'active'
      ? surface.text // full-ink = "answered / readable" (green stays the audio colour)
      : surface.textTertiary // loading/empty/unavailable = muted
  const ringOpacity = reduceMotion ? 0.4 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.6] })
  const ringScale = reduceMotion ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] })

  return (
    <Pressable
      {...tidWith(TEST_ID[dkey], { state: isConv ? 'active' : status }, a11yLabel(dkey, status))}
      accessibilityRole="button"
      accessibilityState={{ busy: status === 'loading', disabled: false }}
      onPress={onPress}
      style={({ pressed }) => [styles.iconWrap, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.iconCircleWrap}>
        {status === 'loading' ? (
          <Animated.View
            aria-hidden
            style={[styles.ring, { borderColor: surface.accent, opacity: ringOpacity, transform: [{ scale: ringScale }] }]}
          />
        ) : null}
        <View style={[styles.iconCircle, { backgroundColor: surface.sunken, borderColor: isConv ? surface.accentSecondary : surface.border }]}>
          <Glyph size={22} color={glyphColor} strokeWidth={2} />
        </View>
        {status === 'active' && dkey === 'facts' && count ? (
          <View style={[styles.badge, { backgroundColor: surface.accent }]}>
            <Text style={[typeStyles.caption, { color: surface.onAccent }]}>{count}</Text>
          </View>
        ) : null}
        {status === 'empty' ? <View style={[styles.dot, { backgroundColor: surface.textTertiary }]} /> : null}
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
  reduceMotion,
  surface,
  onOpen,
}: {
  statuses: Record<Exclude<DockKey, 'conversation'>, BucketStatus>
  factCount: number
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
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [anyLoading, reduceMotion, pulse])

  return (
    <View {...tid(ids.reveal.buckets)} style={styles.dock}>
      {/* Fixed 5-slot grid: a HIDDEN research bucket (legacy revisit with no `section` events) renders an INVISIBLE
          spacer, not null, so space-between always distributes the SAME five slots — What stays flush-left and Ask
          flush-right in every state, never a scattered 3-icon row (adversarial AF5). */}
      {(['what', 'purpose', 'maker', 'facts'] as const).map((k) =>
        statuses[k] === 'hidden' ? (
          <View key={k} style={styles.slotSpacer} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        ) : (
          <BucketIcon key={k} dkey={k} status={statuses[k]} count={k === 'facts' ? factCount : undefined} pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen(k)} />
        ),
      )}
      <BucketIcon dkey="conversation" status="active" pulse={pulse} reduceMotion={reduceMotion} surface={surface} onPress={() => onOpen('conversation')} />
    </View>
  )
}

/** One verified fact, rendered as its own chip with a tappable SOURCE PROOF (verbatim quote + link). */
function FactChip({ fact, surface }: { fact: RevealFact; surface: Surface }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <View {...tid(ids.reveal.fact)} style={[styles.factChip, { backgroundColor: surface.sunken, borderColor: surface.border }]}>
      <Text style={[typeStyles.body, { color: surface.text }]}>{fact.text}</Text>
      {fact.sourceUrl ? (
        <>
          <Pressable {...tid(ids.reveal.factSource, `Source: ${fact.sourceTitle || fact.sourceUrl}`)} accessibilityRole="button" onPress={() => setOpen((o) => !o)} style={styles.sourceBtn}>
            <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]}>{open ? 'Hide source' : 'Source'}</Text>
          </Pressable>
          {open ? (
            <View style={styles.proof}>
              <Text style={[typeStyles.footnote, { color: surface.textMuted, fontStyle: 'italic' }]}>“{fact.quote}”</Text>
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(fact.sourceUrl).catch(() => {})}>
                <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]}>{fact.sourceTitle || fact.sourceUrl}</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  )
}

export type AudioState = 'idle' | 'loading' | 'ready' | 'failed'

/** The morph CARD: a scrim-backed overlay that rises + scales in from the dock (single-node transform+opacity on
 *  the JS driver — not an expensive per-node shared-element morph, adversarial 7b; reduce-motion → cross-fade).
 *  Holds the full-question eyebrow, the grounded body (or the fact chips), a source proof, the per-bucket audio
 *  control, and a LABELED tab strip to switch buckets (never a swipe). */
export function BucketCard({
  bucket,
  body,
  sourceUrl,
  sourceTitle,
  quote,
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
  bucket: Exclude<DockKey, 'conversation'>
  body: string
  sourceUrl?: string
  sourceTitle?: string
  quote?: string
  facts?: RevealFact[]
  audioUrl: string | null
  audioState: AudioState
  playing: boolean
  reduceMotion: boolean
  surface: Surface
  tabs: Exclude<DockKey, 'conversation'>[]
  onTab: (k: Exclude<DockKey, 'conversation'>) => void
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
            <View {...tid(ids.reveal.facts)} style={{ gap: space.sm }}>
              {facts.map((f, i) => (
                <FactChip key={`${f.sourceUrl}:${i}`} fact={f} surface={surface} />
              ))}
            </View>
          ) : body ? (
            <>
              <Text {...(bucket === 'what' ? tid(ids.reveal.whatItIs) : {})} style={[typeStyles.body, { color: surface.text, lineHeight: 24 }]}>{body}</Text>
              {sourceUrl ? (
                <Pressable {...tid(ids.reveal.factSource, `Source: ${sourceTitle || sourceUrl}`)} accessibilityRole="link" onPress={() => void Linking.openURL(sourceUrl).catch(() => {})} style={styles.sourceBtn}>
                  <Text style={[typeStyles.footnote, { color: surface.accentSecondary }]}>{quote ? `“${quote}” — ${sourceTitle || sourceUrl}` : sourceTitle || sourceUrl}</Text>
                </Pressable>
              ) : null}
            </>
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
  dock: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: space.md, marginHorizontal: DOCK_EDGE_INSET, flexWrap: 'nowrap' },
  iconWrap: { alignItems: 'center', width: ICON_WRAP },
  slotSpacer: { width: ICON_WRAP }, // holds a HIDDEN bucket's slot so space-between keeps five even columns
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
  cardScroll: { marginTop: space.sm },
  sourceBtn: { minHeight: hit.min, justifyContent: 'center', alignSelf: 'flex-start', marginTop: space.xs },
  proof: { marginTop: space.xs, gap: space.xs },
  factChip: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  playBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm, marginTop: space.md },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg, flexWrap: 'wrap' },
  tab: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
})
