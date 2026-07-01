/**
 * Tray — a slide-up bottom sheet (grab handle + rounded top + scrim) that holds the "Recently catalogued"
 * carousel on the camera home. Opened by an icon button (`camera.recentToggle`); tapping the scrim or the X
 * closes it. RN `Animated` (JS-driven, web+native parity), reduce-motion → quick fade.
 *
 * Safe-area: the camera is a full-bleed screen whose live feed reaches the PHYSICAL bottom, so the sheet must
 * too — otherwise the feed shows in the home-indicator strip below the sheet. It extends `bottom: -insets.bottom`
 * to the physical edge and pads its content up by the inset so nothing sits under the indicator.
 */
import React, { useEffect, useRef } from 'react'
import { View, Animated, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { RecentlyIdentified } from './RecentlyIdentified'
import { ids, tid } from '../lib/testid'
import { radius, space, scrim as scrimColor, shadow, motion } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { ThreadSummary } from '../lib/apiClient'

const SHEET_H = 300

export function Tray({
  open,
  onClose,
  threads,
  isLoading,
  isError,
  onRetry,
  onOpen,
  onSeeAll,
}: {
  open: boolean
  onClose: () => void
  threads: ThreadSummary[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  onOpen: (threadId: string) => void
  onSeeAll: () => void
}): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  const insets = useSafeAreaInsets()
  const fullH = SHEET_H + insets.bottom
  const y = useRef(new Animated.Value(fullH)).current

  useEffect(() => {
    Animated.timing(y, {
      toValue: open ? 0 : fullH,
      duration: reduceMotion ? motion.fast : motion.base,
      useNativeDriver: false,
    }).start()
  }, [open, reduceMotion, y, fullH])

  const scrimOpacity = y.interpolate({ inputRange: [0, fullH], outputRange: [1, 0] })

  return (
    <>
      <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrimOpacity }]}>
        <Pressable {...tid(ids.camera.recentClose, 'Close recent')} accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { height: fullH, bottom: -insets.bottom, paddingBottom: insets.bottom + space.md, backgroundColor: surface.surface, transform: [{ translateY: y }] },
          shadow,
        ]}
      >
        <View style={styles.handle} />
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.x}>
          <X size={22} color={surface.textMuted} strokeWidth={2} />
        </Pressable>
        <RecentlyIdentified threads={threads} isLoading={isLoading} isError={isError} onRetry={onRetry} onOpen={onOpen} onSeeAll={onSeeAll} />
      </Animated.View>
    </>
  )
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: scrimColor, zIndex: 20 },
  sheet: { position: 'absolute', left: 0, right: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.sm, zIndex: 21 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', marginBottom: space.md },
  x: { position: 'absolute', top: space.sm, right: space.md, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
})
