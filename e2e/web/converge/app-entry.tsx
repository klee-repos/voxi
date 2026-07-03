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
import {
  initObservability,
  captureIfUnexpected,
  VoxiErrorBoundary,
} from '../../../app/src/lib/observability'
import Welcome from '../../../app/app/welcome'
import SignUp from '../../../app/app/sign-up'
import SignIn from '../../../app/app/sign-in'
import FirstRun from '../../../app/app/first-run'
import Camera from '../../../app/app/(tabs)/camera'
import Threads from '../../../app/app/(tabs)/threads'
import Settings from '../../../app/app/(tabs)/settings'
import Processing from '../../../app/app/processing'
import Reveal from '../../../app/app/reveal'
import Interview from '../../../app/app/interview'
import Paywall from '../../../app/app/paywall'
import Conversation from '../../../app/app/conversation'
import Podcast from '../../../app/app/podcast'

// The real router seam maps each path the app navigates to its REAL screen component. welcome.replace('/first-run')
// and first-run.replace('/(tabs)/camera') are the genuine post-auth hops; the drawer navigates to threads/settings.
const routes: Record<string, React.ComponentType> = {
  '/welcome': Welcome,
  '/sign-up': SignUp,
  '/sign-in': SignIn,
  '/first-run': FirstRun,
  '/(tabs)/camera': Camera,
  '/(tabs)/threads': Threads,
  '/(tabs)/settings': Settings,
  '/processing': Processing,
  '/reveal': Reveal,
  '/interview': Interview,
  '/paywall': Paywall,
  '/conversation': Conversation,
  '/podcast': Podcast, // the Deep Dive player — reached from the reveal dock's Deep Dive icon
  '*': Welcome,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __captureStore?: unknown }).__captureStore = useCaptureStore
}

// Init the REAL observability module (same code that ships) so the E2E exercises the shipping init + boundary,
// not a stand-in. It reads window.__VOXI_SENTRY_DSN__, which the harness injects ONLY when opts.sentry is set —
// so every other agentic runner leaves Sentry disabled and this is inert there.
initObservability()

/**
 * A VISIBLE, DSN-gated dev affordance the agent perceives + taps. On tap it captures a secret-bearing error
 * DIRECTLY (a React error boundary can't catch an event-handler throw, and a prod bundle won't route it to
 * window.onerror — so a "throw and hope it's caught" trigger is non-deterministic; a direct capture isn't).
 * Rendered ONLY under the Sentry E2E, never in a prod bundle.
 */
function DevSentryTrigger(): React.ReactElement | null {
  const dsn =
    typeof window !== 'undefined' &&
    (window as unknown as { __VOXI_SENTRY_DSN__?: unknown }).__VOXI_SENTRY_DSN__
  if (!dsn) return null
  return (
    <button
      data-testid="dev.sentryThrow"
      style={{ position: 'fixed', bottom: 8, right: 8, zIndex: 99999, padding: 8 }}
      onClick={() =>
        captureIfUnexpected(
          // A message stuffed with every secret shape the redactor must scrub, proven end-to-end at the sink.
          new Error(
            'e2e sentry probe :: postgresql://voxi_app:PROBE_PGPW@/voxi sk_live_PROBEKEY123 data:image/png;base64,QUJDREVG /media/p?sig=PROBESIG&exp=1',
          ),
        )
      }
    >
      sentry-throw
    </button>
  )
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <VoxiErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ApiProvider>
            <div data-testid="converge.root" style={{ height: '100%' }}>
              {/* DrawerHost is passed as NavHost's `wrap` so it lives INSIDE the router context — a drawer row then
                  actually navigates (see shims/expo-router.tsx), while its open/closed state survives screen swaps. */}
              <NavHost routes={routes} initial="/welcome" wrap={DrawerHost} />
              <DevSentryTrigger />
            </div>
          </ApiProvider>
        </AuthProvider>
      </ThemeProvider>
    </VoxiErrorBoundary>
  )
}
