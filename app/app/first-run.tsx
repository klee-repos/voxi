/**
 * First-run (PLAN §10.2 screen 2 / D2 / §15) — "Meet Voxi" persona intro, then camera & mic permission PRIMING
 * before the OS prompts (mic = voice chat), a privacy acknowledgement ("objects, not people"; faces/plates
 * redacted; no facial recognition), and the photo→public SHARE consent toggle (defaults OFF — global exemplars
 * require explicit opt-in, PLAN §7.4). A step machine drives the firstRun.* contract ids. Finishing confirms the
 * session against the BFF (GET /v1/me), records the consent/completion intent, and lands on the camera tab.
 *
 * State matrix (PLAN §10.2 D1): LOADING (requesting an OS permission / bootstrapping the session), ERROR (the
 * final BFF check failed — recoverable, the user keeps their consent choices and retries), OFFLINE (the global
 * banner via useOffline + final CTA disabled; priming copy stays readable), EMPTY (the "meet" step is the
 * resting intro). Reduce-motion is respected — the hero orb is calm (the Orb swaps its own animation) and the
 * busy line (LoadingLine) renders a static glyph under reduce-motion.
 */
import React, { useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, Button, Toggle, LoadingLine, ErrorState } from '../src/components/ui'
import { OfflineBanner } from '../src/components/Banners'
import { Orb } from '../src/components/Orb'
import { ids } from '../src/lib/testid'
import { space } from '../src/lib/theme'
import { useApi } from '../src/lib/api'
import { useOffline, isOfflineError } from '../src/lib/useOffline'
import { createCameraPermission } from '../src/lib/cameraPermission'
import { requestMicPermission } from '../src/lib/permissions'
import { useOnboardingStore } from '../src/state/onboardingStore'

type Step = 'meet' | 'camera' | 'mic' | 'privacy'

export default function FirstRun(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { shareConsent, setShareConsent, setCameraPermission, setMicPermission, complete } = useOnboardingStore()

  // One camera-permission seam instance for the whole screen (native vision-camera or the deterministic stub).
  const [cameraApi] = useState(createCameraPermission)
  const [step, setStep] = useState<Step>('meet')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [netError, setNetError] = useState(false)

  const offline = useOffline(netError)

  // Prime camera → trigger the real OS prompt → advance regardless of grant (never block onboarding on denial).
  async function onAllowCamera(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      setCameraPermission(await cameraApi.request())
    } finally {
      setBusy(false)
      setStep('mic')
    }
  }

  async function onAllowMic(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      setMicPermission(await requestMicPermission())
    } finally {
      setBusy(false)
      setStep('privacy')
    }
  }

  // Finish → confirm the session is live against the BFF, persist completion, land on the camera.
  async function onFinish(): Promise<void> {
    if (busy || offline) return
    setBusy(true)
    setError(null)
    setNetError(false)
    try {
      await api.me()
      complete()
      router.replace('/(tabs)/camera')
    } catch (e) {
      setNetError(isOfflineError(e))
      setError(
        isOfflineError(e)
          ? "We're offline — I'll let you in the moment we reconnect."
          : "I couldn't quite reach the Guide. Mine to fix; give it another go.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <OfflineBanner visible={offline} />

      <View style={styles.hero}>
        <Orb id={ids.processing.orb} state={busy ? 'thinking' : step === 'mic' ? 'listening' : 'idle'} size={110} />
      </View>

      {step === 'meet' && (
        <>
          <Title>A brief hello.</Title>
          <Body style={{ marginTop: space.md }}>
            I'm Voxi, the Guide's voice. Point your camera at an object — a bike, a camera, a bottle — and I'll
            identify it as precisely as the evidence allows, then happily talk your ear off about it.
          </Body>
          <Button
            id={ids.firstRun.meetVoxiNext}
            label="Go on, then"
            onPress={() => setStep('camera')}
            style={{ marginTop: space.xl }}
          />
        </>
      )}

      {step === 'camera' && (
        <>
          <Title>The camera.</Title>
          <Body style={{ marginTop: space.md }}>
            Everything begins with a photo. I'll ask for camera access next — faces and number plates are redacted
            before anything is stored, and I never run facial recognition.
          </Body>
          {busy ? <LoadingLine label="Asking for camera access…" /> : null}
          <Button
            id={ids.firstRun.cameraPrimeAllow}
            label="Allow camera"
            onPress={() => void onAllowCamera()}
            disabled={busy}
            style={{ marginTop: space.xl }}
          />
        </>
      )}

      {step === 'mic' && (
        <>
          <Title>Your voice (optional).</Title>
          <Body style={{ marginTop: space.md }}>
            You can talk to me, not just type. The microphone is only for our conversations — sessions are recorded
            and transcribed, and push-to-talk keeps you in control.
          </Body>
          {busy ? <LoadingLine label="Asking for microphone access…" /> : null}
          <Button
            id={ids.firstRun.micPrimeAllow}
            label="Allow microphone"
            onPress={() => void onAllowMic()}
            disabled={busy}
            style={{ marginTop: space.xl }}
          />
        </>
      )}

      {step === 'privacy' && (
        <>
          <Title>One last thing.</Title>
          <Body style={{ marginTop: space.md }}>
            Objects, never people. I don't do facial recognition. Your captures stay private by default.
          </Body>
          <Toggle
            id={ids.firstRun.shareConsentToggle}
            value={shareConsent}
            onValueChange={setShareConsent}
            label="You may use my redacted photos to help build the Guide for everyone."
          />
          <Muted style={{ marginTop: space.sm }}>You can change this any time in Settings.</Muted>

          {error ? <ErrorState message={error} /> : null}
          {busy ? <LoadingLine label="One moment…" /> : null}

          <Button
            id={ids.firstRun.privacyAck}
            label="Start exploring"
            onPress={() => void onFinish()}
            disabled={busy || offline}
            style={{ marginTop: space.xl }}
          />

          {offline ? (
            <Muted style={{ marginTop: space.sm, textAlign: 'center' }}>
              You're offline — I'll let you in the moment we're reconnected.
            </Muted>
          ) : null}
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: space.xl },
})
