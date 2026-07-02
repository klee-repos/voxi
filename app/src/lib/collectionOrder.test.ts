/**
 * Collection ordering + neighbour selection — the pure basis for reveal swipe-paging. Pinned here so the
 * "swipe pages into the interview form" regression (UNKNOWN/null-band items in the set) can never come back,
 * and so the grid + the pager can never disagree on order.
 */
import { test, expect, describe } from 'bun:test'
import { orderThreads, pageableThreads } from './collectionOrder'
import type { ThreadSummary } from './apiClient'

const t = (id: string, createdAt: number, band: ThreadSummary['band'] = 'CONFIDENT'): ThreadSummary => ({
  threadId: id,
  title: id,
  band,
  createdAt,
})

describe('orderThreads', () => {
  test('newest-first, does not mutate the input', () => {
    const input = [t('a', 100), t('b', 300), t('c', 200)]
    const out = orderThreads(input)
    expect(out.map((x) => x.threadId)).toEqual(['b', 'c', 'a'])
    expect(input.map((x) => x.threadId)).toEqual(['a', 'b', 'c']) // original untouched
  })
})

describe('pageableThreads (the paging FlatList data)', () => {
  test('newest-first, and the current item sits at its recency index', () => {
    const pages = pageableThreads([t('a', 100), t('b', 300), t('c', 200)], 'c')
    expect(pages.map((x) => x.threadId)).toEqual(['b', 'c', 'a']) // newest → oldest
    expect(pages.findIndex((x) => x.threadId === 'c')).toBe(1)
  })

  test('[CRIT] UNKNOWN / null-band items are NOT pageable (a swipe never lands in the interview form)', () => {
    const pages = pageableThreads(
      [t('confident', 400, 'CONFIDENT'), t('unknown', 300, 'UNKNOWN'), t('nullband', 200, null), t('probable', 100, 'PROBABLE')],
      'confident',
    )
    expect(pages.map((x) => x.threadId)).toEqual(['confident', 'probable']) // only the two revealable items
  })

  test('the CURRENT item is exempt from the band filter (a fresh capture is transiently band:null in cache)', () => {
    const pages = pageableThreads([t('fresh', 300, null), t('older', 100, 'CONFIDENT')], 'fresh')
    expect(pages.map((x) => x.threadId)).toEqual(['fresh', 'older']) // the null-band current item is kept
  })

  test('single revealable item → a length-1 list (nothing to page to)', () => {
    expect(pageableThreads([t('only', 100, 'CONFIDENT')], 'only')).toHaveLength(1)
  })
})
