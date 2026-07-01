/**
 * schedules/promote — sybil-resistant private→global promotion (PLAN §4.2, §7.4 / §22.2, §22.3 S1, §22.4, RT-6).
 *
 * A private catalogue entry becomes a GLOBAL one only when ≥N WEIGHTED distinct owners independently
 * photographed it. The weighting + device-diversity sybil guard are the shared `promotion` module (reused, not
 * re-implemented). This schedule wires that into a Cloud-Scheduler-drivable job and adds the §7.4/§22.2 policy
 * around it:
 *   - clusters are computed in a SYSTEM CONTEXT (elevated visibility, exempt from the per-user ACL) over a
 *     category-bucketed cross-user index (§22.4) — this module receives the already-clustered owner signals;
 *   - a promoted record is minted FROM STRUCTURED FIELDS ONLY — never private notes/transcripts (§7.4);
 *   - the new global record is AUTO-HELD for moderation before it can become a matchable vector OR a generation
 *     input (§7.4); it does not go straight live.
 *
 * SELF-HOST RISK INSURANCE (§22.3 S1): exposed as a Cloud-Scheduler-drivable handler behind a BFF cron route, so
 * promotion runs whether or not eve's world-postgres scheduler can drive it. Pure logic; nothing forces green —
 * the sybil weighting and the moderation hold are the real, tested policy.
 */
import { shouldPromote, type OwnerSignal } from '../../../../packages/shared/src/promotion'

/** A cluster of private entries (across users) the system-context clustering judged to be the same object. */
export interface PromotionCluster {
  /** a stable cluster key (e.g. the category + embedding bucket). */
  clusterId: string
  category: string
  /** the private entries in this cluster (across users). */
  privateEntryIds: string[]
  /** the distinct owners who confirmed it, with their sybil-resistance signals. */
  owners: OwnerSignal[]
  /** STRUCTURED fields only — the minted global record is built from these, never from private notes. */
  structuredFields: Record<string, string>
}

/** A minted global record, held for moderation before it can match or feed generation (§7.4). */
export interface GlobalRecordDraft {
  clusterId: string
  category: string
  /** built ONLY from `structuredFields` — provably no private notes/transcripts leaked in. */
  fields: Record<string, string>
  /** always 'pending_global' on mint: held for moderation, not yet a matchable vector or generation input. */
  visibility: 'pending_global'
}

export interface PromotionOutcome {
  clusterId: string
  promote: boolean
  weighted: number
  reason: string
  /** present iff promote — the held-for-moderation draft. */
  draft?: GlobalRecordDraft
}

/** Default confirmation threshold N (PLAN §7.4 "start 3–5, tunable"). */
export const DEFAULT_PROMOTION_N = 3

/**
 * Decide promotion for ONE cluster. Reuses the shared `shouldPromote` (distinct-owner weighting + device-
 * diversity sybil guard). On promote, mints a 'pending_global' draft from STRUCTURED FIELDS ONLY — never private
 * notes — and the draft stays held for moderation (visibility is pending_global, not global).
 */
export function decidePromotion(cluster: PromotionCluster, N: number = DEFAULT_PROMOTION_N): PromotionOutcome {
  const d = shouldPromote(cluster.owners, N)
  if (!d.promote) {
    return { clusterId: cluster.clusterId, promote: false, weighted: d.weighted, reason: d.reason }
  }
  // Mint from structured fields ONLY — defence against leaking private testimony into a global record (§7.4).
  const draft: GlobalRecordDraft = {
    clusterId: cluster.clusterId,
    category: cluster.category,
    fields: { ...cluster.structuredFields },
    visibility: 'pending_global', // auto-held for moderation before matchable/generation-eligible.
  }
  return { clusterId: cluster.clusterId, promote: true, weighted: d.weighted, reason: d.reason, draft }
}

/**
 * The promotion sweep handler, Cloud-Scheduler-drivable (§22.3 S1). Runs `decidePromotion` over every cluster
 * the system-context clustering produced. Idempotent (computes drafts; the caller applies them under a compare-
 * and-set on cluster state), so a duplicate Cloud Scheduler delivery cannot double-promote.
 */
export function runPromotionSweep(
  clusters: PromotionCluster[],
  N: number = DEFAULT_PROMOTION_N,
): PromotionOutcome[] {
  return clusters.map((c) => decidePromotion(c, N))
}

/** Guard: a minted draft must contain ONLY keys present in the cluster's structuredFields (no private leakage). */
export function draftIsStructuredOnly(cluster: PromotionCluster, draft: GlobalRecordDraft): boolean {
  const allowed = new Set(Object.keys(cluster.structuredFields))
  return Object.keys(draft.fields).every((k) => allowed.has(k))
}

/** Cloud Scheduler cron contract (§22.3 S1) — the BFF cron route binds this so promotion runs off eve's scheduler. */
export const PROMOTE_CRON = {
  bffRoute: '/internal/cron/promote',
  /** hourly is ample — promotion is not latency-sensitive and the moderation hold absorbs any lag. */
  schedule: 'every 1 hour',
} as const
