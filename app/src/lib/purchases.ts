/**
 * Billing seam (PLAN §13 / D — StoreKit 2 DIRECT, no third-party billing vendor). The paywall and settings
 * screens consume THIS interface, never the StoreKit module directly, so the screens render + the E2E paywall
 * flow runs without a StoreKit sandbox.
 *
 * Default = a deterministic in-process stub (web/E2E/CI): `purchase` reports entitled, `restore` reports
 * nothing-to-restore — enough to exercise the success/notice/error branches deterministically. On device the
 * real factory (`purchases.native`) wraps `expo-iap` (Apple StoreKit 2) and is a drop-in swap.
 *
 * Nothing on device is trusted as the source of truth for entitlements — the client forwards the StoreKit 2
 * SIGNED transaction (JWS) to the BFF, which VERIFIES it against Apple (see services/voxi-api/src/appstore.ts)
 * and the BFF's GET /v1/me is authoritative (PLAN §6.4). A successful purchase just dismisses the wall; the next
 * /me read reflects the server-verified plan. There is no RevenueCat and no client-trusted entitlement.
 */
export type Plan = 'free' | 'explorer' | 'voyager'

export interface PurchaseResult {
  /** True iff the user now holds an active entitlement (purchased, or already owned on restore). */
  entitled: boolean
  plan: Plan
}

export interface PurchasesSeam {
  /** Begin a StoreKit 2 purchase for the given plan/product. Resolves entitled on success, !entitled on cancel. */
  purchase(plan: Exclude<Plan, 'free'>): Promise<PurchaseResult>
  /** Re-check StoreKit 2 for existing entitlements (Apple-required "Restore Purchases"). */
  restore(): Promise<PurchaseResult>
}

/** Deterministic stub used until the native build wires StoreKit 2 (expo-iap). */
const stub: PurchasesSeam = {
  async purchase(plan) {
    return { entitled: true, plan }
  },
  async restore() {
    // No prior purchase in the stub world — drives the "nothing to restore" notice branch.
    return { entitled: false, plan: 'free' }
  },
}

// Default = the stub. On device the app wires the real StoreKit 2 seam at startup via `setPurchasesSeam(
// createNativePurchases(api.verifyPurchase))` (app/src/lib/api.tsx) — kept explicit so the web/E2E bundle never
// imports `expo-iap`, and the native seam carries the authenticated BFF verifier without importing React context.
let impl: PurchasesSeam | null = null

/** Inject a custom seam (the native StoreKit 2 factory on device, or a fake in tests). */
export function setPurchasesSeam(seam: PurchasesSeam): void {
  impl = seam
}

export const purchases: PurchasesSeam = {
  purchase: (plan) => (impl ?? stub).purchase(plan),
  restore: () => (impl ?? stub).restore(),
}
