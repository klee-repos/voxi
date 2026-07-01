/**
 * Converge entry — mounts the REAL Expo screen app/app/conversation.tsx under react-native-web. Nothing in app/
 * is edited; this is the converge mount point (the analogue of expo-router/entry, scoped to one screen).
 *
 * The REAL component tree: Conversation → Screen/Body/Muted/Button/PressableTile/TextField (ui.tsx) + Orb +
 * OfflineBanner + createVoiceSession (the REAL pipecat seam — its deterministic in-process stub, the exact path
 * the whole web E2E suite + the native build-until-Pipecat use) + useCaptureStore + useOffline + useRouter. The
 * conversation screen now also DURABLY persists its turns + replays history on revisit (COLLECTION-PERSISTENCE),
 * so it consumes the BFF via useApi → it needs the REAL ApiProvider + a real bearer (SignedIn), like threads.
 * We prime the capture store with a threadId so the screen reads a real (non-'unknown') session id, exactly as it
 * would after a reveal. (That id isn't a real owned thread here, so the message read/write owner-404s and no-ops —
 * harmless; the durable conversation persistence itself is proven in app-persistence.test.)
 */
import React, { useEffect, useState } from 'react'
import { ThemeProvider } from '../../../app/src/lib/themeProvider'
import { ApiProvider } from '../../../app/src/lib/api'
import { useCaptureStore } from '../../../app/src/state/captureStore'
import Conversation from '../../../app/app/conversation'
import { SignedIn } from './auth-gate'

function PrimedConversation(): React.ReactElement {
  const store = useCaptureStore
  const [ready, setReady] = useState(false)
  useEffect(() => {
    // Prime a thread id (as a post-reveal "Ask Voxi" entry would) so the real session reads a real id, then mount.
    store.getState().setThread('thr_converge')
    setReady(true)
  }, [store])
  if (!ready) return <div data-testid="converge.priming" />
  return (
    <div data-testid="converge.root">
      <Conversation />
    </div>
  )
}

export function ConvergeRoot(): React.ReactElement {
  return (
    <ThemeProvider>
      <SignedIn>
        <ApiProvider>
          <PrimedConversation />
        </ApiProvider>
      </SignedIn>
    </ThemeProvider>
  )
}
