/**
 * Deterministic coverage for the live TTS provider's pure helpers (PLAN §6.2.3). The ElevenLabs HTTP call is
 * exercised by spikes/live-podcast.ts; here we pin the two-host turn-merging and the ID3-strip that makes
 * multi-segment MP3 concat player-safe — no creds.
 */
import { test, expect, describe } from 'bun:test'
import { mergeTurns, stripId3, ElevenLabsTts, DEFAULT_PODCAST_VOICES, type PodcastVoices } from './live-tts'
import type { Script } from './render'

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

describe('ElevenLabsTts — each speaker is synthesized in its own configured voice', () => {
  // A fake transport that records the URL of every ElevenLabs call and returns a minimal MP3 frame. This asserts
  // the REAL request the provider builds (the voice id is in the path) — not a stubbed success of the render.
  function recordingFetch(calls: string[]): typeof fetch {
    return (async (url: string | URL) => {
      calls.push(String(url))
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer }
    }) as unknown as typeof fetch
  }

  // arlo then mave: mergeTurns keeps the two speakers separate → one TTS call per speaker, in order.
  const script: Script = {
    facts: [],
    clauses: [
      { speaker: 'arlo', text: 'So what are we looking at?', claimType: 'flavor' },
      { speaker: 'mave', text: 'A camera, and a lovely one.', claimType: 'flavor' },
    ],
  }

  test('the default pair sends arlo and mave to the shipped Deep Dive voice IDs', async () => {
    const calls: string[] = []
    const tts = new ElevenLabsTts('fake-key', DEFAULT_PODCAST_VOICES, recordingFetch(calls))
    await tts.synthesize(script)
    expect(calls).toHaveLength(2)
    expect(calls[0]!).toContain('6u6JbqKdaQy89ENzLSju') // arlo
    expect(calls[1]!).toContain('Q1QcmfZPmFDVUWmzASdy') // mave
  })

  test('a caller-supplied voice pair overrides the default (the future user-config seam)', async () => {
    const calls: string[] = []
    const custom: PodcastVoices = { arlo: 'CUSTOM_ARLO_ID', mave: 'CUSTOM_MAVE_ID' }
    const tts = new ElevenLabsTts('fake-key', custom, recordingFetch(calls))
    await tts.synthesize(script)
    expect(calls[0]!).toContain('CUSTOM_ARLO_ID')
    expect(calls[1]!).toContain('CUSTOM_MAVE_ID')
  })

  test('DEFAULT_PODCAST_VOICES pins the exact shipped IDs', () => {
    expect(DEFAULT_PODCAST_VOICES).toEqual({ arlo: '6u6JbqKdaQy89ENzLSju', mave: 'Q1QcmfZPmFDVUWmzASdy' })
  })
})
