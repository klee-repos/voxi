/**
 * Unknown-item interview (PLAN §10.2 screen 10 / §7.3) — momentum-preserving: in-persona Q&A capped at 2–3
 * questions, SKIP on every step (skip = answer:null), a "why am I asked this" one-liner, and a single
 * visibility toggle DEFAULTING TO PRIVATE (a global exemplar requires the explicit toggle). Reads like
 * "co-writing an entry," not an error form. Drives POST /v1/interview + /answer. ids: interview.*.
 *
 * States covered: LOADING (opening the interview), ERROR/OFFLINE (open failed — retry, but the thread stays
 * private regardless), EMPTY (service returned no questions → straight to reveal), and the live Q&A. The orb
 * respects reduce-motion (the Orb component swaps its breathing for a static bloom).
 */
import React, { useCallback, useEffect, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Title, Body, Muted, Button, TextField, Toggle, PressableTile, LoadingLine, ErrorState } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { ids, tid } from '../src/lib/testid'
import { space } from '../src/lib/theme'
import { useApi } from '../src/lib/api'
import { useOffline, isOfflineError } from '../src/lib/useOffline'
import { useCaptureStore } from '../src/state/captureStore'
import type { InterviewQuestion } from '../src/lib/apiClient'

type Phase = 'loading' | 'error' | 'ready'

