/**
 * live-glm-research — CRED-GATED. Proves the Firecrawl→GLM-5.2 grounding path END-TO-END on the real vendors: a real
 * Firecrawl /v2/search+scrape → real GLM-5.2 verbatim-quote extraction. This is the path now shared by the BFF
 * narration/research/dossier and the podcast worker. Run: `bun spikes/live-glm-research.ts [Subject]`.
 */
import { groundedFacts } from '../services/eve-agent/agent/lib/grounded-research'
import { firecrawlFromEnv } from '../services/eve-agent/agent/tools/web_research'

const web = firecrawlFromEnv()
if (!web) {
  console.error('FIRECRAWL_API_KEY not set in .env.local')
  process.exit(1)
}
if (!process.env.GLM_API_KEY) {
  console.error('GLM_API_KEY not set in .env.local')
  process.exit(1)
}

const SUBJECT = process.argv[2] ?? 'Canon AE-1'
console.log(`groundedFacts("${SUBJECT}") — Firecrawl → GLM-5.2 (default thinking)\n`)

const { facts, sources } = await groundedFacts({ web, subject: SUBJECT, query: SUBJECT, item: true })

console.log(`sources fetched: ${sources.length}`)
for (const s of sources.slice(0, 4)) console.log(`  - ${s.title || '(no title)'} — ${s.url}`)

console.log(`\nfacts extracted: ${facts.length}`)
for (const f of facts) {
  const q = f.quote.length > 140 ? `${f.quote.slice(0, 140)}…` : f.quote
  console.log(`  [${f.claimType}] ${f.text}`)
  console.log(`      quote: "${q}"`)
  console.log(`      src:   ${f.sourceUrl}`)
}
console.log(`\nRESULT: ${facts.length === 0 ? 'no facts (honest-empty)' : 'PASS'}`)
