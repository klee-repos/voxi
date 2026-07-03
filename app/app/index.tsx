/**
 * Entry — routes by auth state. Signed-in → the camera tab (the one screen that matters after login, PLAN §1);
 * signed-out → welcome (the landing). Shows a brief orb splash while Clerk loads.
 */
import React from 'react'
import { Redirect } from 'expo-router'
import { useAuth } from '../src/lib/clerk'
import { getAuthMode } from '../src/lib/testAuth'
import { Screen } from '../src/components/ui'
import { Orb } from '../src/components/Orb'
import { ids } from '../src/lib/testid'

export default function Index(): React.ReactElement {
  const { isLoaded, isSignedIn, signOut } = useAuth()

  // E2E-only: an auth-mode deep link (`voxi://e2e?auth=…`) means "render the auth screens". On a COLD launch
  // FakeAuth already inits signed-out (it reads the mode), so this never fires. It's the WARM safety net — if the
  // maestro build's TEST_USER auto-signin is live when the link arrives, drop that session (behind an orb splash,
  // never a dead Redirect) so the landing shows. Inert in prod: getAuthMode() is always null there.
  const freshOverride = getAuthMode() !== null && isSignedIn
  React.useEffect(() => {
    if (freshOverride) void signOut()
  }, [freshOverride, signOut])

  if (!isLoaded || freshOverride) {
    return (
      <Screen center>
        <Orb id={ids.processing.orb} state="idle" />
      </Screen>
    )
  }
  return <Redirect href={isSignedIn ? '/(tabs)/camera' : '/welcome'} />
}
