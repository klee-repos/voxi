/**
 * reveal-buckets.ts — the BUCKET-QUALITY proof (REVEAL-CONTENT-QUALITY-PLAN §13.5; the user's proof-of-improvement).
 *
 * Unlike run-reveal-judge.web.ts (which hand-feeds a subject to narrate() at a HARDCODED band), this drives the REAL
 * `runIdentificationCascade` end-to-end over a REAL branded-object image, so the actual fix under test — the VLM
 * reading the brand, arbitration landing PROBABLE, the observed-evidence + brand-lane path — is exercised. It then:
 *   1. captures the four buckets FROM THE EMITTED EVENTS (token/description_upgrade → what; section → purpose/maker;
 *      fact → facts) — never a reconstructed narrate();
 *   2. reports the arbitrated band (a branded fixture should be PROBABLE — that's where the old code went generic);
 *   3. scores each bucket with the INDEPENDENT Claude judge (judgeIndependent — NO Gemini fallback, so the proof is
 *      never Gemini-judging-Gemini), N times, and reports mean ± spread;
 *   4. compares against a FROZEN baseline-buckets.json (the BEFORE, captured on old code) — written ONLY under
 *      --write-baseline, never self-overwritten;
 *   5. asserts a deterministic honesty NEGATIVE control: no fabricated maker on an anonymous object.
 *
 * Report-only — never gates CI (repo rule: the LLM never decides pass/fail; the deterministic gate.ts + unit tests
 * do). This is the "validate the improvement" run. Creds: gcloud + FIRECRAWL_API_KEY + ANTHROPIC_API_KEY.
 *   bun e2e/judge/reveal-buckets.ts                 # measure + delta vs frozen baseline
 *   bun e2e/judge/reveal-buckets.ts --write-baseline # freeze the current output as the BEFORE (run on OLD code)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runIdentificationCascade } from '../../services/eve-agent/agent/cascade'
import { LiveVisionProvider } from '../../services/eve-agent/agent/providers/live-vision'
import { LiveSafetyClassifier } from '../../services/eve-agent/agent/providers/live-safety'
import { LiveNarrator } from '../../services/eve-agent/agent/providers/live-narrator'
import { LiveResearcher } from '../../services/eve-agent/agent/providers/live-research'
import { dossierProviderFromEnv } from '../../services/eve-agent/agent/providers/live-dossier'
import { loadImageBytes } from '../../services/eve-agent/agent/lib/gcp-vision'
import { judgeIndependent, type RubricKey } from './judge'

const WRITE_BASELINE = process.argv.includes('--write-baseline')
const N = Number(process.env.JUDGE_SAMPLES ?? 2) // samples per bucket → mean ± spread (LLM non-determinism)
const BUCKETS: RubricKey[] = ['what', 'purpose', 'maker', 'facts']

interface Fixture {
  id: string
  subject: string
  wikiPage: string
  /** honest expectation: a clearly-branded object the arbiter cannot place to a model should hedge to PROBABLE. */
  expectBand?: 'PROBABLE' | 'CONFIDENT'
  /** the maker bucket should name this brand (a substring check — proof the read brand reached the reveal). */
  expectBrand?: string
  /** an anonymous object: assert NO fabricated maker (the honesty negative control). */
  negativeControl?: boolean
}

// Real, fetchable Wikipedia lead images. The Sub Pop logo is the SAME input as docs/reveal-quality-baseline-before.txt
// (arbitrates PROBABLE with the read brand), so before/after is apples-to-apples on the identical image.
const FIXTURES: Fixture[] = [
  { id: 'subpop', subject: 'Sub Pop', wikiPage: 'Sub_Pop', expectBand: 'PROBABLE', expectBrand: 'sub pop' },
  { id: 'anon-mug', subject: 'a plain mug', wikiPage: 'Mug', negativeControl: true },
]

interface Captured { band: string; title: string; what: string; purpose: string; maker: string; facts: string[] }

async function wikiImage(page: string): Promise<string | null> {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { headers: { 'user-agent': 'voxi-judge/1.0' } })
  if (!r.ok) return null
  const j = (await r.json()) as { originalimage?: { source: string }; thumbnail?: { source: string } }
  return j.originalimage?.source ?? j.thumbnail?.source ?? null
}

async function captureBuckets(imageUri: string): Promise<Captured> {
  const whatTokens: string[] = []
  const sections: Record<string, string> = {}
  const facts: string[] = []
  let band = '', title = '', upgrade = ''
  for await (const ev of runIdentificationCascade('proof', { uri: imageUri, userId: 'proof' }, {
    vision: new LiveVisionProvider(),
    safety: new LiveSafetyClassifier(),
    narrator: new LiveNarrator(),
    researcher: new LiveResearcher(),
    dossier: dossierProviderFromEnv(),
  })) {
    if (ev.type === 'confidence_band') { band = ev.band; title = ev.title }
    else if (ev.type === 'token') whatTokens.push(ev.text)
    else if (ev.type === 'description_upgrade') upgrade = ev.text
    else if (ev.type === 'section') sections[ev.bucket] = ev.text
    else if (ev.type === 'fact') facts.push(ev.text)
  }
  return { band, title, what: upgrade || whatTokens.join(' '), purpose: sections.purpose ?? '', maker: sections.maker ?? '', facts }
}

