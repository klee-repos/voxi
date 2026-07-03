/**
 * Scrubber — the Deep Dive player's seekable progress bar (Spotify-podcast pattern): a filled track + round thumb,
 * elapsed clock left, remaining clock right. TAP-TO-SEEK (a Pressable measuring the tap's x over the track width →
 * a fraction → an absolute seek) is the primary, deterministically-testable control (the ±15 buttons cover fine
 * control; a PanResponder drag is a native nicety layered on top). All JS-`Animated`-free (static layout) → converge-safe.
 */
import React, { useRef, useState } from 'react'
import { View, Text, Pressable, PanResponder, StyleSheet, type GestureResponderEvent } from 'react-native'
import { ids, tid, tidWith } from '../lib/testid'
import { space, radius, typeStyles, hit } from '../lib/theme'
import { formatClock } from '../lib/composeProgress'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

export function Scrubber({
  positionSec,
  durationSec,
  onSeek,
  surface,
}: {
  positionSec: number
  durationSec: number
  onSeek: (seconds: number) => void
  surface: Surface
}): React.ReactElement {
  const [width, setWidth] = useState(0)
  const widthRef = useRef(0)
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? Math.min(positionSec, dur || positionSec) : 0
  const frac = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0
  const remaining = dur > 0 ? Math.max(0, dur - pos) : 0

  const seekToX = (x: number): void => {
    const w = widthRef.current
    if (dur > 0 && w > 0) onSeek(Math.min(dur, Math.max(0, (x / w) * dur)))
  }

  // Drag (native + web): the responder gives locationX relative to the track. Tap is the release with no move.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (e: GestureResponderEvent) => seekToX(e.nativeEvent.locationX),
      onPanResponderRelease: (e: GestureResponderEvent) => seekToX(e.nativeEvent.locationX),
    }),
  ).current

  return (
    <View style={styles.wrap}>
      <Pressable
        {...tidWith(ids.podcast.scrubber, { fraction: frac.toFixed(3) }, 'Seek')}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(frac * 100) }}
        onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; setWidth(e.nativeEvent.layout.width) }}
        onPress={(e) => seekToX(e.nativeEvent.locationX ?? width / 2)}
        hitSlop={{ top: 12, bottom: 12 }}
        style={styles.hitArea}
        {...pan.panHandlers}
      >
        <View style={[styles.track, { backgroundColor: surface.border }]}>
          <View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: surface.text }]} />
        </View>
        <View style={[styles.thumb, { left: `${frac * 100}%`, backgroundColor: surface.text }]} />
      </Pressable>
      <View style={styles.clocks}>
        <Text {...tid(ids.podcast.scrubberElapsed)} style={[typeStyles.caption, { color: surface.textMuted }]}>{formatClock(pos)}</Text>
        <Text {...tid(ids.podcast.scrubberDuration)} style={[typeStyles.caption, { color: surface.textMuted }]}>-{formatClock(remaining)}</Text>
      </View>
    </View>
  )
}

const THUMB = 12
const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch' },
  hitArea: { minHeight: hit.min, justifyContent: 'center' },
  track: { height: 4, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radius.pill },
  // the thumb centers on the fill's right edge; marginLeft pulls it back by half its width so 0%/100% don't clip
  thumb: { position: 'absolute', top: '50%', width: THUMB, height: THUMB, borderRadius: THUMB / 2, marginLeft: -THUMB / 2, marginTop: -THUMB / 2 },
  clocks: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
})
