/**
 * PlayerTransport — the Deep Dive player's compact control row (Spotify-for-Creators / Waking Up pattern):
 *   [⟲15]   ( ▶ / ❚❚  big )   [15⟳]
 * The ±15 use the rotate-arrow glyphs with a "15" numeral (no dedicated lucide 15-icon); the center is the large
 * green play/pause (green = the design.md audio lane). Icon-only controls carry real a11y labels. Pure layout —
 * no animation — so it renders identically web + native + converge.
 */
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Play, Pause, RotateCcw, RotateCw } from 'lucide-react-native'
import { ids, tid } from '../lib/testid'
import { space, radius, hit, type as typeTokens } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

/** A ±15 skip control: a rotate-arrow glyph with a small "15" centered inside it. */
function SkipButton({
  id,
  label,
  forward,
  onPress,
  surface,
}: {
  id: string
  label: string
  forward: boolean
  onPress: () => void
  surface: Surface
}): React.ReactElement {
  const Arrow = forward ? RotateCw : RotateCcw
  return (
    <Pressable {...tid(id, label)} accessibilityRole="button" onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.skip, { opacity: pressed ? 0.6 : 1 }]}>
      <Arrow size={40} color={surface.text} strokeWidth={1.6} />
      <Text style={[styles.skipNum, { color: surface.text }]}>15</Text>
    </Pressable>
  )
}

export function PlayerTransport({
  playing,
  onPlayPause,
  onSkipBack,
  onSkipForward,
  surface,
}: {
  playing: boolean
  onPlayPause: () => void
  onSkipBack: () => void
  onSkipForward: () => void
  surface: Surface
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <SkipButton id={ids.podcast.skipBack} label="Back 15 seconds" forward={false} onPress={onSkipBack} surface={surface} />
      <Pressable
        {...tid(ids.podcast.playPause, playing ? 'Pause' : 'Play')}
        accessibilityRole="button"
        onPress={onPlayPause}
        style={({ pressed }) => [styles.play, { backgroundColor: surface.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        {playing ? (
          <Pause size={30} color={surface.onAccent} fill={surface.onAccent} />
        ) : (
          <Play size={30} color={surface.onAccent} fill={surface.onAccent} style={{ marginLeft: 3 }} />
        )}
      </Pressable>
      <SkipButton id={ids.podcast.skip15} label="Forward 15 seconds" forward onPress={onSkipForward} surface={surface} />
    </View>
  )
}

const PLAY = 72
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xxl },
  skip: { width: hit.min, height: hit.min, alignItems: 'center', justifyContent: 'center' },
  // the "15" sits centered inside the rotate arrow (absolute so it doesn't offset the glyph)
  skipNum: { position: 'absolute', fontFamily: typeTokens.family.sans['800'], fontSize: 11 },
  play: { width: PLAY, height: PLAY, borderRadius: PLAY / 2, alignItems: 'center', justifyContent: 'center' },
})
