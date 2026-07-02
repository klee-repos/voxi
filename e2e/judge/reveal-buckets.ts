/**
 * reveal-buckets.ts — the BUCKET-QUALITY proof (REVEAL-WHAT-MAKER-PLAN §7.1; the user's proof-of-improvement).
 *
 * Drives the REAL `runIdentificationCascade` end-to-end over a MANY-OBJECT matrix of real public Wikipedia object
 * photos, so the actual fixes under test are exercised: the VLM reading (or not) the brand, arbitration landing
 * PROBABLE/CONFIDENT, the deriveMaker corroborated-brand lane, the genre-junk web filter, the what backstop. It:
 *   1. captures the four buckets FROM THE EMITTED EVENTS (token/description_upgrade → what; section → purpose/maker;
 *      fact → facts) + the arbitrated band — never a reconstructed narrate();
 *   2. HARD-GATES the user's complaint deterministically (repo rule: the LLM never decides pass/fail):
 *        • a BRANDED fixture (`expectBrand`) FAILS unless the brand appears in the maker/what bucket;
 *        • a NEGATIVE control (`negativeControl`) FAILS on any FABRICATED maker (the honesty spine);
 *      the process exit code is gated on these, so the proof can FAIL loudly, not just print a soft warning;
 *   3. scores each bucket with the INDEPENDENT Claude judge (judgeIndependent — NO Gemini fallback), N times, and
 *      reports mean ± spread + the delta vs a FROZEN baseline (the BEFORE, captured on OLD code, `--write-baseline`).
 *
 * Tiers (env `JUDGE_TIERS`, default `A,B,C`; `JUDGE_FIXTURES=id,id` filters by id; `JUDGE_SAMPLES=N`):
 *   A — logo-brand make+model products (the Xbox failure class: brand is a LOGO, often no readable text).
 *   B — text/OCR-brand products (also exercises the observedBrand path + specificity).
 *   C — unbranded honesty NEGATIVE controls (must never fabricate a maker).
 *
 * Report-only for the JUDGE scores (the LLM never gates); the DETERMINISTIC brand/honesty assertions DO gate.
 * Creds: gcloud + ANTHROPIC_API_KEY (+ FIRECRAWL_API_KEY for the deep path; the grounding path works without).
 *   bun e2e/judge/reveal-buckets.ts                       # measure + delta vs frozen baseline (all tiers)
 *   JUDGE_TIERS=A JUDGE_FIXTURES=xbox bun e2e/judge/reveal-buckets.ts   # one fixture, fast
 *   bun e2e/judge/reveal-buckets.ts --write-baseline      # freeze the current output as the BEFORE (run on OLD code)
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
const TIERS = new Set((process.env.JUDGE_TIERS ?? 'A,B,C').split(',').map((t) => t.trim().toUpperCase()))
const ONLY = (process.env.JUDGE_FIXTURES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const BUCKETS: RubricKey[] = ['what', 'purpose', 'maker', 'facts']

interface Fixture {
  id: string
  subject: string
  wikiPage: string
  tier: 'A' | 'B' | 'C'
  /** the maker/what bucket MUST contain this brand (lowercase substring) — a HARD gate. Omit → reported, not gated. */
  expectBrand?: string
  /** an anonymous object: assert NO fabricated maker (the honesty negative control) — a HARD gate. */
  negativeControl?: boolean
}

