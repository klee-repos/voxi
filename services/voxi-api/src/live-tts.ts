/**
 * LiveNarrationTts — the production `NarrationTtsProvider` for the spoken reveal (ANALYSIS-VOICE-PLAN B1).
 *
 * Returns `Uint8Array<ArrayBuffer>` so the BFF can hand the bytes straight to Hono's `c.body`. Constructed only
 * when `ELEVENLABS_API_KEY` is present — otherwise the BFF leaves `speech` unset and `/v1/threads/:id/speech`
 * 503s (loud, never a fake success).
 */
import type { NarrationTtsProvider } from './app'

const VOXI_VOICE = '19STyYD15bswVz51nqLf' // Voxi's voice

export class LiveNarrationTts implements NarrationTtsProvider {
  constructor(
    private apiKey: string,
    private voiceId: string = VOXI_VOICE,
    private timeoutMs = 15000,
  ) {}

  async synthesize(text: string): Promise<Uint8Array<ArrayBuffer>> {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs), // a hung synth can't hold the request handler open
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
      }),
    })
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return new Uint8Array(await r.arrayBuffer()) // arrayBuffer() ⇒ Uint8Array<ArrayBuffer>, exactly Hono's Data type
  }
}
