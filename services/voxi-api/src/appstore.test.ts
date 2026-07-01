/**
 * Direct StoreKit 2 entitlement verification (PLAN §13) — the RevenueCat replacement. The Apple JWS crypto is
 * behind the injected `AppleJwsVerifier` seam, so this exercises the REAL entitlement logic with no live Apple
 * keys: a fake verifier decodes a JSON "jws". Asserts the honesty/anti-abuse invariants — client never trusted,
 * transactions bound to the user (anti-replay), refund/revoke/expiry → free, unverifiable → nothing (fail-closed).
 */
import { test, expect, describe } from 'bun:test'
import {
  planForProduct,
  entitlementFromTransaction,
  isActive,
  planForUser,
  verifyAndApplyTransaction,
  applyNotification,
  memoryEntitlementStore,
  type AppleJwsVerifier,
} from './appstore'

/** A fake verifier: a "jws" is just its JSON payload (the real one verifies x5c + signature). null = rejected. */
const okVerify: AppleJwsVerifier = async (jws) => {
  try {
    return JSON.parse(jws)
  } catch {
    return null
  }
}
const failVerify: AppleJwsVerifier = async () => null
const tx = (o: Record<string, unknown>) => JSON.stringify(o)

describe('product → plan mapping (unknown product grants nothing)', () => {
  test('known products map to their plan; unknown → free', () => {
    expect(planForProduct('com.voxi.explorer.monthly')).toBe('explorer')
    expect(planForProduct('com.voxi.voyager.yearly')).toBe('voyager')
    expect(planForProduct('com.voxi.hax.lifetime')).toBe('free')
  })
})

describe('entitlement from a transaction (revocation-aware)', () => {
  test('a normal transaction grants its product plan + expiry', () => {
    const e = entitlementFromTransaction('u1', { productId: 'com.voxi.explorer.monthly', originalTransactionId: 't1', expiresDate: 5000 })
    expect(e.plan).toBe('explorer')
    expect(e.expiresAt).toBe(5000)
  })
  test('a revoked/refunded transaction grants NOTHING regardless of product', () => {
    const e = entitlementFromTransaction('u1', { productId: 'com.voxi.voyager.yearly', originalTransactionId: 't1', revocationDate: 10 })
    expect(e.plan).toBe('free')
  })
})

describe('isActive / planForUser — expiry is enforced on read', () => {
  test('an unexpired paid entitlement is active; past its expiry it reads free', async () => {
    const store = memoryEntitlementStore([{ userId: 'u1', plan: 'explorer', originalTransactionId: 't1', expiresAt: 1000 }])
    expect(await planForUser(store, 'u1', 999)).toBe('explorer')
    expect(await planForUser(store, 'u1', 1001)).toBe('free') // expired
    expect(await planForUser(store, 'nobody', 0)).toBe('free')
    expect(isActive({ userId: 'u1', plan: 'free', originalTransactionId: 't' }, 0)).toBe(false)
  })
})

describe('verifyAndApplyTransaction — client never trusted, bound to the user (anti-replay)', () => {
  test('a valid transaction grants the plan and persists it', async () => {
    const store = memoryEntitlementStore()
    const plan = await verifyAndApplyTransaction(tx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't9', appAccountToken: 'u1' }), 'u1', okVerify, store)
    expect(plan).toBe('voyager')
    expect((await store.get('u1'))?.plan).toBe('voyager')
  })

  test("a transaction whose appAccountToken is ANOTHER user's is rejected (anti-replay) — grants nothing", async () => {
    const store = memoryEntitlementStore()
    const plan = await verifyAndApplyTransaction(tx({ productId: 'com.voxi.voyager.monthly', originalTransactionId: 't9', appAccountToken: 'someone_else' }), 'u1', okVerify, store)
    expect(plan).toBeNull()
    expect(await store.get('u1')).toBeNull()
  })

  test('an unverifiable transaction (bad signature) grants NOTHING (fail-closed)', async () => {
    const store = memoryEntitlementStore()
    expect(await verifyAndApplyTransaction('garbage', 'u1', failVerify, store)).toBeNull()
    expect(await store.get('u1')).toBeNull()
  })
})

describe('applyNotification — Apple lifecycle events keep entitlements current', () => {
  const notif = (notificationType: string, txInfo: Record<string, unknown>) => ({ notificationType, data: { signedTransactionInfo: tx(txInfo) } })

  test('DID_RENEW (re)grants the plan for the linked user', async () => {
    const store = memoryEntitlementStore()
    const r = await applyNotification(notif('DID_RENEW', { productId: 'com.voxi.explorer.yearly', originalTransactionId: 't1', appAccountToken: 'u1', expiresDate: 99999 }), okVerify, store)
    expect(r).toEqual({ userId: 'u1', plan: 'explorer' })
    expect((await store.get('u1'))?.plan).toBe('explorer')
  })

  test('REFUND / REVOKE / EXPIRED downgrade the user to free', async () => {
    for (const type of ['REFUND', 'REVOKE', 'EXPIRED']) {
      const store = memoryEntitlementStore([{ userId: 'u1', plan: 'voyager', originalTransactionId: 't1', expiresAt: 99999 }])
      const r = await applyNotification(notif(type, { productId: 'com.voxi.voyager.monthly', originalTransactionId: 't1', appAccountToken: 'u1' }), okVerify, store)
      expect(r?.plan).toBe('free')
      expect((await store.get('u1'))?.plan).toBe('free')
    }
  })

  test('a notification with no signed transaction, or an unattributable one, changes nothing', async () => {
    const store = memoryEntitlementStore()
    expect(await applyNotification({ notificationType: 'DID_RENEW' }, okVerify, store)).toBeNull()
    // no appAccountToken → cannot attribute → no change
    expect(await applyNotification(notif('DID_RENEW', { productId: 'com.voxi.explorer.monthly', originalTransactionId: 't1' }), okVerify, store)).toBeNull()
  })
})
