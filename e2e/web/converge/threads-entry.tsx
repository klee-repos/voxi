/**
 * Converge entry — mounts the REAL Expo screen app/app/(tabs)/threads.tsx under react-native-web against the REAL
 * voxi-api BFF. Nothing in app/ is edited; this is the converge mount point (the analogue of expo-router/entry,
 * scoped to one screen).
 *
 * The REAL component tree: Threads → Screen/Title/Body/Muted/Button (ui.tsx) + CatalogTile + FlatList +
 * OfflineBanner + useQuery (TanStack, shimmed in the converge scope) + useApi (real ApiClient → real BFF GET
 * /v1/threads) + useCaptureStore + useRouter. States selected by `?state=`:
 *   - empty (default): the owner has no threads → the designed empty state (threads.emptyState + captureCta).
 *   - populated (?state=populated): create 3 threads on the REAL BFF (confident/probable/unknown), THEN render.
 *   - many (?state=many&count=N): create N (default 24) threads to exercise the virtualized infinite-scroll grid.
 *   - loading (?state=loading[&count=N]): the GET listThreads call is delayed 400ms (module-top fetch wrapper
 *     below) so the cold-load skeleton is observable. count defaults to 0 (skeleton→empty) — the deterministic
 *     split-proof — or 1 (skeleton→populated grid). Seeding is REAL (just fewer items); the delay is REAL.
 * Seeding is FAIL-LOUD (repo convention): if any create is rejected (e.g. a 402 once the scan entitlement is
 * exhausted) or the created count falls short, we render `converge.seedError` so the test fails instead of
 * silently under-seeding the grid and manufacturing a weak green.
 * Wrapped in the REAL ThemeProvider + REAL FakeAuth sign-in (→ a real bearer for useApi) + a QueryClientProvider.
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider, useApi } from '../../../app/src/lib/api'
import Threads from '../../../app/app/(tabs)/threads'
import { SignedIn } from './auth-gate'
import { QueryClient, QueryClientProvider } from './shims/react-query'

// ---- C1: an HONEST slow-BFF seam for the loading converge proof (?state=loading). Delays ONLY the GET
// listThreads call by 400ms so the cold-load skeleton is observable; every other request (POST createThread
// seeding, /:id, /media) passes through untouched. A counter (globalThis.__voxiListThreadsGets) exposes how
// many delayed GETs fired so the converge proof can assert delegation — a fake-success stub that fabricates a
// payload WITHOUT calling the real client never increments it (closes R3's "never stubbed to force green").
// Installed at module top-level so ApiClient — constructed at <ApiProvider/> render — captures the wrapped
// fetch (apiClient.ts:157 `opts.fetchImpl ?? fetch`). The match is pathname-suffix + method, prefix-independent
// (works whether baseUrl is `/api` or absolute). Nothing here runs in production — this file is converge-only.
const realFetch = globalThis.fetch.bind(globalThis)
;(globalThis as unknown as { __voxiListThreadsGets: number }).__voxiListThreadsGets = 0
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let isListGet = false
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(raw, globalThis.location?.href ?? 'http://localhost')
    const method = String(init?.method ?? 'GET').toUpperCase()
    // `/v1/threads` (list) ends with this suffix; `/v1/threads/:id` does not. GET-only (createThread is POST).
    isListGet = method === 'GET' && u.pathname.endsWith('/v1/threads')
  } catch {
    isListGet = false // non-URL input — pass through unchanged
  }
  if (!isListGet) return realFetch(input as RequestInfo | URL, init)
  ;(globalThis as unknown as { __voxiListThreadsGets: number }).__voxiListThreadsGets++
  return new Promise<Response>((resolve, reject) => {
    setTimeout(() => realFetch(input as RequestInfo | URL, init).then(resolve, reject), 400)
  })
}

const client = new QueryClient()

function params(): { state: string; count: number } {
  const p = new URLSearchParams(globalThis.location?.search ?? '')
  const state = p.get('state') ?? 'empty'
  // `loading` defaults to 0 threads so <Threads/> mounts instantly (ready=true) and the 400ms-delayed GET
  // makes the skeleton observable — never the N=24 `many` default, which would blow the waitFor budget before
  // the loading state is ever seen. Pass ?state=loading&count=1 to prove the skeleton→POPULATED-grid transition.
  const count = Number(p.get('count') ?? (state === 'loading' ? '0' : '24'))
  return { state, count }
}

/** The captures to seed for the current `?state=`.
 *  - `loading` → `count` confident tiles (default 0 = skeleton→empty; count=1 = skeleton→grid). NEVER 24.
 *  - `many` → N confident tiles; `populated` → 3 mixed bands. */
function seedPlan(state: string, count: number): { photoUrl: string; title: string }[] {
  if (state === 'loading') {
    return Array.from({ length: count }, (_v, i) => ({ photoUrl: 'obj:confident', title: `Capture · item ${i + 1}` }))
  }
  if (state === 'many') {
    return Array.from({ length: count }, (_v, i) => ({ photoUrl: 'obj:confident', title: `Capture · item ${i + 1}` }))
  }
  if (state === 'populated') {
    return ['confident', 'probable', 'unknown'].map((obj) => ({ photoUrl: `obj:${obj}`, title: `Capture · ${obj}` }))
  }
  return []
}

/** Create the seed captures on the REAL BFF before the screen's real useQuery runs; fail loud on any shortfall. */
function SeedThenThreads(): React.ReactElement {
  const api = useApi()
  const { state, count } = params()
  const plan = seedPlan(state, count)
  const [ready, setReady] = useState(plan.length === 0)
  const [seedError, setSeedError] = useState<string | null>(null)

  useEffect(() => {
    if (plan.length === 0) return
    let cancelled = false
    void (async () => {
      let made = 0
      for (const capture of plan) {
        try {
          await api.createThread(capture)
          made++
        } catch (e) {
          if (!cancelled) setSeedError(`create failed after ${made}/${plan.length}: ${e instanceof Error ? e.message : String(e)}`)
          return // stop on first failure — a 402 mid-seed means the entitlement is short; do NOT limp on and under-seed
        }
      }
      if (cancelled) return
      if (made !== plan.length) setSeedError(`seeded ${made}, expected ${plan.length}`)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, state, count])

  if (seedError) return <div data-testid="converge.seedError">{seedError}</div>
  if (!ready) return <div data-testid="converge.seeding" />
  return (
    <div data-testid="converge.root">
      <Threads />
    </div>
  )
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <QueryClientProvider client={client}>
            <SeedThenThreads />
          </QueryClientProvider>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
