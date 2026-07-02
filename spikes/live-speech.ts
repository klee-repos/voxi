/**
 * LIVE spoken reveal: exercises the production `LiveNarrationTts` seam (the one the BFF `/speech` route uses)
 * against real ElevenLabs. Needs ELEVENLABS_API_KEY. Run: `bun spikes/live-speech.ts "text to speak"`.
 */
import { LiveNarrationTts } from '../services/voxi-api/src/live-tts'

const key = process.env.ELEVENLABS_API_KEY
if (!key) {
  console.error('ELEVENLABS_API_KEY missing (set it in .env.local)')
  process.exit(1)
}

const text =
  process.argv[2] ??
  'This is the 1976 Canon AE-1, a 35mm single-lens reflex. Its onboard microprocessor made accurate exposure a matter of pointing and shooting — which is rather the point of a camera.'

console.log('\n── LIVE spoken reveal (LiveNarrationTts → ElevenLabs "George") ──')
console.log('chars:', text.length)
const bytes = await new LiveNarrationTts(key).synthesize(text)
const out = process.env.TTS_OUT ?? '/tmp/voxi-reveal-narration.mp3'
await Bun.write(out, bytes)
const validMp3 =
  (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
console.log(`${validMp3 && bytes.length > 2000 ? '✓' : '✗'} wrote ${out} — ${bytes.length} bytes, valid MP3 header: ${validMp3}`)
process.exit(validMp3 && bytes.length > 2000 ? 0 : 1)
