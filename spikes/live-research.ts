/**
 * LIVE grounded research (ANALYSIS-VOICE-PLAN A1) — the real Vertex Gemini Google-Search-grounded call that
 * turns a confirmed identity into CITABLE facts, each paired with the source URL that grounds it. This is what
 * lets the reveal narration be specific + valuable (make/model/year + an interesting fact) while staying inside
 * the honesty gate. Auth is the same gcloud CLI token as identification — NO new creds.
 *
 * Run: `bun spikes/live-research.ts "1976 Canon AE-1"`  (defaults to the Canon AE-1).
 */
import { LiveResearcher } from '../services/eve-agent/agent/providers/live-research'

const label = process.argv[2] ?? '1976 Canon AE-1'
// Best-effort split of "YEAR MAKE MODEL…" for the item-scope keys (the research prompt uses make+base-model).
const m = /^(?:(\d{4})\s+)?(\S+)\s+(.+)$/.exec(label)
const make = m?.[2]
const model = m?.[3]

console.log(`\n── LIVE grounded research: "${label}" (item scope) ──`)
const researcher = new LiveResearcher()
const facts = await researcher.research({ scope: 'item', label, make, model, category: undefined })

console.log(`grounded facts: ${facts.length}`)
for (const f of facts) console.log(`  [${f.ref}] ${f.claim}\n        ↳ ${f.sourceUrl}`)

// A real success = at least one fact that carries a real http(s) source URL (grounded, not hallucinated).
const grounded = facts.filter((f) => /^https?:\/\//.test(f.sourceUrl))
console.log(`\n${grounded.length > 0 ? '✓' : '✗'} ${grounded.length} fact(s) carry a real grounding source URL`)
process.exit(grounded.length > 0 ? 0 : 1)
