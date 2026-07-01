/**
 * Device (native) billing wiring — Metro resolves THIS over `wireBilling.ts` on iOS. It installs the real
 * StoreKit 2 seam (`expo-iap`) carrying the ApiClient's authenticated server verifier, so a purchase's signed
 * transaction is verified by the BFF (no billing vendor). Only imported on native, so the web/converge bundle
 * never pulls `expo-iap`.
 */
import type { ApiClient } from './apiClient'
import { setPurchasesSeam } from './purchases'
// NB: import from './storekit', NOT './purchases.native' — Metro treats a trailing `.native` as a platform
// suffix and would resolve `./purchases` instead, silently dropping createNativePurchases (undefined at runtime).
import { createNativePurchases } from './storekit'

export function wireBilling(client: ApiClient): void {
  setPurchasesSeam(createNativePurchases((jws) => client.verifyPurchase(jws)))
}
