/**
 * Sign-in — login (separated from account creation). Thin wrapper over useEmailCodeAuth({mode:'signIn'}) +
 * EmailCodeForm. A returning user lands straight on the camera (they've already onboarded — index.tsx sends
 * signed-in users there, so /first-run is a sign-up-only step). "No account yet? Create one" and the
 * enumeration-safe code-stage switch cross-link to /sign-up.
 */
import React from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { EmailCodeForm, type AuthCopy } from '../src/components/EmailCodeForm'
import { useEmailCodeAuth } from '../src/lib/useEmailCodeAuth'
import { ids } from '../src/lib/testid'

export default function SignIn(): React.ReactElement {
  const router = useRouter()
  const { email } = useLocalSearchParams<{ email?: string }>()

  const auth = useEmailCodeAuth({
    mode: 'signIn',
    initialEmail: email ?? '',
    onSuccess: () => router.replace('/(tabs)/camera'),
  })

  const copy: AuthCopy = {
    emailTitle: 'Welcome back.',
    emailBody: "Enter your email and I'll send a code to sign you in.",
    emailCta: 'Continue',
    switchPrompt: 'No account yet?',
    switchCta: 'Create one',
    onSwitch: (typed) => router.replace({ pathname: '/sign-up', params: typed ? { email: typed } : {} }),
  }

  return (
    <Screen id={ids.signIn.screen} header={<AppHeader leading="back" fallback="/welcome" />} padded={false}>
      <EmailCodeForm auth={auth} copy={copy} />
    </Screen>
  )
}
