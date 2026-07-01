/**
 * LiveNarrator — Voxi's persona reveal narration ("what it is / its use"), PLAN §6/§8.3. It is a Vertex Gemini
 * TEXT call (same gcloud-CLI auth as identification — NO new creds; ElevenLabs is only the later VOICE/TTS layer)
 * whose output is CLAIM-STRUCTURED and run through the REAL shared honesty gate before a word reaches the user.
 *
 * The load-bearing wiring: the arbiter's BAND becomes evidence. On CONFIDENT the confirmed identity is a citable
 * evidence ref ("id"), so the narrator MAY assert the model; on PROBABLE/UNKNOWN that ref is absent, so any clause
 * asserting the specific model is DROPPED by the gate — the persona is mechanically forced to hedge exactly as
 * registerFor() prescribes. Falsifiable claims (spec/date/provenance/…) must cite the web evidence or be dropped;
 * this is the description path (failClosed:false → render approved-only), never "narrate anyway".
 */
import { validateClaims, registerFor, type Clause, type Evidence, type ConfidenceBand, type EntailmentJudge } from '../../../../packages/shared/src/confidence'
import type { IdEvidence } from '../tools/identify_object'
import { geminiJSON } from '../lib/gcp-vision'
import { renderPrompt } from '../prompts'

export interface NarrationInput {
  label: string
  band: ConfidenceBand
  evidence: IdEvidence[]
  unsupportedFields: string[]
  candidates: string[]
}

/** The cascade consumes this: the approved (gate-passed) clause texts, in order, + how many were dropped. */
export interface Narration {
  clauses: string[]
  dropped: number
}

export interface Narrator {
  narrate(input: NarrationInput): Promise<Narration>
}

const NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          claimType: { type: 'string', enum: ['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative', 'flavor'] },
          evidenceRef: { type: 'string' },
        },
        required: ['text', 'claimType'],
      },
    },
  },
  required: ['clauses'],
}

/**
 * Default independent auditor (RT-1 §22.1, hardened by ANALYSIS-VOICE-PLAN A7): a `flavor` clause that smuggles
 * ANY falsifiable assertion is flagged so the self-label can't launder it. Now that the reveal cites GROUNDED
 * research facts and Part B voices them authoritatively, the auditor must catch NON-numeric smuggling too —
 * named provenance, superlatives, and causal/comparative claims — not just years and measured specs.
 */
export function smugglesFalsifiable(text: string): boolean {
  if (/\b(1[89]\d\d|20\d\d)\b/.test(text)) return true // a year
  if (/\b\d+(\.\d+)?\s?(mm|cm|kg|g|lb|cc|mp|mph|hp|fps|inch|in|ft)\b/i.test(text)) return true // a measured spec
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text)) return true // a proper-noun run (a named maker/place/model → provenance)
  if (/\b(first|only|last|fastest|slowest|largest|smallest|lightest|heaviest|oldest|newest|rarest|finest|cheapest|the most|the least)\b/i.test(text)) return true // superlative
  if (/\b(which is why|because|due to|thanks to|so that|more than|less than|faster than|lighter than|compared to|outsold|outperformed)\b/i.test(text)) return true // causal / comparative
  return false
}

/** The band-as-evidence rule: the confirmed identity is a citable ref ONLY when CONFIDENT (else the narrator is
 *  mechanically forced to hedge, since any model-asserting clause has nothing to cite). */
export function narrationEvidence(input: NarrationInput): Evidence[] {
  const evidence: Evidence[] = input.evidence.map((e) => ({ ref: e.ref, sourceUrl: e.sourceUrl, claim: e.claim }))
  if (input.band === 'CONFIDENT') evidence.push({ ref: 'id', sourceUrl: 'voxi:cascade', claim: input.label })
  return evidence
}

/** Apply the REAL honesty gate to drafted clauses (pure — the testable core; no Gemini). Render approved-only. */
export function gateNarration(input: NarrationInput, clauses: Clause[], judge?: EntailmentJudge): Narration {
  const verdict = validateClaims(clauses, narrationEvidence(input), { judge, detectNamedClaim: smugglesFalsifiable, failClosed: false })
  return { clauses: verdict.approved.map((c) => c.text), dropped: verdict.rejected.length }
}

export class LiveNarrator implements Narrator {
  constructor(private judge?: EntailmentJudge) {}

  async narrate(input: NarrationInput): Promise<Narration> {
    const reg = registerFor(input.band)
    const evidence = narrationEvidence(input)

    // The narration prompt lives in `prompts/narration.{system,user}.md`; code supplies only data. The
    // conditional prose (assert-vs-hedge, candidate line, unsupported-fields line) is selected by the template's
    // sections, so the honesty framing stays out of code. Golden tests pin the rendered output byte-for-byte.
    const system = renderPrompt('narration.system.md', {
      confident: reg.mayAssertSpecificModel,
      label: input.label,
      chipLabel: reg.chipLabel,
      hasCandidates: input.candidates.length > 1,
      candidates: input.candidates.join(' OR '),
      hasUnsupported: input.unsupportedFields.length > 0,
      unsupportedFields: input.unsupportedFields.join(', '),
    })

    const user = renderPrompt('narration.user.md', {
      label: input.label,
      band: input.band,
      evidence,
      noExternal: evidence.length === 1 && evidence[0]!.ref === 'id',
    })

    let clauses: Clause[]
    try {
      const out = await geminiJSON<{ clauses: Clause[] }>(system, user, NARRATION_SCHEMA, 0.7)
      clauses = out.clauses ?? []
    } catch {
      return { clauses: [], dropped: 0 } // narration is best-effort; a failure just means no narration, never a crash
    }
    // The REAL honesty gate: drop any falsifiable clause without valid grounding; render approved-only.
    return gateNarration(input, clauses, this.judge)
  }
}
