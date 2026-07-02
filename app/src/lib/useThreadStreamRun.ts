/**
 * useThreadStreamRun — the ONE loading-stream engine, shared by the `/processing` alias screen and the reveal
 * surface's own pre-band loading overlay (LOADING-EXPERIENCE-PLAN §3.1). It is the extraction of processing's
 * old inline `run()`: begin the single-owner stream → `applyStreamEvent` into the shared store → rotate the
 * loader copy → arm the long-wait ack → settle the band → hand off. It owns ONLY the loading UI state + the
 * stream lifecycle; NAVIGATION is the caller's (via `onOutcome`), so the reveal can settle in place while the
 * alias route-replaces — one engine, zero drift on the mapping/copy/timing the adversarial pass flagged (A2).
 *
 * Ownership contract (mirrors threadStream.beginThreadStream single-owner): the hook auto-starts on mount /
 * threadId change UNLESS a stream is already in flight (`isThreadStreaming()`) — that is the reveal's in-place
 * SWIPE, which owns its own stream via `loadPage`; the hook must not double-start over it. If the store already
 * carries a `band` at start (a known-identity revisit painted from cache), the hook opens in the `settled`
 * phase (no overlay) and only fills the async buckets behind; otherwise it opens `streaming` (overlay shown)
 * until the band arrives.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCaptureStore } from '../state/captureStore'
import { beginThreadStream, applyStreamEvent, isThreadStreaming, type StreamActions, type ThreadStreamSource } from './threadStream'
import { loadingLines, firstLine, settledReveal, longWaitAck } from './loadingCopy'
import { haptics } from './haptics'
import type { OrbState } from './pipecat'

export type RunKind = 'analyze' | 'revisit'
export type RunPhase = 'streaming' | 'settled' | 'failed'

export type Settled =
  | { kind: 'reveal'; title: string }
  | { kind: 'partial'; title: string; refinedFrom: string | null }
  | { kind: 'interview' }

/** Where a terminal band routes. `reveal` = CONFIDENT/PROBABLE (settle in place / cross-fade to the dock);
 *  `interview` = UNKNOWN (both consumers hand off to the interview form). */
export type Outcome = 'reveal' | 'interview'

export interface ThreadRun {
  phase: RunPhase
  settled: Settled | null
  line: string
  longWait: boolean
  offline: boolean
  failed: string | null
  orb: OrbState
  /** true while the identity scan-line should sweep (pre-settle, pre-fail). */
  scanning: boolean
  /** the derived status line shown in the LoadingPill (settled celebration / failure apology / rotating copy). */
  statusText: string
  /** the long-wait footnote, when armed + still scanning. */
  ack: string | undefined
  retry: () => void
  cancel: () => void
}

export interface UseThreadStreamRunOpts {
  threadId: string | null
  /** revisit = a replay/retrieval (calm copy, no scan-line, no celebratory haptic); analyze = a fresh find. */
  isRevisit: boolean
  api: ThreadStreamSource
  reduceMotion: boolean
  /** Fired ONCE, after the settle beat, when a terminal band routes. The caller navigates (or, for the reveal's
   *  in-place CONFIDENT/PROBABLE settle, ignores `'reveal'` and lets the overlay dissolve to the dock). */
  onOutcome?: (dest: Outcome) => void
  /** Keep the stream alive across THIS screen's unmount, because it hands the running stream to another screen
   *  (the `/processing` alias → `/reveal`). The reveal owns the stream to completion while mounted → false. */
  keepAliveAcrossUnmount?: boolean
  /** cancel() runs this after aborting (the alias: back to the camera). */
  onCancel?: () => void
}

const SETTLE_DELAY_MS = 450
const LONG_WAIT_MS = 9000
const ROTATE_MS = 2500