export default function Interview(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const threadId = useCaptureStore((s) => s.threadId) ?? 'unknown'

  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [netError, setNetError] = useState(false)
  const [interviewId, setInterviewId] = useState<string | null>(null)
  const [questions, setQuestions] = useState<InterviewQuestion[]>([])
  const [idx, setIdx] = useState(0)
  const [answer, setAnswer] = useState('')
  const [global, setGlobal] = useState(false) // default PRIVATE
  const [showWhy, setShowWhy] = useState(false)
  const [busy, setBusy] = useState(false)

  const offline = useOffline(netError)

  // NEW back affordance (interview was a backward dead-end). Detail screen → guarded dismiss to the actual
  // parent (camera, since processing replaced itself into interview), fallback camera on deep-link/reload.
  const backHeader = <AppHeader leading="back" />

  const open = useCallback(async (): Promise<boolean> => {
    setPhase('loading')
    setErrMsg(null)
    setNetError(false)
    try {
      const r = await api.openInterview({ threadId, visibility: 'private' })
      setInterviewId(r.interviewId)
      setQuestions(r.questions)
      setPhase('ready')
      return true
    } catch (e) {
      // The interview is a momentum feature; a failure must never lose the (already private) thread. We offer
      // a retry, but also a way to finish — the user can always proceed to the reveal with nothing shared.
      setNetError(isOfflineError(e))
      setErrMsg(isOfflineError(e) ? "We're offline, so I can't open the entry just yet." : "I couldn't start the entry. Mine to fix, not yours.")
      setPhase('error')
      return false
    }
  }, [api, threadId])

  useEffect(() => {
    // EMPTY (reachable, zero questions) is handled by the render guard below — no auto-redirect, so the user
    // sees the transition deliberately. ERROR/OFFLINE is set inside open().
    void open()
  }, [open])

  const q = questions[idx]

  async function submit(skip: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      if (q && interviewId) {
        await api.answerInterview(interviewId, { questionId: q.id, answer: skip ? null : answer.trim() || null }).catch(() => undefined)
      }
      setAnswer('')
      if (idx + 1 < questions.length && idx + 1 < 3) setIdx(idx + 1)
      else router.replace('/reveal')
    } finally {
      setBusy(false)
    }
  }

  // LOADING
  if (phase === 'loading') {
    return (
      <Screen id={ids.interview.screen} header={backHeader}>
        <OfflineBanner visible={offline} />
        <View style={styles.hero}>
          <Orb id={ids.processing.orb} state="thinking" size={96} />
          <Title style={{ marginTop: space.lg }}>Opening a fresh entry…</Title>
        </View>
        <LoadingLine label="Finding the right questions to ask." />
      </Screen>
    )
  }

  // ERROR / OFFLINE
  if (phase === 'error') {
    return (
      <Screen id={ids.interview.screen} header={backHeader}>
        <OfflineBanner visible={offline} />
        <View style={styles.hero}>
          <Orb id={ids.processing.orb} state="uncertain" size={96} />
          <Title style={{ marginTop: space.lg }}>A small hiccup.</Title>
        </View>
        <ErrorState id={ids.interview.question} message={errMsg ?? 'Something went sideways.'} onRetry={() => void open()} retryId={ids.reveal.primaryAction} />
        <Button id={ids.interview.skip} label="Skip and continue" variant="secondary" onPress={() => router.replace('/reveal')} />
      </Screen>
    )
  }

  // EMPTY (reachable, no questions) — a calm one-tap exit, nothing shared.
  if (questions.length === 0) {
    return (
      <Screen id={ids.interview.screen} header={backHeader}>
        <OfflineBanner visible={offline} />
        <View style={styles.hero}>
          <Orb id={ids.processing.orb} state="idle" size={96} />
          <Title style={{ marginTop: space.lg }}>Nothing to ask, this time.</Title>
          <Muted style={{ marginTop: space.sm, textAlign: 'center' }}>
            The Guide already has what it needs. Your capture stays private to you.
          </Muted>
        </View>
        <Body {...tid(ids.interview.question)} style={styles.question}>No further questions.</Body>
        <Toggle id={ids.interview.visibilityToggle} value={global} onValueChange={setGlobal} label="Share this entry with everyone (off = private to you)" />
        <PressableTile id={ids.interview.whyAsked} onPress={() => setShowWhy((v) => !v)} style={{ marginVertical: space.sm }}>
          <Muted>Why am I asked this?</Muted>
        </PressableTile>
        {showWhy ? <Muted>Sharing helps the Guide recognise this object for everyone next time. Off keeps it yours alone.</Muted> : null}
        <Button id={ids.reveal.primaryAction} label="See the entry" onPress={() => router.replace('/reveal')} style={{ marginTop: space.lg }} />
      </Screen>
    )
  }

  // READY — the live Q&A.
  return (
    <Screen id={ids.interview.screen}>
      <OfflineBanner visible={offline} />
      <View style={styles.hero}>
        <Orb id={ids.processing.orb} state="thinking" size={96} />
        <Title style={{ marginTop: space.lg }}>Let's write its entry together.</Title>
        <Muted style={{ marginTop: space.sm }}>The Guide hasn't met this one yet. A couple of questions and we'll fix that.</Muted>
      </View>

      <Body {...tid(ids.interview.question)} style={styles.question}>{q?.prompt ?? '…'}</Body>

      <PressableTile id={ids.interview.whyAsked} onPress={() => setShowWhy((v) => !v)} style={{ marginVertical: space.sm }}>
        <Muted>Why am I asked this?</Muted>
      </PressableTile>
      {showWhy ? <Muted>{q?.whyAsked ?? 'It helps the Guide build a precise entry.'}</Muted> : null}

      <TextField id={ids.interview.answerInput} value={answer} onChangeText={setAnswer} placeholder="Your answer (optional)" multiline />

      <Toggle id={ids.interview.visibilityToggle} value={global} onValueChange={setGlobal} label="Share this entry with everyone (off = private to you)" />

      <View style={styles.actions}>
        <Button id={ids.interview.skip} label="Skip" variant="secondary" disabled={busy} onPress={() => void submit(true)} />
        <Button id={ids.reveal.primaryAction} label={idx + 1 < questions.length && idx + 1 < 3 ? 'Next' : 'Finish'} disabled={busy} onPress={() => void submit(false)} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: space.xl },
  question: { marginTop: space.md, fontSize: 20 },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
})
