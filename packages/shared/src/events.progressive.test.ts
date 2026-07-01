/**
 * Progressive-reveal event taxonomy (PROMPT-QUALITY §3.C / §2.4): the `fact` (with provenance) + `description_upgrade`
 * events round-trip, and the forward-compatible client parser skips UNKNOWN types without throwing while a
 * malformed KNOWN type still throws loud (adversarial #10).
 */
import { test, expect, describe } from 'bun:test'
import { parseEventLine, parseEventLineTolerant, StreamEvent } from './events'

describe('fact + description_upgrade events round-trip', () => {
  test('a fact carries its provenance (sourceUrl + verbatim quote)', () => {
    const ev = { type: 'fact', index: 7, text: 'The Canon AE-1 is a 35mm SLR.', sourceUrl: 'https://en.wikipedia.org/wiki/Canon_AE-1', sourceTitle: 'Canon AE-1', quote: 'The Canon AE-1 is a 35 mm SLR camera.' }
    const parsed = parseEventLine(JSON.stringify(ev))
    expect(parsed).toEqual(ev)
    if (parsed.type === 'fact') expect(parsed.quote.length).toBeGreaterThan(0)
  })
  test('sourceTitle defaults to empty when omitted', () => {
    const parsed = StreamEvent.parse({ type: 'fact', index: 1, text: 't', sourceUrl: 'u', quote: 'q' })
    expect(parsed).toEqual({ type: 'fact', index: 1, text: 't', sourceUrl: 'u', sourceTitle: '', quote: 'q' })
  })
  test('description_upgrade round-trips', () => {
    const ev = { type: 'description_upgrade', index: 12, text: 'A fuller, grounded account.' }
    expect(parseEventLine(JSON.stringify(ev))).toEqual(ev)
  })
})

describe('parseEventLineTolerant — forward-compat client reader', () => {
  test('skips an UNKNOWN event type (returns null, never throws) — an old client survives a new server', () => {
    expect(parseEventLineTolerant(JSON.stringify({ type: 'some_future_event', index: 3, foo: 1 }))).toBeNull()
  })
  test('parses a KNOWN event normally', () => {
    const line = JSON.stringify({ type: 'token', index: 2, text: 'hi' })
    expect(parseEventLineTolerant(line)).toEqual({ type: 'token', index: 2, text: 'hi' })
  })
  test('a malformed KNOWN type STILL throws (never silently swallowed)', () => {
    // `token` missing its required `index` is a real server↔client disagreement — must surface.
    expect(() => parseEventLineTolerant(JSON.stringify({ type: 'token', text: 'hi' }))).toThrow()
    // a malformed `fact` (missing quote) likewise throws.
    expect(() => parseEventLineTolerant(JSON.stringify({ type: 'fact', index: 1, text: 't', sourceUrl: 'u' }))).toThrow()
  })
  test('malformed JSON still throws', () => {
    expect(() => parseEventLineTolerant('{not json')).toThrow()
  })
  test('strict parseEventLine still throws on an unknown type (BFF boundary stays strict)', () => {
    expect(() => parseEventLine(JSON.stringify({ type: 'some_future_event', index: 3 }))).toThrow()
  })
})
