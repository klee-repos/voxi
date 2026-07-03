/**
 * Server-owned reveal narration, keyed per (session, BUCKET) (ANALYSIS-VOICE-PLAN A11 + ANALYSIS-UX §5.C). The
 * exact honesty-gated text behind each reveal bucket, captured ONCE per (session,bucket) and PINNED, then voiced by
 * `POST /v1/threads/:id/speech[/:bucket]`. Four buckets: `what` (the what-only narration), `purpose`/`maker` (their
 * `section` texts, tapped off the stream as they pass), and `facts` (the joined verified facts, captured at `done`).
 *
 * Why "captured once + pinned": the narrator runs at temperature 0.7 and re-runs on every `stream()` call
 * (retry / thread revisit / `?startIndex=` reconnect). Capturing naïvely would double or truncate the stored
 * text and let the spoken narration DIVERGE from what the user read. So the first successful text for a bucket wins
 * and later runs are ignored — `/speech` always voices the same words the app rendered on the first drain.
 *
 * Owner-scoping: the sessionId encodes the owner (`sess_<userId>_…`), so a read is owner-scoped without a
 * separate ACL map — a non-owner (or a bucket with no captured text) reads null.
 */
import type { AudioBucket } from '../../../packages/shared/src/events'

export class NarrationStore {
  private byId = new Map<string, Partial<Record<AudioBucket, string>>>()

  /** Idempotent per-(session,bucket) capture: the first non-empty text for a bucket wins; later runs are ignored. */
  capture(sessionId: string, bucket: AudioBucket, text: string): void {
    if (!text) return
    const cur = this.byId.get(sessionId) ?? {}
    if (cur[bucket]) return // pin-once per bucket
    cur[bucket] = text
    this.byId.set(sessionId, cur)
  }

  /** Owner-scoped read — null for a non-owner or a (session,bucket) with no captured text. */
  get(sessionId: string, userId: string, bucket: AudioBucket): string | null {
    if (!sessionId.startsWith(`sess_${userId}_`)) return null
    return this.byId.get(sessionId)?.[bucket] ?? null
  }

  /** Deletion-cascade hygiene: drop every captured bucket for this user's sessions. */
  purgeUser(userId: string): void {
    const prefix = `sess_${userId}_`
    for (const sid of [...this.byId.keys()]) if (sid.startsWith(prefix)) this.byId.delete(sid)
  }

  /** Delete/regenerate hygiene for ONE session: drop its pinned buckets so a fresh re-run re-pins new text
   *  (pin-once would otherwise keep voicing the stale narration after a regenerate re-identifies the object). */
  purgeSession(sessionId: string): void {
    this.byId.delete(sessionId)
  }
}
