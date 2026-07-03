/**
 * Converge entry — mounts the REAL Deep Dive player (app/app/podcast.tsx) under react-native-web with a REAL
 * owned thread (created on the REAL BFF), so the §F2 idle-gate contract is provable on the real screen: opening
 * the player must NOT auto-generate — it PROBES for a durable episode (GET /v1/threads/:id, none here) and shows
 * the explicit "Generate a Deep Dive" CTA; generation (POST /v1/podcast) only fires on that tap. Nothing in app/
 * is edited; this mirrors entry.tsx, scoped to the Deep Dive screen.
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Podcast from '../../../app/app/podcast'
import { SignedIn } from './auth-gate'

function ConvergeRoot(): React.ReactElement {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = 'test:converge'
      const authJson = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      // Create a REAL owned thread (no reveal stream needed) so getThread + the podcast gate act on a real item.
      useCaptureStore.getState().startCapture('obj:deepdive')
      const tr = await fetch('/api/v1/threads', {
        method: 'POST',
        headers: authJson,
        body: JSON.stringify({ photoUrl: 'obj:deepdive', title: 'A Curious Object' }),
      })
      if (tr.status === 200) {
        const { threadId } = (await tr.json()) as { threadId: string }
        useCaptureStore.getState().setThread(threadId)
        useCaptureStore.getState().setBand('CONFIDENT', 'A Curious Object', [])
      }
      if (!cancelled) setReady(true)
    })()
    return () => { cancelled = true }
  }, [])

  // Render the player only once the thread is seeded, so it mounts straight into the PROBE → IDLE path (not the
  // thread-less empty state) — exactly the state the idle-gate contract is about.
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <div data-testid="converge.root" data-ready={String(ready)}>
            {ready ? <Podcast /> : null}
          </div>
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}

export { ConvergeRoot }
