/**
 * Connectivity seam (PLAN §10.2 state matrix — every screen specifies an `offline` state).
 *
 * On web (the E2E harness) this reflects `navigator.onLine` and the `online`/`offline` window events, so the
 * `global.offlineBanner` surface appears the instant connectivity drops. On native there is no `navigator`, so
 * the hook reports "online" by default and screens fall back to treating a network/stream failure as offline
 * (the same belt-and-suspenders the processing screen already uses). A real build swaps in `@react-native-
 * community/netinfo` behind this exact hook — a drop-in, no screen changes.
 */
import { useEffect, useState } from 'react'

type NavigatorLike = { onLine?: boolean }
type WindowLike = {
  addEventListener?: (t: string, cb: () => void) => void
  removeEventListener?: (t: string, cb: () => void) => void
}

function currentOnline(): boolean {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator
  // navigator.onLine is web-only; absent (native) → assume online and let API failures drive the banner.
  return typeof nav?.onLine === 'boolean' ? nav.onLine : true
}

/**
 * `true` while the device reports no connectivity. Web-accurate; native-safe default. `force` lets a screen
 * OR-in an active signal (e.g. a fetch that threw a network error) so a single banner reflects both passive
 * (navigator) and active (failed request) connectivity loss without a second mechanism.
 */
export function useOffline(force?: boolean): boolean {
  const [offline, setOffline] = useState(() => !currentOnline())

  useEffect(() => {
    const win = (globalThis as { window?: WindowLike }).window
    if (!win?.addEventListener) return
    const sync = (): void => setOffline(!currentOnline())
    win.addEventListener('online', sync)
    win.addEventListener('offline', sync)
    sync()
    return () => {
      win.removeEventListener?.('online', sync)
      win.removeEventListener?.('offline', sync)
    }
  }, [])

  return force === true || offline
}

/**
 * Classifies a thrown error as a connectivity loss (vs an application/HTTP error). Network failures surface as
 * a `TypeError` ("Failed to fetch" / "Network request failed") from fetch; an `ApiError` (an HTTP status) is
 * NOT offline. Screens use this to choose between the offline banner and an in-persona error block, and to
 * decide whether a failed query should be treated as a connectivity drop.
 */
export function isOfflineError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof TypeError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /network|failed to fetch|offline|connection|timed out|timeout/i.test(msg)
}
