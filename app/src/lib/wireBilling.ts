/**
 * Default (web / non-native) billing wiring — a NO-OP; the deterministic `purchases` stub is used instead.
 * Keeps `expo-iap` out of the web/converge bundle. Metro overrides this with `wireBilling.native.ts` on device.
 */
import type { ApiClient } from './apiClient'

export function wireBilling(_client: ApiClient): void {
  /* no-op on web / non-native */
}
