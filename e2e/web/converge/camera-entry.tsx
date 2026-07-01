/**
 * Converge entry — mounts the REAL Expo screen app/app/(tabs)/camera.tsx under react-native-web against the REAL
 * voxi-api BFF. Nothing in app/ is edited; this is the converge mount point (the analogue of expo-router/entry,
 * scoped to one screen).
 *
 * The REAL component tree: Camera → Screen/Title/Body/Muted/Button (ui.tsx) + Orb + OfflineBanner +
 * useCameraPermission seam + useApi (real ApiClient → real BFF) + useCaptureStore + useRouter. The web camera
 * permission seam (app/src/lib/cameraPermission.ts) starts `undetermined` on web and `request()` flips it to
 * `granted` (the happy path), so the viewfinder + camera.shutter render; tapping the shutter calls the real
 * api.signUpload + api.createThread on the BFF and then router.push('/processing') (observed via the expo-router
 * shim's data-last-nav). Wrapped in the REAL ThemeProvider + the REAL FakeAuth sign-in so useApi() has a bearer.
 */
import React from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import Camera from '../../../app/app/(tabs)/camera'
import { SignedIn } from './auth-gate'

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root">
            <Camera />
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