const sampleFor = (fx: Fixture, cap: Captured, b: RubricKey): string => {
  const body =
    b === 'facts' ? cap.facts.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(none)'
    : b === 'what' ? cap.what || '(empty)'
    : b === 'purpose' ? cap.purpose || '(empty)'
    : cap.maker || '(empty)'
  return `Photographed object: ${fx.subject} (arbitrated band: ${cap.band}).\n${b.toUpperCase()} bucket:\n${body}`
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs))

async function main(): Promise<void> {
  console.log(`\nreveal-buckets — REAL cascade + INDEPENDENT Claude judge (N=${N}/bucket)${WRITE_BASELINE ? '  [WRITE-BASELINE]' : ''}\n`)
  const baselinePath = join(import.meta.dir, 'baseline-buckets.json')
  let baseline: Record<string, { by: string; band: string; scores: Record<string, number> }> = {}
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) } catch { /* first run */ }
  const next: typeof baseline = {}
  let honestyFailures = 0

  for (const fx of FIXTURES) {
    console.log(`── ${fx.subject} (${fx.id}) ──`)
    const url = await wikiImage(fx.wikiPage)
    if (!url) { console.log('  (no image — skipped)\n'); continue }
    const { b64, mime } = await loadImageBytes(url)
    const cap = await captureBuckets(`data:${mime};base64,${b64}`)
    console.log(`  band=${cap.band}  title="${cap.title}"`)
    console.log(`  what:    ${cap.what || '(empty)'}`)
    console.log(`  purpose: ${cap.purpose || '(empty)'}`)
    console.log(`  maker:   ${cap.maker || '(empty)'}`)
    console.log(`  facts (${cap.facts.length}): ${cap.facts.map((f) => `\n     • ${f}`).join('')}`)

    if (fx.expectBand && cap.band !== fx.expectBand) console.log(`  ⚠ band ${cap.band} ≠ expected ${fx.expectBand} (the fix path may not be exercised)`)

    // Honesty NEGATIVE control: an anonymous object must never fabricate a maker.
    if (fx.negativeControl) {
      const fabricated = cap.maker.trim().length > 0 && !/nothing|keeps their counsel|no |n\/a/i.test(cap.maker)
      if (fabricated) { honestyFailures++; console.log(`  ✗ HONESTY: fabricated a maker for an anonymous object → "${cap.maker}"`) }
      else console.log('  ✓ honesty: no fabricated maker (honest-empty)')
      console.log('')
      continue
    }
    // Proof that the read brand reached the maker bucket.
    if (fx.expectBrand && !`${cap.maker} ${cap.what}`.toLowerCase().includes(fx.expectBrand)) {
      console.log(`  ⚠ brand "${fx.expectBrand}" not found in what/maker — the brand may not have surfaced`)
    }

    const scores: Record<string, number> = {}
    let by = ''
    for (const b of BUCKETS) {
      const runs: number[] = []
      for (let i = 0; i < N; i++) {
        const s = await judgeIndependent(b, sampleFor(fx, cap, b))
        runs.push(s.score); by = s.by
      }
      scores[b] = Number(mean(runs).toFixed(3))
      const prev = baseline[fx.id]?.scores?.[b]
      const delta = prev === undefined ? '' : `  Δ ${scores[b] - prev >= 0 ? '+' : ''}${(scores[b] - prev).toFixed(2)} (was ${prev})`
      console.log(`  judge[${b}] = ${scores[b].toFixed(2)} ±${spread(runs).toFixed(2)}${delta}`)
    }
    next[fx.id] = { by, band: cap.band, scores }
    // Confounded-delta guard (§13.5): never compare across judge identities.
    if (baseline[fx.id] && baseline[fx.id]!.by !== by) console.log(`  ⚠ baseline judged by ${baseline[fx.id]!.by}, this run by ${by} — delta not comparable`)
    console.log('')
  }

  if (WRITE_BASELINE) { writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n'); console.log(`baseline-buckets.json FROZEN (${Object.keys(next).length} fixtures).`) }
  else console.log('(re-run with --write-baseline to freeze; the frozen BEFORE lives in git + docs/reveal-quality-baseline-before.txt)')
  console.log(honestyFailures === 0 ? '\nHONESTY CONTROL: PASS (no fabricated maker)' : `\nHONESTY CONTROL: ${honestyFailures} FAILURE(S)`)
  process.exit(honestyFailures === 0 ? 0 : 1)
}

await main()