export function useThreadStreamRun(opts: UseThreadStreamRunOpts): ThreadRun {
  const { threadId, isRevisit, api, reduceMotion, onOutcome, keepAliveAcrossUnmount = false, onCancel } = opts
  const kind: RunKind = isRevisit ? 'revisit' : 'analyze'

  const setBand = useCaptureStore((s) => s.setBand)
  const setOutcome = useCaptureStore((s) => s.setOutcome)
  const appendText = useCaptureStore((s) => s.appendText)
  const appendFact = useCaptureStore((s) => s.appendFact)
  const appendSection = useCaptureStore((s) => s.appendSection)
  const upgradeDescription = useCaptureStore((s) => s.upgradeDescription)
  const setLoadingLine = useCaptureStore((s) => s.setLoadingLine)
  const setError = useCaptureStore((s) => s.setError)
  const setResearchComplete = useCaptureStore((s) => s.setResearchComplete)
  const setResearchError = useCaptureStore((s) => s.setResearchError)
  const setLastSeenIndex = useCaptureStore((s) => s.setLastSeenIndex)

  // Initial phase reflects a band ALREADY in the store (a from-cache revisit painted instantly) so no loading
  // overlay flashes for one frame before the stream effect runs; a fresh capture (no band) opens `streaming`.
  const [phase, setPhase] = useState<RunPhase>(() => (useCaptureStore.getState().band ? 'settled' : 'streaming'))
  const [orb, setOrb] = useState<OrbState>(() => (useCaptureStore.getState().band ? 'speaking' : 'thinking'))
  const [line, setLine] = useState(() => firstLine(kind))
  const [longWait, setLongWait] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [settled, setSettled] = useState<Settled | null>(null)

  const partialTitleRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const keepAliveRef = useRef(false)
  const mountedRef = useRef(true)
  // Stable refs for the store setters + callbacks so `run` never needs them in a dep array (it is called from an
  // effect keyed only on threadId — the same discipline processing used with its inline run()).
  const onOutcomeRef = useRef(onOutcome)
  onOutcomeRef.current = onOutcome

  const run = useCallback(async (): Promise<void> => {
    if (!threadId) return
    // A terminal outcome is ALREADY in the store (a seeded/deep-linked refusal or failure surface) — render it,
    // never stream over it (which would clobber the distinct refusal into a generic failure). An explicit retry()
    // for a recoverable network drop leaves `outcome` null, so it still streams.
    const seeded = useCaptureStore.getState()
    if (seeded.outcome === 'refusal' || seeded.outcome === 'failure') { setPhase('failed'); return }
    // Fully-loaded content is ALREADY in the store (a cached revisit hydrated it) — paint it instantly, don't
    // re-stream (that would show the buckets loading again for something already seen this session).
    if (seeded.researchComplete && seeded.band) { setPhase('settled'); return }
    // Someone already owns the in-flight stream (the reveal's in-place swipe via loadPage) — do NOT double-start
    // over it; that stream fills the shared store and this surface renders from it.
    if (isThreadStreaming()) {
      // If a band is already seeded (known-identity revisit), reflect the settled phase so no overlay shows.
      if (useCaptureStore.getState().band) setPhase('settled')
      return
    }
    setFailed(null)
    setOffline(false)
    setSettled(null)
    // A band already in the store means this is a revisit painted from cache: open settled (no overlay), just
    // fill the async buckets behind. No band → a fresh analysis: open streaming with the loading overlay.
    const seededBand = useCaptureStore.getState().band
    setPhase(seededBand ? 'settled' : 'streaming')
    // Fresh run (initial scan OR an `unavailable`-retry re-entry): clear the terminal research flags so a resumed
    // stream re-drives the buckets loading→active/empty rather than staying stuck on a prior drop's `unavailable`.
    useCaptureStore.setState({ researchError: false, researchComplete: false })
    partialTitleRef.current = null
    setLine(firstLine(kind))
    setLoadingLine(firstLine(kind))
    setOrb(seededBand ? 'speaking' : 'thinking')

    const ac = beginThreadStream()
    abortRef.current = ac
    const actions: StreamActions = {
      setLastSeenIndex, appendText, appendFact, appendSection, upgradeDescription, setBand, setResearchComplete, setResearchError,
    }

    let rotate: ReturnType<typeof setInterval> | null = null
    if (!reduceMotion && !seededBand) {
      const lines = loadingLines(kind)
      let i = 0
      rotate = setInterval(() => {
        i = (i + 1) % lines.length
        const next = lines[i] ?? firstLine(kind)
        setLine(next)
        setLoadingLine(next)
      }, ROTATE_MS)
    }
    const longTimer = setTimeout(() => setLongWait(true), LONG_WAIT_MS)

    const settleDelay = reduceMotion ? 0 : SETTLE_DELAY_MS
    const ui = (fn: () => void): void => { if (mountedRef.current) fn() }
    let routed = false
    const route = (dest: Outcome): void => {
      if (routed) return
      routed = true
      if (dest === 'reveal') keepAliveRef.current = keepAliveAcrossUnmount // survive the caller's cross-nav
      setTimeout(() => { if (!ac.signal.aborted) onOutcomeRef.current?.(dest) }, settleDelay)
    }

    try {
      for await (const ev of api.streamThread(threadId, { signal: ac.signal })) {
        applyStreamEvent(ev, actions) // the SHARED reducer — durable store writes; UI/orb/route stays here
        if (ev.type === 'token') {
          ui(() => setOrb('speaking'))
        } else if (ev.type === 'partial_id') {
          partialTitleRef.current = ev.title
          ui(() => { setOrb('thinking'); setLine(`Looks like ${ev.title}. Confirming…`) })
        } else if (ev.type === 'confidence_band') {
          if (ev.band === 'CONFIDENT') {
            ui(() => { setOrb('speaking'); setSettled({ kind: 'reveal', title: ev.title }); setPhase('settled') })
            if (!isRevisit) haptics.success()
            route('reveal') // INSTANT settle; the stream keeps running for the async facts + description upgrade
          } else if (ev.band === 'PROBABLE') {
            const tentative = partialTitleRef.current
            const refinedFrom = tentative && tentative !== ev.title ? tentative : null
            ui(() => { setOrb('uncertain'); setSettled({ kind: 'partial', title: ev.title, refinedFrom }); setPhase('settled') })
            if (!isRevisit) haptics.success()
            route('reveal')
          } else {
            ui(() => { setOrb('uncertain'); setSettled({ kind: 'interview' }); setPhase('settled') })
            if (!isRevisit) haptics.warning()
            route('interview')
            break // UNKNOWN hands off to the interview — no async research to keep streaming for
          }
        } else if (ev.type === 'error') {
          // Terminal error AFTER the band settled = a swallowed phase-2 research failure → resolve buckets to
          // `empty`, keep the reveal. PRE-band = the real hard-failure / refusal → the failure path + refund.
          if (routed) { setResearchComplete(); return }
          ui(() => { setOrb('uncertain'); setFailed(ev.message || ev.code); setPhase('failed') })
          haptics.error()
          // A safety refusal is a DISTINCT surface (describe-not-identify), not a generic failure. setError forces
          // outcome='failure', so set the message then pin the outcome back to 'refusal' (mirrors the BFF mapping).
          if (ev.code === 'safety_refusal') {
            if (ev.message) setError(ev.message)
            setOutcome('refusal')
          } else {
            setError(ev.message || ev.code)
          }
          return
        } else if (ev.type === 'done') {
          break
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      // Network drop. POST-band (already settled): flip loading buckets to `unavailable` (retriable), NOT `empty`.
      // PRE-band: the hard-failure display (a genuine identification failure, not a research gap).
      if (routed) { setResearchError(); return }
      ui(() => { setOrb('uncertain'); setOffline(true); setFailed(e instanceof Error ? e.message : 'stream_failed'); setPhase('failed') })
      haptics.error()
      return
    } finally {
      if (rotate) clearInterval(rotate)
      clearTimeout(longTimer)
    }

    // Safety net: the stream ended without ever settling a band (no error) → fall back to the store outcome.
    if (!routed && mountedRef.current) {
      const outcome = useCaptureStore.getState().outcome
      route(outcome === 'interview' ? 'interview' : 'reveal')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, isRevisit, api, reduceMotion, keepAliveAcrossUnmount])

  useEffect(() => {
    mountedRef.current = true
    keepAliveRef.current = false
    void run()
    return () => {
      mountedRef.current = false
      // Abort ONLY on a genuine unmount that is NOT a keepAlive cross-nav (the alias handing the stream to /reveal).
      if (!keepAliveRef.current) abortRef.current?.abort()
    }
  }, [run])

  const cancel = useCallback((): void => {
    keepAliveRef.current = false
    abortRef.current?.abort()
    onCancel?.()
  }, [onCancel])

  const orbState: OrbState = failed ? 'uncertain' : settled ? (settled.kind === 'reveal' ? 'speaking' : 'uncertain') : orb
  const scanning = phase === 'streaming'
  const statusText = failed
    ? "I couldn't get a clear read on that one. The fault is mine, not yours."
    : settled
      ? settled.kind === 'reveal'
        ? settledReveal(kind, settled.title)
        : settled.kind === 'partial'
          ? settled.refinedFrom
            ? `On closer look it's ${settled.title}, not ${settled.refinedFrom}. I've confirmed it.`
            : `A confident maybe: ${settled.title}.`
          : "I don't know this one — yet. Let's write its entry together."
      : line
  const ack = longWait && scanning ? longWaitAck(kind) : undefined

  return { phase, settled, line, longWait, offline, failed, orb: orbState, scanning, statusText, ack, retry: () => void run(), cancel }
}
