/**
 * RevealMoreMenu — the ⋯ overflow's bottom ACTION SHEET on a cataloged item (mirrors the RevealDock morph card:
 * scrim + bottom-flush GlassFill sheet, JS-driven `Animated`, lucide-only icons, reduce-motion aware). Two actions:
 * Regenerate (re-run identification) and Delete (destructive, LAST per convention). Delete is a TWO-STEP flow — this
 * sheet only expresses intent; the destructive commit happens in a separate ConfirmDialog the parent opens.
 *
 * Rows are 44pt leaf Pressables (Maestro `id:` resolves on leaves, not the wrapping sheet). Rendered only while
 * `visible`; the parent unmounts it to dismiss (enter-only animation, like BucketCard).
 */
import React, { useEffect, useRef } from 'react'
import { View, Text, Pressable, Animated, StyleSheet, type ViewStyle } from 'react-native'
import { RotateCw, Trash2 } from 'lucide-react-native'
import { GlassFill } from './GlassFill'
import { ids, tid } from '../lib/testid'
import { radius, space, typeStyles, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

// Bottom-flush sheet: round ONLY the top corners (the bottom sits on the screen edge), matching the dock card.
const SHEET_RADIUS: ViewStyle = { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
const SHEET_SCRIM = 'rgba(20,18,14,0.55)' // same depth as the dock morph card so the glass doesn't bleed the photo

export function RevealMoreMenu({
  visible,
  onRegenerate,
  onDelete,
  onClose,
  reduceMotion,
  surface,
}: {
  visible: boolean
  onRegenerate: () => void
  onDelete: () => void
  onClose: () => void
  reduceMotion: boolean
  surface: Surface
}): React.ReactElement | null {
  const enter = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current
  useEffect(() => {
    if (!visible) return
    if (reduceMotion) { enter.setValue(1); return }
    enter.setValue(0)
    Animated.timing(enter, { toValue: 1, duration: 200, useNativeDriver: false }).start()
  }, [visible, reduceMotion, enter])
  if (!visible) return null

  const sheetStyle = {
    opacity: enter,
    transform: reduceMotion ? [] : [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
  }

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <Pressable {...tid(ids.reveal.moreMenuScrim, 'Close menu')} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: SHEET_SCRIM }]} />
      <Animated.View {...tid(ids.reveal.moreMenu)} style={[styles.sheet, shadow, sheetStyle]}>
        <GlassFill strong radiusStyle={SHEET_RADIUS} />
        <Pressable
          {...tid(ids.reveal.menuRegenerate, 'Regenerate')}
          accessibilityRole="button"
          onPress={onRegenerate}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <RotateCw size={22} color={surface.text} strokeWidth={2} />
          <Text style={[typeStyles.body, { color: surface.text }]}>Regenerate</Text>
        </Pressable>
        <View style={[styles.divider, { backgroundColor: surface.border }]} />
        <Pressable
          {...tid(ids.reveal.menuDelete, 'Delete')}
          accessibilityRole="button"
          onPress={onDelete}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Trash2 size={22} color={surface.danger} strokeWidth={2} />
          <Text style={[typeStyles.body, { color: surface.danger }]}>Delete</Text>
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 30 },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: space.md },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
})
