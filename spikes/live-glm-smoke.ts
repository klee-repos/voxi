/**
 * live-glm-smoke — CRED-GATED. Validates the GLM-5.2 assumptions the migration rests on, against the live z.ai API:
 *   1. `response_format:{type:'json_object'}` is honored (GLM-5.2 is absent from the docs' supporting-models list).
 *   2. `thinking` (default enabled) emits as a SEPARATE `reasoning_content` field — `content` alone parses as JSON.
 *   3. `lib/glm.ts` (`glmJSON`/`glmText`) round-trips end-to-end with the real endpoint + key.
 * Run: `bun spikes/live-glm-smoke.ts` (reads GLM_API_KEY / GLM_BASE_URL from .env.local, which Bun auto-loads).
 */
const BASE = process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/paas/v4/'
const KEY = process.env.GLM_API_KEY
if (!KEY) {
  console.error('GLM_API_KEY is not set — put it in .env.local')
  process.exit(1)
}

console.log(`endpoint: ${BASE}chat/completions  model: glm-5.2  thinking: enabled (default)\n`)

// --- 1. RAW call: inspect the full response shape (content vs reasoning_content, json_object enforcement) ---
const res = await fetch(`${BASE}chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'glm-5.2',
    messages: [
      {
        role: 'system',
        content:
          'Extract verbatim facts. Respond with ONLY JSON shaped {"facts":[{"text":"","claimType":"spec|provenance|date","quote":"","sourceUrl":""}]}. Copy each quote EXACTLY from the user sources.',
      },
      {
        role: 'user',
        content:
          'Subject: the Canon AE-1 35mm SLR.\n\nSOURCE https://en.wikipedia.org/wiki/Canon_AE-1 (Canon AE-1):\nThe Canon AE-1 is a 35mm single-lens reflex camera introduced by Canon in 1976. It was the first SLR with a microprocessor. Over 5.7 million units were sold.',
      },
    ],
    temperature: 0.2,
    thinking: { type: 'enabled' },
    response_format: { type: 'json_object' },
  }),
})
const raw = (await res.json()) as {
  choices?: { message?: { content?: string; reasoning_content?: string } }[]
  usage?: { total_tokens?: number; completion_tokens?: number; prompt_tokens?: number }
  error?: unknown
}
console.log('RAW STATUS:', res.status, res.ok ? '(ok)' : '(FAILED)')
if (!res.ok) {
  console.log('RAW ERROR BODY:', JSON.stringify(raw).slice(0, 500))
  process.exit(2)
}
const msg = raw.choices?.[0]?.message
const content = msg?.content ?? ''
const reasoning = msg?.reasoning_content ?? ''
console.log('HAS content           :', content.length > 0, `(${content.length} chars)`)
console.log('HAS reasoning_content :', reasoning.length > 0, `(${reasoning.length} chars)`)
console.log('content parses as JSON:', (() => { try { JSON.parse(content); return true } catch { return false } })())
console.log('content preview       :', content.slice(0, 280).replace(/\n/g, ' '))
console.log('usage                 :', raw.usage)

// --- 2. Via lib/glm.ts: confirm glmJSON round-trips (reads content only, tolerant parse) ---
const { glmJSON } = await import('../services/eve-agent/agent/lib/glm')
try {
  const out = await glmJSON<{ facts?: { text: string; claimType: string; quote: string; sourceUrl: string }[] }>(
    'Extract verbatim facts about the subject. Copy each quote EXACTLY from the supplied source markdown.',
    'Subject: the Sony Walkman TPS-L2.\n\nSOURCE https://en.wikipedia.org/wiki/Walkman (Walkman):\nThe Sony Walkman TPS-L2 went on sale in July 1979. It was the first portable cassette player. It had two headphone jacks.',
    { type: 'object', properties: { facts: { type: 'array' } } },
    0.2,
  )
  console.log('\nglmJSON round-trip OK :', (out.facts?.length ?? 0), 'facts')
  console.log('  first fact          :', JSON.stringify(out.facts?.[0] ?? null).slice(0, 220))
} catch (e) {
  console.error('\nglmJSON FAILED        :', (e as Error).message)
  process.exit(3)
}

console.log('\nSMOKE RESULT: PASS')
