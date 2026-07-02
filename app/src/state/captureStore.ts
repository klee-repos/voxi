/**
 * Capture-flow state (Zustand) — the in-memory result of the most recent scan, shared across the camera →
 * processing → reveal → conversation/podcast screens.
 *
 * This holds ONLY UI/session state derived from the BFF stream (the durable thread lives server-side). It is
 * the bridge between the NDJSON events the ApiClient yields and what each screen renders.
 */
import { create } from 'zustand'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'

export type RevealOutcome = 'reveal' | 'partial' | 'interview' | 'failure' | 'refusal'

/** A verified reveal fact with its attached provenance (the durable "proof if challenged"). */
export interface RevealFact {
  text: string
  sourceUrl: string
  sourceTitle: string
  quote: string
}

/** One normalized research SECTION (ANALYSIS-UX): the grounded text for a narrative bucket + optional source proof.
 *  A `section` with empty `text` is the honest "I researched this and found nothing groundable" marker (distinct
 *  from a bucket that never arrived) — it flips the icon to `empty`, not perpetual `loading`. */
export interface RevealSection {
  text: string
  sourceUrl: string
  sourceTitle: string
  quote: string
}

/** The two narrative buckets that stream as their own `section` event. `what` rides `whatItIs`; `facts` ride `facts[]`. */
export type SectionBucket = 'purpose' | 'maker'

/** The dock icon state for one research bucket, derived purely from store state (testable; UI reads this). */
export type BucketStatus = 'loading' | 'active' | 'empty' | 'unavailable' | 'hidden'

export interface CaptureState {
  threadId: string | null
  photoUri: string | null
  /** loading lines streamed during processing. */
  loadingLine: string
  title: string
  band: ConfidenceBand | null
  whatItIs: string
  candidates: string[]
  /** the async deep-research facts — appended ONE-BY-ONE as each is found + verified (progressive reveal). */
  facts: RevealFact[]
  /** the two narrative research buckets (what's-it-for / who-made-it), streamed as `section` events. */
  sections: Partial<Record<SectionBucket, RevealSection>>
  /** true once ANY `section` event has been seen — distinguishes a NEW-era reveal (buckets show empty honestly)
   *  from a durable revisit of a pre-redesign reveal (no sections at all → buckets hidden, never false-empty). */
  sawAnySection: boolean
  /** the async research stream reached its terminal `done` — a still-empty bucket may now settle to `empty`. */
  researchComplete: boolean
  /** the research stream dropped/errored AFTER band-settle — loading buckets settle to `unavailable` (retriable),
   *  NEVER conflated with `empty` (which would falsely claim the object has nothing to know). */
  researchError: boolean
  /** highest stream `index` seen — the `?startIndex=` seed for the unavailable-retry resume. */
  lastSeenIndex: number | null
  outcome: RevealOutcome | null
  error: string | null

  startCapture(photoUri: string | null): void
  setThread(threadId: string): void
  setLoadingLine(line: string): void
  setBand(band: ConfidenceBand, title: string, candidates: string[]): void
  appendText(text: string): void
  /** the async, grounded description replacing the first-pass narration (visual upgrade). */
  upgradeDescription(text: string): void
  /** append a verified fact (idempotent by text+source, so a reconnect/replay never double-adds a chip). */
  appendFact(fact: RevealFact): void
  /** set a narrative bucket's content — LAST-WRITE-WINS (the dossier upgrade supersedes the first-pass version). */
  appendSection(bucket: SectionBucket, content: RevealSection): void
  setResearchComplete(): void
  setResearchError(): void
  setLastSeenIndex(index: number): void
  setOutcome(outcome: RevealOutcome): void
  setError(error: string): void
  reset(): void
}

const initial = {
  threadId: null,
  photoUri: null,
  loadingLine: 'Consulting the Guide…',
  title: '',
  band: null as ConfidenceBand | null,
  whatItIs: '',
  candidates: [] as string[],
  facts: [] as RevealFact[],
  sections: {} as Partial<Record<SectionBucket, RevealSection>>,
  sawAnySection: false,
  researchComplete: false,
  researchError: false,
  lastSeenIndex: null as number | null,
  outcome: null as RevealOutcome | null,
  error: null as string | null,
}

