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

export type RubricKey = 'title' | 'description' | 'facts'

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
    'specific, checkable facts about THIS object (records, provenance, design, history) — not generic or obvious, and ' +
    'mutually distinct. Score 0..1.',
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

/** The judge can run when EITHER an Anthropic key or gcloud auth is available (gcloud is the fallback judge). */
export function judgeAvailable(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  try {
    return !!gcloudToken()
  } catch {
    return false
  }
}
