/**
 * Connectivity compatibility shim — re-exports `useConnectivity()` (`{ online }`) over the canonical
 * `useOffline` seam, so both shapes resolve to ONE detection mechanism. New code should prefer `useOffline`.
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
