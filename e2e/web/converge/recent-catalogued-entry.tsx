/**
 * Converge entry — the RECENTLY-CATALOGUED proof. Mounts the REAL Expo screen app/app/(tabs)/camera.tsx under
 * react-native-web against the REAL voxi-api BFF, AFTER a real capture with a REAL photo — so the camera-home's
 * floating `RecentCard` has a durable recent item to render (photo thumbnail + identified label, the SAME
 * `CatalogTile` the Collection grid uses). Nothing in app/ is edited.
 *
 * Flow (all through the real ApiClient → real BFF, no stubs; mirrors collection-persistence-entry):
 *   1. capture: api.createThread({ photoUrl: <a real data:image/png> }) → the BFF decodes + PERSISTS the bytes.
 *   2. settle: drain api.streamThread(threadId) to `done` → the reveal is PINNED durably (revealTitle set).
 *   3. render: the real Camera screen mounts; its useQuery(['threads']) lists the collection → the RecentCard
 *      (opened via camera.recentToggle) shows a tile carrying the persisted thumbnail + label.
 * Seeding is guarded on an EMPTY collection so a reload does NOT re-capture. NOTE: a SEPARATE entry (not
 * camera-entry.tsx) so the existing camera-rnw proof stays on an EMPTY collection (its retakeHint assertion
 * depends on threads.length === 0 — seeding there would flip the copy and break it).
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider, useApi } from '../../../app/src/lib/api'
import Camera from '../../../app/app/(tabs)/camera'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import { SignedIn } from './auth-gate'
import { QueryClient, QueryClientProvider } from './shims/react-query'

const client = new QueryClient()

// The converge bundle defines NODE_ENV="production" (harness.ts:47), so captureStore.ts does NOT self-attach its
// dev seam — expose it here (as flow-entry/app-entry do) so the runner can assert revisit seeded `photoUri`.
;(window as unknown as { __captureStore?: unknown }).__captureStore = useCaptureStore

// A real, decodable 1×1 PNG — REAL bytes, so the persisted thumbnail is a genuine image the browser decodes
// (naturalWidth > 0), same as collection-persistence's proof (no placeholder cheat).
const REAL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function CaptureThenCamera(): React.ReactElement {
  const api = useApi()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { threads } = await api.listThreads()
      if (threads.length === 0) {
        const { threadId } = await api.createThread({ photoUrl: REAL_PNG })
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ev of api.streamThread(threadId)) {
          /* drain to the terminal `done` → the reveal is persisted (first-write-wins) */
        }
      }
      if (!cancelled) setReady(true)
    })().catch(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [api])

  if (!ready) return <div data-testid="converge.capturing" />
  return (
    <div data-testid="converge.root">
      <Camera />
    </div>
  )
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <QueryClientProvider client={client}>
            <CaptureThenCamera />
          </QueryClientProvider>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
