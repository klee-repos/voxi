/**
 * Deep Dive generation store — the BACKGROUND generation lifecycle, hoisted OUT of the player screen so it
 * survives navigation (the player is a pushed screen that unmounts; its old in-component poll died on unmount,
 * losing the composing state and leaving the dock unable to show "generating"). Now:
 *
 *   • state lives in a Zustand store keyed by threadId (both the player AND the reveal dock read it);
 *   • the poll runs on a MODULE-LEVEL job map (`Map<threadId, Job>`), NOT tied to any component — closing the
 *     player mid-compose does not stop it, and reopening reflects the live state or the finished audio;
 *   • `startDeepDive` is IDEMPOTENT: a live job (or a ready episode) → ATTACH, never a second `generate`
 *     (no double-charge — the BFF gate is also idempotent per (user,item,version), this is the client belt);
 *   • the poll EXITS (deletes its job) on ready / failed / budget-lapse — no infinite loop, no leak.
 *
 * Server-side generation is fire-and-forget and always continues regardless of the client; this store is the
 * CLIENT's honest mirror of it. Not persisted — on app restart the player's durable getThread probe recovers a
 * ready episode, and `generate` is idempotent so a resume never re-charges.
 */
import { create } from 'zustand'
import { ApiError } from '../lib/apiClient'
import type { ApiClient } from '../lib/apiClient'

export type DeepDiveState = 'idle' | 'composing' | 'slow' | 'ready' | 'failed'
export type DeepDiveFailReason = 'limit' | 'render' | 'network' | null

export interface DeepDiveStatus {
  state: DeepDiveState
  token?: string
  audioUrl?: string
  transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[]
  failReason: DeepDiveFailReason
  /** ms epoch when composing began — the ComposeHero derives the live elapsed clock from this (no per-second
   *  store writes). null unless composing/slow. */
  startedAt: number | null
}

const IDLE: DeepDiveStatus = { state: 'idle', failReason: null, startedAt: null }

interface DeepDiveStoreShape {
  byThread: Record<string, DeepDiveStatus>
  _set(threadId: string, next: DeepDiveStatus): void
  _reset(): void
}

export const useDeepDiveStore = create<DeepDiveStoreShape>((set) => ({
  byThread: {},
  _set: (threadId, next) => set((s) => ({ byThread: { ...s.byThread, [threadId]: next } })),
  _reset: () => set({ byThread: {} }),
}))

function read(threadId: string): DeepDiveStatus {
  return useDeepDiveStore.getState().byThread[threadId] ?? IDLE
}
function write(threadId: string, patch: Partial<DeepDiveStatus>): void {
  useDeepDiveStore.getState()._set(threadId, { ...read(threadId), ...patch })
}

// ── module-level jobs (survive component unmount) ────────────────────────────────────────────────────────────
interface Job {
  cancelled: boolean
  promise: Promise<void>
}
const jobs = new Map<string, Job>()

/** The minimal api surface the poller needs (a seam so the store tests without the whole ApiClient). */
export interface DeepDiveApi {
  generatePodcast: ApiClient['generatePodcast']
  podcastStatus: ApiClient['podcastStatus']
}

export interface StartOpts {
  pollMs?: number
  pollMax?: number
  /** injectable for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /** injectable clock for tests (default Date.now). */
  now?: () => number
}

const POLL_MS = 2000
const POLL_MAX = 90 // ~180s, matching the old in-screen budget

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Begin (or ATTACH to) a Deep Dive generation for `threadId`. Idempotent: a live job or a ready episode returns
 * immediately (no second `generate`, no re-charge). Sets `composing` synchronously so the dock/player reflect it
 * before any network call. The poll runs to a terminal state (ready/failed) or budget-lapse (`slow`), then the
 * job is removed so a later re-open can resume (generate is idempotent server-side).
 */
