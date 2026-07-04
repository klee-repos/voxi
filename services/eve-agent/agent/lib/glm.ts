/**
 * Live GLM (z.ai, OpenAI-compatible) calls — the model behind narration/title, fact extraction, the grounded-research
 * extractor, and the interview script. Authed by an API key (NOT gcloud). Thinking is ON by default and emits as a
 * SEPARATE `reasoning_content` field, so this client reads ONLY `choices[0].message.content` — reasoning never reaches
 * the JSON parser. Structured output is `response_format: json_object` (GLM enforces no json_schema, so callers
 * Zod-validate the shape downstream). A missing key throws loud (fail-closed), never a fake success.
 */
const DEFAULT_BASE = 'https://api.z.ai/api/paas/v4/'
const DEFAULT_MODEL = 'glm-5.2'

const base = () => process.env.GLM_BASE_URL ?? DEFAULT_BASE
const model = () => process.env.GLM_MODEL ?? DEFAULT_MODEL
const key = () => process.env.GLM_API_KEY

interface ChatOpts {
  temperature?: number
  json?: boolean
  timeoutMs?: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices?: { message?: { content?: string; reasoning_content?: string } }[]
  error?: unknown
}

async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const apiKey = key()
  if (!apiKey) throw new Error('GLM_API_KEY is not set — cannot call GLM')
  const r = await fetch(`${base()}chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    body: JSON.stringify({
      model: model(),
      messages,
      temperature: opts.temperature ?? 0.6,
      thinking: { type: 'enabled' }, // default thinking; reasoning lands in reasoning_content, read only content
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  const j = (await r.json()) as ChatResponse
  if (!r.ok) throw new Error('glm: ' + JSON.stringify(j).slice(0, 300))
  // content ONLY — never concatenate reasoning_content (would corrupt JSON parsing).
  const content = j.choices?.[0]?.message?.content
  if (content == null) throw new Error('glm: empty content in response')
  return content
}

/** Free-text GLM call. */
export async function glmText(
  system: string,
  user: string,
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  return chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    opts,
  )
}

/**
 * Structured-JSON GLM call. GLM does NOT enforce a schema server-side, so `schema` is rendered into the system prompt
 * as a shape hint and `response_format: json_object` is set; the parsed object is returned for the caller to
 * Zod-validate. Mirrors `geminiJSON`'s positional signature so callsites swap in one line. Tolerant of prose/fenced
 * wrappers via `extractJson`.
 */
export async function glmJSON<T = unknown>(
  system: string,
  user: string,
  schema: object,
  temperature = 0.6,
): Promise<T> {
  const fullSystem = `${system}\n\nRespond with ONLY a JSON object matching this shape (no prose, no code fences):\n${JSON.stringify(schema)}`
  const raw = await chat(
    [
      { role: 'system', content: fullSystem },
      { role: 'user', content: user },
    ],
    { temperature, json: true },
  )
  return extractJson(raw) as T
}

/** First JSON value (object or array) in a model response that may wrap it in prose/fences. String-aware (unescaped
 *  inner quotes don't fool the brace walk). Exported so the worker reuses the same tolerance. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = (fenced ?? text).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    /* fall through to a string-aware brace/bracket walk */
  }
  const start = candidate.search(/[[{]/)
  if (start < 0) throw new Error('glm: no JSON found in response')
  const open = candidate[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1))
    }
  }
  throw new Error('glm: unbalanced JSON in response')
}
