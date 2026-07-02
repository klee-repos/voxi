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
import type { Evidence } from '../../../packages/shared/src/confidence'
import type { Narrator, NarrationClause, NarrativeBucket } from './providers/live-narrator'
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

/** Common English words that are ALSO brands (Dove, Shell, Apple, …). A single such word can't disambiguate the
 *  research entity (`sourceMatchesSubject(['dove'])` matches a Dove-chocolate page for a Dove-soap object), so the
 *  brand lane refuses them and falls back to honest-empty maker (§13.3, adversarial #15). */
const COMMON_WORD_BRANDS: ReadonlySet<string> = new Set([
  'dove', 'shell', 'apple', 'galaxy', 'delta', 'puma', 'orange', 'sun', 'tide', 'amazon', 'gap', 'guess', 'monster',
  'polo', 'coach', 'north', 'face', 'pink', 'boss', 'fossil', 'method', 'dawn', 'joy', 'off', 'raid',
])

/** A brand is DISTINCTIVE enough to research as an entity when it is multi-token ("Sub Pop", "Sonic Youth") OR a
 *  single word that is not a common dictionary/homonym word (§13.3, adversarial #15). Conservative: an ambiguous
 *  single-word brand is treated as non-distinctive → the maker stays honest-empty rather than risk wrong-entity facts. */
