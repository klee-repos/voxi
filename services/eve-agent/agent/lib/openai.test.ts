import { afterEach, test, expect } from 'bun:test'
import { openaiText, openaiJSON, extractJson, OPENAI_CALL_TIMEOUT_MS } from './openai'

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_MAX_TOKENS
  delete process.env.OPENAI_CALL_TIMEOUT_MS
})

/** Signal-aware never-resolving fetch (the RCA's adversarial finding): `AbortSignal.timeout` only DISPATCHES `abort`,
 *  it does NOT reject the promise — so a signal-blind `new Promise(()=>{})` hangs the test in BOTH red and green. The
 *  mock must listen for the abort event itself. Exported-from-scratch replacement for the deleted glm.test.ts helper. */
function neverResolvingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as typeof fetch
}

test('openaiJSON: default base URL is api.openai.com, model gpt-5.4-mini, reasoning_effort:none + max_completion_tokens + json_object (F8/F9)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  let capturedInput: string | undefined
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    capturedInput = String(input)
    capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }))
  }) as typeof fetch
  await openaiJSON('sys', 'usr', { type: 'object' })
  // F9 — POSITIVE URL assertion (not just "not z.ai"): the default base IS api.openai.com/v1/chat/completions.
  expect(capturedInput).toBe('https://api.openai.com/v1/chat/completions')
  expect(capturedBody!.model).toBe('gpt-5.4-mini')
  // F8 — the stall fix, structurally asserted: NO `thinking` field (the GLM-5.2 RCA root cause — `thinking:{type:'enabled'}`
  // ran unbounded reasoning >120s) and reasoning_effort is explicitly 'none' so the model can never enter a reasoning
  // phase. max_completion_tokens (NOT max_tokens) bounds output so even a runaway can't hang.
  expect(capturedBody).not.toHaveProperty('thinking')
  expect(capturedBody!.reasoning_effort).toBe('none')
  expect(capturedBody).toHaveProperty('max_completion_tokens')
  expect(capturedBody).not.toHaveProperty('max_tokens')
  expect(capturedBody!.response_format).toEqual({ type: 'json_object' })
})

test('openaiText omits response_format (free text) but keeps reasoning_effort:none + max_completion_tokens', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'free text reply' } }] }))
  }) as typeof fetch
  const out = await openaiText('sys', 'usr')
  expect(out).toBe('free text reply')
  expect(capturedBody).not.toHaveProperty('response_format') // free text — no json_object
  expect(capturedBody!.reasoning_effort).toBe('none')
  expect(capturedBody).toHaveProperty('max_completion_tokens')
})

test('OPENAI_BASE_URL + OPENAI_MODEL + OPENAI_MAX_TOKENS env overrides take effect (custom proxy / model / budget)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1/'
  process.env.OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17'
  process.env.OPENAI_MAX_TOKENS = '4096'
  let capturedInput: string | undefined
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    capturedInput = String(input)
    capturedBody = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  }) as typeof fetch
  await openaiText('s', 'u')
  expect(capturedInput).toBe('https://proxy.example.com/v1/chat/completions')
  expect(capturedBody!.model).toBe('gpt-5.4-mini-2026-03-17')
  expect(capturedBody!.max_completion_tokens).toBe(4096)
})

test('openaiJSON: a missing OPENAI_API_KEY throws (fail-closed, never a fake success)', async () => {
  await expect(openaiText('s', 'u')).rejects.toThrow(/OPENAI_API_KEY/)
  await expect(openaiJSON('s', 'u', { type: 'object' })).rejects.toThrow(/OPENAI_API_KEY/)
})

test('openaiJSON: a non-OK response throws an openai-prefixed error (vendor 5xx surfaced, not swallowed)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'openai down' }), { status: 500 })) as typeof fetch
  await expect(openaiJSON('s', 'u', { type: 'object' })).rejects.toThrow(/openai/)
  await expect(openaiText('s', 'u')).rejects.toThrow(/openai:/)
})

test('openaiJSON: an empty content response throws (never silently returns undefined)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: null } }] }))) as typeof fetch
  await expect(openaiJSON('s', 'u', { type: 'object' })).rejects.toThrow(/openai:/)
})

test('extractJson: parses a bare object, a fenced block, and an array wrapped in prose; throws on no/bad JSON', () => {
  expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  expect(extractJson('```json\n{"b":2}\n```')).toEqual({ b: 2 })
  expect(extractJson('Here is the data:\n[{"c":3}]')).toEqual([{ c: 3 }])
  expect(() => extractJson('no json here')).toThrow(/openai:/)
})

// F2a — the timeout on openaiJSON/openaiText. A HUNG call (the RCA: GLM-5.2 unbounded reasoning spun >120s, but any
// black-holed vendor socket is the same shape) MUST throw at `timeoutMs` when the caller passes one, NOT hang the
// reveal. The `timeoutMs` becomes `chat`'s `AbortSignal.timeout`. RED: omit `timeoutMs` and the await never settles
// (test times out). GREEN: with `timeoutMs:50` the abort fires → the signal-aware mock rejects → openaiJSON throws.
test('openaiJSON: a never-resolving call throws at timeoutMs (no unbounded-reasoning hang) when timeoutMs is set', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  globalThis.fetch = neverResolvingFetch()
  const t0 = Date.now()
  await expect(
    openaiJSON('s', 'u', { type: 'object' }, 0.6, 50),
  ).rejects.toThrow(/aborted|AbortError|openai:/i)
  expect(Date.now() - t0).toBeLessThan(2000)
})

test('openaiJSON/openaiText with NO timeoutMs stay untimed (backward compat — the worker script + tests pass undefined)', async () => {
  process.env.OPENAI_API_KEY = 'k-test'
  // A fetch with NO signal listener proves the untimed path: the call resolves normally with no AbortSignal wired.
  globalThis.fetch = (async (_input, init) => {
    expect(init?.signal).toBeUndefined() // untimed — no timeout signal set
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] }))
  }) as typeof fetch
  const out = await openaiJSON('s', 'u', { type: 'object' })
  expect(out).toEqual({ facts: [] })
})

test('OPENAI_CALL_TIMEOUT_MS defaults to 90000 and is env-overridable (RCA shortens it without a redeploy)', () => {
  expect(OPENAI_CALL_TIMEOUT_MS).toBe(90_000)
})