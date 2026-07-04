/**
 * Production providers for the podcast render pipeline (render.ts seams), no fakes:
 *   - CompositeResearchProvider: GLM-5.2 PRIMARY (the shared Firecrawl→GLM `groundedFacts` primitive) with a
 *     native-Gemini grounding FALLBACK (GeminiResearchProvider) so a Firecrawl outage can't hard-fail a Deep Dive.
 *   - GlmScriptProvider: GLM-5.2 writes the claim-structured two-host (Arlo/Mave) script over ONLY the closed
 *     facts, refs translated back to the closed sourceUrls the honesty gate resolves against.
 *   - FfmpegMuxer: takes the concatenated multi-voice MP3, runs a real ffmpeg pass (loudnorm + clean re-encode)
 *     → a single player-safe MP3 written into the asset dir. (HLS segmentation is a later prod refinement; a
 *     normalized MP3 is a real, playable asset.)
 *
 * Auth: GLM uses an API key (lib/glm); the native-Gemini fallback reuses gcloudToken() (gcloud CLI bearer).
 */
import { gcloudToken } from '../../eve-agent/agent/lib/gcp-vision'
import { glmJSON } from '../../eve-agent/agent/lib/glm'
import { groundedFacts } from '../../eve-agent/agent/lib/grounded-research'
import { firecrawlFromEnv, type WebResearchProvider } from '../../eve-agent/agent/tools/web_research'
import { loadPrompt, renderPrompt } from './prompts'
import type { GcsClient } from './gcs'
import type { ResearchProvider, ScriptProvider, Muxer, Fact, Script, PodcastJob } from './render'

const PROJECT = process.env.GCP_PROJECT ?? 'eighth-duality-354701'
/** Native-Gemini grounding fallback targets the GLOBAL endpoint — gemini-3.5-flash is not on us-central1. */
const GEMINI_LOCATION = process.env.GEMINI_LOCATION ?? 'global'
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
const ENDPOINT = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${GEMINI_LOCATION}/publishers/google/models/${MODEL}:generateContent`
// Per-call bounds so a black-holed vendor socket / ffmpeg pipe can't hang the render. The whole render body is ALSO
// bounded (renderPodcast's deadline) — these just release each hung call so the deadline's loser isn't left burning.
const VERTEX_CALL_MS = 120_000
const FFMPEG_KILL_MS = 120_000

/**
 * Extract the first JSON value (object or array) from a model text response that may wrap it in prose/fences.
 * String-AWARE brace walk: a `{`/`}` inside a quoted value can't throw off the depth counter.
 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('no JSON found in research response')
  const open = body[start]!
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return JSON.parse(body.slice(start, i + 1)) }
  }
  throw new Error('unterminated JSON in research response')
}

/**
 * Best-effort claim recovery when the model emits INVALID JSON. Grounding is mutually exclusive with a
 * responseSchema, so the research call is free-text: ~15% of responses embed UNESCAPED double-quotes inside a
 * claim value (e.g. its "honest" sound) which breaks JSON.parse ("Expected '}'"). Each object is a single-key
 * {"claim":"…"}, so anchor the value's end on the closing quote-then-brace and tolerate inner quotes. Also
 * survives a truncated tail (a partial final object simply doesn't match). Never invents — only what's present.
 */
export function recoverClaims(text: string): string[] {
  const out: string[] = []
  const re = /"claim"\s*:\s*"([\s\S]*?)"\s*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const claim = m[1]!.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
    if (claim) out.push(claim)
  }
  return out
}

/** Parse the research response into claim strings: strict JSON first, tolerant recovery on malformed output. */
export function parseClaims(text: string): string[] {
  try {
    const parsed = extractJson(text) as { claim?: string }[] | { claim?: string }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const claims = arr.map((f) => (typeof f?.claim === 'string' ? f.claim.trim() : '')).filter((c) => c.length > 0)
    if (claims.length > 0) return claims
  } catch {
    /* malformed JSON (unescaped inner quotes / truncation) → fall through to tolerant recovery */
  }
  return recoverClaims(text)
}

/**
 * Search-grounded research: real facts with real grounded source URLs (fail-closed if it can't ground).
 * RETRIES the grounded call: the free-text response intermittently (~15%) emits invalid JSON, and a single
 * parse failure must NOT kill the whole render (the reported "Deep Dive failed" bug). Each attempt is a fresh
 * grounded generation; parsing is strict-then-tolerant. Only if EVERY attempt fails do we fail-closed.
 */
export class GeminiResearchProvider implements ResearchProvider {
  constructor(private readonly maxAttempts = 3) {}

  async research(job: PodcastJob): Promise<Fact[]> {
    const prompt = renderPrompt('research.md', { subject: job.subject })
    let lastErr = 'research failed'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(VERTEX_CALL_MS),
        headers: { authorization: `Bearer ${gcloudToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }], // real Google Search grounding
          generationConfig: { temperature: 0.2 },
        }),
      })
      const j = await r.json()
      if (!r.ok) { lastErr = 'gemini research: ' + JSON.stringify(j).slice(0, 300); continue }
      const cand = j.candidates?.[0]
      const text: string = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''
      // Real grounded URLs the model actually consulted (never invented).
      const chunks: { web?: { uri?: string; title?: string } }[] = cand?.groundingMetadata?.groundingChunks ?? []
      const urls = chunks.map((c) => c.web?.uri).filter((u): u is string => !!u)
      if (urls.length === 0) { lastErr = 'research produced no grounded sources'; continue }

      const claims = parseClaims(text)
      if (claims.length === 0) { lastErr = 'research produced no parseable facts'; continue }
      // Attribute each fact to a real grounded URL (round-robin so refs resolve against the closed set).
      return claims.map((claim, i) => ({ claim, sourceUrl: urls[i % urls.length]!, confidence: 0.9 }))
    }
    // Fail-closed: refuse to ship ungrounded/unparseable rather than fabricate.
    throw new Error(`${lastErr} (after ${this.maxAttempts} attempts)`)
  }
}

