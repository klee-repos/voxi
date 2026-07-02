/**
 * The identification cascade as a STREAM (PLAN §4.6, §8.4, §5, §8.3) — the deterministic core of what the eve
 * workflow does for one photo, factored out of the durable runtime so it is:
 *   - runnable + unit-testable HERE with fakes (no creds, no framework), and
 *   - runnable LIVE by injecting the real providers (LiveSafetyClassifier + LiveVisionProvider), and
 *   - emitting EXACTLY the `packages/shared/src/events.ts` NDJSON taxonomy the client already renders.
 *
 * It runs safety_gate FIRST (the persona never sees a blocked image), then identify_object, then maps the
 * arbitrated result to a `confidence_band` event. It does NOT fabricate the witty narration — that is the
 * storyteller subagent (an LLM, creds-gated); this bridge streams the IDENTIFICATION, which is the load-bearing,
 * verifiable half. Wiring the storyteller on top is a `token`-event concatenation over the same stream.
 */
import type { StreamEvent } from '../../../packages/shared/src/events'
import { identify_object, type VisionProvider, type ImageRef, type IdentifyResult } from './tools/identify_object'
import { safety_gate, type SafetyClassifier, type SafetyThresholds, DEFAULT_SAFETY_THRESHOLDS } from './tools/safety_gate'
import type { Thresholds } from '../../../packages/shared/src/arbitration'
import { DEFAULT_THRESHOLDS } from '../../../packages/shared/src/arbitration'
import type { Narrator } from './providers/live-narrator'
import type { Researcher, ResearchInput } from './providers/live-research'
import type { DossierProvider } from './providers/live-dossier'
import type { DossierInput } from './subagents/researcher'

export interface CascadeDeps {
  vision: VisionProvider
  safety: SafetyClassifier
  arbitration?: Thresholds
  safetyThresholds?: SafetyThresholds
  /** OPTIONAL persona narrator ("what it is / its use"). When present, gate-approved narration is streamed as
   *  `token` events after the reveal band; absent → identification-only stream (the deterministic default). */
  narrator?: Narrator
  /**
   * OPTIONAL grounded researcher. When present (with a narrator), the reveal is ENRICHED with grounded facts the
   * narrator can cite — CONFIDENT gets item-level facts (make/base-model), PROBABLE gets class-level facts only
   * (never a specific model). Best-effort: any failure leaves the narration on web evidence only. UNKNOWN never
   * researches (it hands off to the interview). See `buildResearchInput` for the honesty-safe keying rules.
   */
  researcher?: Researcher
  /**
   * OPTIONAL async deep-research provider (PROMPT-QUALITY §3.B). When present (with a narrator), AFTER the instant
   * reveal + first-pass narration the cascade drives it OFF the reveal path, streaming each VERIFIED, provably-
   * sourced fact as a `fact` event and (when the dossier lands) a richer `description_upgrade`, THEN the terminal
   * `done`. Best-effort: any failure/timeout leaves the instant reveal exactly as it was. UNKNOWN never researches.
   */
  dossier?: DossierProvider
  /**
   * OPTIONAL image pre-loader (INJECTED so the cascade stays GCP-free/testable). When present, the image is
   * fetched ONCE up front and the bytes are threaded to both stages; a fetch failure is a technical
   * `hard_failure` (retryable) — NOT a safety refusal — so a dead URL never reads as "unsafe content".
   */
  preload?: (uri: string) => Promise<{ b64: string; mime: string }>
  /**
   * OPTIONAL synchronous hook fired with the gate-approved FIRST-PASS narration clauses the instant the narrator
   * produces them — BEFORE they stream as `token` events and before the async deep-research phase. The BFF uses it
   * to PIN the server-owned narration immediately, so POST /v1/threads/:id/speech has it the moment the reveal
   * renders (capturing off the event stream instead would wait for the ~minute-long deep-research drain). No-op when
   * absent; never fired on UNKNOWN (no narration) or when the gate drops every clause.
   */
  onNarration?: (clauses: string[]) => void
}

/** Human-facing refusal copy per suppressing action (kept dry + in-persona; NEVER identifies the object). */
const REFUSAL: Record<string, string> = {
  refuse_non_identifying: "I keep to objects, not medicine — I won't identify pills, dosages, or markings.",
  block: "That's not something I'm willing to look at. Point me at something else and I'm all yours.",
}

/** A weapon is named at CATEGORY level only — never model/caliber/acquisition/modification (§8.4). */
const CATEGORY_LABEL: Record<string, string> = { weapon: 'a weapon (I can see what it is, but I keep the details to myself)' }

