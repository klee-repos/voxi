/**
 * Shared thread-ownership ACL for the collection surface: GET /v1/threads/:id, its /stream, /v1/interview, and
 * the voice sub-app's POST /v1/voice/session all bind to a thread the caller owns.
 *
 * The rule (belt-and-suspenders): the in-memory ownership map is an early, authoritative deny when it KNOWS the
 * session; a MISS defers to the durable thread row. The map is process-local and NOT rehydrated on restart, so:
 *   - it must never FAIL-CLOSE on the legitimate owner of a persisted session (the pre-restart /stream 403 bug), and
 *   - a soft-only check must never FAIL-OPEN after a restart empties the map (the /voice + /interview gap).
 * Non-owner → 404 not_found (matches GET /v1/threads/:id; never leaks existence).
 *
 * Extracted into ONE function so these routes cannot drift apart again — the drift between /stream (strict) and
 * its siblings (belt-and-suspenders) WAS the bug.
 */
import type { ThreadStore, ThreadRecord } from './app'

export type ThreadOwnerVerdict =
  | { ok: true; rec: ThreadRecord | null }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' }

export async function threadOwnerVerdict(
  deps: { sessionOwner: Map<string, string>; threads?: ThreadStore },
  id: string,
  userId: string,
): Promise<ThreadOwnerVerdict> {
  const known = deps.sessionOwner.get(id)
  if (known && known !== userId) return { ok: false, status: 403, error: 'forbidden' } // map KNOWS a different owner
  const rec = (await deps.threads?.get(id)) ?? null
  if (rec) return rec.ownerUserId === userId ? { ok: true, rec } : { ok: false, status: 404, error: 'not_found' }
  // No durable row: allow iff the map affirmatively owns it (a fresh same-process session, before its reveal has
  // been persisted); else the session is unknown here → 404 (never fail-open on an unknown id).
  if (known === userId) return { ok: true, rec: null }
  return { ok: false, status: 404, error: 'not_found' }
}
