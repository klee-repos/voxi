/**
 * Live GCP vision calls (Vertex Gemini + Cloud Vision), authed via the gcloud CLI (no ADC, no SA key).
 * PLAN §5 Stage-1 (VLM) + Stage-2 (web grounding). Shared by the live VisionProvider and the accuracy spike.
 *
 * Auth model: a bearer token minted from `gcloud auth print-access-token`, cached ~50min. Vertex takes the
 * project in the URL path; Cloud Vision needs the `X-Goog-User-Project` quota-project header.
 */
import { loadPrompt } from '../prompts'

const PROJECT = process.env.GCP_PROJECT ?? 'eighth-duality-354701'
const LOCATION = process.env.GCP_LOCATION ?? 'us-central1'
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

let _tok: { value: string; exp: number } | null = null
export function gcloudToken(): string {
  if (_tok && Date.now() < _tok.exp) return _tok.value
  const p = Bun.spawnSync(['gcloud', 'auth', 'print-access-token'], { stdout: 'pipe', stderr: 'pipe' })
  const value = new TextDecoder().decode(p.stdout).trim()
  if (!value) throw new Error('gcloud auth print-access-token failed: ' + new TextDecoder().decode(p.stderr))
  _tok = { value, exp: Date.now() + 50 * 60_000 }
  return value
}

export async function loadImageBytes(pathOrUrl: string): Promise<{ b64: string; mime: string }> {
  let bytes: Uint8Array
  let mime = 'image/jpeg'
  // Inline `data:image/...;base64,...` — the device sends the captured JPEG this way (no upload store needed).
  if (pathOrUrl.startsWith('data:')) {
    const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(pathOrUrl)
    if (!m) throw new Error('malformed data URI')
    return { b64: m[2]!, mime: m[1] || mime }
  }
  if (/^https?:\/\//.test(pathOrUrl)) {
    let r: Response | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      r = await fetch(pathOrUrl, { headers: { 'user-agent': 'voxi/1.0 (dev@voxi.test)' } })
      if (r.ok) break
      if (r.status === 429 || r.status === 503) {
        await new Promise((res) => setTimeout(res, 1200 * Math.pow(attempt + 1, 2)))
        continue
      }
      break
    }
    if (!r || !r.ok) throw new Error(`fetch ${pathOrUrl} → ${r?.status ?? 'no-response'}`)
    mime = r.headers.get('content-type')?.split(';')[0] ?? mime
    bytes = new Uint8Array(await r.arrayBuffer())
  } else {
    bytes = new Uint8Array(await Bun.file(pathOrUrl).arrayBuffer())
    if (pathOrUrl.endsWith('.png')) mime = 'image/png'
  }
  return { b64: Buffer.from(bytes).toString('base64'), mime }
}

export interface GeminiId {
  category: string
  make: string
  model: string
  year_or_range: string
  fine_confidence: number
  /** concise, human-friendly display name of the single primary object (2–5 words, Title Case). */
  display_title: string
  /** which object was chosen when the scene has several (audit/debug; never user-facing). */
  subject_note?: string
  distinguishing_features?: string[]
  ocr_text?: string[]
}

const ID_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    make: { type: 'string' },
    model: { type: 'string' },
    year_or_range: { type: 'string' },
    fine_confidence: { type: 'number' },
    display_title: { type: 'string' },
    subject_note: { type: 'string' },
    distinguishing_features: { type: 'array', items: { type: 'string' } },
    ocr_text: { type: 'array', items: { type: 'string' } },
  },
  required: ['category', 'make', 'model', 'year_or_range', 'fine_confidence', 'display_title'],
}

