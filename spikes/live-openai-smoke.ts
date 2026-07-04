/**
 * live-openai-smoke — CRED-GATED. Validates the OpenAI gpt-5.4-mini assumptions the migration rests on, against the
 * real OpenAI Chat Completions API — the BACKEND artifact this swap actually ships. Three deterministic claims:
 *   1. `reasoning_effort:'none'` emits NO `reasoning_content` (the stall fix: no reasoning phase can run away —
 *      the GLM-5.2 RCA root cause was `thinking:{type:'enabled'}` running unbounded >120s).
 *   2. `response_format:{type:'json_object'}` is honored (content parses as JSON).
 *   3. `lib/openai.ts` (`openaiJSON`/`openaiText`) round-trips end-to-end with the real endpoint + key, BOUNDED
 *      (<10s — no unbounded-reasoning hang).
 * Run: `bun spikes/live-openai-smoke.ts` (reads OPENAI_API_KEY / OPENAI_BASE_URL from .env.local, which Bun auto-loads).
 * The key is pulled from env at call-time and NEVER printed.
 */
const BASE = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/'
const KEY = process.env.OPENAI_API_KEY
if (!KEY) {
  console.error('OPENAI_API_KEY is not set — put it in .env.local')
  process.exit(1)
}

console.log(`endpoint: ${BASE}chat/completions  model: gpt-5.4-mini  reasoning_effort: none (the stall fix)\n`)

// --- 1. RAW call: inspect the full response shape (no reasoning_content, json_object enforcement, usage) ---
const t0 = Date.now()
const res = await fetch(`${BASE}chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-5.4-mini',
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
    reasoning_effort: 'none', // the stall fix — NO reasoning phase can run away
    max_completion_tokens: 8192,
    response_format: { type: 'json_object' },
  }),
})
const raw = (await res.json()) as {
  choices?: { message?: { content?: string; reasoning_content?: string }[] }[]
  usage?: { total_tokens?: number; completion_tokens?: number; prompt_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
  error?: unknown
}
const elapsed1 = Date.now() - t0
console.log('RAW STATUS:', res.status, res.ok ? '(ok)' : '(FAILED)')
if (!res.ok) {
  console.log('RAW ERROR BODY:', JSON.stringify(raw).slice(0, 500))
  process.exit(2)
}
const msg = raw.choices?.[0]?.message
const content = msg?.content ?? ''
const reasoning = msg?.reasoning_content ?? ''
console.log('elapsed_ms            :', elapsed1, elapsed1 < 10_000 ? '(bounded — NOT a >120s reasoning hang)' : '(SLOW!)')
console.log('HAS content           :', content.length > 0, `(${content.length} chars)`)
console.log('HAS reasoning_content :', reasoning.length > 0, `(${reasoning.length} chars)  ← MUST be false (the stall fix)`)
console.log('content parses as JSON:', (() => { try { JSON.parse(content); return true } catch { return false } })())
console.log('content preview       :', content.slice(0, 280).replace(/\n/g, ' '))
console.log('usage                 :', raw.usage)
console.log('reasoning_tokens      :', raw.usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a', '← MUST be 0/absent')

// --- 2. Via lib/openai.ts: confirm openaiJSON round-trips (reads content only, tolerant parse) ---
const { openaiJSON } = await import('../services/eve-agent/agent/lib/openai')
const t1 = Date.now()
try {
  const out = await openaiJSON<{ facts?: { text: string; claimType: string; quote: string; sourceUrl: string }[] }>(
    'Extract verbatim facts about the subject. Copy each quote EXACTLY from the supplied source markdown.',
    'Subject: the Sony Walkman TPS-L2.\n\nSOURCE https://en.wikipedia.org/wiki/Walkman (Walkman):\nThe Sony Walkman TPS-L2 went on sale in July 1979. It was the first portable cassette player. It had two headphone jacks.',
    { type: 'object', properties: { facts: { type: 'array' } } },
    0.2,
  )
  const elapsed2 = Date.now() - t1
  console.log('\nopenaiJSON round-trip OK :', (out.facts?.length ?? 0), 'facts', `(${elapsed2}ms)`)
  console.log('  first fact             :', JSON.stringify(out.facts?.[0] ?? null).slice(0, 220))
  if (elapsed2 > 10_000) { console.error('SLOW openaiJSON call — investigate'); process.exit(3) }
} catch (e) {
  console.error('\nopenaiJSON FAILED        :', (e as Error).message)
  process.exit(3)
}

// --- 3. Verdict: the deterministic assertions the migration rests on ---
const ok =
  reasoning.length === 0 && // no reasoning phase — the stall is structurally impossible
  (raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0) === 0 &&
  elapsed1 < 10_000 &&
  (() => { try { JSON.parse(content); return true } catch { return false } })()
console.log('\nSMOKE RESULT:', ok ? 'PASS — stall structurally impossible, json_object honored, bounded' : 'FAIL')
if (!ok) process.exit(4)