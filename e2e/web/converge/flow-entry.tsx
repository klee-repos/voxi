/**
 * Flow converge entry — mounts the REAL screens under a minimal real router (`NavHost`) inside the REAL
 * DrawerHost + providers, so an agentic test can click through the ACTUAL user journey (camera → shutter →
 * processing → reveal, plus the tray + drawer) with real navigation, the real BFF stream, and the real Zustand
 * store carrying the captured image + band across screens. The store is exposed on `window.__captureStore` so
 * the driver can inject a test image (the web target has no camera to produce one).
 */
import React from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { DrawerHost } from '../../../app/src/components/Drawer'
import { NavHost } from './shims/expo-router'
import { SignedIn } from './auth-gate'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Camera from '../../../app/app/(tabs)/camera'
import Threads from '../../../app/app/(tabs)/threads'
import Settings from '../../../app/app/(tabs)/settings'
import Processing from '../../../app/app/processing'
import Reveal from '../../../app/app/reveal'
import Interview from '../../../app/app/interview'
import Paywall from '../../../app/app/paywall'

const routes: Record<string, React.ComponentType> = {
  '/(tabs)/camera': Camera,
  '/(tabs)/threads': Threads,
  '/(tabs)/settings': Settings,
  '/processing': Processing,
  '/reveal': Reveal,
  '/interview': Interview,
  '/paywall': Paywall,
  '*': Camera,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __captureStore?: unknown }).__captureStore = useCaptureStore
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root" style={{ height: '100%' }}>
            <DrawerHost>
              <NavHost routes={routes} initial="/(tabs)/camera" />
            </DrawerHost>
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
