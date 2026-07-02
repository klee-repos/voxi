/**
 * app-entry.tsx — the SHARED full-app converge entry: the REAL Expo screens mounted under the REAL router so an
 * agentic test can sign in and click through the ACTUAL user journey exactly as a person does. This is the
 * real-screen home for every agentic runner (agentic-auth / agentic-collection / agentic-sweep).
 *
 * What makes it faithful:
 *  - It mounts the REAL app/app/welcome.tsx as the INITIAL route and wraps the tree in the REAL AuthProvider
 *    (FakeAuth seam) WITHOUT the auto-sign-in gate — so the agent drives the genuine two-phase sign-in UI
 *    (email + consents → OTP → verify), then the REAL first-run onboarding, landing on the REAL camera. No screen
 *    is faked or skipped; the agent perceives and taps the same affordances a user would.
 *  - Navigation is the real router seam (NavHost): welcome → /first-run → /(tabs)/camera → /processing → /reveal,
 *    plus the drawer routes to /(tabs)/threads and /(tabs)/settings. The real Zustand capture store carries the
 *    photo + band across screens; `window.__captureStore` is exposed so a runner can inspect it if needed.
 *  - The REAL BFF (createWebHarness) backs every /api call; the seeded object is steered by `?scan=` (the harness
 *    reads it off the Referer for a genuine shutter capture — see e2e/web/server.ts).
 *
 * Nothing in app/ is edited — only the three Expo-resolved imports (expo-router/expo-image/safe-area) are
 * bundler-aliased to the converge web shims, exactly what Metro/babel-preset-expo do on the real web build.
 */
import React from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { AuthProvider } from '../../../app/src/lib/clerk'
import { DrawerHost } from '../../../app/src/components/Drawer'
import { NavHost } from './shims/expo-router'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Welcome from '../../../app/app/welcome'
import FirstRun from '../../../app/app/first-run'
import Camera from '../../../app/app/(tabs)/camera'
import Threads from '../../../app/app/(tabs)/threads'
import Settings from '../../../app/app/(tabs)/settings'
import Processing from '../../../app/app/processing'
import Reveal from '../../../app/app/reveal'
import Interview from '../../../app/app/interview'
import Paywall from '../../../app/app/paywall'
import Conversation from '../../../app/app/conversation'

// The real router seam maps each path the app navigates to its REAL screen component. welcome.replace('/first-run')
// and first-run.replace('/(tabs)/camera') are the genuine post-auth hops; the drawer navigates to threads/settings.
const routes: Record<string, React.ComponentType> = {
  '/welcome': Welcome,
  '/first-run': FirstRun,
  '/(tabs)/camera': Camera,
  '/(tabs)/threads': Threads,
  '/(tabs)/settings': Settings,
  '/processing': Processing,
  '/reveal': Reveal,
  '/interview': Interview,
  '/paywall': Paywall,
  '/conversation': Conversation,
  '*': Welcome,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __captureStore?: unknown }).__captureStore = useCaptureStore
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ApiProvider>
          <div data-testid="converge.root" style={{ height: '100%' }}>
            {/* DrawerHost is passed as NavHost's `wrap` so it lives INSIDE the router context — a drawer row then
                actually navigates (see shims/expo-router.tsx), while its open/closed state survives screen swaps. */}
            <NavHost routes={routes} initial="/welcome" wrap={DrawerHost} />
          </div>
        </ApiProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