/**
 * PRIMARY research path: the shared Firecrawl→GLM-5.2 `groundedFacts` primitive (same one the BFF dossier/researcher
 * use). Each fact's sourceUrl is the real Firecrawl doc its quote was lifted from — NO round-robin (per-fact
 * attribution is the honesty property). Fail-closed retry; a null web → throws so the composite falls back to Gemini.
 */
export class GroundedResearchProvider implements ResearchProvider {
  constructor(private web: WebResearchProvider | null, private maxAttempts = 3) {}

  async research(job: PodcastJob): Promise<Fact[]> {
    if (!this.web) throw new Error('grounded research: no Firecrawl provider wired')
    let lastErr = 'grounded research failed'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const { facts } = await groundedFacts({ web: this.web, subject: job.subject, query: job.subject, item: true })
        if (!facts.length) { lastErr = 'grounded research: no facts extracted'; continue }
        return facts.map((f) => ({ claim: f.text, sourceUrl: f.sourceUrl, confidence: 0.9 }))
      } catch (e) {
        lastErr = 'grounded research: ' + (e as Error).message
      }
    }
    throw new Error(`${lastErr} (after ${this.maxAttempts} attempts)`)
  }
}

/**
 * Resilience composite: GLM-5.2 (Firecrawl) primary, native-Gemini grounding fallback. A Firecrawl outage or a missing
 * key no longer HARD-FAILS a Deep Dive — the worker is fail-closed by design (render.ts re-throws when priorFacts is
 * empty), so without this fallback an outage would sink every episode whose BFF dossier was also starved. The fallback
 * is safe: the worker's honesty gate resolves evidenceRef against the closed facts[] (render.ts), NOT via the BFF's
 * sourceMatchesSubject, so the synthetic-title concern does not apply here.
 */
export class CompositeResearchProvider implements ResearchProvider {
  constructor(private primary: ResearchProvider, private fallback: ResearchProvider) {}
  async research(job: PodcastJob): Promise<Fact[]> {
    try {
      return await this.primary.research(job)
    } catch {
      return this.fallback.research(job) // Firecrawl/GLM down → native Gemini grounding
    }
  }
}

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

/**
 * GLM-5.2 writes the claim-structured two-host script over ONLY the closed facts (grounded refs enforced).
 * RETRIES on a transient/parse failure. GLM enforces no json_schema, so the schema is a prompt hint + a client-side
 * tolerant parse, and there is NO maxOutputTokens cap — GLM thinking tokens are heavy, so a tight cap would truncate
 * a long script mid-JSON.
 */
