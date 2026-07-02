/**
 * LIVE deep-research dossier (PROMPT-QUALITY §3.B). Runs the REAL dossierProviderFromEnv() — Firecrawl deep crawl
 * (if FIRECRAWL_API_KEY) → Gemini fact extraction with verbatim quotes → the CLOSED PROVENANCE LOOP (quote⊆source
 * + sourceMatchesSubject + quote⊨text) — and prints each VERIFIED fact with its attached proof. No Firecrawl key →
 * the Gemini-grounding fallback (gcloud only). Run: `bun spikes/live-dossier.ts "Canon AE-1"`.
 */
import { dossierProviderFromEnv } from '../services/eve-agent/agent/providers/live-dossier'
import type { DossierInput } from '../services/eve-agent/agent/subagents/researcher'

const subject = process.argv[2] ?? 'Canon AE-1'
const parts = subject.split(/\s+/)
const input: DossierInput = {
  subject,
  scope: 'item',
  subjectTerms: parts.length >= 2 ? [parts[0]!, parts.slice(1).join(' ')] : [subject],
}

console.log(`\n── LIVE dossier research: "${subject}" (Firecrawl=${process.env.FIRECRAWL_API_KEY ? 'on' : 'off → Gemini grounding'}) ──`)
const provider = dossierProviderFromEnv()
let n = 0
let dossierFacts = 0
for await (const ev of provider.research(input)) {
  if (ev.type === 'fact') {
    n++
    console.log(`\n  [${n}] ${ev.fact.text}`)
    console.log(`      ↳ PROOF: “${ev.fact.quote}”`)
    console.log(`      ↳ SOURCE: ${ev.fact.sourceTitle || ''} ${ev.fact.sourceUrl}`)
  } else if (ev.type === 'done') {
    dossierFacts = ev.dossier?.facts.length ?? 0
  }
}
console.log(`\n${n >= 1 ? '✓' : '✗'} ${n} verified fact(s) surfaced, each with a real source + verbatim quote (dossier held ${dossierFacts}).`)
process.exit(n >= 1 ? 0 : 1)
