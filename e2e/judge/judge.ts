/**
 * The LLM judge (PROMPT-QUALITY §3.D4) — a QUALITY/EVAL signal, NOT a CI gate. It scores the reveal's title,
 * description, and facts against rubrics. Per the repo rule ("the LLM never decides pass/fail") this only runs in
 * the explicit `--live` measurement run and PRINTS scores; it is never wired into `bun test`, and the deterministic
 * gate (gate.ts) is the CI pass/fail.
 *
 * Judge model (independence, §D4): the reveal content is Gemini-generated, so an INDEPENDENT Claude judge (via the
 * Anthropic API, `claude-opus-4-8`) is preferred to limit self-preference. When Anthropic is unavailable (no key /
 * no credits), it FALLS BACK to a Vertex Gemini judge on the existing gcloud auth — with a logged self-preference
 * CAVEAT (Gemini judging Gemini-narrated content). It auto-upgrades to the independent Claude judge once
 * ANTHROPIC_API_KEY is funded.
 */
import { geminiJSON, gcloudToken } from '../../services/eve-agent/agent/lib/gcp-vision'

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'

export interface RubricScore {
  score: number // 0..1
  reasons: string
  by: 'claude' | 'gemini'
}

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0..1 quality score against the rubric' },
    reasons: { type: 'string', description: 'one or two sentences justifying the score' },
  },
  required: ['score', 'reasons'],
}

export type RubricKey = 'title' | 'description' | 'facts' | 'what' | 'purpose' | 'maker' | 'museum_identity' | 'museum_enrichment'

const RUBRICS: Record<RubricKey, string> = {
  title:
    'You are grading the TITLE a real-world-object identifier shows for a photographed object. A great title (1.0) is the ' +
    'single most prominent object named concisely and human-friendly (e.g. "Canon AE-1", "La Croix Sparkling Water") — ' +
    'specific, not a bare category ("a can", "a device"), and not a spec-dump. Score 0..1.',
  description:
    'You are grading the read-aloud DESCRIPTION of a specific object, spoken by "Voxi" — a dry, witty, British AI that ' +
    'catalogues human-made things. A great description (1.0) reads like an encyclopedia entry about THIS actual object ' +
    '(what it is, what it is for, who makes it, its defining detail), is SPECIFIC and grounded (not generic filler about ' +
    'the category), AND keeps Voxi\'s dry-witty voice. Penalise generic category filler heavily. Score 0..1.',
  facts:
    'You are grading a set of "curious facts" about a specific object. A great set (1.0) is 3+ genuinely interesting, ' +
    'specific, checkable facts about THIS object OR its brand/maker (records, provenance, design, history) — not generic ' +
    'or obvious, and mutually distinct. An empty set is 0. Score 0..1.',
  // The four reveal BUCKETS (ANALYSIS-UX). Each is graded on being SPECIFIC to this exact object/brand, not the
  // generic category. An honest EMPTY bucket ("nothing I can prove") is scored ~0.5 — NOT penalised as hard as
  // generic category filler, because honesty is the product's spine (a fabricated answer must never beat an honest gap).
  what:
    'You are grading the "WHAT IT IS" answer Voxi shows for a photographed object. A great answer (1.0) names THIS exact ' +
    'object/brand and the detail that sets it apart (e.g. "bears the Sub Pop stamp — the Seattle grunge label\'s mark"), ' +
    'SPECIFIC and grounded, not "a logo is a graphic mark" category filler. An honest empty ("nothing grounded") ≈ 0.5. Score 0..1.',
  purpose:
    'You are grading the "WHAT IT\'S FOR / PURPOSE" answer Voxi shows. A great answer (1.0) is what THIS specific object ' +
    'is for or what it commemorates/promotes (e.g. band merchandise that promotes a label), SPECIFIC and grounded — not ' +
    '"a mug holds hot drinks" category truism. An honest empty ("nothing grounded to add") ≈ 0.5. Score 0..1.',
  maker:
    'You are grading the "WHO MADE IT / MAKER" answer Voxi shows. A great answer (1.0) identifies the specific brand/maker ' +
    'ENTITY and a grounded detail about it (e.g. "Sub Pop, the Seattle label that signed Nirvana"). It must state the ' +
    'RELATIONSHIP the evidence supports (branded by / merch from / released by) and must NOT over-claim manufacture ' +
    '("made by X") of a merch/branded item unless a real manufacturer is named — penalise an unsupported "made by". An ' +
    'honest empty ("the maker keeps their counsel") ≈ 0.5; a generic/wrong maker is 0. Score 0..1.',
  // Museum eval (§F4). The sample carries the GROUND TRUTH so the judge scores correctness against a known answer.
  museum_identity:
    'You are grading whether a real-world-object identifier CORRECTLY IDENTIFIED a famous museum object from a photo. ' +
    'The sample gives you the GROUND TRUTH (title, maker, year, category) AND the identifier\'s output (band, title, ' +
    'what-it-is). A great score (1.0) = it named THIS specific work/object AND its maker correctly and confidently. ' +
    'Partial credit for the right object but a missing/vague maker or an over-hedge. Score 0 for a WRONG object or a ' +
    'bare category ("a painting", "a statue"). An honest "I don\'t recognise this" on a genuinely obscure/anonymous ' +
    'item ≈ 0.3 — better than a confident WRONG answer, which is 0. Reward specificity that matches the truth; never ' +
    'reward a confident fabrication. Score 0..1.',
  museum_enrichment:
    'You are grading the ENRICHMENT (what-it-is / purpose / maker / curious-facts) a catalog identifier produced for a ' +
    'photographed museum object, spoken by "Voxi" — a dry, witty British narrator. The sample gives the GROUND TRUTH ' +
    'and the produced buckets. A great score (1.0) = SPECIFIC and FAITHFUL to THIS actual object (its real medium, ' +
    'creator, history, why it matters), grounded, in Voxi\'s voice — not generic category filler and not fabricated ' +
    'detail. Penalise fabricated or wrong specifics HEAVILY (an honest gap beats a confident fabrication). An empty ' +
    'bucket ≈ 0.4. Score 0..1.',
}

