/**
 * CaptureOrb — the central capture control: a flat green disc + white aperture glyph, no gradient/bloom (that is
 * reserved for the narrator Orb). Carries the `camera.shutter` id. Idle breathing + press-spring via RN
 * `Animated` (converge-safe); reduce-motion freezes to a static disc. Fires a haptic on press.
 */
import React, { useEffect, useRef } from 'react'
import { Animated, Pressable, View, StyleSheet } from 'react-native'
import { Aperture } from 'lucide-react-native'
import { ids, tid } from '../lib/testid'
import { motion, shadow } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import { haptics } from '../lib/haptics'

export function CaptureOrb({
  id = ids.camera.shutter,
  busy,
  onPress,
  size = 96,
}: {
  id?: string
  busy: boolean
  onPress: () => void
  size?: number
}): React.ReactElement {
  const { surface, reduceMotion } = useTheme()
  const breathe = useRef(new Animated.Value(0)).current
  const press = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (reduceMotion || busy) {
      breathe.stopAnimation()
      breathe.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: motion.orbIdle / 2, useNativeDriver: false }),
        Animated.timing(breathe, { toValue: 0, duration: motion.orbIdle / 2, useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [breathe, reduceMotion, busy])

  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, reduceMotion ? 1 : 1.04] })
  const scale = Animated.multiply(press, breatheScale)

  const pressIn = () => Animated.timing(press, { toValue: 0.94, duration: motion.fast, useNativeDriver: false }).start()
  const pressOut = () =>
    Animated.spring(press, { toValue: 1, useNativeDriver: false, damping: motion.spring.damping, stiffness: motion.spring.stiffness }).start()

  const handlePress = () => {
    if (busy) return
    haptics.capture()
    onPress()
  }

  return (
    <Pressable
      {...tid(id, 'Identify object')}
      accessibilityRole="button"
      accessibilityHint="Takes a photo and identifies it"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPressIn={pressIn}
      onPressOut={pressOut}
      onPress={handlePress}
      hitSlop={12}
    >
      <Animated.View
        style={[
          styles.disc,
          shadow,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: busy ? '#238C4F' : surface.accent, transform: [{ scale }] },
        ]}
      >
        <View style={[styles.rim, { width: size - 8, height: size - 8, borderRadius: (size - 8) / 2 }]} />
        <Aperture size={Math.round(size * 0.44)} color="#FFFFFF" strokeWidth={2} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center' },
  rim: { position: 'absolute', borderWidth: 1, borderColor: '#1F8A4C' },
  aperture: { borderWidth: 2, borderColor: '#FFFFFF' },
  dot: { position: 'absolute', backgroundColor: '#FFFFFF' },
})
