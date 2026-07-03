/**
 * Thread stream ownership + the shared event→store reducer. The single-owner invariant (beginThreadStream aborts
 * the prior stream) is what closes the "the item you swiped away from keeps writing into the one you swiped to"
 * contamination, so it is unit-pinned; applyStreamEvent/consumeThreadStream are pinned so processing's loop and
 * the reveal's swipe path can never drift.
 */
import { test, expect, describe } from 'bun:test'
import { beginThreadStream, abortThreadStream, applyStreamEvent, consumeThreadStream, type StreamActions, type ThreadStreamSource } from './threadStream'
import type { StreamEvent } from '../../../packages/shared/src/events'

function spyActions() {
  const calls: Record<string, unknown[]> = {
    setLastSeenIndex: [], appendText: [], appendFact: [], appendSection: [], upgradeDescription: [], setBand: [], setResearchComplete: [], setResearchError: [],
  }
  const a: StreamActions = {
    setLastSeenIndex: (i) => calls.setLastSeenIndex.push(i),
    appendText: (t) => calls.appendText.push(t),
    appendFact: (f) => calls.appendFact.push(f),
    appendSection: (b, c) => calls.appendSection.push([b, c]),
    upgradeDescription: (t) => calls.upgradeDescription.push(t),
    setBand: (band, title, c) => calls.setBand.push([band, title, c]),
    setResearchComplete: () => calls.setResearchComplete.push(true),
    setResearchError: () => calls.setResearchError.push(true),
  }
  return { calls, a }
}

const source = (events: StreamEvent[], opts?: { throwAfter?: number }): ThreadStreamSource => ({
  async *streamThread() {
    let i = 0
    for (const e of events) {
      if (opts?.throwAfter !== undefined && i === opts.throwAfter) throw new Error('network drop')
      yield e
      i++
    }
  },
})

describe('beginThreadStream / abortThreadStream (single-owner invariant)', () => {
  test('[CRIT] starting a new stream ABORTS the prior controller', () => {
    const first = beginThreadStream()
    expect(first.signal.aborted).toBe(false)
    const second = beginThreadStream()
    expect(first.signal.aborted).toBe(true) // the swipe-away stream is cancelled
    expect(second.signal.aborted).toBe(false)
    abortThreadStream()
    expect(second.signal.aborted).toBe(true)
  })
})

describe('applyStreamEvent (the shared reducer)', () => {
  test('setLastSeenIndex fires for EVERY event; each type maps to its store write', () => {
    const { calls, a } = spyActions()
    applyStreamEvent({ type: 'token', index: 0, text: 'A ' } as StreamEvent, a)
    applyStreamEvent({ type: 'fact', index: 1, text: 'f', sourceUrl: 'u', sourceTitle: 's', quote: 'q' } as StreamEvent, a)
    applyStreamEvent({ type: 'section', index: 2, bucket: 'purpose', text: 'p', sourceUrl: '', sourceTitle: '', quote: '' } as StreamEvent, a)
    applyStreamEvent({ type: 'section', index: 3, bucket: 'unknownbucket', text: 'x', sourceUrl: '', sourceTitle: '', quote: '' } as StreamEvent, a)
    applyStreamEvent({ type: 'section', index: 4, bucket: 'made', text: '1976', sourceUrl: '', sourceTitle: '', quote: '' } as StreamEvent, a)
    applyStreamEvent({ type: 'description_upgrade', index: 5, text: 'better' } as StreamEvent, a)
    applyStreamEvent({ type: 'confidence_band', index: 6, band: 'CONFIDENT', title: 'T', candidates: [] } as StreamEvent, a)
    applyStreamEvent({ type: 'done', index: 7, sessionId: 's' } as StreamEvent, a)

    expect(calls.setLastSeenIndex).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(calls.appendText).toEqual(['A '])
    expect(calls.appendFact).toEqual([{ text: 'f', sourceUrl: 'u', sourceTitle: 's', quote: 'q' }])
    // purpose + made are appended; the unknown bucket is ignored, not crashed.
    expect(calls.appendSection).toEqual([
      ['purpose', { text: 'p', sourceUrl: '', sourceTitle: '', quote: '' }],
      ['made', { text: '1976', sourceUrl: '', sourceTitle: '', quote: '' }],
    ])
    expect(calls.upgradeDescription).toEqual(['better'])
    expect(calls.setBand).toEqual([['CONFIDENT', 'T', []]])
    expect(calls.setResearchComplete).toEqual([true])
  })
})

describe('consumeThreadStream', () => {
  test('applies every event and stops on done', async () => {
    const { calls, a } = spyActions()
    const ac = beginThreadStream()
    await consumeThreadStream(
      source([
        { type: 'confidence_band', index: 0, band: 'CONFIDENT', title: 'T', candidates: [] } as StreamEvent,
        { type: 'fact', index: 1, text: 'f', sourceUrl: 'u', sourceTitle: '', quote: 'q' } as StreamEvent,
        { type: 'done', index: 2, sessionId: 's' } as StreamEvent,
      ]),
      't1', ac.signal, a,
    )
    expect(calls.setBand.length).toBe(1)
    expect(calls.appendFact.length).toBe(1)
    expect(calls.setResearchComplete).toEqual([true])
  })

  test('a mid-stream network drop → setResearchError (buckets go retriable, not falsely empty)', async () => {
    const { calls, a } = spyActions()
    const ac = beginThreadStream()
    await consumeThreadStream(source([{ type: 'fact', index: 0, text: 'f', sourceUrl: 'u', sourceTitle: '', quote: 'q' } as StreamEvent], { throwAfter: 0 }), 't1', ac.signal, a)
    expect(calls.setResearchError).toEqual([true])
    expect(calls.setResearchComplete).toEqual([]) // never falsely "complete"
  })

  test('an aborted signal is silent (a newer swipe superseded this one)', async () => {
    const { calls, a } = spyActions()
    const ac = beginThreadStream()
    ac.abort()
    await consumeThreadStream(source([{ type: 'fact', index: 0, text: 'f', sourceUrl: 'u', sourceTitle: '', quote: 'q' } as StreamEvent], { throwAfter: 0 }), 't1', ac.signal, a)
    expect(calls.setResearchError).toEqual([]) // abort is not an error
  })
})
