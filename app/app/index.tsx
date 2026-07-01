/**
 * Entry — routes by auth state. Signed-in → the camera tab (the one screen that matters after login, PLAN §1);
 * signed-out → welcome. Shows a brief orb splash while Clerk loads.
 */
import React from 'react'
import { Redirect } from 'expo-router'
import { useAuth } from '../src/lib/clerk'
import { Screen } from '../src/components/ui'
import { Orb } from '../src/components/Orb'
import { ids } from '../src/lib/testid'

export default function Index(): React.ReactElement {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) {
    return (
      <Screen center>
        <Orb id={ids.processing.orb} state="idle" />
      </Screen>
    )
  }
  return <Redirect href={isSignedIn ? '/(tabs)/camera' : '/welcome'} />
}
