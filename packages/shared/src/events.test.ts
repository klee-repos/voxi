/** Tests for the NDJSON event contract (§4.3) and the vendor record/replay tape. */
import { test, expect, describe } from 'bun:test'
import { parseEventLine, nextStartIndex, StreamEvent } from './events'
import { VendorTape, hashRequest } from '../../../e2e/framework/vendor-tape'

describe('NDJSON event contract', () => {
  test('parses each known event type', () => {
    const lines = [
      '{"type":"token","index":0,"text":"A 2008"}',
      '{"type":"confidence_band","index":1,"band":"PROBABLE","title":"a confident maybe","candidates":["2008","2009"]}',
      '{"type":"done","index":2,"sessionId":"sess_1"}',
    ]
    const evs = lines.map(parseEventLine)
    expect(evs[0].type).toBe('token')
    expect(evs[1]).toMatchObject({ type: 'confidence_band', band: 'PROBABLE' })
  })

  test('rejects an unknown/untyped event (client never sees an untyped event)', () => {
    expect(() => parseEventLine('{"type":"surprise","index":0}')).toThrow()
    expect(() => parseEventLine('{"index":0,"text":"no type"}')).toThrow()
  })

  test('reconnection start index', () => {
    expect(nextStartIndex(null)).toBe(0)
    expect(nextStartIndex(4)).toBe(5)
  })

  test('confidence_band defaults candidates to []', () => {
    const e = StreamEvent.parse({ type: 'confidence_band', index: 0, band: 'CONFIDENT', title: 'identified' })
    expect(e.type === 'confidence_band' && e.candidates).toEqual([])
  })
})

describe('vendor tape record/replay', () => {
  test('record then replay returns the taped response without re-calling the vendor', async () => {
    let realCalls = 0
    const real = async (req: { img: string }) => {
      realCalls++
      return { label: `id-of-${req.img}` }
    }
    const tape = new VendorTape()
    const recorded = tape.wrap('gemini', real, 'record')
    const a = await recorded({ img: 'bike.jpg' })
    expect(a.label).toBe('id-of-bike.jpg')
    expect(realCalls).toBe(1)

    // replay from the same tape: same request → taped response, no further real calls.
    const replayed = tape.wrap('gemini', real, 'replay')
    const b = await replayed({ img: 'bike.jpg' })
    expect(b).toEqual(a)
    expect(realCalls).toBe(1) // not called again
  })

  test('replay MISS throws (never fabricates a response)', async () => {
    const tape = new VendorTape()
    const replayed = tape.wrap('vision', async () => ({ x: 1 }), 'replay')
    await expect(replayed({ unseen: true })).rejects.toThrow(/no recording/)
  })

  test('request hash is stable regardless of key order', () => {
    expect(hashRequest('v', { a: 1, b: 2 })).toBe(hashRequest('v', { b: 2, a: 1 }))
  })
})
