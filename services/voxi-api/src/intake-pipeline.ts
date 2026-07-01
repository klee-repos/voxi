/**
 * Image intake pipeline — the legally load-bearing ordering (PLAN §15 / §22.2, RT-2 & RT-4).
 *
 * Every uploaded photo passes through, in this EXACT order, before it can be embedded, stored, or made
 * visible. The ordering reconciles two rules that otherwise collide:
 *   - "preserve the original untouched for NCMEC" (2258A) — applies only to CSAM matches.
 *   - "irreversibly redact faces/plates before any embed/store" (BIPA/GDPR) — applies to everything else.
 *
 * Order:
 *   1. CSAM hash-match the ORIGINAL first. If match → quarantine the untouched original, route ONLY to NCMEC,
 *      90-day preserve, no redaction, no normal store, no embedding, no human eyes outside the legal path.
 *   2. Else SafeSearch (NSFW/violence) → block before the persona ever sees it.
 *   3. Else redact faces/plates. Redactor is FAIL-CLOSED: any error/timeout/low-confidence → reject the
 *      upload (never store unredacted).
 *   4. Only the redacted derivative is embedded/stored; the original is marked for TTL deletion.
 *
 * Pluggable detectors/redactor so this is deterministically testable without live services.
 */

export type IntakeOutcome =
  | { kind: 'csam_quarantined'; reportedToNcmec: true; storedNormally: false; redacted: false }
  | { kind: 'blocked_nsfw'; storedNormally: false }
  | { kind: 'rejected_redactor_failed'; storedNormally: false }
  | { kind: 'accepted'; redactedObjectKey: string; originalScheduledForDeletion: true; embedSource: 'redacted' }

export interface HashMatcher {
  /** PhotoDNA / CSAI Match on the ORIGINAL bytes. */
  isCsam(original: Uint8Array): Promise<boolean>
}
export interface SafeSearch {
  isDisallowed(original: Uint8Array): Promise<boolean>
}
export interface Redactor {
  /** returns the redacted object key, or throws / returns null on any failure (→ fail-closed). */
  redact(original: Uint8Array): Promise<{ redactedObjectKey: string } | null>
}
export interface NcmecSink {
  quarantineAndReport(original: Uint8Array): Promise<void>
}
export interface ObjectStore {
  scheduleOriginalDeletion(originalKey: string): Promise<void>
}

export interface IntakeDeps {
  hash: HashMatcher
  safeSearch: SafeSearch
  redactor: Redactor
  ncmec: NcmecSink
  store: ObjectStore
}

export async function intake(
  original: Uint8Array,
  originalKey: string,
  deps: IntakeDeps,
): Promise<IntakeOutcome> {
  // 1. CSAM first, on the untouched original.
  if (await deps.hash.isCsam(original)) {
    await deps.ncmec.quarantineAndReport(original)
    return { kind: 'csam_quarantined', reportedToNcmec: true, storedNormally: false, redacted: false }
  }

  // 2. NSFW/violence before persona.
  if (await deps.safeSearch.isDisallowed(original)) {
    return { kind: 'blocked_nsfw', storedNormally: false }
  }

  // 3. Redact — FAIL-CLOSED.
  let redacted: { redactedObjectKey: string } | null = null
  try {
    redacted = await deps.redactor.redact(original)
  } catch {
    redacted = null
  }
  if (!redacted) {
    return { kind: 'rejected_redactor_failed', storedNormally: false }
  }

  // 4. Only the redacted derivative proceeds; original is TTL-deleted.
  await deps.store.scheduleOriginalDeletion(originalKey)
  return {
    kind: 'accepted',
    redactedObjectKey: redacted.redactedObjectKey,
    originalScheduledForDeletion: true,
    embedSource: 'redacted',
  }
}
