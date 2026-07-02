/**
 * Device (native) billing wiring — Metro resolves THIS over `wireBilling.ts` on iOS. Installs the real
 * StoreKit 2 seam (`expo-iap`) carrying the ApiClient's server verifier, so a signed transaction is verified
 * by the BFF.
 */
import type { ApiClient } from './apiClient'
import { setPurchasesSeam } from './purchases'
// NB: import from './storekit', NOT './purchases.native' — Metro treats a trailing `.native` as a platform
// suffix and would resolve `./purchases` instead, silently dropping createNativePurchases (undefined at runtime).
import { createNativePurchases } from './storekit'

export function wireBilling(client: ApiClient): void {
  setPurchasesSeam(createNativePurchases((jws) => client.verifyPurchase(jws)))
}
