/**
 * Concurrent-create dedup guard (PLAN §7.2 / eng-F10).
 *
 * Two users photographing the same not-yet-cataloged object within seconds both pass the low-match check and
 * would each create an entry (a duplicate the sweep must later merge). The guard converges concurrent creates
 * with the same coarse embedding-bucket + category to ONE entry via an advisory-lock-style claim (here an
 * in-memory map; in prod a Postgres advisory lock / upsert on the bucket key).
 */
export function bucketKey(embedding: number[], category: string, buckets = 8): string {
  const q = embedding.slice(0, 4).map((x) => Math.round(x * buckets)).join(',')
  return `${category}|${q}`
}

export class CreateGuard {
  private claimed = new Map<string, string>() // bucketKey -> entryId

  /** First caller for a bucket creates; subsequent concurrent callers merge into the same entry. */
  claim(key: string, newEntryId: string): { result: 'created' | 'merged'; entryId: string } {
    const existing = this.claimed.get(key)
    if (existing) return { result: 'merged', entryId: existing }
    this.claimed.set(key, newEntryId)
    return { result: 'created', entryId: newEntryId }
  }
}
