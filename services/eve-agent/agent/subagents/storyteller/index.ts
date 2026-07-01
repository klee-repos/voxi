/**
 * storyteller subagent — the 5-minute two-voice podcast SCRIPT (PLAN §4.1, §6.2, §8.3 / §22.1, RT-1, RT-9).
 *
 * Task-mode subagent: it produces a CLOSED, CLAIM-STRUCTURED script (never raw prose), validated against the
 * shared honesty gate BEFORE a single byte of audio is ever rendered. Rendering (TTS + ffmpeg + HLS) is the
 * async `voxi-podcast-worker` (D7); this subagent's job is the words and the proof they are grounded.
 *
 * Two hosts, distinct from Voxi (PLAN §6.2):
 *   - ARLO  — the enthusiast (carries momentum/colour).
 *   - MAVE  — the skeptic / fact-checker; she EMBODIES the honesty policy. She is the one who refuses an
 *             unsupported claim in-character, which is exactly what the validator enforces mechanically.
 *
 * The honesty contract (the load-bearing part):
 *   - Every line is a list of CLAUSES `{ text, claimType, evidenceRef? }` — the same shape the shared
 *     `validateClaims` gate consumes. A falsifiable clause (spec/provenance/date/causal/superlative/comparative)
 *     with no valid evidence ref is HARD-REJECTED. `flavor` is the only free type, and an independent auditor
 *     flags a `flavor` clause that smuggles a named entity/date/place.
 *   - The audio path is **fail-closed** (PLAN §6.2 step 2 / RT-1): if any clause is rejected, the segment is
 *     DROPPED; if dropping leaves the episode too thin, the whole episode fails in-persona — we never ship
 *     unvalidated audio to cache. There is no "render anyway".
 *   - Negative claims about an identifiable entity additionally pass the defamation gate (≥2 independent
 *     sources or human review — PLAN §6.2 / RT-9), reusing the shared `gateClaim`.
 *
 * Nothing is stubbed to force green: the validator and defamation gate are the REAL shared modules; this file
 * only structures the script and decides drop/fail from their verdicts.
 */
import {
  validateClaims,
  type Clause,
  type Evidence,
  type EntailmentJudge,
  type NamedClaimDetector,
} from '../../../../../packages/shared/src/confidence'
import { gateClaim, type Source, type ClaimClassifier } from '../../../../../packages/shared/src/moderation'

/** The two hosts. Voxi never speaks in the podcast; these two do (PLAN §6.2). */
export type Speaker = 'ARLO' | 'MAVE'

/** A single spoken line: one speaker, a list of claim-structured clauses (validated before render). */
export interface ScriptLine {
  speaker: Speaker
  clauses: Clause[]
}

/** The closed input the subagent is handed: the grounded research facts (PLAN §6.2 step 1). */
export interface StorytellerInput {
  /** the identified object the episode is about (e.g. "2008 Cannondale SuperSix EVO"). */
  subject: string
  /** the CLOSED facts[] array from grounded research — the only things a falsifiable clause may cite. */
  evidence: Evidence[]
  /** the source URLs behind those facts, for the defamation independent-source check. */
  sources: Source[]
}

/** The validated, render-ready script (the subagent's `outputSchema`). Only emitted if it passed the gate. */
export interface PodcastScript {
  subject: string
  /** the approved, ordered lines — every clause here is grounded or pure flavor. */
  lines: ScriptLine[]
  /** the closed evidence the worker keeps with the asset (provenance for "report episode"). */
  evidence: Evidence[]
}

/** What happened: a shipped script, or an honest in-persona failure (never silent, never unvalidated audio). */
export type StorytellerResult =
  | { ok: true; script: PodcastScript; droppedLines: number }
  | { ok: false; reason: string; inPersona: string }

