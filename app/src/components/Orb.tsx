/**
 * The Orb — Voxi's one persistent character: the AI narrator / Guide (PLAN §10.1 / D3).
 *
 * Design: an aurora sphere — green HOT CORE → blue halo, on design.md's palette. The composition is a stack of
 * concentric filled circles; EVERY layer carries a same-color blurred shadow-glow (box-shadow on web / blur on
 * native) so its edge feathers into the next — that airbrush blending turns discrete discs into one smooth radial
 * falloff instead of visible rings. Plain `Animated.View`s on RN's JS-driven `Animated` (`useNativeDriver:false`)
 * → renders IDENTICALLY web + native, converge/E2E safe.
 *
 * It reflects the 5 states (idle/listening/thinking/speaking/uncertain) and CARRIES `orb.state` via `tidWith`
 * (dataSet on web, accessibilityValue on native) so E2E and VoiceOver can read it. Reduce-motion keeps the orb
 * alive but swaps the size pulse for an opacity-only cross-fade (vestibular-safe), per PLAN §10.3. Pass the
 * matching id so each screen's orb is locatable.
 */
import React, { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native'
import { tidWith } from '../lib/testid'
import { orbPalette } from '../lib/theme'
import { useTheme } from '../lib/themeProvider'
import type { OrbState } from '../lib/pipecat'

export interface OrbProps {
  id: string
  state?: OrbState
  size?: number
  style?: ViewStyle
}

/**
 * Per-state motion + brightness. `period` = full breathe cycle (ms); `amp` = breathe scale delta; `shimmer` =
 * how much the core brightens at the top of the breath; `overall` = whole-orb opacity (uncertain dims). Values
 * are intentionally restrained — calm, clearly alive, never gimmicky (design.md's quiet, low-chrome ethos).
 */
interface OrbAnim {
  period: number // full breathe cycle (ms)
  scaleAmp: number // sphere scale delta (0.08 → sphere grows 8%)
  bloomAmp: number // halo scale SWING (0.24 → halo pulses between −12% and +12%) — the most visible cue
  coreBase: number // resting core brightness
  shimmer: number // how much brighter the core throbs at peak
  bloomBase: number // resting halo opacity
  overall: number // whole-orb opacity (uncertain dims)
}

const ANIM: Record<OrbState, OrbAnim> = {
  // resting presence — slow breath
  idle: { period: 2800, scaleAmp: 0.07, bloomAmp: 0.24, coreBase: 0.82, shimmer: 0.2, bloomBase: 0.17, overall: 1 },
  // attentive — faster, brighter pulse
  listening: { period: 1350, scaleAmp: 0.1, bloomAmp: 0.3, coreBase: 1.0, shimmer: 0.18, bloomBase: 0.22, overall: 1 },
  // working — quick breath + strong core shimmer
  thinking: { period: 1500, scaleAmp: 0.06, bloomAmp: 0.2, coreBase: 0.76, shimmer: 0.4, bloomBase: 0.18, overall: 0.96 },
  // emotive speech — fast bursts, brightest core
  speaking: { period: 820, scaleAmp: 0.13, bloomAmp: 0.34, coreBase: 1.0, shimmer: 0.34, bloomBase: 0.24, overall: 1 },
  // hesitant — slow, dim, quiet halo
  uncertain: { period: 4600, scaleAmp: 0.04, bloomAmp: 0.12, coreBase: 0.6, shimmer: 0.1, bloomBase: 0.1, overall: 0.5 },
}

export function Orb({ id, state = 'idle', size = 120, style }: OrbProps): React.ReactElement {
  const { reduceMotion } = useTheme()
  const cfg = ANIM[state]
  const breathe = useRef(new Animated.Value(0)).current
  const big = size >= 48 // below this (e.g. the 34px status pills) drop the fine detail so it stays clean
  // The breathe loop ALWAYS runs. Reduce-motion doesn't kill it — it swaps the size pulse for a gentle
  // opacity-only cross-fade (vestibular-safe, no scaling/movement), so the orb stays alive per PLAN §10.3.
  const period = reduceMotion ? 3600 : cfg.period

  useEffect(() => {
    breathe.setValue(0)
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: period / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(breathe, { toValue: 0, duration: period / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [breathe, period])

  // derived animated values. Under reduce-motion the scale swings collapse to 1 (no movement) while the
  // brightness/opacity cross-fade keeps breathing — a calm, motion-sick-safe glow.
  const sphereScale = breathe.interpolate({ inputRange: [0, 1], outputRange: reduceMotion ? [1, 1] : [1, 1 + cfg.scaleAmp] })
  const bloomScale = breathe.interpolate({ inputRange: [0, 1], outputRange: reduceMotion ? [1, 1] : [1 - cfg.bloomAmp / 2, 1 + cfg.bloomAmp / 2] })
  const coreOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: [cfg.coreBase, Math.min(1, cfg.coreBase + (reduceMotion ? Math.min(cfg.shimmer, 0.16) : cfg.shimmer))] })
  const bloomOpacity = breathe.interpolate({ inputRange: [0, 1], outputRange: reduceMotion ? [cfg.bloomBase * 0.82, cfg.bloomBase * 1.12] : [cfg.bloomBase * 0.7, cfg.bloomBase * 1.3] })

  // layer diameter as a fraction of `size` (concentric, centered → radial ramp)
  const d = (f: number) => ({ width: size * f, height: size * f, borderRadius: (size * f) / 2 })
  // same-color blurred glow that feathers a layer's hard circle edge into its neighbours (the smoothing trick)
  const feather = (color: string, rFrac: number, op = 0.9) => ({
    shadowColor: color,
    shadowOpacity: op,
    shadowRadius: size * rFrac,
    shadowOffset: { width: 0, height: 0 },
  })

  return (
    <View
      {...tidWith(id, { state })}
      accessibilityRole="image"
      style={[styles.wrap, { width: size, height: size }, style]}
    >
      <View style={[StyleSheet.absoluteFill, styles.center, { opacity: cfg.overall }]}>
        {/* bloom halo — faint blue disc + wide blurred glow; visibly pulses (scale + opacity) = the "alive" cue */}
        <Animated.View
          style={[styles.layer, d(1), { backgroundColor: orbPalette.glow, opacity: bloomOpacity, transform: [{ scale: bloomScale }] }, feather(orbPalette.glow, 0.3, Math.min(0.8, cfg.bloomBase * 4))]}
        />
        {/* blue rim — the cool emitted-light halo, feathered so it's a glow, not a ring */}
        <View style={[styles.layer, d(0.8), { backgroundColor: orbPalette.blue, opacity: 0.4 }, feather(orbPalette.blue, 0.12)]} />

        {/* the sphere itself — body + inner glow + hot core + glint, breathing together */}
        <Animated.View style={[styles.layer, styles.center, d(1), { transform: [{ scale: sphereScale }] }]}>
          <View style={[styles.layer, d(0.66), { backgroundColor: orbPalette.green, opacity: 0.95 }, feather(orbPalette.green, 0.11)]} />
          <View style={[styles.layer, d(0.46), { backgroundColor: orbPalette.greenSoft, opacity: 0.95 }, feather(orbPalette.greenSoft, 0.06)]} />
          <Animated.View style={[styles.layer, d(0.27), { backgroundColor: orbPalette.core, opacity: coreOpacity }, feather(orbPalette.core, 0.11)]} />
          {big ? (
            // specular glint (upper-left) → a glossy-sphere reflection, kept small/high so it reads as a
            // highlight, not a pupil
            <View style={[styles.layer, d(0.09), { position: 'absolute', top: size * 0.3, left: size * 0.35, backgroundColor: '#FFFFFF', opacity: 0.42 }]} />
          ) : null}
        </Animated.View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  layer: { position: 'absolute' },
})
