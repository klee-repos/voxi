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

const VOICE: Record<'arlo' | 'mave', string> = {
  arlo: '19STyYD15bswVz51nqLf', // Voxi's voice
  mave: 'Xb7hH8MSUJpSbSDYk0k2',
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
  constructor(private apiKey = process.env.ELEVENLABS_API_KEY ?? '') {}

  private async ttsMp3(text: string, voiceId: string): Promise<Uint8Array> {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2 } }),
    })
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  async synthesize(script: Script): Promise<{ audio: Uint8Array; durationSec: number }> {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY missing')
    const turns = mergeTurns(script.clauses)
    const parts: Uint8Array[] = []
    for (const turn of turns) {
      const mp3 = await this.ttsMp3(turn.text, VOICE[turn.speaker])
      parts.push(parts.length === 0 ? mp3 : stripId3(mp3)) // keep the first tag; strip the rest → one stream
    }
    const audio = concat(parts)
    // 128 kbps CBR MP3 = 16 KB/s → a real duration estimate from the byte length.
    return { audio, durationSec: audio.length / 16000 }
  }
}
