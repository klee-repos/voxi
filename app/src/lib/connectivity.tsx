/**
 * Connectivity compatibility shim → the canonical seam is `useOffline` (src/lib/useOffline.ts).
 *
 * Some screens consume a `useConnectivity()` accessor (`{ online }`); the project standardised on the boolean
 * `useOffline(force?)` hook + `isOfflineError`. This re-exports a thin `useConnectivity` over `useOffline` so
 * both shapes resolve to ONE source of truth (no second detection mechanism, no drift). New code should prefer
 * `useOffline` directly; this exists so existing imports keep working.
 */
import { useOffline } from './useOffline'

export interface Connectivity {
  online: boolean
  offline: boolean
}

/** `{ online, offline }` derived from the canonical useOffline seam. `force` OR-s in an active error signal. */
export function useConnectivity(force?: boolean): Connectivity {
  const offline = useOffline(force)
  return { online: !offline, offline }
}

export { isOfflineError } from './useOffline'
