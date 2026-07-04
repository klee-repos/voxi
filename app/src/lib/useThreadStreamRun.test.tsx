/**
 * useThreadStreamRun — keepAlive survival across unmount (F1 + F1b proof).
 *
 * The Details cascade stream must keep generating in the background when the user navigates away from
 * the reveal, exactly like the Deep Dive lane. F1 = the reveal opts into `keepAliveAcrossUnmount`
 * (the existing detached-pump primitive /processing uses). F1b = the durable latch so a mid-stream
 * `run` re-fire (e.g. a Clerk-token refresh wobbling `useApi()`) can't strip the survivor's protection.
 *
 * The BFF cascade is request-scoped and only pins a reveal on a FULL drain; an aborted stream loses
 * everything and a reconnect re-runs the whole cascade — so the client must keep consuming. This test
 * proves the REAL changed code path: a real `useThreadStreamRun` instance, a real controlled stream, a
 * real React unmount, asserting real post-unmount `captureStore` writes. Red/green is honest: with
 * `keepAliveAcrossUnmount:false`, the cleanup aborts and post-unmount events do NOT land.
 *
 * Environment: the hook imports `./haptics` → react-native/expo-haptics, which don't run outside the RN
 * bundler, so we mock haptics to a no-op and provide a DOM via happy-dom (react-dom/client render).
 */
import { test, expect, describe, beforeEach, afterAll, mock } from 'bun:test'
import { Window } from 'happy-dom'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import React from 'react'
import type { StreamEvent } from '../../../packages/shared/src/events'

// ── mock haptics so importing the hook doesn't pull react-native/expo-haptics into the node env. Registered
//  before the hook's dynamic import so the mock intercepts `./haptics` at resolution time.
mock.module(new URL('./haptics.ts', import.meta.url).pathname, () => ({
  haptics: { capture() {}, tick() {}, success() {}, warning() {}, error() {} },
}))

const { useThreadStreamRun } = await import('./useThreadStreamRun')
const { useCaptureStore } = await import('../state/captureStore')
const { abortThreadStream } = await import('./threadStream')

// ── env: provide a DOM (react-dom/client needs document) ONLY for this file's tests, then restore. The
//  happy-dom globals MUST NOT leak into the shared Bun process — other test files (e.g. voxi-api pglite)
//  expect the plain node env (no `window`), and a leaked happy-dom `window` breaks them.
const win = new Window()
const ORIG = {
  window: (globalThis as Record<string, unknown>).window,
  document: (globalThis as Record<string, unknown>).document,
  navigator: (globalThis as Record<string, unknown>).navigator,
  MutationObserver: (globalThis as Record<string, unknown>).MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT,
}
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document
;(globalThis as Record<string, unknown>).navigator = win.navigator
;(globalThis as Record<string, unknown>).MutationObserver = win.MutationObserver
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (globalThis as Record<string, unknown>)[k]
    else (globalThis as Record<string, unknown>)[k] = v
  }
})

// ── a controlled ThreadStreamSource: the test pushes events on demand; the generator yields from a queue and
//  races an empty-queue wait against the abort signal (so an abort surfaces as AbortError, like a real fetch).
function controlledSource(): {
  api: { streamThread: (id: string, opts?: { startIndex?: number; signal?: AbortSignal }) => AsyncGenerator<StreamEvent, void, unknown> }
  push(ev: StreamEvent): void
} {
  const queue: StreamEvent[] = []
  const waiters: Array<() => void> = []
  return {
    api: {
      async *streamThread(_id, opts) {
        const signal = opts?.signal
        while (true) {
          while (queue.length) {
            const ev = queue.shift() as StreamEvent
            yield ev
            if (ev.type === 'done') return
          }
          await new Promise<void>((resolve, reject) => {
            waiters.push(resolve)
            if (signal) {
              if (signal.aborted) reject(new DOMException('aborted', 'AbortError'))
              else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
            }
          })
        }
      },
    },
    push(ev: StreamEvent) {
      queue.push(ev)
      for (const w of waiters.splice(0)) w()
    },
  }
}

/** Flush the microtask/macrotask queue so the survivor pump drains pushed events before we assert. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Render a no-op Probe that runs the hook; supports rerender (new opts → the hook re-runs, re-firing the
 *  `[run]` effect when a dep identity changes) and a real unmount (fires the hook's cleanup). */
