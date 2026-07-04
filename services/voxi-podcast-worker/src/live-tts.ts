/**
 * Live ElevenLabs two-voice TTS for the podcast render (PLAN §6.2.3 / D5). Implements the `TtsProvider` seam:
 * merges consecutive same-speaker clauses into turns, synthesizes each turn in that host's voice as MP3, strips
 * each segment's ID3 tag, and concatenates the frame streams into a single MP3 episode. CBR-MP3 frame concat is
 * player-safe; the ffmpeg muxer (loudnorm + gapless + HLS segmentation) is the prod step — this proves the
 * multi-voice synthesis half live without ffmpeg (and without the Pro-tier `pcm_44100`).
 *
 * ARLO and MAVE use distinct voices so the two-host dynamic is audible.
 */
import type { TtsProvider, Script } from './render'

/** The two Deep Dive hosts' ElevenLabs voices. Injected (not hardcoded) so a future user-chosen pair can
 *  override the default — the same seam the reveal narrator uses for its single voice (`LiveNarrationTts`). */
export type PodcastVoices = Record<'arlo' | 'mave', string>

export const DEFAULT_PODCAST_VOICES: PodcastVoices = {
  arlo: '6u6JbqKdaQy89ENzLSju',
  mave: 's3TPKV1kjDlVtZbl4Ksh', // user-chosen
}

function concat(buffers: Uint8Array[]): Uint8Array {
  const total = buffers.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const b of buffers) { out.set(b, o); o += b.length }
  return out
}

/** Strip a leading ID3v2 tag (synchsafe 28-bit size) so concatenated segments are one clean MP3 frame stream. */
export function stripId3(mp3: Uint8Array): Uint8Array {
  if (mp3.length > 10 && mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
    const size = (mp3[6]! << 21) | (mp3[7]! << 14) | (mp3[8]! << 7) | mp3[9]! // synchsafe
    return mp3.subarray(10 + size)
  }
  return mp3
}

/** Merge consecutive same-speaker clauses into natural turns (one TTS call per turn). Pure — unit-tested. */
export function mergeTurns(clauses: { speaker: 'arlo' | 'mave'; text: string }[]): { speaker: 'arlo' | 'mave'; text: string }[] {
  const turns: { speaker: 'arlo' | 'mave'; text: string }[] = []
  for (const c of clauses) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === c.speaker) last.text += ' ' + c.text
    else turns.push({ speaker: c.speaker, text: c.text })
  }
  return turns
}

export class ElevenLabsTts implements TtsProvider {
  constructor(
    private apiKey = process.env.ELEVENLABS_API_KEY ?? '',
    private voices: PodcastVoices = DEFAULT_PODCAST_VOICES,
    private fetchImpl: typeof fetch = fetch, // injectable so the vendor call is assertable without creds
    private retryBackoffMs = 500, // 0 in tests; linear backoff between transient retries
  ) {}

  /** One TTS turn, RETRIED on a TRANSIENT vendor error (network throw, HTTP 429, or 5xx). A render makes ~10 of
   *  these; without a retry a single vendor blip on ANY turn failed the WHOLE Deep Dive (the reported "generation
   *  failed"). A real client error (4xx other than 429 — bad voice/text) is NOT retried; it fails fast. */
  private async ttsMp3(text: string, voiceId: string): Promise<Uint8Array> {
    const MAX = 3
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= MAX; attempt++) {
      let retryable = true // a network throw is retryable; a non-retryable status flips this off before throwing
      try {
        const r = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
          method: 'POST',
          // Bound each turn so a black-holed socket can't hang the render past its deadline (a timeout throw is retryable).
          signal: AbortSignal.timeout(60_000),
          headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2 } }),
        })
        if (r.ok) return new Uint8Array(await r.arrayBuffer())
        const err = new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
        retryable = r.status === 429 || r.status >= 500 // rate-limit + server errors are transient
        if (!retryable) throw err
        lastErr = err
      } catch (e) {
        if (!retryable) throw e // a real 4xx — don't waste retries
        lastErr = e instanceof Error ? e : new Error(String(e)) // network/transient — retry
      }
      if (attempt < MAX && this.retryBackoffMs > 0) await new Promise((res) => setTimeout(res, this.retryBackoffMs * attempt))
    }
    throw lastErr ?? new Error('elevenlabs: TTS failed')
  }

  async synthesize(script: Script): Promise<{ audio: Uint8Array; durationSec: number; clauseEndsSec: number[] }> {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY missing')
    // Group consecutive same-speaker clauses into turns (one TTS call each), REMEMBERING each turn's per-clause
    // char lengths so the turn's REAL byte-derived duration can be distributed back across ITS clauses. This yields
    // accurate per-clause read-along timing (`clauseEndsSec`) — the client karaoke keys off it instead of a
    // whole-episode char estimate that drifts. (mergeTurns stays for its own tests; this is the timed variant.)
    const turns: { speaker: 'arlo' | 'mave'; text: string; clauseChars: number[] }[] = []
    for (const c of script.clauses) {
      const last = turns[turns.length - 1]
      if (last && last.speaker === c.speaker) { last.text += ' ' + c.text; last.clauseChars.push(c.text.length) }
      else turns.push({ speaker: c.speaker, text: c.text, clauseChars: [c.text.length] })
    }
    const parts: Uint8Array[] = []
    const clauseEndsSec: number[] = []
    let cumSec = 0
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t]!
      const mp3 = await this.ttsMp3(turn.text, this.voices[turn.speaker])
      const frames = stripId3(mp3) // audio frames only → a consistent per-turn duration basis (128 kbps CBR)
      parts.push(t === 0 ? mp3 : frames) // keep the first tag; strip the rest → one clean MP3 stream
      const turnSec = frames.length / 16000 // 16 KB/s
      const totalChars = turn.clauseChars.reduce((a, b) => a + b, 0) || 1
      for (const ch of turn.clauseChars) {
        cumSec += turnSec * (ch / totalChars)
        clauseEndsSec.push(cumSec)
      }
    }
    const audio = concat(parts)
    return { audio, durationSec: audio.length / 16000, clauseEndsSec }
  }
}