/**
 * The honesty-safe research keying (ANALYSIS-VOICE-PLAN A8/A9). Returns null when nothing may be researched.
 *  - CONFIDENT → 'item' scope keyed on make + BASE model (parentheticals stripped). The year is included ONLY
 *    when a NON-VLM stage corroborated it (`chosen.source !== 'vlm'`), so an uncorroborated VLM year/sub-variant
 *    can never seed cited facts about the wrong unit.
 *  - PROBABLE  → 'class' scope keyed on the coarse category ONLY (never a specific make/model), so a hedged
 *    reveal can still carry a grounded class fact without asserting an identity the arbiter did not confirm.
 *  - UNKNOWN   → null (the interview handles it, not the persona).
 */
export function buildResearchInput(result: IdentifyResult): ResearchInput | null {
  if (result.confidence_band === 'CONFIDENT') {
    const chosen = result.candidates[0]
    const baseModel = chosen?.model?.replace(/\(.*?\)/g, '').trim() || undefined
    const year = chosen && chosen.source !== 'vlm' ? chosen.year : undefined
    return { scope: 'item', label: result.label, make: chosen?.make, model: baseModel, year, category: result.category }
  }
  if (result.confidence_band === 'PROBABLE') {
    return { scope: 'class', label: result.label, category: result.category }
  }
  return null
}

/**
 * The honesty-safe DOSSIER keying for the async deep-research step (PROMPT-QUALITY §3.B4). CONFIDENT → 'item' scope
 * on the corroborated make + BASE model (the `subject` prefers the clean `displayTitle`); the source-subject match
 * keys on [make, model]. PROBABLE → 'class' scope on the category only, and the VLM's (unconfirmed) make/model are
 * passed as `disallowedSpecificTerms` so a class-level fact can never NAME the specific model. UNKNOWN → null.
 */
export function buildDossierInput(result: IdentifyResult): DossierInput | null {
  if (result.confidence_band === 'CONFIDENT') {
    const chosen = result.candidates[0]
    const make = chosen?.make
    const model = chosen?.model?.replace(/\(.*?\)/g, '').trim() || undefined
    const terms = [make, model].filter(Boolean) as string[]
    const subject = result.displayTitle || [make, model].filter(Boolean).join(' ') || result.label
    return { subject, scope: 'item', subjectTerms: terms.length ? terms : [result.label] }
  }
  if (result.confidence_band === 'PROBABLE') {
    const category = result.category || result.label
    const chosen = result.candidates[0]
    const disallowed = [chosen?.make, chosen?.model].filter(Boolean) as string[]
    return { subject: category, scope: 'class', subjectTerms: [category], disallowedSpecificTerms: disallowed }
  }
  return null
}

/**
 * Run the cascade for one image, yielding typed StreamEvents. `sessionId` is echoed on the terminal `done`.
 * Every event carries a monotonic `index` (the reconnection cursor, §4).
 */
