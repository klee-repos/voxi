/**
 * LIVE ElevenLabs TTS: narration text → speech. Run: `bun spikes/live-tts.ts "text to speak"`.
 */
const key = process.env.ELEVENLABS_API_KEY
const voiceId = '19STyYD15bswVz51nqLf' // Voxi's voice
if (!key) {
  console.error('ELEVENLABS_API_KEY missing (set it in .env.local)')
  process.exit(1)
}

const text =
  process.argv[2] ??
  "This is the 1976 Canon AE-1. It is a 35mm single-lens reflex camera. Intended for the amateur market, it simplified exposure control through extensive electronics. A commemorative edition, presumably for those who enjoyed the Games — or perhaps just cameras."

const out = process.env.TTS_OUT ?? '/tmp/voxi-narration.mp3'
console.log('\n── LIVE ElevenLabs TTS (Voxi voice) ──')
console.log('voice:', voiceId, '| chars:', text.length)

const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
  method: 'POST',
  headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
  }),
})

if (!r.ok) {
  console.error('TTS failed:', r.status, (await r.text()).slice(0, 300))
  process.exit(1)
}
const bytes = new Uint8Array(await r.arrayBuffer())
await Bun.write(out, bytes)
// A real MP3 starts with an ID3 tag ("ID3") or an MPEG frame sync (0xFF 0xEx).
const validMp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
console.log(`✓ wrote ${out} — ${bytes.length} bytes, valid MP3 header: ${validMp3}`)
process.exit(validMp3 && bytes.length > 2000 ? 0 : 1)
