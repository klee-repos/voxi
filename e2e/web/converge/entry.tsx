/**
 * Converge entry — mounts the REAL Expo screen app/app/reveal.tsx under react-native-web and drives its real
 * Zustand capture store from the REAL BFF NDJSON stream. Nothing in app/ is edited; this file is the converge
 * harness's mount point (the analogue of expo-router/entry, scoped to one screen).
 *
 * Flow (proves the convergence path end to end):
 *   1. POST /api/v1/threads (real voxi-api BFF, test-mode auth) → threadId.
 *   2. GET  /api/v1/threads/:id/stream (real BFF NDJSON) → token + confidence_band events.
 *   3. Feed those real events into the REAL useCaptureStore (app/src/state/captureStore.ts).
 *   4. Render the REAL <Reveal/> (app/app/reveal.tsx) wrapped in the REAL <ThemeProvider/> + a connectivity
 *      provider, under RNW. The real testIDs (reveal.card / reveal.title / reveal.confidenceChip[data-band]/…)
 *      reach the DOM as data-testid/data-* — the same contract the framework PlaywrightDriver reads.
 *
 * The component tree is UNMODIFIED app code: Reveal → SurfaceProvider → RevealBody → Screen/Title/Body/Orb/
 * ConfidenceChip/Banners/FadeRise + useCaptureStore + registerFor(shared). Only three Expo-resolved imports
 * (expo-router, expo-image, react-native-safe-area-context) are bundler-aliased to web shims — exactly what
 * babel-preset-expo/Metro do on the real web build (see docs/CONVERGENCE.md).
 */
import React, { useEffect, useState } from 'react'

import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Reveal from '../../../app/app/reveal'
import { SignedIn } from './auth-gate'
import type { ConfidenceBand } from '../../../packages/shared/src/confidence'

// The seeded object is read from the URL (?scan=probable|confident|unknown) so the same deterministic
// outcomes the rest of the web E2E uses are reachable here too.
function seededScan(): string {
  const p = new URLSearchParams(globalThis.location?.search ?? '')
  return p.get('scan') ?? 'probable'
}

/** Drive the REAL capture store from the REAL BFF stream, then render the REAL reveal screen. */
function ConvergeRoot(): React.ReactElement {
  const [ready, setReady] = useState(false)
  const store = useCaptureStore

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const scan = seededScan()
      const token = 'test:converge'
      const authJson = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

      // 1) start a thread on the real BFF
      store.getState().startCapture(`obj:${scan}`)
      const tr = await fetch('/api/v1/threads', {
        method: 'POST',
        headers: authJson,
        body: JSON.stringify({ photoUrl: `obj:${scan}`, title: `Capture · ${scan}` }),
      })
      if (tr.status !== 200) {
        store.getState().setError('The Guide is at capacity.')
        if (!cancelled) setReady(true)
        return
      }
      const { threadId } = (await tr.json()) as { threadId: string }
      store.getState().setThread(threadId)

      // 2) consume the real NDJSON stream and drive the real store from real events
      const s = await fetch(`/api/v1/threads/${threadId}/stream`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const reader = s.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line) continue
          const e = JSON.parse(line) as {
            type: string
            text?: string
            band?: ConfidenceBand
            title?: string
            candidates?: string[]
            code?: string
            message?: string
            sourceUrl?: string
            sourceTitle?: string
            quote?: string
          }
          if (e.type === 'token' && e.text) store.getState().appendText(e.text)
          // async deep research: verified facts (with provenance) + a richer description arrive AFTER the band.
          if (e.type === 'fact' && e.text) {
            store.getState().appendFact({ text: e.text, sourceUrl: e.sourceUrl ?? '', sourceTitle: e.sourceTitle ?? '', quote: e.quote ?? '' })
          }
          if (e.type === 'description_upgrade' && e.text) store.getState().upgradeDescription(e.text)
          if (e.type === 'confidence_band' && e.band) {
            store.getState().setBand(e.band, e.title ?? '', e.candidates ?? [])
          }
          if (e.type === 'error') {
            // refusal → the distinct refusal surface; any other error → failure. captureStore.setError forces
            // outcome='failure', so for a refusal we set the message first, then pin outcome back to 'refusal'.
            if (e.code === 'safety_refusal') {
              if (e.message) store.getState().setError(e.message)
              store.getState().setOutcome('refusal')
            } else {
              store.getState().setError(e.message ?? 'The Guide lost the thread.')
            }
          }
        }
      }
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [store])

  // The REAL screen renders immediately (its own loading state covers the pre-band moment); `ready` just lets
  // a test wait until the stream has fully settled if it wants to.
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root" data-ready={String(ready)}>
            <Reveal />
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}

// react-dom/client renders <ConvergeRoot/> directly (client.tsx); react-native-web injects its StyleSheet into
// document.head automatically on the web target, so no AppRegistry SSR plumbing is needed here.
export { ConvergeRoot }
