/**
 * Catalog visibility filter / tenant ACL (PLAN §7.4 / §11 / eng-F4, infra-04).
 *
 * The core retrieval invariant: a user may only ever see GLOBAL entries OR their OWN private entries. This is
 * enforced in SQL on every catalog read (the physically-partitioned global/private indexes of §11), and
 * re-asserted here as a pure predicate so the ACL is unit-testable and cannot silently regress. The system
 * promotion job is the ONLY caller allowed to cross the boundary, via an explicit elevated context.
 */

export type Visibility = 'global' | 'pending_global' | 'private'

export interface CatalogRow {
  id: string
  ownerUserId: string | null
  visibility: Visibility
}

/** SQL WHERE fragment for a per-user catalog read (parameterized — never string-interpolate userId). */
export const VISIBILITY_SQL = `(visibility = 'global' OR owner_user_id = $1)`

/** Pure predicate mirror of VISIBILITY_SQL — the single source of truth the ACL test asserts against. */
export function canRead(row: CatalogRow, userId: string): boolean {
  return row.visibility === 'global' || row.ownerUserId === userId
}

/** Filter a result set for a normal (non-elevated) user read. */
export function visibleTo(rows: CatalogRow[], userId: string): CatalogRow[] {
  return rows.filter((r) => canRead(r, userId))
}

/**
 * The ONLY sanctioned boundary crossing: the promotion clustering job (schedules/promote) runs in elevated
 * system context to count distinct owners across private entries. It must be explicitly constructed and is
 * never reachable from a request handler. (PLAN §7.4 / §22.4)
 */
export class ElevatedContext {
  private constructor(readonly reason: 'promotion-clustering') {}
  static forPromotion(): ElevatedContext {
    return new ElevatedContext('promotion-clustering')
  }
}

/** Cross-user private scan, allowed only with an ElevatedContext (compile-time + runtime guard). */
export function scanPrivateAcrossUsers(rows: CatalogRow[], ctx: ElevatedContext): CatalogRow[] {
  if (!(ctx instanceof ElevatedContext)) throw new Error('cross-user private scan requires ElevatedContext')
  return rows.filter((r) => r.visibility === 'private')
}
