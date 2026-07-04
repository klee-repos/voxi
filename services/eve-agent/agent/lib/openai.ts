/**
 * Live OpenAI (gpt-5.4-mini, Chat Completions) calls — the model behind narration/title, fact extraction, the
 * grounded-research extractor, and the interview script. Authed by an API key. `reasoning_effort: 'none'` is set
 * explicitly so the model NEVER enters a reasoning phase (the stall fix: unbounded reasoning on the narrator
 * prompt hung GLM-5.2 >120s; 'none' makes the stall structurally impossible — verified, reasoning_tokens:0).
 * `max_completion_tokens` bounds output so even a runaway can't hang. This client reads ONLY
 * `choices[0].message.content` (no reasoning channel is emitted at effort:'none'). Structured output is
 * `response_format: json_object` (OpenAI enforces no json_schema here, so callers Zod-validate downstream). A
 * missing key throws loud (fail-closed), never a fake success.
 */
const DEFAULT_BASE = 'https://api.openai.com/v1/'
const DEFAULT_MODEL = 'gpt-5.4-mini'

const base = () => process.env.OPENAI_BASE_URL ?? DEFAULT_BASE
const model = () => process.env.OPENAI_MODEL ?? DEFAULT_MODEL
const key = () => process.env.OPENAI_API_KEY
const defaultMaxTokens = () => Number(process.env.OPENAI_MAX_TOKENS) || 8192

interface ChatOpts {
  temperature?: number
  json?: boolean
  timeoutMs?: number
  maxTokens?: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: unknown
}

async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const apiKey = key()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — cannot call OpenAI')
  const r = await fetch(`${base()}chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    body: JSON.stringify({
      model: model(),
      messages,
      temperature: opts.temperature ?? 0.6,
      reasoning_effort: 'none', // the stall fix — no reasoning phase can run away
      max_completion_tokens: opts.maxTokens ?? defaultMaxTokens(),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  const j = (await r.json()) as ChatResponse
  if (!r.ok) throw new Error('openai: ' + JSON.stringify(j).slice(0, 300))
  const content = j.choices?.[0]?.message?.content
  if (content == null) throw new Error('openai: empty content in response')
  return content
}

/** Free-text OpenAI call. */
export async function openaiText(
  system: string,
  user: string,
  opts: { temperature?: number; timeoutMs?: number; maxTokens?: number } = {},
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
 * Per-call timeout for the BFF's generative OpenAI calls (narration, dossier, researcher). A hung call never sinks a
 * reveal: the call throws at `timeoutMs` and the caller's retry/backstop takes over. Env-overridable so an RCA can
 * shorten it without a redeploy. No default applied here — callers that omit `timeoutMs` stay UNTIMED (the worker's
 * own script path, the unit-test fast path) for backward compat.
 */
export const OPENAI_CALL_TIMEOUT_MS = Number(process.env.OPENAI_CALL_TIMEOUT_MS) || 90_000

/**
 * Structured-JSON OpenAI call. OpenAI does NOT enforce a schema here, so `schema` is rendered into the system prompt
 * as a shape hint and `response_format: json_object` is set; the parsed object is returned for the caller to
 * Zod-validate. Mirrors `geminiJSON`'s positional signature so callsites swap in one line. Tolerant of prose/fenced
 * wrappers via `extractJson`. `timeoutMs` opts into the per-call timeout (see `OPENAI_CALL_TIMEOUT_MS`); omitted →
 * untimed (the worker script + tests), so the migration is per-callsite, not blanket. `maxTokens` overrides the
 * per-call output bound (default `OPENAI_MAX_TOKENS` || 8192); the script callsite passes 16384 (longer output).
 */
export async function openaiJSON<T = unknown>(
  system: string,
  user: string,
  schema: object,
  temperature = 0.6,
  timeoutMs?: number,
  maxTokens?: number,
): Promise<T> {
  const fullSystem = `${system}\n\nRespond with ONLY a JSON object matching this shape (no prose, no code fences):\n${JSON.stringify(schema)}`
  const raw = await chat(
    [
      { role: 'system', content: fullSystem },
      { role: 'user', content: user },
    ],
    { temperature, json: true, timeoutMs, maxTokens },
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
  if (start < 0) throw new Error('openai: no JSON found in response')
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
  throw new Error('openai: unbalanced JSON in response')
}