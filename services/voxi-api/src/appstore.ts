/**
 * App Store server-side entitlement verification (PLAN §13) — the DIRECT StoreKit 2 path that replaces the
 * former RevenueCat dependency. No third-party billing vendor: the device sends a StoreKit 2 signed transaction
 * (JWS) which we verify against Apple, and Apple posts App Store Server Notifications V2 (renew/expire/refund/
 * revoke) to our webhook. The BFF is the ONLY source of truth for a user's plan (GET /v1/me); the client is
 * never trusted.
 *
 * Apple signature verification (x5c cert chain → Apple root CA + payload signature) is behind a PLUGGABLE
 * `AppleJwsVerifier` seam — exactly like `clerkVerifier` — so all of this logic is unit-testable with NO live
 * Apple keys. In prod the verifier is the real JWS/x5c check; in tests a deterministic fake. FAIL-CLOSED: a JWS
 * that does not verify yields null and grants NOTHING.
 */

export type Plan = 'free' | 'explorer' | 'voyager'

/**
 * App Store Connect product identifiers → the plan they grant. The ONLY place product ids are trusted; an
 * unknown product grants nothing (fail-closed). Keep in sync with the products configured in App Store Connect.
 */
export const PRODUCT_PLAN: Readonly<Record<string, Exclude<Plan, 'free'>>> = {
  'com.voxi.explorer.monthly': 'explorer',
  'com.voxi.explorer.yearly': 'explorer',
  'com.voxi.voyager.monthly': 'voyager',
  'com.voxi.voyager.yearly': 'voyager',
}

export function planForProduct(productId: string): Plan {
  return PRODUCT_PLAN[productId] ?? 'free'
}

/** The decoded StoreKit 2 transaction payload (JWSTransactionDecodedPayload) fields we consume. */
export interface TransactionPayload {
  productId: string
  originalTransactionId: string
  /** the Clerk userId we stamped as appAccountToken at purchase time (our user↔transaction link). */
  appAccountToken?: string
  /** ms epoch; a subscription's access end. Absent for non-expiring. */
  expiresDate?: number
  /** ms epoch; set when Apple refunded/revoked the transaction → entitlement is void. */
  revocationDate?: number
}

/** A persisted entitlement row — what the user is currently owed, and until when. */
export interface Entitlement {
  userId: string
  plan: Plan
  originalTransactionId: string
  /** ms epoch; undefined = no expiry. A read past this returns 'free'. */
  expiresAt?: number
}

/** Compute the entitlement a single verified transaction grants for a user (revocation/expiry aware). */
export function entitlementFromTransaction(userId: string, tx: TransactionPayload): Entitlement {
  // A refunded/revoked transaction grants nothing, regardless of product or expiry.
  if (tx.revocationDate !== undefined) {
    return { userId, plan: 'free', originalTransactionId: tx.originalTransactionId, expiresAt: 0 }
  }
  return {
    userId,
    plan: planForProduct(tx.productId),
    originalTransactionId: tx.originalTransactionId,
    expiresAt: tx.expiresDate,
  }
}

/** Is an entitlement currently active at `now`? (present plan, not expired). */
export function isActive(e: Entitlement | null, now: number): boolean {
  if (!e || e.plan === 'free') return false
  return e.expiresAt === undefined || e.expiresAt > now
}

/** Persistence for verified entitlements (prod = Postgres; tests = in-memory). Keyed by userId. */
export interface EntitlementStore {
  put(e: Entitlement): Promise<void>
  get(userId: string): Promise<Entitlement | null>
}

export function memoryEntitlementStore(seed: Entitlement[] = []): EntitlementStore {
  const rows = new Map<string, Entitlement>(seed.map((e) => [e.userId, e]))
  return {
    async put(e) {
      rows.set(e.userId, e)
    },
    async get(userId) {
      return rows.get(userId) ?? null
    },
  }
}

/** Read the AUTHORITATIVE plan for a user at `now` (expiry-checked). This backs GET /v1/me `planFor`. */
export async function planForUser(store: EntitlementStore, userId: string, now: number): Promise<Plan> {
  const e = await store.get(userId)
  return isActive(e, now) ? e!.plan : 'free'
}

/**
 * A verifier that decodes AND cryptographically verifies an Apple JWS (StoreKit 2 transaction OR an App Store
 * Server Notification V2 signedPayload). Returns the decoded payload object, or null if the signature/cert
 * chain fails. Injected so this module is testable without live Apple certs (mirrors channels/eve clerkVerifier).
 */
export type AppleJwsVerifier = (jws: string) => Promise<Record<string, unknown> | null>

/**
 * VERIFY a device-supplied StoreKit 2 signed transaction and persist the resulting entitlement. The userId comes
 * from our authenticated session (NOT from the JWS) — we additionally require the transaction's appAccountToken
 * to match, so a stolen transaction for another Apple ID cannot be replayed against this user. Returns the
 * granted plan, or null if verification fails (fail-closed → caller returns 400/free).
 */
export async function verifyAndApplyTransaction(
  jws: string,
  userId: string,
  verify: AppleJwsVerifier,
  store: EntitlementStore,
): Promise<Plan | null> {
  const payload = (await verify(jws)) as (TransactionPayload & Record<string, unknown>) | null
  if (!payload || typeof payload.productId !== 'string' || typeof payload.originalTransactionId !== 'string') return null
  // Bind the transaction to THIS user: the appAccountToken we stamped at purchase must match (if present).
  if (payload.appAccountToken && payload.appAccountToken !== userId) return null
  const ent = entitlementFromTransaction(userId, payload)
  await store.put(ent)
  return ent.plan
}

/** The App Store Server Notification V2 types we act on. Others are acknowledged (200) but change nothing. */
export type NotificationType =
  | 'SUBSCRIBED'
  | 'DID_RENEW'
  | 'DID_CHANGE_RENEWAL_STATUS'
  | 'EXPIRED'
  | 'GRACE_PERIOD_EXPIRED'
  | 'REFUND'
  | 'REVOKE'

/**
 * Handle a verified App Store Server Notification V2. The outer signedPayload is verified by the caller; here we
 * verify the INNER signedTransactionInfo and apply the entitlement change. REFUND/REVOKE/EXPIRED downgrade to
 * free; SUBSCRIBED/DID_RENEW (re)grant. The user link is the transaction's appAccountToken. Returns the userId
 * whose entitlement changed (for logging), or null if nothing verifiable/actionable.
 */
export async function applyNotification(
  decodedNotification: { notificationType?: string; data?: { signedTransactionInfo?: string } },
  verify: AppleJwsVerifier,
  store: EntitlementStore,
): Promise<{ userId: string; plan: Plan } | null> {
  const type = decodedNotification.notificationType as NotificationType | undefined
  const signedTx = decodedNotification.data?.signedTransactionInfo
  if (!type || !signedTx) return null

  const tx = (await verify(signedTx)) as (TransactionPayload & Record<string, unknown>) | null
  if (!tx || typeof tx.originalTransactionId !== 'string') return null
  const userId = tx.appAccountToken
  if (!userId) return null // cannot attribute the change to a user

  // A terminal/negative event downgrades to free; a positive one (re)grants per the product/expiry.
  const terminal = type === 'REFUND' || type === 'REVOKE' || type === 'EXPIRED' || type === 'GRACE_PERIOD_EXPIRED'
  const ent: Entitlement = terminal
    ? { userId, plan: 'free', originalTransactionId: tx.originalTransactionId, expiresAt: 0 }
    : entitlementFromTransaction(userId, tx)
  await store.put(ent)
  return { userId, plan: ent.plan }
}
