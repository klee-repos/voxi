/**
 * Converge entry — mounts the REAL left push-drawer (app/src/components/Drawer.tsx `DrawerHost` + `DrawerMenu`)
 * wrapping the REAL camera screen, under react-native-web against the REAL BFF. This is the closest converge
 * analogue of the `(tabs)/_layout.tsx` shell (which the route-less expo-router shim can't mount): tapping the
 * camera's hamburger (`nav.menuButton`) opens the drawer, sliding the content shell and revealing `DrawerMenu`
 * (Capture / Collection / Settings / Upgrade / Sign out) with the real `useAuth` monogram + `me` plan. Providers
 * mirror camera-entry (ThemeProvider + real FakeAuth sign-in + ApiProvider) so `DrawerMenu`'s real hooks work.
 */
import React from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { DrawerHost } from '../../../app/src/components/Drawer'
import Camera from '../../../app/app/(tabs)/camera'
import { SignedIn } from './auth-gate'

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root" style={{ height: '100%' }}>
            <DrawerHost>
              <Camera />
            </DrawerHost>
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
