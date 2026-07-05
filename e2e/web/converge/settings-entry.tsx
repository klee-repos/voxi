/**
 * Converge entry — mounts the REAL Settings screen (`app/app/(tabs)/settings.tsx`) under react-native-web against
 * the REAL BFF. Standalone (no DrawerHost) — `AppHeader leading="menu"` calls `useDrawer()`, which no-ops with no
 * host. Providers mirror drawer-entry (ThemeProvider + real FakeAuth sign-in + ApiProvider) so the screen's real
 * hooks (`useTheme` reduce-motion/speak-aloud, `useAuth` signOut, `useApi` deleteAccount) all work.
 */
import React from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import Settings from '../../../app/app/(tabs)/settings'
import { SignedIn } from './auth-gate'

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root" style={{ height: '100%' }}>
            <Settings />
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
