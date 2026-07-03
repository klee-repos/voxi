/**
 * Sign-up — account creation (separated from login). Thin wrapper: useEmailCodeAuth({mode:'signUp'}) drives the
 * email→code flow, EmailCodeForm renders it. A new session lands on /first-run (the onboarding). The back chevron
 * returns to the landing; "Already have an account? Log in" (and the EmailExists error) cross-link to /sign-in.
 */
import React from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Screen } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { EmailCodeForm, type AuthCopy } from '../src/components/EmailCodeForm'
import { useEmailCodeAuth } from '../src/lib/useEmailCodeAuth'
import { ids } from '../src/lib/testid'

export default function SignUp(): React.ReactElement {
  const router = useRouter()
  const { email } = useLocalSearchParams<{ email?: string }>()

  const auth = useEmailCodeAuth({
    mode: 'signUp',
    initialEmail: email ?? '',
    onSuccess: () => router.replace('/first-run'),
  })

  const copy: AuthCopy = {
    emailTitle: "Let's get you set up.",
    emailBody: "Create your account with just your email — I'll send a code, no password to remember.",
    emailCta: 'Continue',
    switchPrompt: 'Already have an account?',
    switchCta: 'Log in',
    onSwitch: (typed) => router.replace({ pathname: '/sign-in', params: typed ? { email: typed } : {} }),
  }

  return (
    <Screen id={ids.signUp.screen} header={<AppHeader leading="back" fallback="/welcome" />} padded={false}>
      <EmailCodeForm auth={auth} copy={copy} />
    </Screen>
  )
}
