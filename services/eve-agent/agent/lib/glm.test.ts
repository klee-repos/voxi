import { afterEach, test, expect } from 'bun:test'
import { glmJSON, glmText, extractJson } from './glm'

const origFetch = globalThis.fetch

type Captured = { url: string; method?: string; auth?: string; body?: unknown }
let lastReq: Captured | undefined

function mockFetch(
  content: string,
  opts: { reasoningContent?: string; ok?: boolean; status?: number; payload?: unknown } = {},
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    lastReq = {
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method,
      auth: headers.authorization,
      body: init?.body != null ? JSON.parse(String(init.body)) : undefined,
    }
    const ok = opts.ok ?? true
    const payload =
      opts.payload ?? { choices: [{ message: { content, reasoning_content: opts.reasoningContent } }] }
    return new Response(JSON.stringify(payload), { status: ok ? 200 : opts.status ?? 500 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = origFetch
  lastReq = undefined
  delete process.env.GLM_API_KEY
  delete process.env.GLM_BASE_URL
})

test('glmJSON reads content only (ignores reasoning_content), sends json_object + thinking:enabled', async () => {
  process.env.GLM_API_KEY = 'k-test'
  mockFetch('{"title":"X","description":"y"}', { reasoningContent: 'let me reason about this...' })
  const out = await glmJSON(
    'be the narrator',
    'describe a brick',
    { type: 'object', properties: { title: { type: 'string' } } },
    0.7,
  )
  expect(out).toEqual({ title: 'X', description: 'y' })
  expect(lastReq?.url).toMatch(/\/chat\/completions$/)
  expect(lastReq?.auth).toBe('Bearer k-test')
  expect(lastReq?.body).toMatchObject({
    model: 'glm-5.2',
    thinking: { type: 'enabled' },
    response_format: { type: 'json_object' },
    temperature: 0.7,
  })
  // the schema hint is rendered into the system prompt, not sent as a vendor schema field
  const messages = (lastReq?.body as { messages: { role: string; content: string }[] }).messages
  expect(messages[0]?.role).toBe('system')
  expect(messages[0]?.content).toContain('JSON object matching this shape')
})

test('glmText omits response_format (free text)', async () => {
  process.env.GLM_API_KEY = 'k-test'
  mockFetch('hello world')
  const out = await glmText('sys', 'usr')
  expect(out).toBe('hello world')
  expect((lastReq?.body as { response_format?: unknown }).response_format).toBeUndefined()
})

test('respects GLM_BASE_URL override', async () => {
  process.env.GLM_API_KEY = 'k-test'
  process.env.GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/'
  mockFetch('{"a":1}')
  await glmJSON('s', 'u', { type: 'object' })
  expect(lastReq?.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
})

test('throws loud when GLM_API_KEY is unset (fail-closed, never a fake success)', async () => {
  delete process.env.GLM_API_KEY
  mockFetch('noop')
  await expect(glmText('s', 'u')).rejects.toThrow(/GLM_API_KEY/)
  await expect(glmJSON('s', 'u', { type: 'object' })).rejects.toThrow(/GLM_API_KEY/)
})

test('throws on a non-2xx (vendor error surfaces, not swallowed)', async () => {
  process.env.GLM_API_KEY = 'k-test'
  mockFetch('', { ok: false, status: 429, payload: { error: 'rate limit' } })
  await expect(glmText('s', 'u')).rejects.toThrow(/glm:/)
})

test('extractJson tolerates prose wrappers, code fences, and arrays', () => {
  expect(extractJson('sure! {"a":1} done')).toEqual({ a: 1 })
  expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  expect(extractJson('text before [1,2,3] tail after')).toEqual([1, 2, 3])
  expect(() => extractJson('no json here')).toThrow(/no JSON/)
})
