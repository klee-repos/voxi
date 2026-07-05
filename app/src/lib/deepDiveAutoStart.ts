/**
 * Deep Dive auto-start gate (REVEAL-STREAMING-PLAN F2, decoupled from "all facts done").
 *
 * TODAY the dd auto-starts only after the FULL reveal research completes (`done`). The user
 * asked to decouple — fire after a MINIMUM threshold (the first grounded fact), so the story
 * generates in parallel with the remaining streaming research. The honesty gate is untouched
 * (no new LLM output); the double-charge guard holds (the BFF gate is idempotent per
 * (user,item,version) + `startDeepDive` is idempotent + the reveal-side idle guard).
 *
 * THE RACE (the documented invariant at reveal.tsx:279-287): firing at band-settle starved the
 * reveal's own Firecrawl+OpenAI research. The first-FACT threshold is race-safe because facts
 * only come from the dossier (cascade.ts:478), which runs SEQUENTIALLY AFTER stage-4 first-pass
 * fully completes — so by fact #1 the core reveal (what + first-pass purpose/maker) is already
 * rendered and cannot be starved. The Deep Dive then competes only with the REMAINING dossier
 * work; worst case = slower fact trickle, NOT "no details" (adversarial R1 fold H).
 *
 * The threshold MODE is SERVER-DRIVEN (R1 fold F): the BFF exposes
 * `deepDiveAutoStartThreshold: 'min'|'done'` on the thread + podcast-status responses, sourced
 * from a Cloud Run env var — a server env change rolls a new revision in SECONDS (a true
 * instant kill-switch if the race ever regresses; no app rebuild / App Store review). The
 * build-time env below is the FALLBACK default only, used when the server field is absent
 * (backward compat with an old BFF). It MUST be `EXPO_PUBLIC_*` (Expo inlines client env at
 * build time; a bare name resolves to `undefined`).
 */

export type AutoStartMode = 'min' | 'done'

/** Build-time fallback default. Runtime source of truth is the server-driven field. */
export function envDeepDiveAutoStartThreshold(): AutoStartMode {
  const v = process.env.EXPO_PUBLIC_VOXI_DEEPDIVE_AUTOSTART_THRESHOLD
  return v === 'done' ? 'done' : 'min'
}

export interface CanAutoStartInput {
  /** The server-driven mode (preferred); the caller falls back to envDeepDiveAutoStartThreshold(). */
  mode: AutoStartMode
  offline: boolean
  isRevisit: boolean
  hasThreadId: boolean
  band: unknown | null | undefined
  bandIsUnknown: boolean
  researchComplete: boolean
  researchError: boolean
  /** `facts.length >= 1` — proves stage-4 first-pass is done + the dossier is producing output. */
  hasFirstFact: boolean
}

/**
 * Pure gate. Mirrors today's hard-blocks (offline / revisit / no-thread / no-band / UNKNOWN /
 * researchError) regardless of mode, then applies the mode threshold:
 *   'done' → researchComplete (today's behavior)
 *   'min'  → researchComplete || hasFirstFact (fires at the first grounded fact; falls back to
 *            researchComplete when the dossier yields zero facts)
 */
export function canAutoStartDeepDive(s: CanAutoStartInput): boolean {
  if (s.offline || s.isRevisit || !s.hasThreadId || !s.band || s.bandIsUnknown) return false
  if (s.researchError) return false
  if (s.mode === 'done') return s.researchComplete
  return s.researchComplete || s.hasFirstFact
}
