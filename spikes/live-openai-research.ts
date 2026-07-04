/**
 * live-openai-research — CRED-GATED. Proves the Firecrawl→OpenAI gpt-5.4-mini grounding path END-TO-END on the real
 * vendors: a real Firecrawl /v2/search+scrape → real OpenAI gpt-5.4-mini verbatim-quote extraction. This is the shared
 * path now used by the BFF narration/research/dossier AND the podcast worker — and the substrate the honesty gate's
 * `verifyQuote` + `sourceMatchesSubject` depend on (both require the full page markdown Firecrawl returns).
 *
 * Deterministic verdict: ≥1 fact whose `quote` is a VERBATIM substring of its source markdown (the honesty gate's
 * `verifyQuote` invariant — `verbatimKey(quote) ⊆ verbatimKey(sourceText)`). A non-empty fact list with a verbatim
 * quote is PASS; empty is honest-empty (not a crash). Run: `bun spikes/live-openai-research.ts [Subject]`.
 * Keys pulled from env at call-time, NEVER printed.
 */
import { groundedFacts } from '../services/eve-agent/agent/lib/grounded-research'
import { verifyQuote } from '../services/eve-agent/agent/subagents/researcher'
import { firecrawlFromEnv } from '../services/eve-agent/agent/tools/web_research'

const web = firecrawlFromEnv()
if (!web) {
  console.error('FIRECRAWL_API_KEY not set in .env.local')
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set in .env.local')
  process.exit(1)
}

const SUBJECT = process.argv[2] ?? 'Canon AE-1'
console.log(`groundedFacts("${SUBJECT}") — Firecrawl → OpenAI gpt-5.4-mini (reasoning_effort:none)\n`)

const t0 = Date.now()
const { facts, sources } = await groundedFacts({ web, subject: SUBJECT, query: SUBJECT, item: true })
const elapsed = Date.now() - t0

console.log(`elapsed: ${elapsed}ms (bounded — NOT a >120s reasoning hang)`)
console.log(`sources fetched: ${sources.length}`)
for (const s of sources.slice(0, 4)) console.log(`  - ${s.title || '(no title)'} — ${s.url}`)

console.log(`\nfacts extracted: ${facts.length}`)
let verifiedCount = 0
let droppedCount = 0
for (const f of facts) {
  const q = f.quote.length > 140 ? `${f.quote.slice(0, 140)}…` : f.quote
  // the REAL honesty gate's verifyQuote (verbatimKey: stripMarkdown + lowercase + whitespace-collapsed substring).
  // A `false` here means the gate would DROP this fact in prod — that is the honesty gate WORKING, not a failure.
  const src = sources.find((s) => s.url === f.sourceUrl)?.text ?? ''
  const verified = verifyQuote(f.quote, src)
  if (verified) verifiedCount++
  else droppedCount++
  console.log(`  [${f.claimType}] ${f.text}`)
  console.log(`      quote:    "${q}"`)
  console.log(`      src:      ${f.sourceUrl}`)
  console.log(`      verified: ${verified}${verified ? '' : '  ← gate would DROP (non-verbatim) — honesty gate working'}`)
}

// PASS = the path flows end-to-end (≥1 verified fact) AND it's bounded. A non-zero droppedCount is fine — the gate
// dropping a non-verbatim quote is the honesty gate doing its job (the migration preserves it).
const ok = facts.length > 0 && verifiedCount > 0 && elapsed < 15_000
console.log(`\nverified: ${verifiedCount}/${facts.length} (dropped ${droppedCount} — gate working), elapsed ${elapsed}ms`)
console.log(`RESULT: ${facts.length === 0 ? 'no facts (honest-empty — not a crash)' : ok ? 'PASS — ≥1 verifyQuote-grounded fact, bounded, honesty gate armed' : 'FAIL (no verified facts or slow)'}`)
if (facts.length > 0 && !ok) process.exit(2)