export async function geminiIdentify(b64: string, mime: string): Promise<GeminiId> {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`
  const prompt = loadPrompt('identify-object.md')
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${gcloudToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: ID_SCHEMA, temperature: 0 },
    }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('gemini: ' + JSON.stringify(j).slice(0, 300))
  return JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
}

/**
 * General Vertex Gemini structured-text call (used by the live narrator). Same auth/endpoint as geminiIdentify;
 * `system` is the persona/rules, `user` the task, `schema` the JSON shape to force. Temperature is caller-set
 * (a narrator wants a little warmth; identification wants 0).
 */
export async function geminiJSON<T>(system: string, user: string, schema: object, temperature = 0.6): Promise<T> {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${gcloudToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
    }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('gemini-json: ' + JSON.stringify(j).slice(0, 300))
  return JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}') as T
}

/** Google-Search grounding metadata (Vertex generateContent). Each support segment maps to a source chunk. */
export interface GroundingChunk {
  web?: { uri?: string; title?: string }
}
export interface GroundingSupport {
  segment?: { startIndex?: number; endIndex?: number; text?: string }
  groundingChunkIndices?: number[]
}
export interface GroundingMetadata {
  groundingChunks?: GroundingChunk[]
  groundingSupports?: GroundingSupport[]
  webSearchQueries?: string[]
}

/**
 * Grounded Vertex Gemini TEXT call (Google Search grounding) — used by the reveal RESEARCH step to gather
 * citable facts about a confirmed identity.
 *
 * CRITICAL (verified against Vertex, gemini-2.5): controlled generation (`responseMimeType:'application/json'` /
 * `responseSchema`) is MUTUALLY EXCLUSIVE with the `googleSearch` tool — combining them 400s. So this call
 * returns FREE TEXT + `groundingMetadata`; the caller derives structured facts from the metadata, never a
 * schema. An `AbortController` timeout guarantees a hung grounded call can NEVER stall the reveal stream.
 */
export async function geminiGrounded(
  system: string,
  user: string,
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<{ text: string; grounding: GroundingMetadata }> {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${gcloudToken()}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), // fail-closed: a hung grounded call can't stall the stream
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      tools: [{ googleSearch: {} }], // grounding tool — NO responseSchema (mutually exclusive on 2.5)
      generationConfig: { temperature: opts.temperature ?? 0.2 },
    }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('gemini-grounded: ' + JSON.stringify(j).slice(0, 300))
  const cand = j.candidates?.[0]
  const text = ((cand?.content?.parts ?? []) as { text?: string }[]).map((p) => p.text ?? '').join('')
  return { text, grounding: (cand?.groundingMetadata ?? {}) as GroundingMetadata }
}

export interface WebDetect {
  bestGuess?: string
  entities: { description: string; score: number }[]
  pages: { url: string; title: string }[]
}

export async function visionWebDetect(b64: string): Promise<WebDetect> {
  const r = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${gcloudToken()}`, 'x-goog-user-project': PROJECT, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: b64 }, features: [{ type: 'WEB_DETECTION', maxResults: 8 }] }] }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('vision: ' + JSON.stringify(j).slice(0, 300))
  // The batch endpoint returns 200 even when the SINGLE image failed — the fault is in responses[0].error.
  const resp0 = j.responses?.[0]
  if (!resp0 || resp0.error) throw new Error('vision web-detect per-image error: ' + JSON.stringify(resp0?.error ?? 'no response'))
  const wd = resp0.webDetection ?? {}
  return {
    bestGuess: wd.bestGuessLabels?.[0]?.label,
    entities: (wd.webEntities ?? []).filter((e: { description?: string }) => e.description).slice(0, 6).map((e: { description: string; score: number }) => ({ description: e.description, score: e.score ?? 0 })),
    pages: (wd.pagesWithMatchingImages ?? []).slice(0, 4).map((p: { url: string; pageTitle?: string }) => ({ url: p.url, title: p.pageTitle ?? '' })),
  }
}

/** Cloud Vision SafeSearch likelihoods (the raw signal the live safety classifier maps to a policy category). */
export interface SafeSearch {
  adult: string
  violence: string
  medical: string
  racy: string
  spoof: string
}

export async function visionSafeSearch(b64: string): Promise<SafeSearch> {
  const r = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${gcloudToken()}`, 'x-goog-user-project': PROJECT, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: b64 }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] }] }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error('vision safesearch: ' + JSON.stringify(j).slice(0, 300))
  // SAFETY-CRITICAL fail-closed: the batch endpoint returns 200 even when the single image failed (per-image
  // `responses[0].error`, or a missing safeSearchAnnotation for corrupt/oversized data). If we cannot SCORE the
  // image, we must NOT silently treat it as 'safe' — throw so safety_gate's fail-closed catch suppresses it.
  const resp0 = j.responses?.[0]
  if (!resp0 || resp0.error || !resp0.safeSearchAnnotation) {
    throw new Error('vision safesearch per-image error/absent: ' + JSON.stringify(resp0?.error ?? 'no annotation'))
  }
  const s = resp0.safeSearchAnnotation
  const v = (x?: string) => x ?? 'UNKNOWN'
  return { adult: v(s.adult), violence: v(s.violence), medical: v(s.medical), racy: v(s.racy), spoof: v(s.spoof) }
}
