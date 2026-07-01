/**
 * Deterministic coverage for the live TTS provider's pure helpers (PLAN §6.2.3). The ElevenLabs HTTP call is
 * exercised by spikes/live-podcast.ts; here we pin the two-host turn-merging and the ID3-strip that makes
 * multi-segment MP3 concat player-safe — no creds.
 */
import { test, expect, describe } from 'bun:test'
import { mergeTurns, stripId3 } from './live-tts'

describe('mergeTurns — consecutive same-speaker clauses become one turn', () => {
  test('alternating speakers stay separate; runs merge with a space', () => {
    const turns = mergeTurns([
      { speaker: 'arlo', text: 'A 1976 Canon AE-1.' },
      { speaker: 'arlo', text: 'A handsome thing.' },
      { speaker: 'mave', text: 'Shutter-priority, mind you.' },
      { speaker: 'arlo', text: 'Over a million sold.' },
    ])
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEqual({ speaker: 'arlo', text: 'A 1976 Canon AE-1. A handsome thing.' })
    expect(turns[1]!.speaker).toBe('mave')
    expect(turns[2]!.text).toBe('Over a million sold.')
  })
  test('empty script → no turns', () => {
    expect(mergeTurns([])).toEqual([])
  })
})

describe('stripId3 — leading ID3v2 tag removed for gapless concat', () => {
  test('strips an ID3v2 tag using its synchsafe size', () => {
    // ID3v2: "ID3", ver(2), flags(1), synchsafe size(4) = 10-byte header + payload. size=3 → strip 13 bytes.
    const tagged = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 3, 0xaa, 0xbb, 0xcc, 0xff, 0xfb, 0x90])
    const out = stripId3(tagged)
    expect(Array.from(out)).toEqual([0xff, 0xfb, 0x90]) // only the MP3 frame remains
  })
  test('a bare frame stream (no ID3) is returned unchanged', () => {
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
    expect(stripId3(frame)).toBe(frame)
  })
})
