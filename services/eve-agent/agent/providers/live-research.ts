/**
 * LiveResearcher — the reveal ENRICHMENT step (PLAN §6 richer narration; ANALYSIS-VOICE-PLAN A1/A6–A9).
 *
 * Once identification lands, the honesty gate will still strip any specific fact the narrator cannot CITE, and
 * Cloud Vision reverse-image page TITLES carry almost no citable facts — which is why descriptions read generic.
 * This provider gives the narrator real, GROUNDED facts to cite: a Vertex Gemini Google-Search-grounded call
 * (same gcloud-CLI auth — NO new creds) whose response is mapped to closed `IdEvidence[]`, each fact paired with
 * the source URL that grounds it. Facts with no grounding source are dropped, so nothing ungrounded ever becomes
 * citable. Best-effort: any error/timeout returns `[]` and the reveal proceeds on web evidence only.
 *
 * Two scopes (honesty-load-bearing, ANALYSIS-VOICE-PLAN A8/A9):
 *   'item'  — CONFIDENT only. Keyed on the CORROBORATED make + BASE model (never the VLM-only year/sub-variant),
 *             so research can't amplify an unverified year into cited facts about the wrong unit.
 *   'class' — PROBABLE. Keyed on the CATEGORY only (never a specific make/model), so a hedged reveal can still
 *             carry one grounded, class-level fact without asserting an identity the arbiter did not confirm.
 */
import type { IdEvidence } from '../tools/identify_object'
import { geminiGrounded, type GroundingMetadata } from '../lib/gcp-vision'
import { renderPrompt } from '../prompts'

export interface ResearchInput {
  /** the display identity (fallback subject when structured fields are absent). */
  label: string
  make?: string
  /** the BASE model — parenthetical editions already stripped by the caller (A8). */
  model?: string
  /** ONLY set when a non-VLM stage corroborated it (A8); omitted on the VLM-confirmed path. */
  year?: number
  /** coarse VLM category, e.g. "camera" — the ONLY key used at 'class' scope. */
  category?: string
  /** 'item' = ground the specific make/model (CONFIDENT); 'class' = ground the category only (PROBABLE). */
  scope: 'item' | 'class'
}

export interface Researcher {
  research(input: ResearchInput): Promise<IdEvidence[]>
}

const norm = (s: string): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Map a grounded Gemini response to the closed evidence the honesty gate checks. Each fact is a GROUNDED text
 * SEGMENT (`groundingSupports[].segment.text`) paired with the URL of the chunk that grounds it
 * (`groundingChunks[idx].web.uri`). A segment with no grounding chunk is DROPPED — no ungrounded "fact" ever
 * becomes citable. Deduped by normalized claim; capped so the narrator has a small, high-signal evidence set.
 */
export function factsFromGrounding(grounding: GroundingMetadata, cap = 5): IdEvidence[] {
  const chunks = grounding.groundingChunks ?? []
  const out: IdEvidence[] = []
  const seen = new Set<string>()
  for (const s of grounding.groundingSupports ?? []) {
    const claim = (s.segment?.text ?? '').trim()
    if (!claim) continue
    const idx = (s.groundingChunkIndices ?? []).find((i) => chunks[i]?.web?.uri)
    if (idx === undefined) continue // ungrounded segment → drop (never citable)
    const key = norm(claim)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ref: `fact${out.length + 1}`, sourceUrl: chunks[idx]!.web!.uri!, claim })
    if (out.length >= cap) break
  }
  return out
}

/**
 * The grounded-search subject + rules per scope (kept pure so the prompt is testable without a live call). The
 * prose lives in `prompts/research.{system,user}.md`; here we compute only the honesty-safe subject key and the
 * scope flag that selects the item-vs-class rules section. A golden test pins the rendered output byte-for-byte.
 */
export function researchPrompt(input: ResearchInput): { system: string; user: string } {
  const itemSubject = [input.make, input.model].filter(Boolean).join(' ').trim() || input.label
  const subject = input.scope === 'item' ? `the ${itemSubject}` : `the category of object: ${input.category || input.label}`
  const system = renderPrompt('research.system.md', { item: input.scope === 'item' })
  const user = renderPrompt('research.user.md', { subject })
  return { system, user }
}

export class LiveResearcher implements Researcher {
  constructor(private timeoutMs = 8000) {}

  async research(input: ResearchInput): Promise<IdEvidence[]> {
    const { system, user } = researchPrompt(input)
    try {
      const { grounding } = await geminiGrounded(system, user, { timeoutMs: this.timeoutMs, temperature: 0.2 })
      return factsFromGrounding(grounding)
    } catch {
      return [] // enrichment is best-effort — never throw, never block the reveal
    }
  }
}
