/**
 * Scrubber — the Deep Dive player's seekable progress bar (Spotify-podcast pattern): a filled track + round thumb,
 * elapsed clock left, remaining clock right. Tap-and-drag-to-seek runs through ONE PanResponder on a plain View:
 * its responder events carry a `locationX` (touch x relative to the track) on BOTH native and react-native-web, so
 * a tap or drag maps to an absolute seek. (An earlier build put the pan on a `Pressable`; on RNW the Pressable owns
 * the responder, so the pan never engaged and every tap fell back to mid-track — the "scrubber only jumps to the
 * middle" web bug. A plain View lets the pan engage identically on both platforms.) All JS-`Animated`-free → converge-safe.
 */
import React, { useRef } from 'react'
import { View, Text, PanResponder, StyleSheet, type GestureResponderEvent } from 'react-native'
import { ids, tid, tidWith } from '../lib/testid'
import { space, radius, typeStyles, hit } from '../lib/theme'
import { formatClock, seekTargetSeconds } from '../lib/composeProgress'
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
  const widthRef = useRef(0)
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? Math.min(positionSec, dur || positionSec) : 0
  const frac = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0
  const remaining = dur > 0 ? Math.max(0, dur - pos) : 0

  // The scrubber's live duration changes across renders; keep the pan reading the CURRENT value via a ref so a
  // long-lived PanResponder never closes over a stale duration of 0 (which would silently drop every seek).
  const durRef = useRef(dur)
  durRef.current = dur
  const seekToX = (x: number): void => {
    const secs = seekTargetSeconds(x, widthRef.current, durRef.current)
    if (secs !== null) onSeek(secs)
  }

  // Tap + drag on a plain View: the responder event carries locationX (relative to the track) on native AND
  // react-native-web. Tap = grant→release with no move; drag = the move stream. One code path, both platforms.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => seekToX(e.nativeEvent.locationX),
      onPanResponderMove: (e: GestureResponderEvent) => seekToX(e.nativeEvent.locationX),
      onPanResponderRelease: (e: GestureResponderEvent) => seekToX(e.nativeEvent.locationX),
    }),
  ).current

  return (
    <View style={styles.wrap}>
      <View
        {...tidWith(ids.podcast.scrubber, { fraction: frac.toFixed(3) }, 'Seek')}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(frac * 100) }}
        onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width }}
        hitSlop={{ top: 12, bottom: 12 }}
        style={styles.hitArea}
        {...pan.panHandlers}
      >
        <View style={[styles.track, { backgroundColor: surface.border }]}>
          <View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: surface.text }]} />
        </View>
        <View style={[styles.thumb, { left: `${frac * 100}%`, backgroundColor: surface.text }]} />
      </View>
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
