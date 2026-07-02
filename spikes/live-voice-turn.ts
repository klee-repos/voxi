/**
 * LIVE voice conversation turn against the real vendors, headless (no WebRTC transport):
 *   user AUDIO → Deepgram STT → Gemini (Voxi persona) → ElevenLabs TTS → reply AUDIO → STT to confirm grounding.
 * Run: `bun spikes/live-voice-turn.ts`.
 */
import { geminiJSON } from '../services/eve-agent/agent/lib/gcp-vision'

const el = process.env.ELEVENLABS_API_KEY!
const dg = process.env.DEEPGRAM_API_KEY!
const VOXI = '19STyYD15bswVz51nqLf' // Voxi's voice
const USER = 'Xb7hH8MSUJpSbSDYk0k2' // a stand-in "user" voice (distinct from Voxi)
if (!el || !dg) { console.error('need ELEVENLABS_API_KEY + DEEPGRAM_API_KEY'); process.exit(1) }

async function tts(text: string, voice: string): Promise<Uint8Array> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': el, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75 } }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 150)}`)
  return new Uint8Array(await r.arrayBuffer())
}
async function stt(mp3: Uint8Array): Promise<string> {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true', {
    method: 'POST', headers: { Authorization: `Token ${dg}`, 'content-type': 'audio/mpeg' }, body: mp3,
  })
  if (!r.ok) throw new Error(`stt ${r.status}`)
  return (await r.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
}

/** The Voxi conversation turn: an in-persona, honesty-constrained answer grounded in the thread's confirmed ID. */
const REPLY_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
async function voxiAnswer(context: { identity: string; facts: string[] }, question: string): Promise<string> {
  const system = [
    'You are Voxi — dry, witty, unmistakably British; a real-world Hitchhiker\'s Guide. You are mid-conversation about an object the user photographed.',
    `The object is CONFIRMED to be: ${context.identity}. You MAY state that identity.`,
    'GROUNDED FACTS you may rely on:', ...context.facts.map((f) => `  - ${f}`),
    'HONESTY: answer ONLY from the confirmed identity + the grounded facts. If the user asks something not covered, say you do not know rather than inventing specs/dates/prices. Keep it to 1–2 sentences, in character.',
    'Return JSON: { answer }.',
  ].join('\n')
  const out = await geminiJSON<{ answer: string }>(system, `User asks: "${question}"`, REPLY_SCHEMA, 0.6)
  return out.answer
}

console.log('\n── LIVE voice conversation turn (STT → Voxi LLM → TTS) ──')
const context = {
  identity: '1976 Canon AE-1, a 35mm single-lens reflex film camera',
  facts: ['Launched in 1976.', 'One of the first SLRs with a microprocessor-controlled electronic system (shutter-priority auto-exposure).', 'Over one million units sold — a best-seller of its era.'],
}
const userQuestion = 'So, what year is this camera from, and was it actually any good?'

// 1) user speaks → 2) Deepgram hears it
const userAudio = await tts(userQuestion, USER)
const heard = await stt(userAudio)
console.log(`  user said : "${userQuestion}"`)
console.log(`  STT heard : "${heard}"`)

// 3) Voxi answers (grounded, in persona)
const answer = await voxiAnswer(context, heard)
console.log(`  Voxi says : "${answer}"`)

// 4) speak the reply → 5) confirm it is grounded (mentions 1976)
const replyAudio = await tts(answer, VOXI)
await Bun.write('/tmp/voxi-voice-turn-reply.mp3', replyAudio)
const replyHeard = await stt(replyAudio)

const grounded = /1976|seventy.?six/i.test(answer) || /1976/.test(replyHeard)
const heardOk = /year|camera|good|canon/i.test(heard)
const audioOk = userAudio.length > 5000 && replyAudio.length > 5000
const pass = heardOk && !!answer && grounded && audioOk
console.log('\n' + (pass ? '✓ PASS' : '✗ FAIL') + ` — STT ok:${heardOk} · answer:${!!answer} · grounded(1976):${grounded} · audio:${audioOk}`)
console.log('  reply audio → /tmp/voxi-voice-turn-reply.mp3')
process.exit(pass ? 0 : 1)
