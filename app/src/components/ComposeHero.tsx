/**
 * ComposeHero — the LARGE "how long is this going to take" surface for the Deep Dive composing wait (make it fun +
 * large + honest, never look stuck). Low-chrome per design.md (no new glows): the existing brand Orb at the centre,
 * a FLAT determinate ring of dots that fills with an HONEST eased estimate (`composeProgress` — never claims 100%
 * until the worker really returns), the literal elapsed clock, and honest copy. It fills the screen height and
 * breathes (no squish); there is deliberately NO spinning satellite (removed on request).
 */
import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Orb } from './Orb'
import { ids, tid } from '../lib/testid'
import { space, typeStyles, type as typeTokens } from '../lib/theme'
import { estimateProgress, formatElapsed } from '../lib/composeProgress'
import { useTheme } from '../lib/themeProvider'

type Surface = ReturnType<typeof useTheme>['surface']

const DOTS = 12
const RING_R = 104 // ring radius (px)
const TYPICAL_MS = 120_000 // ~2 min typical Deep Dive render → the eased-estimate time constant base

export function ComposeHero({
  startedAt,
  title,
  copy,
  surface,
}: {
  /** ms epoch the compose began — the elapsed clock + eased progress derive from this. */
  startedAt: number | null
  title: string
  copy: string
  surface: Surface
  reduceMotion?: boolean
}): React.ReactElement {
  // Tick once a second so the elapsed clock + eased ring advance (no store writes — purely local).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0
  const progress = estimateProgress(elapsed, TYPICAL_MS)
  const filled = Math.round(progress * DOTS)

  return (
    <View {...tid(ids.podcast.progressHero)} style={styles.wrap}>
      <View style={styles.stage}>
        {/* the flat determinate dot ring */}
        {Array.from({ length: DOTS }).map((_, i) => {
          const angle = (i / DOTS) * 2 * Math.PI - Math.PI / 2 // start at top, clockwise
          const left = RING_R + RING_R * Math.cos(angle)
          const top = RING_R + RING_R * Math.sin(angle)
          return (
            <View
              key={i}
              style={[styles.dot, { left, top, backgroundColor: i < filled ? surface.accent : surface.border, opacity: i < filled ? 1 : 0.5 }]}
              aria-hidden
            />
          )
        })}
        {/* the brand Orb at the center */}
        <View style={styles.orbCenter} pointerEvents="none">
          <Orb id={ids.processing.orb} state="thinking" size={128} />
        </View>
      </View>

      <View style={styles.caption}>
        <Text style={[typeStyles.heading, { color: surface.text, textAlign: 'center' }]}>{title}</Text>
        <Text {...tid(ids.podcast.composeElapsed)} style={[styles.elapsed, { color: surface.accent }]}>{formatElapsed(elapsed)}</Text>
        <Text style={[typeStyles.body, { color: surface.textMuted, marginTop: space.md, textAlign: 'center', maxWidth: 320 }]}>{copy}</Text>
      </View>
    </View>
  )
}

const DOT = 9
const styles = StyleSheet.create({
  // fill the whole screen body and spread the hero + caption apart (no squish) — the "use more vertical space" ask
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'space-evenly', paddingVertical: space.xxxl },
  stage: { width: RING_R * 2, height: RING_R * 2, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2, marginLeft: -DOT / 2, marginTop: -DOT / 2 },
  orbCenter: { alignItems: 'center', justifyContent: 'center' },
  caption: { alignItems: 'center', gap: space.sm },
  elapsed: { fontFamily: typeTokens.family.sans['800'], fontSize: 34, marginTop: space.md, fontVariant: ['tabular-nums'] },
})
