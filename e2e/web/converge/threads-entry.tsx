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

const client = new QueryClient()

function params(): { state: string; count: number } {
  const p = new URLSearchParams(globalThis.location?.search ?? '')
  return { state: p.get('state') ?? 'empty', count: Number(p.get('count') ?? '24') }
}

/** The captures to seed for the current `?state=`. `many` → N confident tiles; `populated` → 3 mixed bands. */
function seedPlan(state: string, count: number): { photoUrl: string; title: string }[] {
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