export async function* runIdentificationCascade(
  sessionId: string,
  image: ImageRef,
  deps: CascadeDeps,
): AsyncGenerator<StreamEvent> {
  let i = 0
  const at = <E extends Omit<StreamEvent, 'index'>>(e: E) => ({ ...e, index: i++ }) as StreamEvent

  // ── Stage -1: fetch the image ONCE (when a loader is injected). A fetch failure is a technical hard_failure,
  //    NOT a safety refusal — the safety gate must only fail-closed on a genuine classification error. ──
  let scoped = image
  if (deps.preload) {
    try {
      scoped = { ...image, bytes: await deps.preload(image.uri) }
    } catch (err) {
      yield at({ type: 'error', code: 'hard_failure', message: `could not load image: ${(err as Error).message}` })
      yield at({ type: 'done', sessionId })
      return
    }
  }

  // ── Stage 0: safety gate (before the persona sees anything). ──
  yield at({ type: 'tool_start', tool: 'safety_gate' })
  const verdict = await safety_gate(scoped, deps.safety, deps.safetyThresholds ?? DEFAULT_SAFETY_THRESHOLDS)
  yield at({ type: 'tool_result', tool: 'safety_gate', ok: !verdict.fault })

  // A classifier FAULT (could not score the image) fails closed — no identification — but is surfaced as a
  // retryable TECHNICAL error, never a content refusal that implies the user's photo was unsafe.
  if (verdict.fault) {
    yield at({ type: 'error', code: 'hard_failure', message: "I couldn't get a clear look at that just now — try that shot again in a moment." })
    yield at({ type: 'done', sessionId })
    return
  }

  // Suppressing categories terminate with a content refusal (the BFF credits the scan back on this code, §13/F9).
  if (verdict.action === 'refuse_non_identifying' || verdict.action === 'block') {
    yield at({ type: 'error', code: 'safety_refusal', message: REFUSAL[verdict.action]! })
    yield at({ type: 'done', sessionId })
    return
  }

  // Weapon → name the category ONLY; the specific-ID stage never runs.
  if (verdict.action === 'category_name_only') {
    yield at({ type: 'confidence_band', band: 'CONFIDENT', title: CATEGORY_LABEL[verdict.category] ?? 'a restricted object', candidates: [] })
    yield at({ type: 'done', sessionId })
    return
  }

  // ── Stage 1–3: the identification cascade (VLM + web + catalog → arbitration). ──
  yield at({ type: 'tool_start', tool: 'identify_object' })
  let result: Awaited<ReturnType<typeof identify_object>>
  try {
    result = await identify_object(scoped, deps.vision, deps.arbitration ?? DEFAULT_THRESHOLDS)
  } catch (err) {
    yield at({ type: 'tool_result', tool: 'identify_object', ok: false })
    yield at({ type: 'error', code: 'hard_failure', message: `identification failed: ${(err as Error).message}` })
    yield at({ type: 'done', sessionId })
    return
  }
  yield at({ type: 'tool_result', tool: 'identify_object', ok: true })

  // The arbitrated band IS the reveal: CONFIDENT→reveal card, PROBABLE→partial (both candidates), UNKNOWN→interview.
  // Any reveal CARD (CONFIDENT or PROBABLE) shows the single clean human `displayTitle`; the uncertainty is carried
  // by the confidence chip + the candidate list, NOT by a hedged "X or Y" title. UNKNOWN routes to the interview,
  // not a card, so it keeps the arbitrated label (never asserting a tidy identity we could not place at all).
  const revealTitle =
    result.confidence_band === 'UNKNOWN' ? result.label : result.displayTitle ?? result.label
  yield at({
    type: 'confidence_band',
    band: result.confidence_band,
    title: revealTitle,
    candidates: result.candidates.map((c) => c.name),
  })

  // Persona narration ("what it is / its use") — only on a reveal (CONFIDENT/PROBABLE); UNKNOWN hands off to the
  // interview instead. Every clause is already honesty-gated by the narrator; we stream it as `token` events. A
  // narrator failure is non-fatal — the reveal still stands.
  if (deps.narrator && result.confidence_band !== 'UNKNOWN') {
    // Enrich the closed evidence with GROUNDED facts the narrator may cite (best-effort; a failure/timeout falls
    // back to web evidence only). CONFIDENT grounds the item, PROBABLE grounds only the class — never the model.
    let evidence = result.evidence
    const researchInput = buildResearchInput(result)
    if (deps.researcher && researchInput) {
      try {
        const facts = await deps.researcher.research(researchInput)
        if (facts.length) evidence = [...evidence, ...facts]
      } catch {
        /* enrichment is best-effort — never block or fail the reveal on a research error */
      }
    }
    const narration = await deps.narrator.narrate({
      label: result.label,
      band: result.confidence_band,
      evidence,
      unsupportedFields: result.unsupported_fields,
      candidates: result.candidates.map((c) => c.name),
    })
    // PIN the narration synchronously, the instant it's produced — before streaming tokens and before the async
    // deep-research phase below — so the BFF can voice it (POST /speech) the moment the reveal renders (not ~a
    // minute later at end-of-stream). Only when there's something to say (dropped-to-empty never pins).
    if (narration.clauses.length) deps.onNarration?.(narration.clauses)
    for (const clause of narration.clauses) yield at({ type: 'token', text: clause })
  }

  // ── Async deep research (PROMPT-QUALITY §3.B4): OFF the reveal path (the reveal already streamed above). Stream
  //    each VERIFIED, provably-sourced fact as a `fact` event as it clears the honesty gate, then a richer grounded
  //    `description_upgrade` re-voiced from the dossier's closed evidence, THEN the deferred terminal `done`. A
  //    single generator ⇒ one monotonic `index` across both phases. Best-effort: research NEVER breaks the reveal,
  //    and it must NEVER emit a terminal `error` (those codes are reserved for phase-1 id failure + the refund). ──
  if (deps.dossier && deps.narrator && result.confidence_band !== 'UNKNOWN') {
    const dossierInput = buildDossierInput(result)
    if (dossierInput) {
      try {
        for await (const ev of deps.dossier.research(dossierInput)) {
          if (ev.type === 'fact') {
            yield at({ type: 'fact', text: ev.fact.text, sourceUrl: ev.fact.sourceUrl, sourceTitle: ev.fact.sourceTitle, quote: ev.fact.quote })
          } else if (ev.type === 'done' && ev.dossier && ev.dossier.evidence.length) {
            const upgraded = await deps.narrator.narrate({
              label: result.label,
              band: result.confidence_band,
              evidence: ev.dossier.evidence,
              unsupportedFields: result.unsupported_fields,
              candidates: result.candidates.map((c) => c.name),
            })
            if (upgraded.clauses.length) yield at({ type: 'description_upgrade', text: upgraded.clauses.join(' ') })
          }
        }
      } catch {
        /* best-effort: a research failure/timeout leaves the instant reveal exactly as it was streamed. */
      }
    }
  }

  yield at({ type: 'done', sessionId })
}