export const useCaptureStore = create<CaptureState>((set) => ({
  ...initial,
  startCapture: (photoUri) => set({ ...initial, photoUri }),
  setThread: (threadId) => set({ threadId }),
  setLoadingLine: (loadingLine) => set({ loadingLine }),
  setBand: (band, title, candidates) =>
    set({ band, title, candidates, outcome: band === 'UNKNOWN' ? 'interview' : band === 'PROBABLE' ? 'partial' : 'reveal' }),
  appendText: (text) => set((s) => ({ whatItIs: s.whatItIs ? `${s.whatItIs} ${text}` : text })),
  // The async grounded description REPLACES the first-pass narration (visual upgrade — §3.C).
  upgradeDescription: (text) => set({ whatItIs: text }),
  // Idempotent by text+source so a `?startIndex=` reconnect / durable revisit never double-adds a fact chip.
  appendFact: (fact) =>
    set((s) => (s.facts.some((f) => f.text === fact.text && f.sourceUrl === fact.sourceUrl) ? s : { facts: [...s.facts, fact] })),
  // Last-write-wins per bucket: the dossier upgrade's richer/better-sourced section supersedes the first-pass one.
  // `sawAnySection` latches true so a NEW-era reveal shows honest `empty` while a pre-redesign revisit stays hidden.
  appendSection: (bucket, content) => set((s) => ({ sections: { ...s.sections, [bucket]: content }, sawAnySection: true })),
  setResearchComplete: () => set({ researchComplete: true }),
  setResearchError: () => set({ researchError: true }),
  setLastSeenIndex: (index) => set((s) => ({ lastSeenIndex: s.lastSeenIndex === null || index > s.lastSeenIndex ? index : s.lastSeenIndex })),
  setOutcome: (outcome) => set({ outcome }),
  setError: (error) => set({ error, outcome: 'failure' }),
  reset: () => set({ ...initial }),
}))

/**
 * Pure derivation of a bucket's dock-icon state (ANALYSIS-UX §4.4) — exported so the UI and the unit tests agree.
 *   • `what`   — active the instant the band is settled (identity is known; narration is guaranteed to follow), so
 *                the primary icon never flips loading→active jarringly while tokens stream (adversarial D).
 *   • `facts`  — active on the first fact; else empty on researchComplete; else unavailable on drop/offline.
 *   • purpose/maker — a `section` with text → active; an empty-marker section → empty (researched, nothing found);
 *                no section yet + researchComplete → empty if any section was seen else HIDDEN (legacy revisit,
 *                adversarial B — never a false "nothing to add"); drop/offline → unavailable; otherwise loading.
 */
export type StatusSlice = Pick<
  CaptureState,
  'band' | 'sections' | 'facts' | 'researchComplete' | 'researchError' | 'sawAnySection'
>
export function deriveBucketStatus(bucket: 'what' | SectionBucket | 'facts', s: StatusSlice, offline: boolean): BucketStatus {
  if (bucket === 'what') return s.band ? 'active' : 'loading'
  if (bucket === 'facts') {
    if (s.facts.length > 0) return 'active'
    if (s.researchComplete) return 'empty'
    if (s.researchError || offline) return 'unavailable'
    return 'loading'
  }
  const sec = s.sections[bucket]
  if (sec) return sec.text ? 'active' : 'empty'
  if (s.researchComplete) return s.sawAnySection ? 'empty' : 'hidden'
  if (s.researchError || offline) return 'unavailable'
  return 'loading'
}

// Dev/E2E testability seam (never attached in a production build): expose the store on the browser global so
// Playwright can drive the capture flow to any state — reveal READY/LOADING, processing, refusal — without a
// live backend scan or Clerk sign-in. Same spirit as the FakeAuth fallback (lib/clerk) and the BFF test-seed:
// it seeds the SAME state the real NDJSON stream would produce, so what renders is the real screen, not a mock.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(globalThis as unknown as { __captureStore?: typeof useCaptureStore }).__captureStore = useCaptureStore
}
