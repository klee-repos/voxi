/**
 * Loading copy — the single source of truth for what the loader says while a thread hydrates, keyed by FRESH
 * analysis vs REVISIT of an already-catalogued item (captureStore `isRevisit`).
 *
 * A revisit REPLAYS a persisted reveal server-side (no re-analysis, no re-bill), so its loader must read as
 * RETRIEVAL ("opening your entry"), never the fresh-analysis copy that implies the Guide is re-identifying the
 * object. Pure + unit-tested so processing.tsx and reveal.tsx can never drift on the phrasing.
 */
export type LoadKind = 'analyze' | 'revisit'

/** The rotating loader lines. Analyze = the Guide identifying; revisit = the Guide recalling a saved entry. */
const ANALYZE_LINES: readonly string[] = [
  'Consulting the Guide…',
  'Cross-referencing several thousand near-identical objects…',
  'Narrowing it down. Bear with me.',
]
const REVISIT_LINES: readonly string[] = [
  'Opening your entry…',
  'Recalling what the Guide found…',
  'Almost there…',
]

export function loadingLines(kind: LoadKind): readonly string[] {
  return kind === 'revisit' ? REVISIT_LINES : ANALYZE_LINES
}

/** The first line shown before the rotation kicks in. */
export function firstLine(kind: LoadKind): string {
  return loadingLines(kind)[0] ?? 'Consulting the Guide…'
}

/** The settled status for a CONFIDENT identification: analyze celebrates a NEW find; revisit just re-presents. */
export function settledReveal(kind: LoadKind, title: string): string {
  return kind === 'revisit' ? `Here it is: ${title}.` : `I've got it: ${title}.`
}

/** The "still going" acknowledgement on a long wait. */
export function longWaitAck(kind: LoadKind): string {
  return kind === 'revisit' ? 'Still fetching it from your collection.' : 'Still here. Some objects are coy about their identity.'
}

/** Copy for the reveal screen's own transient `!band` loading pill (title + subtitle). */
export function revealLoadingPill(kind: LoadKind): { title: string; sub: string } {
  return kind === 'revisit'
    ? { title: 'Opening your entry…', sub: 'Fetching what I saved.' }
    : { title: 'Settling on a title…', sub: "Nearly there. I don't like to be wrong." }
}

/**
 * Copy for the reveal's EMPTY branch — reached only when the screen is opened with nothing captured (a deep link).
 * A warm getting-started INVITATION in the Guide's voice, never an error ("Nothing to show yet" read as a failure).
 */
export function revealEmptyState(): { title: string; body: string; cta: string } {
  return {
    title: 'Ready when you are.',
    body: "Point me at any human-made object and I'll tell you what it is — a bike, a camera, a curious bottle.",
    cta: 'Open the camera',
  }
}
