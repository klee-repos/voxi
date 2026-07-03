/**
 * Collection grid data pipeline — the PURE basis for the Collection screen's virtualized photo-book grid
 * (`app/app/(tabs)/threads.tsx`). Kept out of the component so the date-bucketing + row-flattening (the only new
 * risk in the infinite-scroll rewrite) is unit-testable with no RN/render.
 *
 * The grid is a single `FlatList` over a FLAT row list — a date-header row, then "pair" rows of up to two tiles —
 * so the virtualizer windows at row granularity (a large "Today" bucket doesn't defeat virtualization). Row keys
 * are content-stable (bucket label / the pair's threadIds), so growing the client-side window never remounts an
 * already-shown tile — its persisted photo doesn't reload.
 */
import type { ThreadSummary } from './apiClient'

const DAY = 86_400_000

/** Local midnight for `ms` (day-bucket boundary). */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The date bucket a capture falls in, relative to `now` (newest-first buckets). */
export function bucketLabel(createdAt: number, now: number): string {
  const days = Math.floor((startOfDay(now) - startOfDay(createdAt)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Earlier this week'
  if (days < 30) return 'Earlier this month'
  return 'Earlier'
}

export interface DateGroup {
  label: string
  items: ThreadSummary[]
}

/** Group an ALREADY newest-first list (see `orderThreads`) into consecutive date buckets. Buckets are monotonic
 *  in a newest-first list, so each label appears at most once → header keys are unique downstream. */
export function groupByDate(threads: ThreadSummary[], now: number): DateGroup[] {
  const out: DateGroup[] = []
  for (const t of threads) {
    const label = bucketLabel(t.createdAt, now)
    const last = out[out.length - 1]
    if (last && last.label === label) last.items.push(t)
    else out.push({ label, items: [t] })
  }
  return out
}

/** A single row in the virtualized grid: a date header, or a pair of up to two tiles. */
export type CollectionRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'pair'; key: string; items: ThreadSummary[] }

/** Flatten date groups into header + pair rows for the FlatList. A trailing odd item yields a 1-item pair (the
 *  screen renders a flex spacer beside it so it stays column-width). Keys are content-stable so window growth
 *  reconciles in place. */
export function buildRows(groups: DateGroup[]): CollectionRow[] {
  const rows: CollectionRow[] = []
  for (const g of groups) {
    rows.push({ kind: 'header', key: 'h:' + g.label, label: g.label })
    for (let i = 0; i < g.items.length; i += 2) {
      const items = g.items.slice(i, i + 2)
      rows.push({ kind: 'pair', key: 'p:' + items.map((t) => t.threadId).join('|'), items })
    }
  }
  return rows
}
