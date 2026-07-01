/**
 * Converge entry — the COLLECTION PERSISTENCE proof (COLLECTION-PERSISTENCE-PLAN §7). Mounts the REAL Expo
 * screen app/app/(tabs)/threads.tsx under react-native-web against the REAL voxi-api BFF, AFTER a real capture
 * with a REAL photo. Nothing in app/ is edited.
 *
 * Flow (all through the real ApiClient → real BFF, no stubs):
 *   1. capture: api.createThread({ photoUrl: <a real data:image/png> }) → the BFF decodes + PERSISTS the bytes.
 *   2. settle: drain api.streamThread(threadId) to `done` → the reveal (a PROBABLE identification for a
 *      markerless photo) is PINNED durably.
 *   3. render: the real Threads screen's real useQuery lists the collection → a tile carrying the persisted
 *      thumbnail (a signed /media URL the browser actually loads) + the identified label.
 * Seeding is guarded on an EMPTY collection so a page RELOAD (a fresh JS context) does NOT re-capture — it finds
 * the durable thread already there, proving the photo + reveal live SERVER-SIDE, not in the page's memory.
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider, useApi } from '../../../app/src/lib/api'
import Threads from '../../../app/app/(tabs)/threads'
import { SignedIn } from './auth-gate'
import { QueryClient, QueryClientProvider } from './shims/react-query'

const client = new QueryClient()

// A real, decodable 1×1 PNG — REAL bytes (adversarial A3: no placeholder cheat), so the persisted thumbnail is a
// genuine image the browser decodes (naturalWidth > 0).
const REAL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function CaptureThenCollection(): React.ReactElement {
  const api = useApi()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Guard on an empty collection so a reload doesn't re-capture — a persisted thread proves server durability.
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
            <CaptureThenCollection />
          </QueryClientProvider>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