// Real, fetchable Wikipedia lead images (probed). Tier A brands are derived from the display NAME (a logo, no OCR);
// Tier B carry readable text; Tier C are generic. Sub Pop is the OCR-brand regression tripwire from prior rounds.
const FIXTURES: Fixture[] = [
  // ── Tier A — logo-brand make+model products (the Xbox failure class) ──
  { id: 'xbox', subject: 'an Xbox Wireless Controller', wikiPage: 'Xbox_Wireless_Controller', tier: 'A', expectBrand: 'xbox' },
  { id: 'iphone4', subject: 'an iPhone 4', wikiPage: 'IPhone_4', tier: 'A', expectBrand: 'apple' },
  { id: 'rubik', subject: "a Rubik's Cube", wikiPage: "Rubik's_Cube", tier: 'A', expectBrand: 'rubik' },
  { id: 'nes', subject: 'a Nintendo Entertainment System', wikiPage: 'Nintendo_Entertainment_System', tier: 'A', expectBrand: 'nintendo' },
  { id: 'eames', subject: 'an Eames Lounge Chair', wikiPage: 'Eames_Lounge_Chair', tier: 'A', expectBrand: 'eames' },
  { id: 'aeron', subject: 'a Herman Miller Aeron chair', wikiPage: 'Aeron_chair', tier: 'A', expectBrand: 'herman miller' },
  { id: 'gameboy', subject: 'a Game Boy', wikiPage: 'Game_Boy', tier: 'A' }, // soft: leading token generic → may honest-empty or OCR "Nintendo"
  { id: 'swissarmy', subject: 'a Swiss Army knife', wikiPage: 'Swiss_Army_knife', tier: 'A' }, // soft: "Swiss" is an ambiguous leading token
  // ── Tier B — text/OCR-brand products ──
  { id: 'canon', subject: 'a Canon AE-1', wikiPage: 'Canon_AE-1', tier: 'B', expectBrand: 'canon' },
  { id: 'leica', subject: 'a Leica M3', wikiPage: 'Leica_M3', tier: 'B', expectBrand: 'leica' },
  { id: 'polaroid', subject: 'a Polaroid SX-70', wikiPage: 'Polaroid_SX-70', tier: 'B', expectBrand: 'polaroid' },
  { id: 'strat', subject: 'a Fender Stratocaster', wikiPage: 'Fender_Stratocaster', tier: 'B', expectBrand: 'fender' },
  { id: 'lespaul', subject: 'a Gibson Les Paul', wikiPage: 'Gibson_Les_Paul', tier: 'B', expectBrand: 'gibson' },
  { id: 'vespa', subject: 'a Vespa scooter', wikiPage: 'Vespa', tier: 'B', expectBrand: 'vespa' },
  { id: 'coke', subject: 'a Coca-Cola bottle', wikiPage: 'Coca-Cola', tier: 'B', expectBrand: 'coca' },
  { id: 'lecreuset', subject: 'a Le Creuset dutch oven', wikiPage: 'Le_Creuset', tier: 'B', expectBrand: 'le creuset' },
  { id: 'subpop', subject: 'a Sub Pop mug', wikiPage: 'Sub_Pop', tier: 'B', expectBrand: 'sub pop' }, // OCR-brand regression tripwire
  // ── Tier C — unbranded honesty NEGATIVE controls (NO fabricated maker) ──
  { id: 'mug', subject: 'a plain mug', wikiPage: 'Mug', tier: 'C', negativeControl: true },
  { id: 'plywood', subject: 'a plywood board', wikiPage: 'Plywood', tier: 'C', negativeControl: true },
  { id: 'brick', subject: 'a brick', wikiPage: 'Brick', tier: 'C', negativeControl: true },
  { id: 'spoon', subject: 'a wooden spoon', wikiPage: 'Wooden_spoon', tier: 'C', negativeControl: true },
  { id: 'officechair', subject: 'an office chair', wikiPage: 'Office_chair', tier: 'C', negativeControl: true },
  { id: 'cuttingboard', subject: 'a cutting board', wikiPage: 'Cutting_board', tier: 'C', negativeControl: true },
  { id: 'clothespin', subject: 'a clothespin', wikiPage: 'Clothespin', tier: 'C', negativeControl: true },
  { id: 'cinderblock', subject: 'a cinder block', wikiPage: 'Cinder_block', tier: 'C', negativeControl: true },
]

interface Captured { band: string; title: string; what: string; purpose: string; maker: string; facts: string[] }

