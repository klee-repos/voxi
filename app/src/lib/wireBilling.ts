/**
 * Default (web / non-native / esbuild-converge) billing wiring — a NO-OP. Subscriptions are a native-only
 * StoreKit 2 concern; on web/E2E the deterministic `purchases` stub is used. Keeping this the default resolution
 * guarantees `expo-iap` never enters the web/converge bundle (esbuild has no RN platform resolution). Metro
 * overrides this with `wireBilling.native.ts` on device.
 */
import type { ApiClient } from './apiClient'

export function wireBilling(_client: ApiClient): void {
  /* no-op on web / non-native */
}
