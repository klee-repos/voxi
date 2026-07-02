/**
 * Add-a-tip / contribution (PLAN §10.2 screen 11 / §7.5). A trust-level-honest post-submit banner driven by the
 * SERVER (POST /v1/tips returns status): TL0 → "a moderator will review"; TL2+ → "live now". ids: contribute.*.
 *
 * States: idle, SUBMITTING, trust-aware SUCCESS banner, ERROR (in-persona retry), OFFLINE, and a distinct
 * SAFETY-REFUSAL surface (global.safetyRefusal) for a tip the Guide declines — separate from the status banner.
 */
import React, { useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { Screen, Title, Body, Muted, Button, TextField, PressableTile, ErrorState } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { OfflineBanner, SafetyRefusal } from '../src/components/Banners'
import { ids, tid } from '../src/lib/testid'
import { radius, space } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'
import { useApi } from '../src/lib/api'
import { useOffline, isOfflineError } from '../src/lib/useOffline'
import { useCaptureStore } from '../src/state/captureStore'
import { ApiError } from '../src/lib/apiClient'

export default function Contribute(): React.ReactElement {
  const api = useApi()
  const { surface } = useTheme()
  const catalogItemId = useCaptureStore((s) => s.threadId) ?? 'unknown'

  const [text, setText] = useState('')
  const [status, setStatus] = useState<null | 'pending_review' | 'live'>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [netError, setNetError] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [reportState, setReportState] = useState<'idle' | 'busy' | 'done'>('idle')

  const offline = useOffline(netError)
  const canSubmit = !!text.trim() && !busy && !offline

  async function submit(): Promise<void> {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setNetError(false)
    setRefused(null)
    setStatus(null)
    try {
      const r = await api.submitTip({ catalogItemId, text: text.trim() })
      setStatus(r.status)
      setText('')
    } catch (e) {
      if (isOfflineError(e)) {
        setNetError(true)
      } else if (e instanceof ApiError && /refus|safety|disallow/i.test(e.code)) {
        // The Guide declines some contributions by policy — a deterministic, non-alarm refusal, NOT an error.
        setRefused("I can't take that one. The Guide steers clear of a few categories by design.")
      } else {
        setError(e instanceof Error ? e.message : "Your tip didn't go through. Try once more?")
      }
    } finally {
      setBusy(false)
    }
  }

  async function report(): Promise<void> {
    if (reportState !== 'idle' || offline) return
    setReportState('busy')
    try {
      await api.report({ targetId: catalogItemId, kind: 'tip' })
      setReportState('done')
    } catch {
      setReportState('idle')
    }
  }

  return (
    <Screen id={ids.contribute.screen} header={<AppHeader leading="none" showClose />}>
      <OfflineBanner visible={offline} />

      <Title>Add a tip</Title>
      <Muted style={{ marginTop: space.sm }}>
        Know something the Guide doesn't? Add it here. New contributors' tips are reviewed before they go live;
        trusted contributors post straight away.
      </Muted>

      <TextField id={ids.contribute.tipInput} value={text} onChangeText={setText} placeholder="e.g. The 2008 model swapped to a BB30 bottom bracket." multiline style={{ marginTop: space.lg }} />

      <Button id={ids.contribute.submit} label={busy ? 'Submitting…' : 'Submit tip'} onPress={() => void submit()} disabled={!canSubmit} />

      {/* trust-aware status banner — driven by the SERVER's returned status, never a client flag */}
      {status ? (
        <View {...tid(ids.contribute.statusBanner)} style={[styles.banner, { borderColor: surface.border, backgroundColor: surface.surface }]}>
          <Body>{status === 'live' ? "Live now — thanks. It's part of the Guide." : 'Submitted. A moderator will review it shortly.'}</Body>
        </View>
      ) : null}

      {/* safety refusal — a DISTINCT surface (global.safetyRefusal), not the status banner and not an error */}
      <SafetyRefusal visible={!!refused} message={refused ?? undefined} />

      {/* in-persona error (no separate retry button — the Submit button above IS the retry, so we avoid a
          duplicate testID; offline is handled by the banner + disabled submit). */}
      {error ? <ErrorState message={error} /> : null}

      <PressableTile id={ids.contribute.reportBtn} onPress={() => void report()} style={{ marginTop: space.xl }}>
        <Muted>{reportState === 'done' ? 'Reported — hidden pending review. Thank you.' : reportState === 'busy' ? 'Reporting…' : 'Report a problem with this entry'}</Muted>
      </PressableTile>
    </Screen>
  )
}

const styles = StyleSheet.create({
  banner: { borderWidth: 1, borderRadius: radius.md, padding: space.lg, marginTop: space.lg },
})
