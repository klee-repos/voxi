/**
 * OS reduce-motion sync (PLAN §10.3). Seeds and keeps ThemeProvider's `reduceMotion` flag in sync with the
 * platform accessibility setting, without depending on a native module at import time (the E2E web harness has
 * no AccessibilityInfo). Web reads `prefers-reduced-motion`; native reads `AccessibilityInfo` if present.
 */
import { useEffect } from 'react'

type Setter = (v: boolean) => void

/** Resolves the platform's current reduce-motion preference, defaulting to false when unknowable. */
function queryMedia(): boolean | null {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  return null
}

export function useReducedMotionSync(setReduceMotion: Setter): void {
  useEffect(() => {
    let cancelled = false

    // Web path: prefers-reduced-motion media query + live change listener.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      const apply = () => setReduceMotion(mq.matches)
      apply()
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', apply)
        return () => mq.removeEventListener('change', apply)
      }
      return
    }

    // Native path: AccessibilityInfo, loaded lazily so the web bundle never needs it.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AccessibilityInfo } = require('react-native') as typeof import('react-native')
      if (AccessibilityInfo?.isReduceMotionEnabled) {
        AccessibilityInfo.isReduceMotionEnabled().then((on: boolean) => {
          if (!cancelled) setReduceMotion(on)
        })
        const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on: boolean) =>
          setReduceMotion(on),
        )
        return () => {
          cancelled = true
          sub?.remove?.()
        }
      }
    } catch {
      /* no AccessibilityInfo (harness) — fall back to the media query result, if any */
      const m = queryMedia()
      if (m !== null) setReduceMotion(m)
    }

    return () => {
      cancelled = true
    }
  }, [setReduceMotion])
}
