/**
 * Theme context — exposes the active surface, the static tokens, and a reduce-motion flag (PLAN §10.3) that
 * screens read to swap particle sequences for cross-fades.
 *
 * The default surface is the warm PARCHMENT (cream) — light everywhere, no dark fallback. `dark` survives only
 * for the token/AA tests.
 */
import React, { createContext, useContext, useMemo, useState } from 'react'
import { dark, parchment, theme, type Surface } from './theme'

interface ThemeCtx {
  surface: Surface
  t: typeof theme
  reduceMotion: boolean
  setReduceMotion: (v: boolean) => void
  /**
   * "Speak results aloud" (ANALYSIS-VOICE-PLAN A13). A dedicated AUDIO preference — NOT reduce-motion (a motion
   * signal) — that gates whether the reveal auto-speaks. Default ON to honour "results should be spoken", but a
   * user in a shop can turn it off in Settings; the reveal's play orb is always the manual play/stop control.
   */
  speakAloud: boolean
  setSpeakAloud: (v: boolean) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [reduceMotion, setReduceMotion] = useState(false)
  const [speakAloud, setSpeakAloud] = useState(true)
  // The OS reduce-motion sync (PLAN §10.3) is mounted as <ReduceMotionBridge/> in _layout.tsx (inside this
  // provider) so it can call setReduceMotion via the context; the Settings toggle still overrides it.
  const value = useMemo<ThemeCtx>(
    () => ({ surface: parchment, t: theme, reduceMotion, setReduceMotion, speakAloud, setSpeakAloud }),
    [reduceMotion, speakAloud],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Override the active surface for a subtree (the reveal card + podcast read-along use parchment). */
export function SurfaceProvider({
  surface,
  children,
}: {
  surface: 'dark' | 'parchment'
  children: React.ReactNode
}): React.ReactElement {
  const parent = useTheme()
  const value = useMemo<ThemeCtx>(
    () => ({ ...parent, surface: surface === 'parchment' ? parchment : dark }),
    [parent, surface],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}
