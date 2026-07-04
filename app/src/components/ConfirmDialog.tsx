/**
 * ConfirmDialog — a FULL-SCREEN take-over decision surface (the SECOND step of a two-step destructive flow, and the
 * regenerate confirm). Per product direction the confirm fills the entire screen (no small centered card floating
 * over a dimmed grid — that read as weird); a solid `surface.bg` replaces the backdrop so the confirm IS the screen.
 * The title + message sit centered; Cancel + the confirm action are full-width pills stacked at the bottom (above
 * the home indicator). The confirm fill is `destructiveColor` (bulk-delete passes a clear red) or the theme's
 * terracotta danger / accent. Backed by RN `Modal` so it covers the header + status bar too, not just the body.
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, StyleSheet, Modal } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { tid } from '../lib/testid'
import { space, typeStyles, hit } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  destructiveColor,
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
  /** Override the destructive fill (defaults to the theme's terracotta danger). Bulk-delete passes a clear red
   *  here per explicit product direction, without changing the global token (which reveal/refusal/safety share). */
  destructiveColor?: string
  /** disable the buttons while the action is in flight (prevents a double-submit). */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  reduceMotion: boolean
  surface: Surface
  dialogTestId: string
  cancelTestId: string
  confirmTestId: string
}): React.ReactElement {
  const insets = useSafeAreaInsets()
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current
  useEffect(() => {
    if (!visible) return
    if (reduceMotion) { enter.setValue(1); return }
    enter.setValue(0)
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: false }).start()
  }, [visible, reduceMotion, enter])

  const confirmBg = destructive ? (destructiveColor ?? surface.danger) : surface.accent

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={busy ? undefined : onCancel} accessibilityViewIsModal>
      {/* Solid full-screen surface (the confirm IS the screen — no small card over a dimmed grid). Tapping it cancels. */}
      <Pressable accessibilityLabel="Cancel" onPress={busy ? undefined : onCancel} style={[StyleSheet.absoluteFill, { backgroundColor: surface.bg }]} />
      <Animated.View
        {...tid(dialogTestId)}
        style={[styles.sheet, { paddingTop: space.xxxl + insets.top, paddingBottom: space.xxxl + insets.bottom, opacity: enter }]}
      >
        <View style={styles.sheetBody}>
          <Text accessibilityRole="header" style={[typeStyles.heading, { color: surface.text, textAlign: 'center' }]}>{title}</Text>
          <Text style={[typeStyles.body, styles.message, { color: surface.textMuted, textAlign: 'center' }]}>{message}</Text>
        </View>
        <View style={styles.actions}>
          <Pressable
            {...tid(cancelTestId, cancelLabel)}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onCancel}
            style={({ pressed }) => [styles.btn, { backgroundColor: surface.sunken, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[typeStyles.headline, { color: surface.text }]}>{cancelLabel}</Text>
          </Pressable>
          <Pressable
            {...tid(confirmTestId, confirmLabel)}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onConfirm}
            style={({ pressed }) => [styles.btn, { backgroundColor: confirmBg, opacity: pressed || busy ? 0.7 : 1 }]}
          >
            <Text style={[typeStyles.headline, { color: surface.onAccent }]}>{busy ? '…' : confirmLabel}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  // The sheet fills the screen; the title + message center vertically, the actions pin to the bottom (above the
  // safe-area inset, applied inline). Transparent bg — the solid surface comes from the absoluteFill Pressable.
  sheet: { flex: 1, paddingHorizontal: space.xxl },
  sheetBody: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.md },
  message: { lineHeight: 24 },
  actions: { flexDirection: 'column', gap: space.sm },
  btn: { minHeight: hit.min, borderRadius: hit.min, alignItems: 'center', justifyContent: 'center', paddingVertical: space.md, paddingHorizontal: space.xl },
})
