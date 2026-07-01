/**
 * Server-owned reveal narration (ANALYSIS-VOICE-PLAN A11/B1). The exact honesty-gated `token` clauses the app
 * renders as `whatItIs`, captured ONCE per session and PINNED, then voiced by `POST /v1/threads/:id/speech`.
 *
 * Why "captured once + pinned": the narrator runs at temperature 0.7 and re-runs on every `stream()` call
 * (retry / thread revisit / `?startIndex=` reconnect). Capturing naïvely would double or truncate the stored
 * text and let the spoken narration DIVERGE from what the user read. So the first successful, complete run wins
 * and later runs are ignored — `/speech` always voices the same clauses the app rendered on the first drain.
 *
 * Owner-scoping: the sessionId encodes the owner (`sess_<userId>_…`), so a read is owner-scoped without a
 * separate ACL map — a non-owner (or a session with no captured narration) reads null.
 */
export class NarrationStore {
  private byId = new Map<string, string>()

  /** Idempotent capture: store the joined clauses on the FIRST non-empty run; later runs are ignored (pinned). */
  capture(sessionId: string, clauses: readonly string[]): void {
    if (clauses.length && !this.byId.has(sessionId)) this.byId.set(sessionId, clauses.join(' '))
  }

  /** Owner-scoped read — null for a non-owner or a session with no captured narration. */
  get(sessionId: string, userId: string): string | null {
    if (!sessionId.startsWith(`sess_${userId}_`)) return null
    return this.byId.get(sessionId) ?? null
  }

  /** Deletion-cascade hygiene: drop every captured narration for this user's sessions. */
  purgeUser(userId: string): void {
    const prefix = `sess_${userId}_`
    for (const sid of [...this.byId.keys()]) if (sid.startsWith(prefix)) this.byId.delete(sid)
  }
}
