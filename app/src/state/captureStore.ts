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
  setOutcome: (outcome) => set({ outcome }),
  setError: (error) => set({ error, outcome: 'failure' }),
  reset: () => set({ ...initial }),
}))

// Dev/E2E testability seam (never attached in a production build): expose the store on the browser global so
// Playwright can drive the capture flow to any state — reveal READY/LOADING, processing, refusal — without a
// live backend scan or Clerk sign-in. Same spirit as the FakeAuth fallback (lib/clerk) and the BFF test-seed:
// it seeds the SAME state the real NDJSON stream would produce, so what renders is the real screen, not a mock.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(globalThis as unknown as { __captureStore?: typeof useCaptureStore }).__captureStore = useCaptureStore
}
