/**
 * ConfirmDialog — a centered, scrim-backed decision surface (the SECOND step of a two-step destructive flow, and the
 * regenerate confirm). Deliberately a SOLID card (not glass) so the warning + the destructive action read at full
 * legibility over the reveal's bright photo. Cancel is the low-emphasis default (left); confirm is a filled pill
 * (accent, or `danger` terracotta when `destructive`). Tapping the scrim cancels. Buttons are 44pt leaf Pressables.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, StyleSheet } from 'react-native'
import { ids, tid } from '../lib/testid'
import { radius, space, typeStyles, hit, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

// A denser scrim than the shared drawer scrim (0.35): a confirm dialog is a modal decision over the bright photo,
// so the backdrop must dim enough to focus on the card + read the destructive warning.
const DIALOG_SCRIM = 'rgba(20,18,14,0.6)'

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
  reduceMotion,
  surface,
  dialogTestId,
  cancelTestId,
  confirmTestId,
}: {
  visible: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  /** disable the buttons while the action is in flight (prevents a double-submit). */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  reduceMotion: boolean
  surface: Surface
  dialogTestId: string
  cancelTestId: string
  confirmTestId: string
}): React.ReactElement | null {
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current
  useEffect(() => {
    if (!visible) return
    if (reduceMotion) { enter.setValue(1); return }
    enter.setValue(0)
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: false }).start()
  }, [visible, reduceMotion, enter])
  if (!visible) return null

  const cardStyle = {
    opacity: enter,
    transform: reduceMotion ? [] : [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
  }
  const confirmBg = destructive ? surface.danger : surface.accent

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable accessibilityLabel="Cancel" onPress={busy ? undefined : onCancel} style={[StyleSheet.absoluteFill, { backgroundColor: DIALOG_SCRIM }]} />
      <Animated.View {...tid(dialogTestId)} style={[styles.card, shadow, { backgroundColor: surface.card }, cardStyle]}>
        <Text accessibilityRole="header" style={[typeStyles.headline, { color: surface.text }]}>{title}</Text>
        <Text style={[typeStyles.body, styles.message, { color: surface.textMuted }]}>{message}</Text>
        <View style={styles.actions}>
          <Pressable
            {...tid(cancelTestId, cancelLabel)}
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={({ pressed }) => [styles.btn, styles.cancelBtn, { backgroundColor: surface.sunken, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[typeStyles.subhead, { color: surface.text }]}>{cancelLabel}</Text>
          </Pressable>
          <Pressable
            {...tid(confirmTestId, confirmLabel)}
            accessibilityRole="button"
            disabled={busy}
            onPress={onConfirm}
            style={({ pressed }) => [styles.btn, { backgroundColor: confirmBg, opacity: pressed || busy ? 0.7 : 1 }]}
          >
            <Text style={[typeStyles.subhead, { color: surface.onAccent, fontWeight: '700' }]}>{busy ? '…' : confirmLabel}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, zIndex: 40 },
  card: { width: '100%', maxWidth: 360, borderRadius: radius.xl, padding: space.xl },
  message: { marginTop: space.sm, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.xl },
  btn: { flex: 1, minHeight: hit.min, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  cancelBtn: {},
})
