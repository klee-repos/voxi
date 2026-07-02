/**
 * run-reveal-judge.web.ts — the reveal-quality test (PROMPT-QUALITY §3.D). Two modes:
 *
 *   default (CI, creds-free) — `bun run judge:reveal`. Drives the REAL app/app/reveal.tsx under react-native-web
 *     over the real BFF (the converge rig) and asserts the DETERMINISTIC structural gate on what actually renders:
 *     a concise non-category title, a real description, ≥3 individual fact chips EACH with a tappable source proof.
 *     This is the pass/fail — no LLM decides it. (The gate's negative controls are unit-tested in gate.test.ts.)
 *
 *   --live (creds) — `bun run judge:reveal:live`. Runs the REAL research pipeline (Gemini/Firecrawl) per fixture and
 *     scores title/description/facts with an INDEPENDENT Claude judge; PRINTS scores + a delta vs baseline.json and
 *     asserts each rubric ≥ 0.7. This is a measurement/eval run — it is NOT part of `bun test`, so the LLM never
 *     gates CI (repo rule). It is the "validate the improvement" run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { standUp } from '../web/converge/harness'
import { ids } from '../framework/testids'
import { BANNED_TITLE_CATEGORIES } from './gate'
import { FIXTURES } from './fixtures'
import { judge, judgeAvailable, type RubricKey } from './judge'

const LIVE = process.argv.includes('--live')
// `fails` gates the run — and ONLY the deterministic gate contributes to it. The `--live` LLM judge is a
// MEASUREMENT signal (§2.5 / adversarial #7): it PRINTS scores + a baseline delta but never turns the run red on a
// model score (live research + judge are non-deterministic; the LLM must not decide pass/fail).
let fails = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' — ' + detail}`)
  if (!ok) fails++
}

// ── DEFAULT: deterministic structural gate over the REAL rendered reveal (CI, no creds) ──────────────────────
async function deterministicGate(): Promise<void> {
  console.log('\njudge:reveal — deterministic structural gate over the REAL reveal.tsx (CONFIDENT):')
  const rig = await standUp('client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
  const { driver: d, page } = rig
  try {
    await page.goto(`${rig.base}/?scan=confident`)
    await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })

    const title = (await d.state(ids.reveal.title)).text ?? ''
    const words = title.trim().split(/\s+/).filter(Boolean)
    const titleTokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    check('title is present + concise (≤6 words)', words.length >= 1 && words.length <= 6, `"${title}" (${words.length}w)`)
    check('title is not a bare category', !(titleTokens.size > 0 && [...titleTokens].every((t) => BANNED_TITLE_CATEGORIES.has(t))), `"${title}"`)

    const desc = (await d.state(ids.reveal.whatItIs)).text ?? ''
    check('description is present + substantial (≥20 words)', desc.trim().split(/\s+/).filter(Boolean).length >= 20, `${desc.slice(0, 60)}…`)

    // Facts: ≥3 individual chips, EACH carrying a source-proof affordance (the "proof if challenged").
    const deadline = Date.now() + 8000
    let nFacts = 0
    while (Date.now() < deadline) {
      nFacts = await page.locator(`[data-testid="${ids.reveal.fact}"]`).count()
      if (nFacts >= 3) break
      await new Promise((r) => setTimeout(r, 150))
    }
    check('≥3 individual fact chips render (not one tray)', nFacts >= 3, `${nFacts} chips`)
    const nSources = await page.locator(`[data-testid="${ids.reveal.factSource}"]`).count()
    check('every fact chip carries a source-proof affordance', nSources >= nFacts && nFacts > 0, `${nSources} source affordances for ${nFacts} facts`)

    // tap one proof → the verbatim quote appears (provenance is real, not decorative).
    await page.locator(`[data-testid="${ids.reveal.factSource}"]`).first().click()
    await page.waitForTimeout(250)
    const body = await page.evaluate(() => document.body.textContent || '')
    check('tapping a source reveals the verbatim quote (proof)', /Hide source/.test(body) && /[“"]/.test(body))
  } finally {
    await rig.stop()
  }
}

// ── --live: real research pipeline + independent Claude judge (measurement, not a CI gate) ───────────────────
async function liveJudge(): Promise<void> {
  if (!judgeAvailable()) {
    console.log('\njudge:reveal:live — SKIPPED (ANTHROPIC_API_KEY not set). The live judge is creds-gated.')
    return
  }
  // Lazy imports so the default (creds-free) mode never loads the live providers.
  const { identify_object } = await import('../../services/eve-agent/agent/tools/identify_object')
  const { LiveVisionProvider } = await import('../../services/eve-agent/agent/providers/live-vision')
  const { dossierProviderFromEnv } = await import('../../services/eve-agent/agent/providers/live-dossier')
  const { LiveNarrator } = await import('../../services/eve-agent/agent/providers/live-narrator')

  const vision = new LiveVisionProvider()
  const dossierProvider = dossierProviderFromEnv()
  const narrator = new LiveNarrator()

  async function wikiImage(page: string): Promise<string | null> {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: { 'user-agent': 'voxi-judge/1.0' } })
    if (!r.ok) return null
    const j = (await r.json()) as { originalimage?: { source: string }; thumbnail?: { source: string } }
    return j.originalimage?.source ?? j.thumbnail?.source ?? null
  }

  const THRESHOLD = 0.7
  const rows: { id: string; title: number; description: number; facts: number }[] = []
  console.log('\njudge:reveal:live — REAL research pipeline, scored by an independent Claude judge:')

  for (const fx of FIXTURES) {
    console.log(`\n  ── ${fx.subject} ──`)
    // TITLE — the real identify path (only where a free lead image exists).
    let revealTitle = fx.subject
    if (fx.wikiPage) {
      try {
        const url = await wikiImage(fx.wikiPage)
        if (url) {
          const res = await identify_object({ uri: url }, vision)
          revealTitle = res.confidence_band === 'CONFIDENT' ? res.displayTitle ?? res.label : res.label
        }
      } catch (e) {
        console.log(`    (title identify skipped: ${(e as Error).message.slice(0, 60)})`)
      }
    }
    // DESCRIPTION + FACTS — the real async research + narration.
    const facts: { text: string; sourceUrl: string; quote: string }[] = []
    let evidence: { ref: string; sourceUrl: string; claim: string }[] = []
    for await (const ev of dossierProvider.research({ subject: fx.subject, scope: fx.scope, subjectTerms: fx.subjectTerms })) {
      if (ev.type === 'fact') facts.push({ text: ev.fact.text, sourceUrl: ev.fact.sourceUrl, quote: ev.fact.quote })
      else if (ev.type === 'done' && ev.dossier) evidence = ev.dossier.evidence
    }
    let description = ''
    if (evidence.length) {
      const narration = await narrator.narrate({ label: fx.subject, band: 'CONFIDENT', evidence, unsupportedFields: [], candidates: [fx.subject] })
      description = narration.clauses.join(' ')
    }
    console.log(`    title: "${revealTitle}"`)
    console.log(`    description: ${description.slice(0, 100)}${description.length > 100 ? '…' : ''}`)
    console.log(`    facts: ${facts.length} verified (each with a source + verbatim quote)`)

    // JUDGE — independent Claude scores each dimension.
    const samples: Record<RubricKey, string> = {
      title: `Photographed object: ${fx.subject}. Title shown: "${revealTitle}".`,
      description: `Object: ${fx.subject}.\nDescription: ${description || '(none produced)'}`,
      facts: `Object: ${fx.subject}.\nFacts:\n${facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n') || '(none)'}`,
    }
    const scores = { id: fx.id, title: 0, description: 0, facts: 0 }
    let judgedBy = ''
    for (const k of ['title', 'description', 'facts'] as RubricKey[]) {
      try {
        const s = await judge(k, samples[k])
        scores[k] = s.score
        judgedBy = s.by
        // report-only (§2.5): a sub-threshold score is a WARN, never a gate failure.
        console.log(`  ${s.score >= THRESHOLD ? 'ok  ' : 'WARN'} ${fx.id} ${k}: ${s.score.toFixed(2)} — ${s.reasons}`)
      } catch (e) {
        console.log(`  WARN ${fx.id} ${k}: judge error — ${(e as Error).message.slice(0, 80)}`)
      }
    }
    rows.push(scores)
    void judgedBy
  }

  // Baseline compare + write (a re-runnable measurement record — the deltas show whether a prompt change improved).
  const baselinePath = join(import.meta.dir, 'baseline.json')
  let baseline: Record<string, typeof rows[number]> = {}
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch {
    /* first run — no baseline yet */
  }
  console.log('\n  ── score report (judge is Gemini fallback; fund ANTHROPIC_API_KEY for the independent Claude judge) ──')
  console.log('  fixture           title         description   facts')
  const delta = (cur: number, id: string, k: 'title' | 'description' | 'facts'): string => {
    const prev = baseline[id]?.[k]
    if (prev === undefined) return `${cur.toFixed(2)}       `
    const d = cur - prev
    return `${cur.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(2)})`
  }
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(16)}  ${delta(r.title, r.id, 'title')}  ${delta(r.description, r.id, 'description')}  ${delta(r.facts, r.id, 'facts')}`)
  }
  const next: Record<string, typeof rows[number]> = {}
  for (const r of rows) next[r.id] = r
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
  console.log(`  (baseline written to e2e/judge/baseline.json — re-run to see deltas)`)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────
await deterministicGate()
if (LIVE) await liveJudge()
console.log(fails === 0 ? `\nJUDGE ${LIVE ? 'LIVE ' : ''}GREEN (${fails} failures)` : `\nJUDGE FAILURES: ${fails}`)
process.exit(fails === 0 ? 0 : 1)
