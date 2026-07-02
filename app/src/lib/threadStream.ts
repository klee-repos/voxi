/**
 * Thread stream ownership + the shared event→store reducer.
 *
 * There is exactly ONE in-flight NDJSON stream at a time. `beginThreadStream()` aborts whatever was running and
 * hands back a fresh `AbortController`; every place that (re)seeds the capture store for a new thread — the
 * camera shutter, a collection/tray revisit, and an in-place reveal SWIPE — starts its stream through it (or,
 * defensively, the store's `startCapture`/`reset` call `abortThreadStream()`). This kills the pre-existing
 * contamination bug: processing keeps its stream ALIVE across the nav to /reveal (`keepAliveRef`), so without a
 * reachable abort a late `fact`/`section`/`done` from the item you swiped AWAY from would land in the item you
 * swiped TO (wrong provenance, wrong count badge, buckets prematurely emptied). One owner, aborted at every
 * reseed, closes that.
 *
 * `applyStreamEvent` is the store-write half of processing's old inline loop, extracted so the reveal's swipe
 * path (`consumeThreadStream`) and processing share ONE mapping and can never drift. Processing keeps its own
 * UI/orb/line/nav/haptics switch on top (behaviour-preserving); this module never touches UI or navigation.
 */
import type { StreamEvent } from '../../../packages/shared/src/events'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'
import type { RevealFact, RevealSection, SectionBucket } from '../state/captureStore'

/** The capture-store setters the reducer drives (stable Zustand action references). */
export interface StreamActions {
  setLastSeenIndex(index: number): void
  appendText(text: string): void
  appendFact(fact: RevealFact): void
  appendSection(bucket: SectionBucket, content: RevealSection): void
  upgradeDescription(text: string): void
  setBand(band: ConfidenceBand, title: string, candidates: string[]): void
  setResearchComplete(): void
  setResearchError(): void
}

/** The one method the loop needs — a seam so the reducer is testable without the whole ApiClient. */
export interface ThreadStreamSource {
  streamThread(threadId: string, opts?: { startIndex?: number; signal?: AbortSignal }): AsyncGenerator<StreamEvent, void, unknown>
}

// The single in-flight stream's controller (module singleton). Null when nothing is streaming.
let current: AbortController | null = null

/** Abort any in-flight stream and start a fresh controller for the next one. Returns the new controller. */
export function beginThreadStream(): AbortController {
  current?.abort()
  current = new AbortController()
  return current
}

/** Abort the in-flight stream (if any) without starting a new one — used by store reseeds/resets. */
export function abortThreadStream(): void {
  current?.abort()
  current = null
}

/** True while a stream is live (started, not yet aborted). Lets the reveal decide whether it must OWN the stream
 *  for a revisit that skipped /processing (nothing running) vs. inherit /processing's keepAlive stream (running). */
export function isThreadStreaming(): boolean {
  return current !== null && !current.signal.aborted
}

/**
 * Map one stream event to its store writes. UI/nav (orb, loading line, /reveal vs /interview routing, haptics)
 * is the CALLER's job — this is only the durable state. `error`/`partial_id`/`tool_*` are intentionally not
 * store writes here (processing handles `error`/`partial_id` with nav-aware logic; tool events have no reveal
 * state). Idempotent by construction: `appendFact` dedupes and `appendSection` is last-write-wins, so a replay
 * or a `?startIndex=` reconnect never double-applies.
 */
export function applyStreamEvent(ev: StreamEvent, a: StreamActions): void {
  a.setLastSeenIndex(ev.index)
  switch (ev.type) {
    case 'token':
      a.appendText(ev.text)
      break
    case 'fact':
      a.appendFact({ text: ev.text, sourceUrl: ev.sourceUrl, sourceTitle: ev.sourceTitle, quote: ev.quote })
      break
    case 'section':
      // Only the two narrative buckets ride `section`; an unknown bucket (a newer server) is ignored, not crashed.
      if (ev.bucket === 'purpose' || ev.bucket === 'maker') {
        a.appendSection(ev.bucket, { text: ev.text, sourceUrl: ev.sourceUrl, sourceTitle: ev.sourceTitle, quote: ev.quote })
      }
      break
    case 'description_upgrade':
      a.upgradeDescription(ev.text)
      break
    case 'confidence_band':
      a.setBand(ev.band, ev.title, ev.candidates)
      break
    case 'done':
      a.setResearchComplete()
      break
    default:
      break
  }
}

/**
 * Drive a thread's stream into the store until it ends or the signal aborts. Used by the reveal's in-place
 * swipe: the resting view is painted synchronously from the cached `ThreadSummary` (band+title+photo), then
 * this fills whatItIs/facts/sections in the background — exactly like processing's `keepAlive` path, minus the
 * screen. A network drop AFTER the band is seeded flips loading buckets to `unavailable` (retriable), never
 * `empty`. An abort is silent (a newer swipe superseded this one).
 */
export async function consumeThreadStream(
  api: ThreadStreamSource,
  threadId: string,
  signal: AbortSignal,
  actions: StreamActions,
  opts: { startIndex?: number } = {},
): Promise<void> {
  try {
    for await (const ev of api.streamThread(threadId, { startIndex: opts.startIndex, signal })) {
      if (signal.aborted) return
      applyStreamEvent(ev, actions)
      if (ev.type === 'done') return
    }
  } catch (e) {
    if (signal.aborted || (e as Error)?.name === 'AbortError') return
    actions.setResearchError()
  }
}
