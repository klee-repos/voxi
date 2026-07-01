/**
 * Converge entry — mounts the REAL Expo screen app/app/(tabs)/threads.tsx under react-native-web against the REAL
 * voxi-api BFF. Nothing in app/ is edited; this is the converge mount point (the analogue of expo-router/entry,
 * scoped to one screen).
 *
 * The REAL component tree: Threads → Screen/Title/Body/Muted/Button/PressableTile (ui.tsx) + OfflineBanner +
 * useQuery (TanStack, shimmed in the converge scope) + useApi (real ApiClient → real BFF GET /v1/threads) +
 * useCaptureStore + useRouter. Two states are exercised against the real BFF, selected by `?state=`:
 *   - empty (default): the owner has no threads → the designed empty state (threads.emptyState + captureCta).
 *   - populated (?state=populated): we first create N threads on the REAL BFF via the real ApiClient (real
 *     createThread, real owner-scoped persistence + metering), THEN render Threads, whose real useQuery lists
 *     them owner-scoped → the real grid (threads.grid + N × threads.item).
 * Wrapped in the REAL ThemeProvider + REAL FakeAuth sign-in (→ a real bearer for useApi) + a QueryClientProvider.
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider, useApi } from '../../../app/src/lib/api'
import Threads from '../../../app/app/(tabs)/threads'
import { SignedIn } from './auth-gate'
import { QueryClient, QueryClientProvider } from './shims/react-query'

const client = new QueryClient()

function seededState(): string {
  const p = new URLSearchParams(globalThis.location?.search ?? '')
  return p.get('state') ?? 'empty'
}

/** For ?state=populated: create N threads on the REAL BFF before the screen's real useQuery runs. */
function SeedThenThreads(): React.ReactElement {
  const api = useApi()
  const populated = seededState() === 'populated'
  const [ready, setReady] = useState(!populated)

  useEffect(() => {
    if (!populated) return
    let cancelled = false
    void (async () => {
      // Three real captures on the real BFF (charges scans from the seeded entitlement); each persists an
      // owner-scoped thread the real GET /v1/threads will return.
      for (const obj of ['confident', 'probable', 'unknown']) {
        await api.createThread({ photoUrl: `obj:${obj}`, title: `Capture · ${obj}` }).catch(() => {})
      }
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [api, populated])

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