function renderProbe(initial: Parameters<typeof useThreadStreamRun>[0]): {
  rerender(next: Parameters<typeof useThreadStreamRun>[0]): void
  unmount(): void
} {
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)
  let current = initial
  function Probe(): null {
    useThreadStreamRun(current)
    return null
  }
  act(() => {
    root.render(React.createElement(Probe))
  })
  return {
    rerender(next) {
      current = next
      act(() => {
        root.render(React.createElement(Probe))
      })
    },
    unmount: () => act(() => { root.unmount() }),
  }
}

const CONFIDENT_BAND: StreamEvent = { type: 'confidence_band', index: 0, band: 'CONFIDENT', title: 'T', candidates: [] }
const PURPOSE: StreamEvent = { type: 'section', index: 1, bucket: 'purpose', text: 'purpose!', sourceUrl: '', sourceTitle: '', quote: '' }
const FACT: StreamEvent = { type: 'fact', index: 2, text: 'fact!', sourceUrl: 'u', sourceTitle: 's', quote: 'q' }

beforeEach(() => {
  abortThreadStream()
  useCaptureStore.getState().reset()
})

describe('useThreadStreamRun — keepAlive survival across unmount', () => {
  test('keepAliveAcrossUnmount:true → the pump keeps writing to captureStore AFTER unmount (F1)', async () => {
    const src = controlledSource()
    const harness = renderProbe({
      threadId: 't1', isRevisit: false, api: src.api, reduceMotion: true,
      keepAliveAcrossUnmount: true,
    })

    // drive past band-settle so route('reveal') latches keepAlive (F1b also latches it on mount)
    await act(async () => { src.push(CONFIDENT_BAND); await flush() })
    expect(useCaptureStore.getState().band).toBe('CONFIDENT')

    // UNMOUNT — with keepAliveAcrossUnmount:true the cleanup must NOT abort the survivor
    harness.unmount()

    // post-unmount events: the survivor pump must still consume them into the store
    await act(async () => {
      src.push(PURPOSE)
      src.push(FACT)
      await flush()
      await flush()
    })
    expect(useCaptureStore.getState().sections.purpose?.text).toBe('purpose!')
    expect(useCaptureStore.getState().facts.length).toBe(1)
  })

  test('keepAliveAcrossUnmount:false → the pump ABORTS on unmount; post-unmount events never land (red/green)', async () => {
    const src = controlledSource()
    const harness = renderProbe({
      threadId: 't2', isRevisit: false, api: src.api, reduceMotion: true,
      keepAliveAcrossUnmount: false,
    })

    await act(async () => { src.push(CONFIDENT_BAND); await flush() })
    expect(useCaptureStore.getState().band).toBe('CONFIDENT')

    harness.unmount() // cleanup aborts (keepAliveRef stays false)

    await act(async () => {
      src.push(PURPOSE)
      await flush()
      await flush()
    })
    // aborted on unmount → the survivor pump is dead → the post-unmount section never lands
    expect(useCaptureStore.getState().sections.purpose).toBeUndefined()
  })

  test('F1b durable latch → a mid-stream run re-fire does NOT strip the survivor (lifecycle-1)', async () => {
    // A `run` dep identity change mid-stream (e.g. Clerk token refresh → useApi() rebuild) re-fires the
    // [run] effect. With F1b the keepAlive latch is preserved across the re-fire; WITHOUT F1b the body's
    // reset leaves keepAliveRef=false, so the NEXT unmount aborts the survivor.
    const src = controlledSource()
    const harness = renderProbe({
      threadId: 't3', isRevisit: false, api: src.api, reduceMotion: true,
      keepAliveAcrossUnmount: true,
    })

    await act(async () => { src.push(CONFIDENT_BAND); await flush() })
    expect(useCaptureStore.getState().band).toBe('CONFIDENT')

    // Simulate the dep wobble: a re-render with a changed `reduceMotion` re-fires [run]. After band-settle
    // `seededBand` is set, so no rotate interval starts; run() re-enters and ATTACHES (isThreadStreaming()).
    act(() => harness.rerender({
      threadId: 't3', isRevisit: false, api: src.api, reduceMotion: false,
      keepAliveAcrossUnmount: true,
    }))
    await flush()

    // NOW unmount. With F1b the latch survived the re-fire → no abort → pump survives.
    harness.unmount()
    await act(async () => {
      src.push(PURPOSE)
      await flush()
      await flush()
    })
    expect(useCaptureStore.getState().sections.purpose?.text).toBe('purpose!')
  })
})