const clamp = (n: number): number => Math.max(0, Math.min(1, n))

async function judgeClaude(rubric: RubricKey, sample: string): Promise<RubricScore> {
  const key = process.env.ANTHROPIC_API_KEY!
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: RUBRICS[rubric] + ' Return JSON only: {"score": <0..1>, "reasons": "<short>"}. No prose, no code fences.',
      messages: [{ role: 'user', content: sample }],
    }),
  })
  const j = (await r.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] }
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${JSON.stringify(j).slice(0, 160)}`)
  if (j.stop_reason === 'refusal') throw new Error('judge refused')
  const text = (j.content ?? []).find((b) => b.type === 'text')?.text ?? ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('claude judge returned no JSON')
  const p = JSON.parse(m[0]) as { score: number; reasons: string }
  return { score: clamp(p.score), reasons: p.reasons, by: 'claude' }
}

async function judgeGemini(rubric: RubricKey, sample: string): Promise<RubricScore> {
  const p = await geminiJSON<{ score: number; reasons: string }>(RUBRICS[rubric], sample, SCHEMA, 0)
  return { score: clamp(p.score), reasons: p.reasons, by: 'gemini' }
}

let caveatLogged = false

/** Score one rubric. Prefers the independent Claude judge; falls back to a Gemini judge (with a caveat). */
export async function judge(rubric: RubricKey, sample: string): Promise<RubricScore> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await judgeClaude(rubric, sample)
    } catch (e) {
      if (!caveatLogged) {
        caveatLogged = true
        console.log(`  ⚠ independent Claude judge unavailable (${(e as Error).message.slice(0, 80)}) — falling back to a GEMINI judge (self-preference caveat: Gemini is grading Gemini-narrated content; fund ANTHROPIC_API_KEY for the independent judge).`)
      }
    }
  } else if (!caveatLogged) {
    caveatLogged = true
    console.log('  ⚠ ANTHROPIC_API_KEY not set — using a GEMINI judge (self-preference caveat; set an Anthropic key for the independent judge).')
  }
  return judgeGemini(rubric, sample)
}

/**
 * The INDEPENDENT judge with NO silent Gemini fallback (§13.5, adversarial #3) — for the acceptance/proof run. A
 * proof-of-improvement graded by Gemini-judges-Gemini is worthless, and a mid-run Claude error silently swapping
 * judges confounds the before/after delta. So this THROWS when the funded Claude judge is unavailable, rather than
 * quietly degrading — the harness aborts and says why instead of printing a self-preferential number.
 */
export async function judgeIndependent(rubric: RubricKey, sample: string): Promise<RubricScore> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for the independent proof judge (no Gemini fallback in the acceptance run)')
  return judgeClaude(rubric, sample)
}

/** The judge can run when EITHER an Anthropic key or gcloud auth is available (gcloud is the fallback judge). */
export function judgeAvailable(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    return !!gcloudToken()
  } catch {
    return false
  }
}
