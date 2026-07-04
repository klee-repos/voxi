/**
 * Capture-flow state (Zustand) — the in-memory result of the most recent scan, shared across the camera →
 * processing → reveal → conversation/podcast screens.
 *
 * This holds ONLY UI/session state derived from the BFF stream (the durable thread lives server-side). It is
 * the bridge between the NDJSON events the ApiClient yields and what each screen renders.
 */
import { create } from 'zustand'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'
import { abortThreadStream } from '../lib/threadStream'

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

/** The narrative buckets that stream as their own `section` event. `what` rides `whatItIs`; `facts` ride `facts[]`.
 *  `made` (when it was made) is stored like the others but has no dock slot — it renders inside the Maker card. */
export type SectionBucket = 'purpose' | 'maker' | 'made'

/** A thread's fully-loaded reveal content, cached in-session (revealCache) so a revisit paints instantly. */
export interface CachedReveal {
  band: ConfidenceBand
  title: string
  candidates: string[]
  whatItIs: string
  facts: RevealFact[]
  sections: Partial<Record<SectionBucket, RevealSection>>
  sawAnySection: boolean
}

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
  /** true when this reveal was opened by REVISITING a catalogued item (collection/tray revisit OR an in-place
   *  swipe) rather than a fresh analysis — flips the loader copy to calm "opening your entry" retrieval (never
   *  the fresh-analysis "cross-referencing / narrowing"), and gates off the scan-line + celebratory haptics. */
  isRevisit: boolean
  outcome: RevealOutcome | null
  error: string | null

  startCapture(photoUri: string | null): void
  setThread(threadId: string): void
  /** mark the current capture as a revisit (called AFTER startCapture, which resets the flag to false). */
  markRevisit(): void
  /** paint a revisit's FULLY-loaded content at once from the session cache — band+title+buckets, marked complete,
   *  so the dock shows instantly with no bucket re-fetch/loading (called AFTER startCapture seeds the photo). */
  hydrate(cached: CachedReveal): void
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
  isRevisit: false,
  outcome: null as RevealOutcome | null,
  error: null as string | null,
}

export const useCaptureStore = create<CaptureState>((set) => ({
  ...initial,
  // Reseeding for a new capture/revisit ends any prior in-flight stream (fresh keepAlive OR a prior swipe) so a
  // late event from the previous thread can't land in this one (threadStream single-owner invariant).
  startCapture: (photoUri) => {
    abortThreadStream()
    set({ ...initial, photoUri })
  },
  setThread: (threadId) => set({ threadId }),
  markRevisit: () => set({ isRevisit: true }),
  // Paint a cached revisit's full content at once; `researchComplete: true` so buckets resolve to active/empty
  // immediately (no loading) and the reveal knows it needs no stream.
  hydrate: (c) =>
    set({
      band: c.band,
      title: c.title,
      candidates: c.candidates,
      whatItIs: c.whatItIs,
      facts: c.facts,
      sections: c.sections,
      sawAnySection: c.sawAnySection,
      researchComplete: true,
      researchError: false,
      outcome: c.band === 'UNKNOWN' ? 'interview' : c.band === 'PROBABLE' ? 'partial' : 'reveal',
    }),
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
  reset: () => {
    abortThreadStream()
    set({ ...initial })
  },
}))

/**
 * Pure derivation of a bucket's dock-icon state (ANALYSIS-UX §4.4) — exported so the UI and the unit tests agree.
 *   • `what`   — SAME loading→active logic as the others: active once its content (the description) has streamed,
 *                loading until then; unavailable on drop/offline. No longer active the instant the band settles —
 *                that lit `what` alone while purpose/maker/facts still read loading on a fresh open / swipe replay.
 *   • `facts`  — active on the first fact; else empty on researchComplete; else unavailable on drop/offline.
 *   • purpose/maker — a `section` with text → active; an empty-marker section → empty (researched, nothing found);
 *                no section yet + researchComplete → empty if any section was seen else HIDDEN (legacy revisit,
 *                adversarial B — never a false "nothing to add"); drop/offline → unavailable; otherwise loading.
 */
export type StatusSlice = Pick<
  CaptureState,
  'band' | 'whatItIs' | 'sections' | 'facts' | 'researchComplete' | 'researchError' | 'sawAnySection'
>
export function deriveBucketStatus(bucket: 'what' | SectionBucket | 'facts', s: StatusSlice, offline: boolean): BucketStatus {
  if (bucket === 'what') {
    if (!s.band) return 'loading'
    if (s.whatItIs) return 'active'
    if (s.researchError || offline) return 'unavailable'
    return 'loading'
  }
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

/** The three research buckets rolled up under the Details dock icon. */
export type DetailsSlice = { what: BucketStatus; purpose: BucketStatus; maker: BucketStatus }

/** The Details dock icon's AGGREGATE state over the research buckets it nests (what/purpose/maker): `loading` while
 *  ANY is still streaming, `empty` if none grounded, else `active`. Pure → unit-pinned (the dock-face contract). */
export function deriveDetailsStatus(s: DetailsSlice): BucketStatus {
  if (s.what === 'loading' || s.purpose === 'loading' || s.maker === 'loading') return 'loading'
  if (s.what !== 'active' && s.purpose !== 'active' && s.maker !== 'active') return 'empty'
  return 'active'
}

/** The Details dock icon's unread dot. It WAITS for the research lane to finish streaming — never while any bucket
 *  is still loading (otherwise the dot pops in beside the spinning ring the moment the first bucket grounds). Pure. */
export function deriveDetailsUnread(s: DetailsSlice, read: Record<'what' | 'purpose' | 'maker', boolean>): boolean {
  return deriveDetailsStatus(s) !== 'loading'
    && (['what', 'purpose', 'maker'] as const).some((k) => s[k] === 'active' && !read[k])
}

// Dev/E2E testability seam (never attached in a production build): expose the store on the browser global so
// Playwright can drive the capture flow to any state without a live backend scan or Clerk sign-in. It seeds the
// SAME state the real NDJSON stream would produce, so what renders is the real screen, not a mock.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(globalThis as unknown as { __captureStore?: typeof useCaptureStore }).__captureStore = useCaptureStore
}