async function wikiImage(page: string): Promise<string | null> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`, { headers: { 'user-agent': 'voxi-judge/1.0' } })
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 900 * (i + 1))); continue }
    if (!r.ok) return null
    const j = (await r.json()) as { originalimage?: { source: string }; thumbnail?: { source: string } }
    return j.originalimage?.source ?? j.thumbnail?.source ?? null
  }
  return null
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
/** A fabricated maker for a NEGATIVE control: a non-empty maker that is NOT an honest-empty phrasing. */
const isFabricatedMaker = (maker: string): boolean =>
  maker.trim().length > 0 && !/nothing|keeps their counsel|no maker|unbranded|unknown|not sure|n\/a|anonymous|generic/i.test(maker)

async function main(): Promise<void> {
  console.log(`\nreveal-buckets — REAL cascade + INDEPENDENT Claude judge over a MANY-OBJECT matrix (N=${N}/bucket, tiers=${[...TIERS].join('')})${WRITE_BASELINE ? '  [WRITE-BASELINE]' : ''}\n`)
  const baselinePath = join(import.meta.dir, 'baseline-buckets.json')
  let baseline: Record<string, { by: string; band: string; scores: Record<string, number> }> = {}
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) } catch { /* first run */ }
  const next: typeof baseline = {}
  let brandFailures = 0
  let honestyFailures = 0

  const run = FIXTURES.filter((f) => TIERS.has(f.tier) && (ONLY.length === 0 || ONLY.includes(f.id)))
  console.log(`running ${run.length} fixtures: ${run.map((f) => f.id).join(', ')}\n`)

  for (const fx of run) {
    console.log(`── [${fx.tier}] ${fx.subject} (${fx.id}) ──`)
    const url = await wikiImage(fx.wikiPage)
    if (!url) { console.log('  (no image — skipped)\n'); continue }
    const { b64, mime } = await loadImageBytes(url)
    let cap: Captured
    try { cap = await captureBuckets(`data:${mime};base64,${b64}`) }
    catch (e) { console.log(`  ✗ cascade error: ${(e as Error).message}\n`); continue }
    console.log(`  band=${cap.band}  title="${cap.title}"`)
    console.log(`  what:    ${cap.what || '(empty)'}`)
    console.log(`  purpose: ${cap.purpose || '(empty)'}`)
    console.log(`  maker:   ${cap.maker || '(empty)'}`)
    console.log(`  facts (${cap.facts.length}): ${cap.facts.map((f) => `\n     • ${f}`).join('')}`)

    // ── DETERMINISTIC HARD GATES (the proof; the LLM never decides these) ──
    if (fx.negativeControl) {
      if (isFabricatedMaker(cap.maker)) { honestyFailures++; console.log(`  ✗ HONESTY: fabricated a maker for an anonymous object → "${cap.maker}"`) }
      else console.log('  ✓ honesty: no fabricated maker (honest-empty)')
    } else if (fx.expectBrand) {
      const hay = `${cap.maker} ${cap.what}`.toLowerCase()
      if (hay.includes(fx.expectBrand)) console.log(`  ✓ brand: maker/what names "${fx.expectBrand}"`)
      else { brandFailures++; console.log(`  ✗ BRAND: maker/what does NOT name "${fx.expectBrand}" (the user's complaint — maker/what failed)`) }
    } else {
      console.log(`  · (soft) maker="${cap.maker || 'honest-empty'}" — reported, not gated`)
    }

    // ── QUALITY (report-only judge scores + baseline delta) ──
    const scores: Record<string, number> = {}
    let by = ''
    for (const b of BUCKETS) {
      const runs: number[] = []
      for (let i = 0; i < N; i++) { const s = await judgeIndependent(b, sampleFor(fx, cap, b)); runs.push(s.score); by = s.by }
      scores[b] = Number(mean(runs).toFixed(3))
      const prev = baseline[fx.id]?.scores?.[b]
      const delta = prev === undefined ? '' : `  Δ ${scores[b] - prev >= 0 ? '+' : ''}${(scores[b] - prev).toFixed(2)} (was ${prev})`
      console.log(`  judge[${b}] = ${scores[b].toFixed(2)} ±${spread(runs).toFixed(2)}${delta}`)
    }
    next[fx.id] = { by, band: cap.band, scores }
    if (baseline[fx.id] && baseline[fx.id]!.by !== by) console.log(`  ⚠ baseline judged by ${baseline[fx.id]!.by}, this run by ${by} — delta not comparable`)
    console.log('')
  }

  if (WRITE_BASELINE) { writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n'); console.log(`baseline-buckets.json FROZEN (${Object.keys(next).length} fixtures).`) }
  else console.log('(re-run with --write-baseline to freeze the current output as the BEFORE)')
  console.log(`\nDETERMINISTIC GATES — brand: ${brandFailures === 0 ? 'PASS' : `${brandFailures} FAILURE(S)`}  |  honesty: ${honestyFailures === 0 ? 'PASS' : `${honestyFailures} FAILURE(S)`}`)
  process.exit(brandFailures === 0 && honestyFailures === 0 ? 0 : 1)
}

await main()
