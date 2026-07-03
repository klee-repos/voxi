/**
 * Conversation (PLAN §10.2 screen 8 / §6.3) — default full-screen ORB voice mode with PUSH-TO-TALK (mic model
 * = push-to-hold/tap-to-toggle by default, protects minute caps + clear privacy indicator) and a ⌨️ toggle
 * that collapses to a text thread. A PERSISTENT live-mic indicator shows the recording state. Turns stream from
 * the Pipecat session seam (createVoiceSession → stub by default, real SmallWebRTC on device).
 *
 * State matrix (PLAN §10.2): loading = connecting to the bot; empty = connected, no turns yet (voice-discovery
 * nudge); error = connect/session failure with retry; offline = global.offlineBanner + the bot can't reach us;
 * minutesExhausted = hard-disconnect at the cap with an in-persona message + paywall CTA + keyboard fallback.
 * Reduce-motion (PLAN §10.3): the live-mic indicator drops its pulsing "live" word for a static recording dot;
 * the orb already swaps its breathing for a static bloom. testids: conversation.*.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Screen, Body, Muted, Button, PressableTile, TextField } from '../src/components/ui'
import { AppHeader } from '../src/components/AppHeader'
import { Orb } from '../src/components/Orb'
import { OfflineBanner } from '../src/components/Banners'
import { ids, tid } from '../src/lib/testid'
import { radius, space, type as typeTokens } from '../src/lib/theme'
import { useTheme } from '../src/lib/themeProvider'
import { createVoiceSession, type OrbState, type TranscriptTurn } from '../src/lib/pipecat'
import { config } from '../src/lib/config'
import { useOffline } from '../src/lib/useOffline'
import { useApi } from '../src/lib/api'
import { useCaptureStore } from '../src/state/captureStore'

type ConnState = 'connecting' | 'connected' | 'error'

export default function Conversation(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion } = useTheme()
  const offline = useOffline()
  const threadId = useCaptureStore((s) => s.threadId) ?? 'unknown'

  const [orb, setOrb] = useState<OrbState>('idle')
  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [keyboard, setKeyboard] = useState(false)
  const [talking, setTalking] = useState(false)
  const [text, setText] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [conn, setConn] = useState<ConnState>('connecting')
  const scrollRef = useRef<ScrollView>(null)

  // Modal dismiss X, guarded → fallback camera. No header title by design (deviation from design.md nav-modal's
  // centered title; the orb IS the identity here).
  const closeHeader = <AppHeader leading="none" showClose />

  const session = useMemo(
    () =>
      createVoiceSession({
        connectUrl: config.pipecatConnectUrl,
        threadId,
        mode: 'pushToTalk',
        events: {
          onConnected: () => setConn('connected'),
          onOrbState: setOrb,
          onTranscript: (turn) => {
            setTurns((prev) => [...prev, turn])
            // Persist each turn durably so the conversation survives a revisit (idempotent on the turn id).
            if (threadId !== 'unknown')
              void api
                .postMessage(threadId, { role: turn.role === 'voxi' ? 'guide' : 'user', text: turn.text, source: 'voice', clientKey: turn.id })
                .catch(() => {})
          },
          onMinutesExhausted: () => setExhausted(true),
          onError: () => setConn('error'),
          onDisconnected: (reason) => {
            // a non-client-initiated drop while we believed we were connected reads as an error to recover from
            if (reason !== 'client_closed') setConn('error')
          },
        },
      }),
    [threadId, api],
  )
  const sessionRef = useRef(session)
  sessionRef.current = session

  // Replay the DURABLE conversation on revisit — a past thread's chat is persisted server-side, so reopening it
  // shows the real history instead of a blank orb. Seeded once; live turns then append on top (and persist).
  const historyLoaded = useRef(false)
  useEffect(() => {
    if (threadId === 'unknown' || historyLoaded.current) return
    historyLoaded.current = true
    void api
      .listMessages(threadId)
      .then(({ messages }) => {
        if (!messages.length) return
        const prior: TranscriptTurn[] = messages.map((m) => ({ id: m.id, role: m.role === 'guide' ? 'voxi' : 'user', text: m.text, final: true }))
        setTurns((prev) => [...prior, ...prev])
      })
      .catch(() => {})
  }, [threadId, api])

  function connect(): void {
    setConn('connecting')
    session.connect().catch(() => setConn('error'))
  }

  useEffect(() => {
    connect()
    return () => {
      void sessionRef.current.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // keep the newest turn in view
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: !reduceMotion })
  }, [turns, reduceMotion])

  function onPressTalk(): void {
    if (exhausted || conn !== 'connected') return
    if (talking) {
      session.stopTalking()
      setTalking(false)
    } else {
      session.startTalking()
      setTalking(true)
    }
  }

  async function onSend(): Promise<void> {
    if (!text.trim() || exhausted || conn !== 'connected') return
    const t = text.trim()
    setText('')
    await session.sendText(t)
  }

  // ---- minutes-exhausted: hard-disconnect with an in-persona message + recovery (paywall / keyboard) ----
  if (exhausted) {
    return (
      <Screen id={ids.conversation.orb} center header={closeHeader}>
        <OfflineBanner visible={offline} />
        <Orb id={ids.conversation.orbVisual} state="uncertain" />
        <Body {...tid(ids.conversation.minutesExhausted)} style={styles.exhaustedMsg}>
          That's our time for now — you've used this period's voice minutes. We can carry on by keyboard, or
          you can top up.
        </Body>
        <Button
          id={ids.conversation.toPaywall}
          label="Top up minutes"
          onPress={() => router.push('/paywall')}
          style={{ marginTop: space.lg }}
        />
        <Button
          id={ids.conversation.keyboardToggle}
          label="Switch to keyboard"
          variant="secondary"
          onPress={() => {
            setExhausted(false)
            setKeyboard(true)
          }}
          style={{ marginTop: space.sm }}
        />
      </Screen>
    )
  }

  // ---- error: connect/session failure → in-persona copy + retry (keyboard toggle still reachable below) ----
  const errored = conn === 'error'

  return (
    <Screen id={ids.conversation.orb} header={closeHeader}>
      <OfflineBanner visible={offline} />

      <View style={styles.orbWrap}>
        <Orb
          id={ids.conversation.orbVisual}
          state={errored ? 'uncertain' : conn === 'connecting' ? 'thinking' : orb}
          size={140}
        />

        {/* PERSISTENT live-mic indicator: always present while a session is live so the privacy state is never
            ambiguous; its treatment changes between armed (recording) and standby. Reduce-motion drops the
            pulsing "live" word for a static recording dot. */}
        {conn === 'connected' && !keyboard ? (
          <View
            {...tid(ids.conversation.liveMicIndicator)}
            style={[
              styles.mic,
              {
                backgroundColor: talking ? surface.danger : surface.card,
                borderColor: talking ? surface.danger : surface.border,
              },
            ]}
            accessibilityRole="text"
          >
            <Muted style={{ color: talking ? surface.onAccent : surface.textMuted }}>
              {talking ? (reduceMotion ? '● recording' : '● live') : '○ mic ready'}
            </Muted>
          </View>
        ) : null}
      </View>

      {/* loading: connecting to the bot */}
      {conn === 'connecting' ? (
        <Muted style={styles.statusLine}>Reaching the Guide…</Muted>
      ) : null}

      {/* error: connection/session failure with a retry */}
      {errored ? (
        <View style={styles.errorBlock}>
          <Body style={{ textAlign: 'center' }}>
            I've lost the thread of our conversation. A momentary lapse — shall we try again?
          </Body>
          <Button id={ids.conversation.micButton} label="Reconnect" onPress={connect} style={{ marginTop: space.md }} />
        </View>
      ) : null}

      {/* transcript thread (the official caption path — every Voxi turn is persisted text, PLAN §10.3) */}
      <ScrollView ref={scrollRef} style={styles.transcript} contentContainerStyle={{ gap: space.sm }}>
        {conn === 'connected' && turns.length === 0 ? (
          // empty: connected but no turns yet — voice-discovery nudge at peak delight (F8)
          <Muted style={styles.emptyHint}>
            Hold to talk, or tap the keyboard to type. Ask me anything about this object.
          </Muted>
        ) : null}
        {turns.map((t) => (
          <View key={t.id} {...(t.role === 'voxi' ? tid(ids.conversation.voxiTurn) : {})} style={styles.turn}>
            <Muted>{t.role === 'voxi' ? 'Voxi' : 'You'}</Muted>
            <Body {...(t.role === 'voxi' ? tid(ids.conversation.transcriptText) : {})}>{t.text}</Body>
          </View>
        ))}
      </ScrollView>

      {/* input row: keyboard thread OR push-to-talk control */}
      {keyboard ? (
        <View style={styles.inputRow}>
          <TextField
            id={ids.conversation.textInput}
            value={text}
            onChangeText={setText}
            placeholder="Type to the Guide…"
            style={{ flex: 1 }}
          />
          <Button id={ids.conversation.sendBtn} label="Send" onPress={() => void onSend()} />
        </View>
      ) : errored ? null : (
        <View style={styles.controls}>
          <PressableTile
            id={ids.conversation.micButton}
            onPress={onPressTalk}
            style={[
              styles.talkBtn,
              {
                backgroundColor: talking ? surface.danger : surface.accent,
                opacity: conn === 'connected' ? 1 : 0.5,
              },
            ]}
          >
            <Body style={{ color: surface.onAccent, fontFamily: typeTokens.family.sans['600'] }}>
              {conn !== 'connected' ? 'Connecting…' : talking ? 'Tap to stop' : 'Hold to talk'}
            </Body>
          </PressableTile>
        </View>
      )}

      <Button
        id={ids.conversation.keyboardToggle}
        label={keyboard ? 'Use voice' : 'Use keyboard'}
        variant="secondary"
        onPress={() => setKeyboard((k) => !k)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  orbWrap: { alignItems: 'center', marginTop: space.lg },
  mic: {
    marginTop: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  statusLine: { textAlign: 'center', marginTop: space.md },
  errorBlock: { marginTop: space.lg, maxWidth: 360, alignSelf: 'center' },
  emptyHint: { textAlign: 'center', paddingHorizontal: space.lg, marginTop: space.lg },
  transcript: { flex: 1, marginVertical: space.lg },
  turn: { gap: space.xs },
  controls: { alignItems: 'center' },
  talkBtn: {
    minHeight: 64,
    paddingHorizontal: space.xxl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.md,
  },
  inputRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  exhaustedMsg: { marginTop: space.xl, textAlign: 'center', maxWidth: 420 },
})
