/**
 * Revisit-action regression pin. Both the Collection grid AND the camera-home recent carousel revisit a durable
 * capture through this ONE core, so the "lost photo on revisit" bug (the camera-home tray used to `reset()` +
 * `setThread()` WITHOUT seeding the photo → a blank reveal) can never come back on either surface.
 */
import { test, expect, describe } from 'bun:test'
import { revisitThread } from './revisitThread'
import type { ThreadSummary } from './apiClient'

function spies() {
  const calls: { startCapture: (string | null)[]; setThread: string[]; push: string[] } = {
    startCapture: [],
    setThread: [],
    push: [],
  }
  return {
    calls,
    deps: {
      startCapture: (uri: string | null) => calls.startCapture.push(uri),
      setThread: (id: string) => calls.setThread.push(id),
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
    revisitThread(item({ photoUrl: 'https://media/x.jpg' }), deps)
    expect(calls.startCapture).toEqual(['https://media/x.jpg'])
    expect(calls.setThread).toEqual(['t1'])
    expect(calls.push).toEqual(['/processing'])
  })

  test('a thread with no photo seeds null (older/no-capture threads never crash the reveal)', () => {
    const { calls, deps } = spies()
    revisitThread(item({ photoUrl: null }), deps)
    expect(calls.startCapture).toEqual([null])
    revisitThread(item({ threadId: 't2' }), spies().deps) // photoUrl undefined → also null (nullish coalesce)
  })

  test('order is seed → point → navigate (photo is set BEFORE the thread + push)', () => {
    const order: string[] = []
    revisitThread(item({ photoUrl: 'p' }), {
      startCapture: () => order.push('startCapture'),
      setThread: () => order.push('setThread'),
      push: () => order.push('push'),
    })
    expect(order).toEqual(['startCapture', 'setThread', 'push'])
  })
})
