/**
 * Converge entry for the UNIVERSAL AppHeader (app/src/components/AppHeader.tsx) — the authoritative real-component
 * proof for the back-navigation header. `?screen=` picks the mount:
 *
 *  • ?screen=<name>  — a SINGLE real screen with NO NavHost, so `useRouter()` resolves to the shim's
 *    `recordingRouter` whose `canGoBack()` returns FALSE. Tapping the header's back/close therefore takes the
 *    header's GUARDED fallback branch (`router.replace(fallback)`), which is exactly the deep-link / web-reload
 *    case the header exists to make safe — recorded on `<body data-last-nav>` for assertion. This proves the
 *    header renders the right control per screen AND that it never dead-clicks.
 *  • ?screen=flow    — the REAL DrawerHost + NavHost stack (like flow-entry), so the back control returns to the
 *    actual parent with a real router that HAS `canGoBack` (M1: no TypeError on the shim).
 *
 * Nothing in app/ is edited. Providers mirror the other converge entries (Theme + real FakeAuth SignedIn + Api +
 * a QueryClient, since camera/threads/settings read `useQuery`).
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { DrawerHost } from '../../../app/src/components/Drawer'
import { NavHost } from './shims/expo-router'
import { QueryClient, QueryClientProvider } from './shims/react-query'
import { SignedIn } from './auth-gate'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Camera from '../../../app/app/(tabs)/camera'
import Threads from '../../../app/app/(tabs)/threads'
import Settings from '../../../app/app/(tabs)/settings'
import Interview from '../../../app/app/interview'
import Podcast from '../../../app/app/podcast'
import Contribute from '../../../app/app/contribute'
import Paywall from '../../../app/app/paywall'
import Conversation from '../../../app/app/conversation'

const client = new QueryClient()

function screenParam(): string {
  const p = new URLSearchParams(globalThis.location?.search ?? '')
  return p.get('screen') ?? 'camera'
}

const STANDALONE: Record<string, React.ComponentType> = {
  camera: Camera,
  threads: Threads,
  settings: Settings,
  interview: Interview,
  podcast: Podcast,
  contribute: Contribute,
  paywall: Paywall,
  conversation: Conversation,
}

function Providers({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}

/** Single real screen, recordingRouter (canGoBack → false → the header's guarded replace-fallback branch). */
function Standalone(): React.ReactElement {
  const which = screenParam()
  const Comp = STANDALONE[which] ?? Camera
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // interview needs a thread to open; conversation reads a session id. podcast WITHOUT a thread = its empty
    // state, which renders the close header immediately (proving the READY-parity close on the fast path).
    if (which === 'interview' || which === 'conversation') useCaptureStore.getState().setThread('thr_converge_header')
    setReady(true)
  }, [which])
  if (!ready) return <div data-testid="converge.priming" />
  return (
    <div data-testid="converge.root" style={{ height: '100%' }}>
      <Comp />
    </div>
  )
}

const routes: Record<string, React.ComponentType> = {
  '/(tabs)/camera': Camera,
  '/(tabs)/threads': Threads,
  '/(tabs)/settings': Settings,
  '/interview': Interview,
  '/paywall': Paywall,
  '*': Camera,
}

/**
 * Real DrawerHost + NavHost stack — the back control returns to the parent through a real (canGoBack) router.
 * DrawerHost is passed as NavHost's `wrap` (NOT wrapped outside) so DrawerMenu's `useRouter()` resolves to the real
 * NavHost router — a drawer row actually NAVIGATES (opens Collection/Settings), instead of only recording
 * data-last-nav (shim docstring: shims/expo-router.tsx). The drawer stays mounted across screen swaps.
 */
function FlowRoot(): React.ReactElement {
  return (
    <div data-testid="converge.root" style={{ height: '100%' }}>
      <NavHost routes={routes} initial="/(tabs)/camera" wrap={DrawerHost} />
    </div>
  )
}

export function ConvergeRoot(): React.ReactElement {
  return <Providers>{screenParam() === 'flow' ? <FlowRoot /> : <Standalone />}</Providers>
}
