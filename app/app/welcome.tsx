/**
 * Welcome / auth (PLAN §10.2 screen 1) — email-first OTP via Clerk, with the EULA + 16+ gate. Two phases in one
 * screen: email + terms → Continue sends the code → Verify confirms the session against the BFF (GET /v1/me) →
 * `/first-run`. `ErrorState` renders beneath the field it refers to (email in phase 1, OTP in phase 2).
 */
import React, { useState } from 'react'
import { View, StyleSheet, KeyboardAvoidingView, ScrollView, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { useAuth } from '../src/lib/clerk'
import { useApi } from '../src/lib/api'
import { useOffline, isOfflineError } from '../src/lib/useOffline'
import { Screen, Title, Body, Muted, Button, TextField, Toggle, LoadingLine, ErrorState, Wordmark } from '../src/components/ui'
import { OfflineBanner } from '../src/components/Banners'
import { Orb } from '../src/components/Orb'
import { ids } from '../src/lib/testid'
import { space } from '../src/lib/theme'

type Phase = 'email' | 'otp'

export default function Welcome(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { isLoaded, signInWithEmail, verifyCode } = useAuth()

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [eula, setEula] = useState(false)
  const [age, setAge] = useState(false)
  const [phase, setPhase] = useState<Phase>('email')
  const [busy, setBusy] = useState<null | 'sending' | 'verifying'>(null)
  const [error, setError] = useState<string | null>(null)
  const [netError, setNetError] = useState(false)

  const offline = useOffline(netError)

  const validEmail = /\S+@\S+\.\S+/.test(email.trim())
  const canStart = validEmail && eula && age && !offline && isLoaded
  const canVerify = code.trim().length >= 4 && !offline

  async function onContinue(): Promise<void> {
    if (busy) return
    setError(null)
    setNetError(false)
    try {
      if (phase === 'email') {
        if (!canStart) return
        setBusy('sending')
        await signInWithEmail(email.trim())
        setPhase('otp')
        return
      }
      if (!canVerify) return
      setBusy('verifying')
      await verifyCode(code.trim())
      await api.me()
      router.replace('/first-run')
    } catch (e) {
      if (isOfflineError(e)) setNetError(true)
      setError(humanError(e, phase))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen id={ids.welcome.screen} padded={false}>
      <OfflineBanner visible={offline} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <Orb id={ids.processing.orb} state={busy ? 'thinking' : 'idle'} size={88} />
            <Wordmark style={{ marginTop: space.lg }} />
            <Title style={{ marginTop: space.xs }}>the Guide</Title>
            <Muted style={{ textAlign: 'center', marginTop: space.sm }}>
              Photograph anything human-made. I'll tell you what it is — as specifically as I can manage.
            </Muted>
          </View>

          <TextField
            id={ids.welcome.emailInput}
            value={email}
            onChangeText={(v) => {
              setEmail(v)
              if (error) setError(null)
            }}
            placeholder="you@email.com"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            returnKeyType="next"
            accessibilityLabel="Email address"
          />
          {phase === 'email' && error ? <ErrorState message={error} /> : null}

          {phase === 'otp' ? (
            <>
              <TextField
                id={ids.welcome.otpInput}
                value={code}
                onChangeText={(v) => {
                  setCode(v)
                  if (error) setError(null)
                }}
                placeholder="6-digit code"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                returnKeyType="done"
                onSubmitEditing={() => void onContinue()}
                autoFocus
                maxLength={8}
                accessibilityLabel="Verification code"
              />
              {error ? <ErrorState message={error} /> : null}
            </>
          ) : null}

          <Toggle
            id={ids.welcome.eulaAccept}
            value={eula}
            onValueChange={setEula}
            label="I accept the Terms and the zero-tolerance content policy."
          />
          <Toggle id={ids.welcome.ageConfirm} value={age} onValueChange={setAge} label="I'm 16 or older." />

          <Muted style={{ marginTop: space.md }}>
            Objects, never people. Faces and number plates are redacted before anything is stored, and I never run
            facial recognition. Your photos help build the Guide only if you opt in.
          </Muted>

          {busy ? <LoadingLine label={busy === 'sending' ? 'Sending your code…' : 'Letting you in…'} /> : null}

          <Button
            id={ids.welcome.continueBtn}
            label={phase === 'otp' ? 'Verify and enter' : 'Continue'}
            onPress={() => void onContinue()}
            disabled={busy !== null || (phase === 'email' ? !canStart : !canVerify)}
            style={styles.cta}
          />

          {offline ? (
            <Muted style={{ marginTop: space.sm, textAlign: 'center' }}>
              You're offline. Signing in needs a connection — I'll wait.
            </Muted>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

/** Maps a thrown error to a calm, in-persona, recoverable message for the welcome flow. */
function humanError(e: unknown, phase: Phase): string {
  if (isOfflineError(e)) return "We're offline — signing in needs a connection. I'll be here when you're back."
  const status = (e as { status?: number } | null)?.status
  if (status === 401) return "That sign-in didn't take. Try the code once more."
  if (typeof status === 'number') return 'The Guide is having a moment. Give it another go in a few seconds.'
  if (phase === 'otp') return "That code didn't match. Check it and try again."
  return "I couldn't send the code just now. Check the address and retry."
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: space.xl, paddingBottom: space.xxl, flexGrow: 1 },
  hero: { alignItems: 'center', marginBottom: space.xl },
  cta: { marginTop: space.lg, height: 52 },
})
