/**
 * Paywall (PLAN §10.2 / §13) — shown when a metered action is denied (BFF 402). The limit message reflects
 * WHICH meter ran out (passed as ?reason=). Subscribe/restore go through the `purchases` seam: a deterministic
 * stub on web/E2E, the real StoreKit 2 wrapper (`expo-iap`) on device. ids: paywall.*.
 */
import React, { useState } from 'react'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { Screen, Title, Body, Muted, Button, ErrorState } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { ids, tid } from '../src/lib/testid'
import { space } from '../src/lib/theme'
import { useOffline } from '../src/lib/useOffline'
import { purchases } from '../src/lib/purchases'

/** Per-meter copy so the limit message names what actually ran out (PLAN §13 — honest, specific paywall). */
const LIMIT_COPY: Record<string, string> = {
  scan_limit_reached: "You've catalogued every object your free entries allow this period. Subscribe to keep the Guide growing — more scans, fresh podcasts, and voice minutes.",
  voice_minutes_exhausted: "That's this period's free voice minutes spent. Subscribe to keep talking — plus more scans and podcasts.",
  podcast_limit_reached: "You've used this period's free episodes. Subscribe to keep the stories coming.",
}

export default function Paywall(): React.ReactElement {
  const router = useRouter()
  const params = useLocalSearchParams<{ reason?: string }>()
  const reason = typeof params.reason === 'string' ? params.reason : 'scan_limit_reached'

  const [busy, setBusy] = useState<null | 'subscribe' | 'restore'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const offline = useOffline()

  function dismiss(): void {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/threads')
  }

  async function subscribe(): Promise<void> {
    if (busy || offline) return
    setBusy('subscribe')
    setError(null)
    setNotice(null)
    try {
      const r = await purchases.purchase('voyager')
      if (r.entitled) dismiss()
      else setNotice('The purchase was cancelled. No charge made.')
    } catch (e) {
      setError(e instanceof Error ? e.message : "The purchase didn't complete. You haven't been charged.")
    } finally {
      setBusy(null)
    }
  }

  async function restore(): Promise<void> {
    if (busy || offline) return
    setBusy('restore')
    setError(null)
    setNotice(null)
    try {
      const r = await purchases.restore()
      if (r.entitled) dismiss()
      else setNotice('No previous purchases found on this account.')
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the store to restore. Try again in a moment.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen id={ids.paywall.screen} center header={<AppHeader leading="none" onClose={dismiss} />}>
      <OfflineBanner visible={offline} />
      <Orb id={ids.processing.orb} state="idle" />
      <Title style={{ marginTop: space.xl, textAlign: 'center' }}>The Guide is vast.</Title>
      <Body {...tid(ids.paywall.limitMessage)} style={{ marginTop: space.md, textAlign: 'center' }}>
        {LIMIT_COPY[reason] ?? LIMIT_COPY.scan_limit_reached}
      </Body>

      <Button
        id={ids.paywall.subscribeBtn}
        label={busy === 'subscribe' ? 'Opening the store…' : 'Subscribe'}
        onPress={() => void subscribe()}
        disabled={busy !== null || offline}
        style={{ marginTop: space.xl }}
      />
      <Button
        id={ids.paywall.restoreBtn}
        label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'}
        variant="secondary"
        onPress={() => void restore()}
        disabled={busy !== null || offline}
      />

      {notice ? <Muted style={{ marginTop: space.md, textAlign: 'center' }}>{notice}</Muted> : null}
      {error ? <ErrorState message={error} /> : null}
    </Screen>
  )
}
