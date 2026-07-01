/**
 * Sybil-resistant private→global promotion (PLAN §7.4 / §22.2 / RT-6).
 *
 * A private catalog entry is nominated to global only when ≥N WEIGHTED distinct owners independently
 * photographed it. "Weighted" discounts cheap signups: account age, device attestation, and capture
 * geo/time dispersion. A device-diversity check blocks a single actor minting many accounts on one device.
 */
export interface OwnerSignal {
  ownerId: string
  accountAgeDays: number
  deviceAttested: boolean
  geoTimeDispersed: boolean
  deviceId: string
}

export function ownerWeight(o: OwnerSignal): number {
  let w = 0
  if (o.accountAgeDays >= 7) w += 0.5
  if (o.deviceAttested) w += 0.3
  if (o.geoTimeDispersed) w += 0.2
  return w // max 1.0 per fully-trusted owner
}

export interface PromotionDecision {
  promote: boolean
  weighted: number
  reason: string
}

export function shouldPromote(owners: OwnerSignal[], N = 3): PromotionDecision {
  // distinct owners only
  const distinct = [...new Map(owners.map((o) => [o.ownerId, o])).values()]

  // device-diversity sybil guard: confirmations must not all come from one device.
  const devices = new Set(distinct.map((o) => o.deviceId))
  if (distinct.length >= 2 && devices.size < 2) {
    return { promote: false, weighted: 0, reason: 'device-diversity guard: all confirmations share one device' }
  }

  const weighted = distinct.reduce((s, o) => s + ownerWeight(o), 0)
  return {
    promote: weighted >= N,
    weighted,
    reason: weighted >= N ? `weighted distinct owners ${weighted.toFixed(1)} ≥ ${N}` : `weighted ${weighted.toFixed(1)} < ${N}`,
  }
}
