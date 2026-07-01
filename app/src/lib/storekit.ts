/**
 * Native StoreKit 2 billing (device only) — the drop-in for the `purchases` seam, backed by `expo-iap`. There is
 * NO third-party billing vendor (no RevenueCat): we do the StoreKit 2 purchase, then forward the SIGNED
 * transaction (JWS) to the BFF (`POST /v1/purchases/verify`), which verifies it against Apple and updates the
 * entitlement. The BFF's GET /v1/me is the source of truth; this returns the server-verified plan.
 *
 * This module imports `expo-iap`, which only exists in the native build. It is imported ONLY by
 * `wireBilling.native.ts` (a Metro platform-split file), so the web/converge bundle — which resolves the no-op
 * `wireBilling.ts` — never pulls `expo-iap`. `ApiProvider` calls `wireBilling(client)` at startup, which installs
 * this seam carrying the client's authenticated server verifier, without importing the React context.
 */
import type { PurchasesSeam, Plan, PurchaseResult } from './purchases'

/**
 * LAZY-load expo-iap only when a purchase is actually attempted. Importing it at module top-level touches its
 * native module during init, which throws on startup if StoreKit/OpenIAP isn't ready — and that previously took
 * the whole app down (via ApiProvider → wireBilling). Deferring the require keeps `createNativePurchases` always
 * defined; the native module is only exercised on a real purchase/restore.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function iap(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-iap')
}

/** App Store Connect product identifiers — MUST match services/voxi-api/src/appstore.ts PRODUCT_PLAN. */
const PRODUCT_FOR: Record<Exclude<Plan, 'free'>, string> = {
  explorer: 'com.voxi.explorer.monthly',
  voyager: 'com.voxi.voyager.monthly',
}

/** Server verifier injected at wire-up: posts the signed transaction to the BFF and returns the verified plan. */
export type VerifyPurchase = (signedTransaction: string) => Promise<{ plan: Plan }>

/** Pull the StoreKit 2 signed transaction (JWS) off an expo-iap purchase, across field-name variants. */
function jwsOf(purchase: unknown): string | undefined {
  const p = purchase as { jwsRepresentationIOS?: string; jwsRepresentation?: string; transactionReceipt?: string }
  return p?.jwsRepresentationIOS ?? p?.jwsRepresentation ?? p?.transactionReceipt
}

export function createNativePurchases(verifyPurchase: VerifyPurchase): PurchasesSeam {
  return {
    async purchase(plan): Promise<PurchaseResult> {
      const IAP = iap()
      const sku = PRODUCT_FOR[plan]
      await IAP.initConnection()
      try {
        const result = await IAP.requestPurchase({ request: { ios: { sku } }, type: 'subs' })
        const purchase = Array.isArray(result) ? result[0] : result
        const jws = jwsOf(purchase)
        if (!jws) return { entitled: false, plan: 'free' } // cancelled / no transaction
        const { plan: verified } = await verifyPurchase(jws) // server is the source of truth
        if (purchase) await IAP.finishTransaction({ purchase, isConsumable: false })
        return { entitled: verified !== 'free', plan: verified }
      } finally {
        await IAP.endConnection().catch(() => {})
      }
    },

    async restore(): Promise<PurchaseResult> {
      const IAP = iap()
      await IAP.initConnection()
      try {
        const owned = await IAP.getAvailablePurchases()
        let best: PurchaseResult = { entitled: false, plan: 'free' }
        for (const purchase of owned ?? []) {
          const jws = jwsOf(purchase)
          if (!jws) continue
          const { plan } = await verifyPurchase(jws)
          if (plan !== 'free') best = { entitled: true, plan }
        }
        return best
      } finally {
        await IAP.endConnection().catch(() => {})
      }
    },
  }
}