export function isDistinctiveBrand(brand: string | undefined): boolean {
  const toks = (brand ?? '').trim().split(/\s+/).filter(Boolean)
  if (toks.length >= 2) return true
  const single = (toks[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return single.length >= 3 && !COMMON_WORD_BRANDS.has(single)
}

/**
 * The honesty-safe DOSSIER keying for the async deep-research step (PROMPT-QUALITY §3.B4, §13.2/§13.3).
 *  - CONFIDENT → 'item' scope on the corroborated make + BASE model (`subject` prefers the clean `displayTitle`).
 *  - PROBABLE with a DISTINCTIVE observed brand → the BRAND LANE: research the brand ENTITY at item rigor
 *    (subjectTerms=[brand], no disallowed), so "Sub Pop the label" grounds the maker/facts — but flagged `brandLane`
 *    so facts stay about the brand, never asserting the object is a specific edition (adversarial #5).
 *  - PROBABLE otherwise → 'class' scope on the category only, VLM make/model as `disallowedSpecificTerms`.
 *  - UNKNOWN → null.
 */
export function buildDossierInput(result: IdentifyResult): DossierInput | null {
  if (result.confidence_band === 'UNKNOWN') return null
  const chosen = result.candidates[0]
  const make = chosen?.make
  const model = chosen?.model?.replace(/\(.*?\)/g, '').trim() || undefined
  const brand = result.observedBrand
  const category = result.category || result.label

  // A CONFIDENT identity with a real MAKE (e.g. "Canon AE-1", "La Croix") → research THAT specific item.
  if (result.confidence_band === 'CONFIDENT' && make) {
    const terms = [make, model].filter(Boolean) as string[]
    const subject = result.displayTitle || terms.join(' ') || result.label
    return { subject, scope: 'item', subjectTerms: terms.length ? terms : [result.label] }
  }

  // Otherwise — a hedged reveal, OR a CONFIDENT-but-GENERIC web label ("coffee cup") with no make — if the object
  // BEARS a distinctive brand we read off it, research the brand ENTITY, keyed on the brand REGARDLESS of the arbiter's
  // band, so a generic web winner never buries the brand printed on the object (the East-Street-mug bug). Honest: we
  // research the brand, never asserting the specimen's edition (the brand-lane extract prompt forbids that).
  if (brand && isDistinctiveBrand(brand)) {
    return { subject: brand, scope: 'item', subjectTerms: [brand], brandLane: true, objectType: category }
  }

  // No brand read → class scope on the category, with the (unconfirmed) VLM make/model disallowed.
  const disallowed = [make, model].filter(Boolean) as string[]
  return { subject: category, scope: 'class', subjectTerms: [category], disallowedSpecificTerms: disallowed }
}

/** The two narrative buckets that stream as their own `section` event (ANALYSIS-UX): `what_is_it` rides the
 *  `token`s/`description_upgrade`, the facts bucket rides `fact` events, and these two get `section` events. */
const SECTION_BUCKETS: readonly Extract<NarrativeBucket, 'purpose' | 'maker'>[] = ['purpose', 'maker']

/**
 * Build a `section` payload for one bucket from gate-approved narration clauses + the closed evidence. Source proof
 * = the first clause citing a REAL evidence ref (never the band-as-evidence `'id'`, which is not a URL/quote — its
 * "source" would render as a dead `voxi:cascade` link). Returns null when the narrator produced no clause for it.
 */
function sectionFor(
  bucket: NarrativeBucket,
  clauses: NarrationClause[],
  evidence: Evidence[],
): { text: string; sourceUrl: string; sourceTitle: string; quote: string } | null {
  const group = clauses.filter((c) => c.bucket === bucket)
  if (!group.length) return null
  let sourceUrl = ''
  let quote = ''
  for (const c of group) {
    // A source proof needs a REAL, tappable URL — never an internal `voxi:` sentinel (`voxi:cascade` = the
    // band-as-evidence `id`; `voxi:observed` = an on-object mark). Those would render as a dead link on the client,
    // so a section citing only them carries no source row (§13.4); the observation lives in the section BODY text.
    if (c.evidenceRef) {
      const ev = evidence.find((e) => e.ref === c.evidenceRef)
      if (ev && ev.sourceUrl && !ev.sourceUrl.startsWith('voxi:')) {
        sourceUrl = ev.sourceUrl
        quote = ev.claim
        break
      }
    }
  }
  return { text: group.map((c) => c.text).join(' '), sourceUrl, sourceTitle: '', quote }
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
  // Which narrative sections we've streamed — so a bucket the narration never grounds gets an empty-marker section
  // before `done` (a NEW reveal ALWAYS carries the full purpose/maker set → the client shows honest `empty`, while
  // a pre-redesign durable reveal with NO section events stays distinguishable → its buckets hide, never false-empty).
  const emittedSections = new Set<string>()
  if (deps.narrator && result.confidence_band !== 'UNKNOWN') {
    // Enrich the closed evidence with GROUNDED facts the narrator may cite (best-effort; a failure/timeout falls
    // back to web evidence only). CONFIDENT grounds the item, PROBABLE grounds only the class — never the model.
    let evidence = result.evidence
    // Skip the sync CLASS researcher for a brand-primary object — its generic category facts ("a ceramic mug retains
    // heat") only produce a GENERIC first-pass purpose that muddies a branded reveal. The dossier BRAND lane supplies
    // the real, specific purpose/maker; until it lands the bucket honestly loads rather than showing category filler.
    const researchInput = result.observedBrand && isDistinctiveBrand(result.observedBrand) ? null : buildResearchInput(result)
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
      // Narrate about the SPECIFIC identity (the clean displayTitle), not the raw make+model concat (§4.B / D-2).
      subject: result.displayTitle ?? result.label,
      band: result.confidence_band,
      evidence, // includes the observed-brand `obs` row (narrator MAY cite it as an `observation`, §13.1)
      unsupportedFields: result.unsupported_fields,
      candidates: result.candidates.map((c) => c.name),
    })
    // Stream ONLY the `what_is_it` clauses as `token`s (→ `whatItIs`) and PIN the what-only audio synchronously —
    // so `/speech/what` voices exactly the What card's text, never the full what+purpose+maker composite
    // (adversarial A). The `purpose`/`maker` clauses become their own progressive `section` events (from the FAST
    // first pass, so their icons light early — later superseded by the richer dossier upgrade below).
    const whatClauses = narration.clauses.filter((c) => c.bucket === 'what_is_it')
    if (whatClauses.length) deps.onNarration?.(whatClauses.map((c) => c.text))
    for (const c of whatClauses) yield at({ type: 'token', text: c.text })
    for (const bucket of SECTION_BUCKETS) {
      const sec = sectionFor(bucket, narration.clauses, evidence)
      if (sec) {
        emittedSections.add(bucket)
        yield at({ type: 'section', bucket, text: sec.text, sourceUrl: sec.sourceUrl, sourceTitle: sec.sourceTitle, quote: sec.quote })
      }
    }
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
              subject: result.displayTitle ?? result.label,
              band: result.confidence_band,
              // Merge the observed-brand `obs` row into the dossier evidence so the What card keeps its grounded
              // "bears the <brand> mark" observation even after the richer dossier upgrade (§13.1).
              evidence: [...result.evidence.filter((e) => e.sourceUrl.startsWith('voxi:observed')), ...ev.dossier.evidence],
              unsupportedFields: result.unsupported_fields,
              candidates: result.candidates.map((c) => c.name),
            })
            // The upgrade refines each bucket from the richer dossier evidence: `what_is_it` → the what-only
            // `description_upgrade` (never the full composite — adversarial A/G), `purpose`/`maker` → `section`
            // events that SUPERSEDE the first-pass ones (the client's appendSection is last-write-wins per bucket).
            const whatUp = upgraded.clauses.filter((c) => c.bucket === 'what_is_it')
            if (whatUp.length) yield at({ type: 'description_upgrade', text: whatUp.map((c) => c.text).join(' ') })
            for (const bucket of SECTION_BUCKETS) {
              const sec = sectionFor(bucket, upgraded.clauses, ev.dossier.evidence)
              if (sec) {
                emittedSections.add(bucket)
                yield at({ type: 'section', bucket, text: sec.text, sourceUrl: sec.sourceUrl, sourceTitle: sec.sourceTitle, quote: sec.quote })
              }
            }
          }
        }
      } catch {
        /* best-effort: a research failure/timeout leaves the instant reveal exactly as it was streamed. */
      }
    }
  }

  // Backstop: any narrative bucket the narration never grounded gets an empty-marker `section` (text:'') so the
  // client resolves it to an honest `empty` icon rather than a perpetual spinner, and NEW reveals are always
  // distinguishable from pre-redesign ones (which carry no `section` events → their buckets hide).
  if (deps.narrator && result.confidence_band !== 'UNKNOWN') {
    for (const bucket of SECTION_BUCKETS) {
      if (!emittedSections.has(bucket)) yield at({ type: 'section', bucket, text: '', sourceUrl: '', sourceTitle: '', quote: '' })
    }
  }

  yield at({ type: 'done', sessionId })
}
