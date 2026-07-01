/**
 * The confidence chip (testids.reveal.confidenceChip) — its TREATMENT changes by band (PLAN §10.2 §5 / D5):
 * solid for CONFIDENT, warm-gold "confident maybe" for PROBABLE, neutral for UNKNOWN. Carries `chip.band` so
 * E2E asserts the band, and uses the shared register copy (packages/shared confidence.registerFor mirror).
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { ids, tidWith } from '../lib/testid'
import { bands, onColorInk, radius, space, type as typeTokens } from '../lib/theme'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'

export function ConfidenceChip({ band }: { band: ConfidenceBand }): React.ReactElement {
  const meta = bands[band]
  const filled = band === 'CONFIDENT'
  return (
    <View
      {...tidWith(ids.reveal.confidenceChip, { band })}
      style={[
        styles.chip,
        { borderColor: meta.color, backgroundColor: filled ? meta.color : 'transparent' },
      ]}
    >
      <Text style={[styles.label, { color: filled ? onColorInk : meta.color }]}>{meta.label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  label: { fontFamily: typeTokens.family.sans['600'], fontSize: typeTokens.size.sm },
})
