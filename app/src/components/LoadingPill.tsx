/**
 * The ONE loading pill — a narrator Orb + a status line (+ an optional footnote) in a dark-glass pill over a
 * photo (or the cream surface). Shared by the processing screen, the reveal's transient `!band` state, and the
 * camera's swipe-open beat, so their loaders can NEVER drift on font / size / shape (they were duplicated inline
 * and drifted — this is the single source of truth). Bottom-anchored POSITIONING is the caller's (each screen
 * provides its own wrap with the right `paddingBottom`); this component is only the pill itself.
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Orb } from './Orb'
import { ids, tid, tidWith } from '../lib/testid'
import { radius, space, typeStyles } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { OrbState } from '../lib/pipecat'

export function LoadingPill({
  text,
  ack,
  orbState = 'thinking',
  onImage = true,
  textTestId,
  textData,
  ackTestId,
}: {
  /** the primary status line (headline size). */
  text: string
  /** an optional secondary footnote under it (e.g. the long-wait ack, or the reveal's sublede). */
  ack?: string
  orbState?: OrbState
  /** true = dark glass + light text (over a photo); false = the cream surface + dark text. */
  onImage?: boolean
  /** carry a testId on the status line (+ optional `data-*`) so a screen keeps its E2E contract. */
  textTestId?: string
  textData?: Record<string, string>
  ackTestId?: string
}): React.ReactElement {
  const { surface } = useTheme()
  const pillText = onImage ? '#FFFFFF' : surface.text
  const pillSub = onImage ? 'rgba(255,255,255,0.75)' : surface.textMuted
  const textProps = textTestId ? (textData ? tidWith(textTestId, textData) : tid(textTestId)) : {}
  return (
    <View style={[styles.pill, { backgroundColor: onImage ? 'rgba(20,18,14,0.62)' : surface.surface }]}>
      <Orb id={ids.processing.orb} state={orbState} size={34} />
      <View accessibilityLiveRegion="polite" style={styles.text}>
        <Text {...textProps} style={[typeStyles.headline, { color: pillText }]}>{text}</Text>
        {ack ? (
          <Text {...(ackTestId ? tid(ackTestId) : {})} style={[typeStyles.footnote, { color: pillSub, marginTop: 2 }]}>{ack}</Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.sm, paddingRight: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, maxWidth: '100%' },
  text: { flexShrink: 1 },
})
