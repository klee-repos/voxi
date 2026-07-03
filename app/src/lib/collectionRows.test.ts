/**
 * Collection grid data pipeline — pins the date-bucketing + row-flattening the virtualized photo-book grid runs
 * on. The key invariant: pair-row keys are content-stable (threadIds), so growing the infinite-scroll window
 * reconciles rows in place and never remounts an already-shown tile (its persisted photo doesn't reload).
 */
import { test, expect, describe } from 'bun:test'
import { bucketLabel, groupByDate, buildRows } from './collectionRows'
import type { ThreadSummary } from './apiClient'

const t = (id: string, createdAt: number): ThreadSummary => ({ threadId: id, title: id, band: 'CONFIDENT', createdAt })

const NOW = new Date('2026-07-03T12:00:00').getTime()
const daysAgo = (n: number) => new Date('2026-07-03T09:00:00').getTime() - n * 86_400_000

describe('bucketLabel', () => {
  test('buckets by day distance from now', () => {
    expect(bucketLabel(NOW, NOW)).toBe('Today')
    expect(bucketLabel(daysAgo(1), NOW)).toBe('Yesterday')
    expect(bucketLabel(daysAgo(3), NOW)).toBe('Earlier this week')
    expect(bucketLabel(daysAgo(10), NOW)).toBe('Earlier this month')
    expect(bucketLabel(daysAgo(40), NOW)).toBe('Earlier')
  })
})

describe('groupByDate', () => {
  test('groups a newest-first list into consecutive buckets, each label once', () => {
    const groups = groupByDate([t('a', NOW), t('b', daysAgo(1)), t('c', daysAgo(1)), t('d', daysAgo(40))], NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups[1]?.items.map((x) => x.threadId)).toEqual(['b', 'c'])
  })
})

describe('buildRows', () => {
  test('emits a header row then pair rows of up to two tiles', () => {
    const rows = buildRows(groupByDate([t('a', NOW), t('b', NOW), t('c', NOW)], NOW))
    // header, [a,b], [c]
    expect(rows.map((r) => r.kind)).toEqual(['header', 'pair', 'pair'])
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Today' })
    expect(rows[1]).toMatchObject({ kind: 'pair' })
    if (rows[1]?.kind === 'pair') expect(rows[1].items.map((x) => x.threadId)).toEqual(['a', 'b'])
  })

  test('a trailing odd item yields a length-1 pair (the screen pads it with a spacer)', () => {
    const rows = buildRows(groupByDate([t('a', NOW), t('b', NOW), t('c', NOW)], NOW))
    const last = rows[rows.length - 1]
    expect(last?.kind).toBe('pair')
    if (last?.kind === 'pair') expect(last.items).toHaveLength(1)
  })

  test('[CRIT] pair keys are content-stable: growing the window reuses the same key for an already-shown pair', () => {
    const all = [t('a', NOW), t('b', NOW), t('c', NOW), t('d', NOW)]
    const first = buildRows(groupByDate(all.slice(0, 2), NOW)) // window = 2 → header + [a,b]
    const grown = buildRows(groupByDate(all, NOW)) // window = 4 → header + [a,b] + [c,d]
    const keyOf = (rows: ReturnType<typeof buildRows>) => rows.find((r) => r.kind === 'pair')?.key
    expect(keyOf(first)).toBe(keyOf(grown)) // the [a,b] pair keeps its identity across window growth
    expect(keyOf(first)).toBe('p:a|b')
  })

  test('header keys are unique (buckets are monotonic in a newest-first list)', () => {
    const rows = buildRows(groupByDate([t('a', NOW), t('b', daysAgo(1)), t('d', daysAgo(40))], NOW))
    const headerKeys = rows.filter((r) => r.kind === 'header').map((r) => r.key)
    expect(new Set(headerKeys).size).toBe(headerKeys.length)
  })
})
