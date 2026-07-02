/**
 * Revisit-action regression pin. Both the Collection grid AND the camera-home recent carousel revisit a durable
 * capture through this ONE core, so the "lost photo on revisit" bug (the camera-home tray used to `reset()` +
 * `setThread()` WITHOUT seeding the photo → a blank reveal) can never come back on either surface.
 *
 * It also pins the fast-open behaviour: a KNOWN-identity revisit (band cached on the tile) paints the reveal
 * straight from the summary and skips /processing (the swipe-parity fix); an UNKNOWN/unresolved one still routes
 * through /processing to settle a band.
 */
import { test, expect, describe } from 'bun:test'
import { revisitThread } from './revisitThread'
import type { ThreadSummary } from './apiClient'

function spies() {
  const calls: {
    startCapture: (string | null)[]
    setThread: string[]
    markRevisit: number
    setBand: { band: string; title: string; candidates: string[] }[]
    push: string[]
  } = { startCapture: [], setThread: [], markRevisit: 0, setBand: [], push: [] }
  return {
    calls,
    deps: {
      startCapture: (uri: string | null) => calls.startCapture.push(uri),
      setThread: (id: string) => calls.setThread.push(id),
      markRevisit: () => { calls.markRevisit += 1 },
      setBand: (band: string, title: string, candidates: string[]) => calls.setBand.push({ band, title, candidates }),
      push: (href: string) => calls.push.push(href),
    },
  }
}

const item = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: 't1',
  title: 'Capture · thing',
  createdAt: 1_700_000_000_000,
  ...over,
})

describe('revisitThread', () => {
  test('[CRIT] seeds the durable photo (startCapture(photoUrl)) — the lost-photo regression guard', () => {
    const { calls, deps } = spies()
    revisitThread(item({ photoUrl: 'https://media/x.jpg', band: 'CONFIDENT' }), deps)
    expect(calls.startCapture).toEqual(['https://media/x.jpg'])
    expect(calls.setThread).toEqual(['t1'])
    expect(calls.markRevisit).toBe(1) // flags the calm "opening your entry" loader (not fresh-analysis copy)
  })

  test('a KNOWN-identity revisit (band cached) seeds the band + opens /reveal directly — no /processing wait', () => {
    const { calls, deps } = spies()
    revisitThread(item({ band: 'CONFIDENT', revealTitle: '1976 Canon AE-1' }), deps)
    expect(calls.setBand).toEqual([{ band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: [] }])
    expect(calls.push).toEqual(['/reveal'])
  })

  test('PROBABLE also opens direct; the seeded title falls back to `title` when no revealTitle', () => {
    const { calls, deps } = spies()
    revisitThread(item({ band: 'PROBABLE' }), deps)
    expect(calls.setBand).toEqual([{ band: 'PROBABLE', title: 'Capture · thing', candidates: [] }])
    expect(calls.push).toEqual(['/reveal'])
  })

  test('an UNKNOWN / unresolved revisit still routes through /processing (needs the stream to settle a band)', () => {
    for (const band of [undefined, null, 'UNKNOWN'] as const) {
      const { calls, deps } = spies()
      revisitThread(item({ band }), deps)
      expect(calls.setBand).toEqual([]) // no cached identity to paint from
      expect(calls.push).toEqual(['/processing'])
    }
  })

  test('a thread with no photo seeds null (older/no-capture threads never crash the reveal)', () => {
    const { calls, deps } = spies()
    revisitThread(item({ photoUrl: null }), deps)
    expect(calls.startCapture).toEqual([null])
    revisitThread(item({ threadId: 't2' }), spies().deps) // photoUrl undefined → also null (nullish coalesce)
  })

  test('order (known identity): seed photo → mark → point → seed band → navigate', () => {
    const order: string[] = []
    revisitThread(item({ photoUrl: 'p', band: 'CONFIDENT' }), {
      startCapture: () => order.push('startCapture'),
      setThread: () => order.push('setThread'),
      markRevisit: () => order.push('markRevisit'),
      setBand: () => order.push('setBand'),
      push: () => order.push('push'),
    })
    // markRevisit MUST follow startCapture (which resets isRevisit → false), else the flag is clobbered.
    expect(order).toEqual(['startCapture', 'markRevisit', 'setThread', 'setBand', 'push'])
  })
})
