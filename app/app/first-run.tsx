/**
 * First-run (PLAN §10.2 screen 2 / D2 / §15) — "Meet Voxi" intro, camera & mic permission PRIMING before the OS
 * prompts, a privacy acknowledgement, and the photo→public SHARE consent toggle (defaults OFF — global exemplars
 * require explicit opt-in, PLAN §7.4). A step machine drives the firstRun.* ids. Finishing confirms the session
 * against the BFF (GET /v1/me), records the consent/completion intent, and lands on the camera tab.
 *
 * State matrix (PLAN §10.2 D1): LOADING, ERROR (the final BFF check failed — recoverable, consent choices kept),
 * OFFLINE (global banner + final CTA disabled), EMPTY (the "meet" step). Reduce-motion is respected.
 */
import React, { useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, Button, Toggle, LoadingLine, ErrorState } from '../src/components/ui'
import { OfflineBanner } from '../src/components/Banners'
import { Orb } from '../src/components/Orb'
import { ids } from '../src/lib/testid'
import { radius, space } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'
import { useApi } from '../src/lib/api'
import { useOffline, isOfflineError } from '../src/lib/useOffline'
import { createCameraPermission } from '../src/lib/cameraPermission'
import { requestMicPermission } from '../src/lib/permissions'
import { useOnboardingStore } from '../src/state/onboardingStore'

type Step = 'meet' | 'camera' | 'mic' | 'privacy'

const STEP_ORDER: Step[] = ['meet', 'camera', 'mic', 'privacy']

/** Slim onboarding progress — a pill fills for the active step, hairline dots for the rest (decorative). */
function StepDots({ step }: { step: Step }): React.ReactElement {
  const { surface } = useTheme()
  const active = STEP_ORDER.indexOf(step)
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {STEP_ORDER.map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            i === active
              ? { width: 20, backgroundColor: surface.accent }
              : { width: 6, backgroundColor: surface.border },
          ]}
        />
      ))}
    </View>
  )
}

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

  const STEP_COPY: Record<Step, { title: string; body: string }> = {
    meet: {
      title: 'A brief hello.',
      body: "I'm Voxi, the Guide's voice. Point your camera at an object — a bike, a camera, a bottle — and I'll identify it as precisely as the evidence allows, then happily talk your ear off about it.",
    },
    camera: {
      title: 'The camera.',
      body: "Everything begins with a photo. I'll ask for camera access next — faces and number plates are redacted before anything is stored, and I never run facial recognition.",
    },
    mic: {
      title: 'Your voice.',
      body: 'You can talk to me, not just type. The microphone is only for our conversations — sessions are recorded and transcribed, and push-to-talk keeps you in control.',
    },
    privacy: {
      title: 'One last thing.',
      body: "Objects, never people. I don't do facial recognition. Your captures stay private by default.",
    },
  }
  const busyLabel = step === 'camera' ? 'Asking for camera access…' : step === 'mic' ? 'Asking for microphone access…' : 'One moment…'

  return (
    <Screen>
      <OfflineBanner visible={offline} />
      <View style={styles.progress}>
        <StepDots step={step} />
      </View>

      {/* CONTENT — orb + title + body centered (the privacy step adds the share-consent opt-in) */}
      <View style={styles.content}>
        <Orb id={ids.processing.orb} state={busy ? 'thinking' : step === 'mic' ? 'listening' : 'idle'} size={112} />
        <Title style={[styles.title, { marginTop: space.xl }]}>{STEP_COPY[step].title}</Title>
        <Body style={styles.body}>{STEP_COPY[step].body}</Body>

        {step === 'privacy' && (
          <View style={styles.consent}>
            <Toggle
              id={ids.firstRun.shareConsentToggle}
              value={shareConsent}
              onValueChange={setShareConsent}
              label="You may use my redacted photos to help build the Guide for everyone."
            />
            <Muted style={{ marginTop: space.xs }}>You can change this any time in Settings.</Muted>
          </View>
        )}

        {error ? <ErrorState message={error} /> : null}
        {busy ? <LoadingLine label={busyLabel} /> : null}
      </View>

      {/* ACTION — pinned to the bottom */}
      <View style={styles.actions}>
        {step === 'meet' && (
          <Button id={ids.firstRun.meetVoxiNext} label="Go on, then" onPress={() => setStep('camera')} style={styles.cta} />
        )}
        {step === 'camera' && (
          <Button id={ids.firstRun.cameraPrimeAllow} label="Allow camera" onPress={() => void onAllowCamera()} disabled={busy} style={styles.cta} />
        )}
        {step === 'mic' && (
          <Button id={ids.firstRun.micPrimeAllow} label="Allow microphone" onPress={() => void onAllowMic()} disabled={busy} style={styles.cta} />
        )}
        {step === 'privacy' && (
          <>
            <Button id={ids.firstRun.privacyAck} label="Start exploring" onPress={() => void onFinish()} disabled={busy || offline} style={styles.cta} />
            {offline ? (
              <Muted style={{ marginTop: space.sm, textAlign: 'center' }}>
                You're offline — I'll let you in the moment we're reconnected.
              </Muted>
            ) : null}
          </>
        )}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  progress: { alignItems: 'center', paddingTop: space.sm },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { textAlign: 'center' },
  body: { textAlign: 'center', marginTop: space.md },
  consent: { marginTop: space.xl, alignSelf: 'stretch' },
  actions: { paddingBottom: space.sm },
  cta: { height: 52 },
  dots: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { height: 6, borderRadius: radius.pill },
})
