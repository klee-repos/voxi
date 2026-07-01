/**
 * Entitlement metering + idempotent paid-generation gate (PLAN §6.4 / eng-F6, F8).
 *
 * The BFF is the only public surface and the single enforcement point: it ATOMICALLY checks+decrements an
 * entitlement BEFORE enqueueing any paid generation, and mints a single-use generation token the worker
 * validates. Enqueue is idempotent on (catalogItemId, userId, version) so retries / double-taps collapse to
 * one decrement and one render.
 *
 * The Store interface is implemented in prod by a Postgres `UPDATE … WHERE remaining>0 RETURNING` (row-atomic).
 * The in-memory impl here is for deterministic tests and documents the exact contract.
 */

export type Meter = 'scan' | 'podcast' | 'voiceMin'

export interface Entitlements {
  scan: number
  podcast: number
  voiceMin: number
}

export interface Store {
  /** Atomically decrement `meter` by `n` iff remaining >= n. Returns true on success, false if insufficient. */
  tryDecrement(userId: string, meter: Meter, n: number): Promise<boolean>
  /** Idempotency: returns an existing token for the key, or null. */
  getToken(key: string): Promise<string | null>
  /** Persist a freshly minted token for the key (must be paired with a successful decrement). */
  putToken(key: string, token: string): Promise<void>
  remaining(userId: string, meter: Meter): Promise<number>
  /** Credit `n` back to a meter — used to refund a scan when the outcome was a refusal/hard-fail (§13/F9). */
  credit(userId: string, meter: Meter, n: number): Promise<void>
}

export interface MintResult {
  ok: boolean
  token?: string
  reason?: 'insufficient_entitlement' | 'ok' | 'idempotent_replay'
}

function genKey(catalogItemId: string, userId: string, version: number): string {
  return `${userId}:${catalogItemId}:v${version}`
}

/**
 * Gate a paid podcast generation. Idempotent: a second call with the same (item,user,version) returns the
 * SAME token and does NOT decrement again. The first call decrements exactly once.
 */
export async function gatePodcastGeneration(
  store: Store,
  args: { userId: string; catalogItemId: string; version: number; mintToken: () => string },
): Promise<MintResult> {
  const key = genKey(args.catalogItemId, args.userId, args.version)

  const existing = await store.getToken(key)
  if (existing) return { ok: true, token: existing, reason: 'idempotent_replay' }

  const decremented = await store.tryDecrement(args.userId, 'podcast', 1)
  if (!decremented) return { ok: false, reason: 'insufficient_entitlement' }

  const token = args.mintToken()
  await store.putToken(key, token)
  return { ok: true, token, reason: 'ok' }
}

/** Charge a unit of a metered action (scan, voice minute). Refusals/hard-fails must NOT call this (§13/F9). */
export async function charge(store: Store, userId: string, meter: Meter, n = 1): Promise<boolean> {
  return store.tryDecrement(userId, meter, n)
}

// ---- in-memory Store for tests (documents the atomic contract) ----
export function memoryStore(initial: Record<string, Entitlements>): Store {
  const ent = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]))
  const tokens = new Map<string, string>()
  return {
    async tryDecrement(userId, meter, n) {
      const e = ent.get(userId)
      if (!e || e[meter] < n) return false
      e[meter] -= n
      return true
    },
    async getToken(key) {
      return tokens.get(key) ?? null
    },
    async putToken(key, token) {
      tokens.set(key, token)
    },
    async remaining(userId, meter) {
      return ent.get(userId)?.[meter] ?? 0
    },
    async credit(userId, meter, n) {
      const e = ent.get(userId)
      if (e) e[meter] += n
    },
  }
}
