/**
 * KaraokeTranscript — the Deep Dive player's HERO: the two-voice read-along as LARGE bold text, with WORD-LEVEL
 * highlight synced to the playhead (Spotify-podcast pattern the user referenced). Spoken words are bright, the
 * CURRENT word sits in a filled highlight box, upcoming words are dimmed. The current line auto-scrolls to a
 * stable anchor.
 *
 * There is no server word-timing (the transcript is `{speaker,text}[]`), so timings are the client-side
 * proportional estimate (`karaokeTiming.ts`) calibrated to the real audio duration — or, until metadata loads /
 * if the duration is unusable, a word-count fallback so the highlight still tracks. A hidden `activeWordIndex`
 * anchor exposes the monotonic active index so the E2E can prove the highlight COUPLES to playback (not hardcoded).
 *
 * Colors (design.md dark + G-A3 AA): text is mist100 (never the pastel speaker colors — the speaker rides a small
 * dot + a11y label). Active word = mist100 bold in a translucent-green box (bright text stays AA over the box);
 * spoken = mist100; upcoming = mist300 (the muted token, still AA). All JS-`Animated`-free → converge-safe.
 */
import React, { useMemo, useRef, useEffect } from 'react'
import { View, Text, ScrollView, StyleSheet, type LayoutChangeEvent } from 'react-native'
import { ids, tid, tidWith } from '../lib/testid'
import { space, speakers, type as typeTokens } from '../lib/theme'
import { computeWordTimings, activeWordIndex, splitWords } from '../lib/karaokeTiming'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']
type Line = { speaker: 'ARLO' | 'MAVE'; text: string }

/** Average spoken-word duration (s) — the fallback when the audio's real duration isn't usable yet, so the
 *  highlight still advances during the metadata-load gap. Overridden by the real duration the moment it arrives. */
const FALLBACK_SEC_PER_WORD = 0.4

export function KaraokeTranscript({
  transcript,
  positionSec,
  durationSec,
  surface,
  reduceMotion,
}: {
  transcript: Line[]
  positionSec: number
  durationSec: number
  surface: Surface
  reduceMotion: boolean
}): React.ReactElement {
  // Per-line words + their GLOBAL index (the same order karaokeTiming tokenizes, so index i ↔ timings[i]).
  const lines = useMemo(() => {
    let gi = 0
    return transcript.map((l) => ({
      speaker: l.speaker,
      words: splitWords(l.text).map((text) => ({ text, gi: gi++ })),
    }))
  }, [transcript])
  const totalWords = useMemo(() => lines.reduce((n, l) => n + l.words.length, 0), [lines])

  const effectiveDuration =
    Number.isFinite(durationSec) && durationSec > 1 ? durationSec : totalWords * FALLBACK_SEC_PER_WORD
  const timings = useMemo(() => computeWordTimings(transcript, effectiveDuration), [transcript, effectiveDuration])
  const active = activeWordIndex(positionSec, timings)
  const activeLine = active >= 0 && timings[active] ? timings[active]!.line : -1

  // Auto-scroll the active line to a stable anchor near the top (kept simple + guarded — the E2E reads the
  // active-index attr, never scroll position, so a scroll hiccup can never fail the proof).
  const scrollRef = useRef<ScrollView>(null)
  const lineY = useRef<number[]>([])
  useEffect(() => {
    if (activeLine < 0) return
    const y = lineY.current[activeLine]
    if (y === undefined) return
    scrollRef.current?.scrollTo({ y: Math.max(0, y - ANCHOR), animated: !reduceMotion })
  }, [activeLine, reduceMotion])

  const onLineLayout = (i: number) => (e: LayoutChangeEvent) => { lineY.current[i] = e.nativeEvent.layout.y }

  return (
    <>
      {/* hidden coupling anchor: the current global word index (E2E asserts it advances with the playhead). */}
      <View {...tidWith(ids.podcast.activeWordIndex, { idx: String(active) })} style={styles.srOnly} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {lines.map((l, i) => (
          <View
            key={i}
            {...tidWith(ids.podcast.transcriptLine, { speaker: l.speaker, active: String(i === activeLine) }, `${speakers[l.speaker].name}: ${transcript[i]!.text}`)}
            onLayout={onLineLayout(i)}
            style={styles.lineRow}
          >
            <View style={[styles.speakerDot, { backgroundColor: speakers[l.speaker].color }]} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={styles.lineText} allowFontScaling>
              {l.words.map((w, wi) => {
                const isActive = w.gi === active
                const isFuture = active >= 0 && w.gi > active
                const color = isFuture ? surface.textMuted : surface.text
                return (
                  <Text
                    key={wi}
                    style={[
                      styles.word,
                      { color, fontFamily: isActive ? typeTokens.family.sans['800'] : typeTokens.family.sans['700'] },
                      isActive ? styles.activeWord : null,
                    ]}
                  >
                    {w.text}
                    {wi < l.words.length - 1 ? ' ' : ''}
                  </Text>
                )
              })}
            </Text>
          </View>
        ))}
      </ScrollView>
    </>
  )
}

const ANCHOR = 96 // px from the top the active line settles to
const styles = StyleSheet.create({
  srOnly: { position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 },
  scroll: { flex: 1 },
  content: { paddingBottom: space.xxl },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: space.lg },
  speakerDot: { width: 10, height: 10, borderRadius: 5, marginTop: 12, marginRight: space.md },
  lineText: { flex: 1, fontSize: 26, lineHeight: 34, letterSpacing: -0.2 },
  word: { fontSize: 26, lineHeight: 34 },
  // bright text over a translucent green box → the "current word" cue while keeping AA (design.md green = audio lane)
  activeWord: { backgroundColor: 'rgba(41,171,96,0.38)' },
})
