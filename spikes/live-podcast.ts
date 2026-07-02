/**
 * LIVE two-voice podcast render through the REAL `renderPodcast` pipeline:
 *   grounded facts → Gemini writes a claim-structured script → real honesty + defamation gates → live
 *   ElevenLabs multi-voice TTS → WAV episode → asset publish.
 * Only the store/muxer plumbing is faked (in-memory + local WAV; ffmpeg/HLS is the one prod step not runnable
 * here). Run: `bun spikes/live-podcast.ts`.
 */
import {
  renderPodcast,
  type PodcastJob,
  type Fact,
  type Script,
  type ResearchProvider,
  type ScriptProvider,
  type Muxer,
  type PodcastAsset,
  type PodcastAssetStore,
  type PodcastStatus,
} from '../services/voxi-podcast-worker/src/render'
import { ElevenLabsTts } from '../services/voxi-podcast-worker/src/live-tts'
import { geminiJSON } from '../services/eve-agent/agent/lib/gcp-vision'

const W = 'https://en.wikipedia.org/wiki/Canon_AE-1'
// Closed, REAL, sourced facts (the ResearchProvider's output; Gemini+Search produces this in prod).
const FACTS: Fact[] = [
  { claim: 'The Canon AE-1 is a 35mm single-lens reflex film camera launched in 1976.', sourceUrl: `${W}#History`, confidence: 1 },
  { claim: 'It was among the first SLRs with a microprocessor-controlled electronic system, offering shutter-priority automatic exposure.', sourceUrl: `${W}#Design`, confidence: 1 },
  { claim: 'It uses the Canon FD breech-lock lens mount.', sourceUrl: `${W}#Lens`, confidence: 1 },
  { claim: 'Over one million units were sold, making it one of the best-selling SLRs of its era.', sourceUrl: `${W}#Sales`, confidence: 1 },
]

const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string', enum: ['arlo', 'mave'] },
          text: { type: 'string' },
          claimType: { type: 'string', enum: ['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative', 'flavor'] },
          evidenceRef: { type: 'string' },
        },
        required: ['speaker', 'text', 'claimType'],
      },
    },
  },
  required: ['clauses'],
}

const liveResearch: ResearchProvider = { async research() { return FACTS } }

const liveScript: ScriptProvider = {
  async writeScript(job, facts): Promise<Script> {
    const refs = facts.map((f, i) => `f${i + 1}`)
    const system = [
      'You write a SHORT two-host podcast segment (~8-12 clauses) about an object, for the show "Voxi\'s Guide".',
      'ARLO is the enthusiast (warm, carries momentum). MAVE is the skeptic / fact-checker (dry, precise). They alternate.',
      'HONESTY (hard rules): every falsifiable clause (spec/provenance/date/causal/superlative/comparative) MUST set evidenceRef to one of the fact ids below. If you cannot ground it, make it a "flavor" clause (no facts). NEVER invent specs, dates, or numbers not in the facts.',
      'Return JSON: { clauses: [{ speaker, text, claimType, evidenceRef? }] }. Keep each clause to one sentence.',
    ].join('\n')
    const user = [`OBJECT: ${job.subject}`, 'FACTS you may cite:', ...facts.map((f, i) => `  ${refs[i]} → ${f.claim}`)].join('\n')
    const out = await geminiJSON<{ clauses: { speaker: 'arlo' | 'mave'; text: string; claimType: Script['clauses'][number]['claimType']; evidenceRef?: string }[] }>(system, user, SCRIPT_SCHEMA, 0.6)
    // Translate the friendly fN refs → the closed sourceUrls the honesty gate resolves against.
    const clauses = (out.clauses ?? []).map((c) => {
      const idx = c.evidenceRef ? refs.indexOf(c.evidenceRef) : -1
      return { speaker: c.speaker, text: c.text, claimType: c.claimType, evidenceRef: idx >= 0 ? facts[idx]!.sourceUrl : undefined }
    })
    return { facts, clauses }
  },
}

// Local muxer: persist the WAV + return keys (prod = ffmpeg loudnorm + HLS split → GCS).
let episodePath = ''
const localMuxer: Muxer = {
  async assemble({ catalogItemId, version, audio }) {
    episodePath = `/tmp/voxi-podcast-${catalogItemId}-v${version}.mp3`
    await Bun.write(episodePath, audio)
    return { playlistKey: `podcasts/${catalogItemId}/v${version}/index.m3u8`, segmentKeys: [`podcasts/${catalogItemId}/v${version}/seg0.mp3`] }
  },
}

function memoryStore(): PodcastAssetStore {
  const status = new Map<string, PodcastStatus>()
  const assets = new Map<string, PodcastAsset>()
  const k = (i: string, v: number) => `${i}:${v}`
  return {
    async compareAndSetStatus(i, v, from, to) {
      const cur = status.get(k(i, v)) ?? 'queued'
      if (cur !== from) return false
      status.set(k(i, v), to)
      return true
    },
    async getStatus(i, v) { return status.get(k(i, v)) ?? 'queued' },
    async putAsset(a) { assets.set(k(a.catalogItemId, a.version), a); status.set(k(a.catalogItemId, a.version), 'ready') },
    async getAsset(i, v) { return assets.get(k(i, v)) ?? null },
  }
}

const job: PodcastJob = { catalogItemId: 'canon-ae1', version: 1, subject: '1976 Canon AE-1' }
console.log('\n── LIVE two-voice podcast render (real pipeline + real GCP + real ElevenLabs) ──')
const outcome = await renderPodcast(job, {
  research: liveResearch,
  script: liveScript,
  tts: new ElevenLabsTts(),
  muxer: localMuxer,
  store: memoryStore(),
})

console.log('outcome:', outcome.kind)
if (outcome.kind === 'rendered' || outcome.kind === 'replayed') {
  const dur = outcome.asset.durationSec
  const bytes = episodePath ? (await Bun.file(episodePath).arrayBuffer()).byteLength : 0
  console.log(`✓ PASS — episode: ${episodePath}`)
  console.log(`   duration ~${dur.toFixed(1)}s · ${(bytes / 1024).toFixed(0)} KB MP3 · two voices (George+Alice)`)
  process.exit(bytes > 40000 && dur > 8 ? 0 : 1)
} else {
  console.log('✗ render did not produce an episode:', JSON.stringify(outcome).slice(0, 300))
  process.exit(1)
}
