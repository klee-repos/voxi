/**
 * PulseRings — three staggered concentric hairline rings that expand and fade around the narrator Orb.
 * Decorative (hidden from AT). RN `Animated` (`useNativeDriver:false`) so it renders identically web + native.
 * Reduce-motion / inactive → two STATIC hairlines, no pulse. Container carries `processing.rings`.
 */
import React, { useEffect, useRef } from 'react'
import { View, Animated, StyleSheet } from 'react-native'
import { ids, tid } from '../lib/testid'

export function PulseRings({
  active,
  reduceMotion,
  color,
  size = 240,
  children,
}: {
  active: boolean
  reduceMotion: boolean
  color: string
  size?: number
  children?: React.ReactNode
}): React.ReactElement {
  const a0 = useRef(new Animated.Value(0)).current
  const a1 = useRef(new Animated.Value(0)).current
  const a2 = useRef(new Animated.Value(0)).current
  const anims = [a0, a1, a2]
  const bases = [0.35, 0.12, 0.05]

  const still = reduceMotion || !active

  useEffect(() => {
    if (still) {
      anims.forEach((a) => {
        a.stopAnimation()
        a.setValue(0)
      })
      return
    }
    const loops = anims.map((a, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 500),
          Animated.timing(a, { toValue: 1, duration: 2000, useNativeDriver: false }),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still])

  return (
    <View
      {...tid(ids.processing.rings)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={[styles.wrap, { width: size, height: size }]}
    >
      {still ? (
        <>
          <View style={[styles.ring, { width: size * 0.55, height: size * 0.55, borderRadius: size * 0.275, borderColor: color, opacity: 0.35 }]} />
          <View style={[styles.ring, { width: size * 0.8, height: size * 0.8, borderRadius: size * 0.4, borderColor: color, opacity: 0.12 }]} />
        </>
      ) : (
        anims.map((a, i) => (
          <Animated.View
            key={i}
            style={[
              styles.ring,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
                borderColor: color,
                opacity: a.interpolate({ inputRange: [0, 1], outputRange: [bases[i] ?? 0.1, 0] }),
                transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }],
              },
            ]}
          />
        ))
      )}
      <View>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderWidth: 1.5, backgroundColor: 'transparent' },
})