export function startDeepDive(api: DeepDiveApi, args: { threadId: string; subject?: string }, opts: StartOpts = {}): void {
  const { threadId, subject } = args
  if (jobs.has(threadId)) return // a poll is already in flight → ATTACH, do not re-fire generate
  if (read(threadId).state === 'ready') return // already have the episode → nothing to do

  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const pollMs = opts.pollMs ?? POLL_MS
  const pollMax = opts.pollMax ?? POLL_MAX

  // composing is set SYNCHRONOUSLY (before any await) so a racing second startDeepDive sees the job and attaches.
  write(threadId, { state: 'composing', failReason: null, startedAt: now() })
  const job: Job = { cancelled: false, promise: Promise.resolve() }
  jobs.set(threadId, job)

  job.promise = (async () => {
    try {
      const { token } = await api.generatePodcast({ catalogItemId: threadId, version: 1, subject: subject || undefined })
      if (job.cancelled) return
      write(threadId, { token })
      for (let i = 0; i < pollMax; i++) {
        if (job.cancelled) return
        const st = await api.podcastStatus(token)
        if (job.cancelled) return
        if (st.state === 'ready') {
          write(threadId, { state: 'ready', audioUrl: st.audioUrl, transcript: st.transcript, failReason: null, startedAt: null })
          return
        }
        if (st.state === 'failed') {
          write(threadId, { state: 'failed', failReason: 'render' })
          return
        }
        await sleep(pollMs)
      }
      // Budget lapsed — the worker may STILL be rendering. Non-terminal 'slow', NOT a fabricated failure.
      if (!job.cancelled) write(threadId, { state: 'slow' })
    } catch (e) {
      if (job.cancelled) return
      const reason: DeepDiveFailReason = e instanceof ApiError && e.status === 402 ? 'limit' : 'render'
      write(threadId, { state: 'failed', failReason: reason })
    } finally {
      jobs.delete(threadId)
    }
  })()
}

/** Cancel + forget a thread's generation (item delete). The server keeps rendering harmlessly; the client stops
 *  tracking it. */
export function cancelDeepDive(threadId: string): void {
  const job = jobs.get(threadId)
  if (job) job.cancelled = true
  jobs.delete(threadId)
}

/** Seed a durable-ready episode discovered by the player's getThread probe, so the dock's ready indicator lights
 *  without a (re)generate. No-op if a generation is in flight. */
export function seedReadyDeepDive(threadId: string, audioUrl: string, transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[]): void {
  if (jobs.has(threadId)) return
  write(threadId, { state: 'ready', audioUrl, transcript, failReason: null, startedAt: null })
}

/** Imperative read (non-hook) — for effects that need the current status without subscribing. */
export function getDeepDiveStatus(threadId: string | null): DeepDiveStatus {
  return threadId ? read(threadId) : IDLE
}

/** Subscribe a component to a thread's generation status (the player + the reveal dock read this). */
export function useDeepDiveStatus(threadId: string | null): DeepDiveStatus {
  return useDeepDiveStore((s) => (threadId ? s.byThread[threadId] : undefined) ?? IDLE)
}

/** Test seam: cancel every job + clear the store. */
export function __resetDeepDive(): void {
  for (const job of jobs.values()) job.cancelled = true
  jobs.clear()
  useDeepDiveStore.getState()._reset()
}

/** Test seam: await the in-flight job for a thread (resolves immediately if none). */
export function __awaitDeepDive(threadId: string): Promise<void> {
  return jobs.get(threadId)?.promise ?? Promise.resolve()
}

/** The dock Deep Dive icon's visual state, derived purely from the generation status (tested; UI reads this).
 *  composing/slow → a spinning "generating" ring; ready → the green ready dot; else the plain active glyph. */
export function deepDiveIconState(status: DeepDiveStatus): 'generating' | 'ready' | 'active' {
  if (status.state === 'composing' || status.state === 'slow') return 'generating'
  if (status.state === 'ready') return 'ready'
  return 'active'
}

// Dev/E2E testability seam (never attached in a production build): drive a thread's generation state so the
// converge proof can assert the dock's generating/ready indicators without a live worker (it seeds the SAME store
// state a real compose would, so the rendered dock is the real code path). Mirrors captureStore's window seam.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  ;(globalThis as unknown as { __deepDive?: unknown }).__deepDive = {
    store: useDeepDiveStore,
    getStatus: getDeepDiveStatus,
    setComposing: (threadId: string) => write(threadId, { state: 'composing', failReason: null, startedAt: Date.now() }),
    setReady: (threadId: string, audioUrl = 'g/podcast/seed.m4a') => write(threadId, { state: 'ready', audioUrl, failReason: null, startedAt: null }),
  }
}