/**
 * Build the script model's USER prompt: the OBJECT + the server-owned reveal ORIENTATION (identity confidence +
 * what/purpose/maker, carried on job.context) + the closed FACTS list. Exported so a test can assert the
 * orientation actually reaches the prompt scope — the byte-golden alone can't (it builds the expected string from
 * the same scope, so it would pass even if this spread were dropped). A missing context field renders '' and its
 * section is elided, so a no-context job is byte-identical to the original fact-list build (back-compat).
 */
export function buildScriptUserPrompt(job: PodcastJob, facts: Fact[]): string {
  return renderPrompt('script.user.md', {
    subject: job.subject,
    band: job.context?.band,
    whatItIs: job.context?.whatItIs,
    purpose: job.context?.purpose,
    maker: job.context?.maker,
    whenMade: job.context?.whenMade,
    facts: facts.map((f, i) => ({ ref: `f${i + 1}`, claim: f.claim })),
  })
}

export class GlmScriptProvider implements ScriptProvider {
  constructor(private readonly maxAttempts = 3) {}

  async writeScript(job: PodcastJob, facts: Fact[]): Promise<Script> {
    const refs = facts.map((_, i) => `f${i + 1}`)
    // Prompt prose lives in `prompts/script.{system,user}.md`; code supplies only the data (facts + reveal context).
    const system = loadPrompt('script.system.md')
    const user = buildScriptUserPrompt(job, facts)
    let lastErr = 'script generation failed'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let out: { clauses: { speaker: 'arlo' | 'mave'; text: string; claimType: Script['clauses'][number]['claimType']; evidenceRef?: string }[] }
      try {
        // glmJSON sets response_format: json_object + renders the schema as a prompt hint + a tolerant extractJson parse.
        out = await glmJSON(system, user, SCRIPT_SCHEMA, 0.6)
      } catch (e) {
        lastErr = 'glm script: ' + (e as Error).message
        continue
      }
      const clauses = (out.clauses ?? []).map((c) => {
        const idx = c.evidenceRef ? refs.indexOf(c.evidenceRef) : -1
        return { speaker: c.speaker, text: c.text, claimType: c.claimType, evidenceRef: idx >= 0 ? facts[idx]!.sourceUrl : undefined }
      })
      if (clauses.length === 0) { lastErr = 'script produced no clauses'; continue }
      return { facts, clauses }
    }
    throw new Error(`${lastErr} (after ${this.maxAttempts} attempts)`)
  }
}

/**
 * Real ffmpeg muxer: loudnorm + clean re-encode of the concatenated multi-voice MP3 → one player-safe MP3, then
 * UPLOAD it to the PUBLIC audio bucket so the (scale-to-zero) worker doesn't have to be up to serve it — the iOS
 * player fetches the stable public GCS URL directly (GCS serves Range natively). The local /tmp file is transient
 * ffmpeg staging, deleted after upload.
 */
export class FfmpegMuxer implements Muxer {
  constructor(
    private outDir: string,
    private gcs: GcsClient,
    private audioBucket: string,
    private ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg',
  ) {}

  async assemble({ catalogItemId, version, audio }: { catalogItemId: string; version: number; audio: Uint8Array; durationSec: number }) {
    const base = `${catalogItemId}__v${version}`.replace(/[^\w.-]/g, '_')
    const inPath = `${this.outDir}/${base}.raw.mp3`
    const outPath = `${this.outDir}/${base}.mp3`
    await Bun.write(inPath, audio)
    // loudnorm (EBU R128) + re-encode to a clean CBR MP3 — fixes frame-concat timing + normalizes levels.
    const proc = Bun.spawn(
      [this.ffmpeg, '-y', '-i', inPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', outPath],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    // Kill a wedged ffmpeg so it can't hold the render lease past the deadline (P2).
    const killer = setTimeout(() => proc.kill(), FFMPEG_KILL_MS)
    let code: number
    try {
      code = await proc.exited
    } finally {
      clearTimeout(killer)
    }
    if (code !== 0) {
      const err = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer())
      throw new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`)
    }
    // Upload the finished MP3 to the public bucket at the stable, versioned key, then drop both local files.
    const playlistKey = `podcasts/${catalogItemId}/v${version}/episode.mp3`
    const bytes = new Uint8Array(await Bun.file(outPath).arrayBuffer())
    await this.gcs.put(this.audioBucket, playlistKey, bytes, 'audio/mpeg')
    for (const p of [inPath, outPath]) {
      try { await Bun.file(p).unlink?.() } catch { /* transient staging; ignore */ }
    }
    return { playlistKey, segmentKeys: [playlistKey] }
  }
}
