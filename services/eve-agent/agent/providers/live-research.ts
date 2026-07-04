/**
 * LiveResearcher — the reveal ENRICHMENT step (PLAN §6 richer narration; ANALYSIS-VOICE-PLAN A1/A6–A9).
 *
 * Once identification lands, the honesty gate strips any specific fact the narrator cannot CITE, so this provider
 * gives the narrator real, GROUNDED facts to cite via the shared Firecrawl→GLM-5.2 `groundedFacts` primitive
 * (lib/grounded-research): each extracted fact carries its real `sourceUrl` + a verbatim quote. Facts with no source
 * are dropped, so nothing ungrounded ever becomes citable. Best-effort: any error/empty (or no Firecrawl wired)
 * returns `[]` and the reveal proceeds on web evidence only — never throws, never blocks the reveal.
 *
 * Two scopes (honesty-load-bearing, ANALYSIS-VOICE-PLAN A8/A9):
 *   'item'  — CONFIDENT only. Keyed on the CORROBORATED make + BASE model (never the VLM-only year/sub-variant),
 *             so research can't amplify an unverified year into cited facts about the wrong unit.
 *   'class' — PROBABLE. Keyed on the CATEGORY only (never a specific make/model), so a hedged reveal can still
 *             carry one grounded, class-level fact without asserting an identity the arbiter did not confirm.
 */
import type { IdEvidence } from '../tools/identify_object'
import { groundedFacts } from '../lib/grounded-research'
import type { WebResearchProvider } from '../tools/web_research'

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
 * Map extracted grounded facts → the closed evidence the honesty gate checks. Each fact's VERBATIM QUOTE is the
 * evidence `claim` (the gate verifies `quote ⊆ source`). Deduped by normalized claim; capped so the narrator has a
 * small, high-signal evidence set. Facts lacking a quote or `sourceUrl` are dropped — never citable. Pure so it is
 * unit-testable without a live call.
 */
export function factsToEvidence(
  facts: { quote?: string; sourceUrl?: string }[],
  cap = 5,
): IdEvidence[] {
  const out: IdEvidence[] = []
  const seen = new Set<string>()
  for (const f of facts) {
    const claim = (f.quote ?? '').trim()
    if (!claim || !f.sourceUrl) continue
    const key = norm(claim)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ref: `fact${out.length + 1}`, sourceUrl: f.sourceUrl, claim })
    if (out.length >= cap) break
  }
  return out
}

/**
 * The grounded-search subject per scope (pure so it is testable without a live call). Item scope names the specific
 * make/model; class scope names ONLY the category — never a specific make/model (a hedged reveal must not amplify an
 * unconfirmed identity into cited facts about the wrong unit). Used as both the extract-prompt subject and the
 * Firecrawl query.
 */
export function researchSubject(input: ResearchInput): string {
  if (input.scope === 'item') {
    return [input.make, input.model].filter(Boolean).join(' ').trim() || input.label
  }
  return input.category || input.label
}

export class LiveResearcher implements Researcher {
  constructor(private web: WebResearchProvider | null = null) {}

  async research(input: ResearchInput): Promise<IdEvidence[]> {
    if (!this.web) return [] // no Firecrawl wired → no grounding (prod asserts the key at boot); reveal proceeds on web evidence only
    try {
      const subject = researchSubject(input)
      const { facts } = await groundedFacts({ web: this.web, subject, query: subject, item: input.scope === 'item' })
      return factsToEvidence(facts)
    } catch {
      return [] // enrichment is best-effort — never throw, never block the reveal
    }
  }
}
