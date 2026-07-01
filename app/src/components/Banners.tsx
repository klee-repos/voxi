/**
 * Cross-screen status banners (testids.global.*).
 *
 * `OfflineBanner` shows when connectivity drops (the global.offlineBanner contract id). `SafetyRefusal` is the
 * deterministic non-identifying refusal surface (PLAN §8.4) — it MUST read visually distinct from a confidence
 * chip (a separate, calm museum-warm treatment), and carries testids.global.safetyRefusal.
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { ids, tid } from '../lib/testid'
import { radius, space, type as typeTokens } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

export function OfflineBanner({ visible }: { visible: boolean }): React.ReactElement | null {
  const { surface } = useTheme()
  if (!visible) return null
  return (
    <View {...tid(ids.global.offlineBanner)} style={[styles.bar, { backgroundColor: surface.offline }]}>
      <Text style={[styles.text, { color: surface.onAccent }]}>You're offline. The Guide will reconnect when you are.</Text>
    </View>
  )
}

export function SafetyRefusal({ visible, message }: { visible: boolean; message?: string }): React.ReactElement | null {
  const { surface } = useTheme()
  if (!visible) return null
  return (
    <View
      {...tid(ids.global.safetyRefusal)}
      accessibilityRole="alert"
      style={[styles.refusal, { borderColor: surface.danger, backgroundColor: surface.surface }]}
    >
      <Text style={[styles.refusalText, { color: surface.text }]}>
        {message ?? "I'd rather not weigh in on that one. The Guide identifies objects, not people, and steers clear of a few categories by design."}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  text: { fontFamily: typeTokens.sans, fontSize: typeTokens.size.sm },
  refusal: { borderWidth: 1.5, borderRadius: radius.md, padding: space.lg, marginVertical: space.md },
  refusalText: { fontFamily: typeTokens.family.sans['500'], fontSize: typeTokens.size.base, lineHeight: typeTokens.size.base * 1.4 },
})
