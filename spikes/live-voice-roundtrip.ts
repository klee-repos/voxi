/**
 * LIVE voice round-trip: text → ElevenLabs TTS → MP3 → Deepgram STT → text, asserting the transcript recovers
 * the identity. Proves both voice vendors in one closed loop. Run: `bun spikes/live-voice-roundtrip.ts`.
 */
const el = process.env.ELEVENLABS_API_KEY
const dg = process.env.DEEPGRAM_API_KEY
const voiceId = '19STyYD15bswVz51nqLf' // Voxi's voice
if (!el || !dg) {
  console.error(`missing keys — ELEVENLABS_API_KEY:${!!el} DEEPGRAM_API_KEY:${!!dg}`)
  process.exit(1)
}

const text = 'This is the 1976 Canon AE-1, a 35 millimetre single-lens reflex camera.'
console.log('\n── LIVE voice round-trip (TTS → STT) ──')
console.log('say:', JSON.stringify(text))

// 1) ElevenLabs TTS.
const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
  method: 'POST',
  headers: { 'xi-api-key': el, 'content-type': 'application/json' },
  body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25 } }),
})
if (!tts.ok) {
  console.error('TTS failed', tts.status, (await tts.text()).slice(0, 200))
  process.exit(1)
}
const mp3 = new Uint8Array(await tts.arrayBuffer())
console.log(`  ✓ ElevenLabs → ${mp3.length} bytes of speech`)

// 2) Deepgram STT.
const stt = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true', {
  method: 'POST',
  headers: { Authorization: `Token ${dg}`, 'content-type': 'audio/mpeg' },
  body: mp3,
})
if (!stt.ok) {
  console.error('STT failed', stt.status, (await stt.text()).slice(0, 200))
  process.exit(1)
}
const alt = (await stt.json()).results?.channels?.[0]?.alternatives?.[0]
const transcript: string = alt?.transcript ?? ''
console.log(`  ✓ Deepgram → "${transcript}" (confidence ${(alt?.confidence ?? 0).toFixed(3)})`)

// 3) Assert the round-trip recovered the identity (whole-token, tolerant of STT spelling of "AE-1"/"35mm").
const hay = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
const need = ['canon', '1976', '35', 'reflex', 'camera']
const missing = need.filter((t) => !hay.includes(t))
const ok = missing.length === 0
console.log('\n' + (ok ? '✓ PASS — voice round-trip recovers the identity.' : `✗ FAIL — missing tokens: ${missing.join(', ')}`))
process.exit(ok ? 0 : 1)
