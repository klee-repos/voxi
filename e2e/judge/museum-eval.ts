/**
 * museum-eval.ts — the MUSEUM identification + enrichment eval (§F4).
 *
 * Drives the REAL `runIdentificationCascade` over a matrix of famous NYC-museum objects (the acquired fixtures +
 * ground-truth manifest), so identification of a STRETCH domain (fine art, historical artifacts — no brand/OCR) is
 * measured end-to-end. Like e2e/judge/reveal-buckets.ts this is a LIVE, cred-gated run (gcloud + ANTHROPIC_API_KEY):
 * the cascade has no vendor-tape seam, so there is no cred-free CI variant — it SKIPS cleanly where creds/fixtures
 * are absent (never a false red, never a raw ENOENT).
 *
 * DETERMINISTIC HARD-GATES (the LLM never decides these; absolute per-fixture, no baseline needed — §D3):
 *   • BAND-SANITY  — an `expected_band` object that lands UNKNOWN (or is wrongly safety-refused) FAILS.
 *   • SUPPRESSION  — a safety refusal on an item NOT flagged `safety_expected` FAILS (a benign object wrongly refused).
 * MEASURED (reported + baseline delta; never gates — this is the number §F5's prompt work improves):
 *   • identification hit-rate / UNKNOWN-rate / suppressed-count (absolute per-fixture, honest-empty is a NON-match),
 *   • INDEPENDENT Claude judge scores for museum_identity + museum_enrichment (mean ± spread vs a frozen baseline).
 *
 *   bun e2e/judge/museum-eval.ts                          # measure + gate (all fixtures)
 *   JUDGE_FIXTURES=starry-night bun e2e/judge/museum-eval.ts
 *   bun e2e/judge/museum-eval.ts --write-baseline         # freeze the current judge scores as the BEFORE
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runIdentificationCascade } from '../../services/eve-agent/agent/cascade'
import { LiveVisionProvider } from '../../services/eve-agent/agent/providers/live-vision'
import { LiveSafetyClassifier } from '../../services/eve-agent/agent/providers/live-safety'
import { LiveNarrator } from '../../services/eve-agent/agent/providers/live-narrator'
import { LiveResearcher } from '../../services/eve-agent/agent/providers/live-research'
import { dossierProviderFromEnv } from '../../services/eve-agent/agent/providers/live-dossier'
import { loadImageBytes, gcloudToken } from '../../services/eve-agent/agent/lib/gcp-vision'
import { judgeIndependent } from './judge'
import {
  identificationResult, bandSanityFail, unexpectedSuppression,
  type MuseumFixture, type Captured, type Band,
} from './museum/gate'

const WRITE_BASELINE = process.argv.includes('--write-baseline')
const N = Number(process.env.JUDGE_SAMPLES ?? 2)
const ONLY = (process.env.JUDGE_FIXTURES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const MUSEUM_DIR = join(import.meta.dir, 'museum')
const FIXTURES_DIR = join(MUSEUM_DIR, 'fixtures')

function skip(msg: string): never {
  console.log(`\nmuseum-eval SKIPPED — ${msg}\n`)
  process.exit(0) // a clean skip, never a false red (mirrors run-reveal-judge.web.ts creds skip)
}

async function capture(imageUri: string): Promise<Captured & { errorCode?: string }> {
  const whatTokens: string[] = []
  const sections: Record<string, string> = {}
  const facts: string[] = []
  let band: Band = ''
  let title = ''
  let upgrade = ''
  let suppressed: Captured['suppressed'] = null
  let errorCode: string | undefined
  for await (const ev of runIdentificationCascade('proof', { uri: imageUri, userId: 'proof' }, {
    vision: new LiveVisionProvider(),
    safety: new LiveSafetyClassifier(),
    narrator: new LiveNarrator(),
    researcher: new LiveResearcher(),
    dossier: dossierProviderFromEnv(),
  })) {
    if (ev.type === 'confidence_band') {
      band = ev.band
      title = ev.title
      if (/keep the details to myself|restricted object/i.test(ev.title)) suppressed = 'category_only'
    } else if (ev.type === 'token') whatTokens.push(ev.text)
    else if (ev.type === 'description_upgrade') upgrade = ev.text
    else if (ev.type === 'section') sections[ev.bucket] = ev.text
    else if (ev.type === 'fact') facts.push(ev.text)
    else if (ev.type === 'error') { errorCode = ev.code; if (ev.code === 'safety_refusal') suppressed = 'safety_refusal' }
  }
  return { band, title, what: upgrade || whatTokens.join(' '), purpose: sections.purpose ?? '', maker: sections.maker ?? '', facts, suppressed, errorCode }
}

const identitySample = (fx: MuseumFixture, cap: Captured): string =>
  `GROUND TRUTH — title: ${fx.title}; maker: ${fx.maker}; year: ${fx.year}; category: ${fx.category}.\n` +
  `IDENTIFIER OUTPUT — band: ${cap.band || 'none'}; title: "${cap.title}"; what-it-is: ${cap.what || '(empty)'}` +
  (cap.suppressed ? `; [SUPPRESSED: ${cap.suppressed}]` : '')

const enrichmentSample = (fx: MuseumFixture, cap: Captured): string =>
  `GROUND TRUTH — ${fx.title} by ${fx.maker} (${fx.year}), ${fx.medium}. Known facts: ${fx.expected_facts.join('; ')}.\n` +
  `PRODUCED —\n  what: ${cap.what || '(empty)'}\n  purpose: ${cap.purpose || '(empty)'}\n  maker: ${cap.maker || '(empty)'}\n` +
  `  facts:\n${cap.facts.map((f, i) => `    ${i + 1}. ${f}`).join('\n') || '    (none)'}` +
  (fx.same_design ? '\n(note: the fixture is a photo of the same DESIGN, not the exact accessioned unit — do not penalise unit-specific provenance gaps)' : '')

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs))

async function main(): Promise<void> {
  // ── guards: never a false red ──
  if (!process.env.ANTHROPIC_API_KEY) skip('ANTHROPIC_API_KEY not set (the independent proof judge is required)')
  try { if (!gcloudToken()) skip('no gcloud auth (the live cascade needs Vertex/Vision)') } catch { skip('no gcloud auth (the live cascade needs Vertex/Vision)') }

  const manifestPath = join(MUSEUM_DIR, 'manifest.json')
  if (!existsSync(manifestPath)) skip(`manifest missing at ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MuseumFixture[]

  // ── missing-fixture guard (§D5): a clean skip, never a raw ENOENT from loadImageBytes ──
  const missing = manifest.filter((fx) => !existsSync(join(FIXTURES_DIR, fx.file)))
  if (missing.length) skip(`${missing.length}/${manifest.length} fixtures absent (${missing.map((m) => m.id).slice(0, 3).join(', ')}…) — run: bun e2e/judge/museum/download-museum-fixtures.ts`)

  const run = manifest.filter((fx) => ONLY.length === 0 || ONLY.includes(fx.id))
  console.log(`\nmuseum-eval — REAL cascade + INDEPENDENT Claude judge over ${run.length} museum objects (N=${N}/rubric)${WRITE_BASELINE ? '  [WRITE-BASELINE]' : ''}\n`)

  const baselinePath = join(import.meta.dir, 'baseline-museum.json')
  let baseline: Record<string, { scores: Record<string, number> }> = {}
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) } catch { /* first run — report only */ }
  const next: typeof baseline = {}

  let hits = 0, misses = 0, suppressedN = 0, unknownN = 0, cascadeErrors = 0
  let bandFailures = 0, suppressionFailures = 0
  const idScores: number[] = []
  const enrichScores: number[] = []

  for (const fx of run) {
    console.log(`── [${fx.difficulty}] ${fx.title} — ${fx.maker} (${fx.id}) ──`)
    let cap: Captured & { errorCode?: string }
    try {
      const { b64, mime } = await loadImageBytes(join(FIXTURES_DIR, fx.file))
      cap = await capture(`data:${mime};base64,${b64}`)
    } catch (e) { console.log(`  ✗ cascade error: ${(e as Error).message}\n`); cascadeErrors++; continue }

    if (cap.errorCode === 'hard_failure') { console.log(`  ✗ hard_failure (env/vendor) — reported, not gated\n`); cascadeErrors++; continue }
    console.log(`  band=${cap.band || 'none'}${cap.suppressed ? ` [suppressed: ${cap.suppressed}]` : ''}  title="${cap.title}"`)
    console.log(`  what:  ${cap.what || '(empty)'}`)
    console.log(`  maker: ${cap.maker || '(empty)'}`)

    // ── DETERMINISTIC GATES (absolute per-fixture; the LLM never decides these) ──
    const id = identificationResult(cap, fx)
    if (id === 'hit') hits++
    else if (id === 'suppressed') suppressedN++
    else misses++
    if (cap.band === 'UNKNOWN') unknownN++
    console.log(`  identification: ${id === 'hit' ? '✓ HIT' : id === 'suppressed' ? '· suppressed' : '✗ miss'} (tokens: ${fx.expected_id_tokens.join(', ')})`)

    if (bandSanityFail(cap, fx)) { bandFailures++; console.log(`  ✗ BAND-SANITY: expected ≥${fx.expected_band} but got ${cap.suppressed ?? (cap.band || 'none')}`) }
    if (unexpectedSuppression(cap, fx)) { suppressionFailures++; console.log(`  ✗ SUPPRESSION: benign object wrongly safety-refused (not flagged safety_expected)`) }
    if (cap.suppressed && fx.safety_expected) console.log(`  ✓ suppression EXPECTED (safety_expected) — not a miss`)

    // ── QUALITY (report-only independent judge + baseline delta) ──
    const idRuns: number[] = []
    const enRuns: number[] = []
    for (let i = 0; i < N; i++) {
      idRuns.push((await judgeIndependent('museum_identity', identitySample(fx, cap))).score)
      enRuns.push((await judgeIndependent('museum_enrichment', enrichmentSample(fx, cap))).score)
    }
    const idS = Number(mean(idRuns).toFixed(3))
    const enS = Number(mean(enRuns).toFixed(3))
    idScores.push(idS); enrichScores.push(enS)
    const delta = (k: string, v: number): string => {
      const prev = baseline[fx.id]?.scores?.[k]
      return prev === undefined ? '' : `  Δ ${v - prev >= 0 ? '+' : ''}${(v - prev).toFixed(2)} (was ${prev})`
    }
    console.log(`  judge[identity]   = ${idS.toFixed(2)} ±${spread(idRuns).toFixed(2)}${delta('museum_identity', idS)}`)
    console.log(`  judge[enrichment] = ${enS.toFixed(2)} ±${spread(enRuns).toFixed(2)}${delta('museum_enrichment', enS)}\n`)
    next[fx.id] = { scores: { museum_identity: idS, museum_enrichment: enS } }
  }

  const scored = run.length - cascadeErrors
  console.log('════════════════════════════════════════════')
  console.log(`IDENTIFICATION (absolute, honest-empty = non-match): ${hits} hit · ${misses} miss · ${suppressedN} suppressed  of ${scored} scored`)
  console.log(`  hit-rate ${scored ? ((hits / scored) * 100).toFixed(0) : 0}%   UNKNOWN-rate ${scored ? ((unknownN / scored) * 100).toFixed(0) : 0}%`)
  console.log(`JUDGE (report-only): identity ${mean(idScores).toFixed(2)}   enrichment ${mean(enrichScores).toFixed(2)}   (mean over ${idScores.length} objects)`)
  if (WRITE_BASELINE) { writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n'); console.log(`baseline-museum.json FROZEN (${Object.keys(next).length} objects).`) }
  else if (Object.keys(baseline).length === 0) console.log('(no baseline yet — re-run with --write-baseline to freeze the BEFORE; judge Δ is report-only on run #1)')

  console.log(`\nDETERMINISTIC GATES — band-sanity: ${bandFailures === 0 ? 'PASS' : `${bandFailures} FAILURE(S)`}  |  suppression: ${suppressionFailures === 0 ? 'PASS' : `${suppressionFailures} FAILURE(S)`}`)
  if (cascadeErrors) console.log(`(${cascadeErrors} fixture(s) hit a cascade/env error — reported, not gated)`) // no silent truncation
  process.exit(bandFailures === 0 && suppressionFailures === 0 ? 0 : 1)
}

await main()