export interface StorytellerOpts {
  /** optional entailment judge (NLI/LLM) so a cited clause must actually be supported, not just cite *something*. */
  judge?: EntailmentJudge
  /** independent auditor: flags a `flavor` clause smuggling a falsifiable assertion (RT-1 §22.1). */
  detectNamedClaim?: NamedClaimDetector
  /** defamation claim classifier (heuristic default in the shared module). */
  classifyClaim?: ClaimClassifier
  /** minimum lines for a shippable episode; below this we fail the episode rather than ship a husk. */
  minLines?: number
}

/** Render one line's clauses to its plain text (only used AFTER the line is approved). */
function lineText(line: ScriptLine): string {
  return line.clauses.map((c) => c.text).join(' ')
}

/**
 * Build a validated two-voice script from the closed research input. This is the subagent's core: it walks each
 * proposed line, runs the REAL honesty gate per line (fail-closed: a line with ANY rejected clause is dropped),
 * runs the REAL defamation gate on negative claims, and either emits an approved script or fails in-persona.
 *
 * `proposedLines` is what the model drafted (claim-structured already — the prompt forces that shape). In prod
 * the draft comes from Claude Sonnet 4.6; in tests it is supplied directly so the GATE is what we exercise.
 */
export function buildScript(
  input: StorytellerInput,
  proposedLines: ScriptLine[],
  opts: StorytellerOpts = {},
): StorytellerResult {
  const minLines = opts.minLines ?? 2
  const approvedLines: ScriptLine[] = []
  let dropped = 0

  for (const line of proposedLines) {
    // 1) Honesty gate, fail-closed: validate this line's clauses against the closed evidence. ANY rejection
    //    drops the WHOLE line (we do not ship a half-grounded line). This is the §6.2-step-2 hard reject.
    const verdict = validateClaims(line.clauses, input.evidence, {
      judge: opts.judge,
      detectNamedClaim: opts.detectNamedClaim,
      failClosed: true, // audio path: never render a rejected clause.
    })
    if (!verdict.ok) {
      dropped++
      continue
    }

    // 2) Defamation gate (RT-9): a negative claim about an identifiable entity needs ≥2 independent sources,
    //    else it goes to human review → for the automated render path that means DROP the line (fail-closed).
    const text = lineText(line)
    const defam = gateClaim(text, input.sources, opts.classifyClaim)
    if (defam.action !== 'allow') {
      dropped++
      continue
    }

    approvedLines.push(line)
  }

  // 3) If the surviving script is too thin to be a real episode, fail the whole thing IN PERSONA (PLAN §6.2):
  //    never ship a husk, and never ship unvalidated audio. Mave's line is the honest refusal.
  if (approvedLines.length < minLines) {
    return {
      ok: false,
      reason: `only ${approvedLines.length} grounded line(s) survived the honesty gate (need ${minLines})`,
      inPersona:
        "I couldn't verify enough about this one to tell its story properly — so I won't pretend. " +
        'When the Guide knows more, the episode will be here.',
    }
  }

  return {
    ok: true,
    script: { subject: input.subject, lines: approvedLines, evidence: input.evidence },
    droppedLines: dropped,
  }
}

/** The subagent's declared output schema (PLAN §4.1 "outputSchema"), as runtime-checkable predicates. */
export const OUTPUT_SCHEMA = {
  hasTwoSpeakers(script: PodcastScript): boolean {
    const speakers = new Set(script.lines.map((l) => l.speaker))
    return speakers.has('ARLO') && speakers.has('MAVE')
  },
  everyFalsifiableClauseCited(script: PodcastScript): boolean {
    const refs = new Set(script.evidence.map((e) => e.ref))
    const FALSIFIABLE = new Set(['spec', 'provenance', 'date', 'causal', 'superlative', 'comparative'])
    return script.lines.every((l) =>
      l.clauses.every((c) => !FALSIFIABLE.has(c.claimType) || (c.evidenceRef !== undefined && refs.has(c.evidenceRef))),
    )
  },
} as const
