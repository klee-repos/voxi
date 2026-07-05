/**
 * Conversation (PLAN §10.2 screen 8 / §6.3) — default full-screen ORB voice mode with PUSH-TO-TALK (mic model
 * = push-to-hold/tap-to-toggle by default, protects minute caps + clear privacy indicator) and a ⌨️ toggle
 * that collapses to a text thread. A PERSISTENT live-mic indicator shows the recording state. Turns stream from
 * the voice session seam (createVoiceSession → deterministic stub by default, real @livekit/react-native Room on device).
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
import { useOffline } from '../src/lib/useOffline'
import { useApi } from '../src/lib/api'
import { useCaptureStore } from '../src/state/captureStore'

type ConnState = 'connecting' | 'connected' | 'degraded' | 'error'

/**
 * Realtime voice is the DEFAULT surface. The client mints a BFF-scoped session (POST /v1/voice/session → a
 * per-session /offer connectUrl) on mount; the native WebRTC transport (the lazily-injected MediaManager) connects
 * to the voice-bot. Voice is the default; a keyboard toggle switches to text (POST /v1/threads/:id/ask). If the
 * mint fails (404 where no voice route is mounted, e.g. the web harness; 503 voice_server_unconfigured; 402 no
 * minutes) the screen falls back to keyboard-only. Set false to force keyboard-only everywhere.
 */
const VOICE_AVAILABLE = true

export default function Conversation(): React.ReactElement {
  const router = useRouter()
  const api = useApi()
  const { surface, reduceMotion } = useTheme()
  const offline = useOffline()
  const threadId = useCaptureStore((s) => s.threadId) ?? 'unknown'

  const [orb, setOrb] = useState<OrbState>('idle')
  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  // Voice is the DEFAULT surface; the keyboard is a toggle. `voiceUnavailable` is set when the voice mint fails
  // (404 where no /v1/voice route is mounted — the web harness; 503 voice_server_unconfigured; etc.) so the screen
  // falls back to keyboard-only and the "Use voice" toggle is hidden.
  const [keyboard, setKeyboard] = useState(!VOICE_AVAILABLE)
  const [voiceUnavailable, setVoiceUnavailable] = useState(!VOICE_AVAILABLE)
  const [talking, setTalking] = useState(false)
  const [sending, setSending] = useState(false)
  const [text, setText] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [conn, setConn] = useState<ConnState>('connecting')
  // The BFF-minted voice session: { url, token } feed createVoiceSession; connectId scopes the refund latch so a
  // session that never reaches the media plane credits its minute back (F5-LIFECYCLE).
  const [voice, setVoice] = useState<{ url: string; token: string } | null>(null)
  const [paused, setPaused] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const connectIdRef = useRef<string | null>(null)
  const connectedRef = useRef(false)
  const degradedRef = useRef(false)
  const pausingRef = useRef(false) // a deliberate pause/resume disconnect is not a session drop
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const recoveryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined) // F3: degraded→error escalation
  // F3: when the connect watchdog fires (20s, no onConnected — Bug B: WebRTC peer up but RTVI channel never delivers)
  // the screen falls back to keyboard instead of showing a dead "failed" error. The disconnect the watchdog issues
  // fires onDisconnected('transport_closed') asynchronously; this ref is the override guard that stops that late
  // callback (and the connect().catch path) from re-erroring the screen the watchdog just moved to keyboard.
  const watchdogFallbackRef = useRef(false)
  // F1: an in-flight disconnect promise the NEXT connect must await, so a close+reopen never connects a new peer
  // before the old one finishes tearing down (the two-streams root cause). 5s safety timeout avoids a deadlock.
  const disconnectingRef = useRef<Promise<void> | null>(null)
  const connRef = useRef<ConnState>('connecting')
  connRef.current = conn

  // F3: enter the recoverable 'degraded' state + arm a recovery watchdog. If a transcript (the bot-is-alive
  // signal) lands within the window, onTranscript clears it back to 'connected'; otherwise escalate to 'error'
  // so the Reconnect affordance renders (never an unrecoverable dead screen post-connect).
  function enterDegraded(): void {
    degradedRef.current = true
    setConn('degraded')
    if (recoveryRef.current) clearTimeout(recoveryRef.current)
    recoveryRef.current = setTimeout(() => {
      recoveryRef.current = undefined
      degradedRef.current = false
      setConn('error')
    }, 10000)
  }
  function clearRecovery(): void {
    if (recoveryRef.current) { clearTimeout(recoveryRef.current); recoveryRef.current = undefined }
    degradedRef.current = false
  }

  // Modal dismiss X, guarded → fallback camera. No header title by design (deviation from design.md nav-modal's
  // centered title; the orb IS the identity here).
  const closeHeader = <AppHeader leading="none" showClose />

  const session = useMemo(
    () =>
      voice
        ? createVoiceSession({
            // The BFF-minted per-session LiveKit { url, token } (POST /v1/voice/session). LiveKit dispatches the
            // voice-bot into the room; the bot never sees the identity directly (the token's metadata carries the
            // connectId capability for the grounded-context fetch). Absent url/token → stub.
            url: voice.url,
            token: voice.token,
            threadId,
            mode: 'pushToTalk',
            events: {
              // onConnected is the SIGNAL the media plane came up — it clears the connect watchdog (F4) + marks the
              // session connected so the cleanup refund is skipped (the minute was used). connect() resolving without
              // this signal would otherwise hang "Reaching the Guide…" forever.
              onConnected: () => {
                if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = undefined }
                connectedRef.current = true
                clearRecovery()
                setConn('connected')
              },
              onOrbState: setOrb,
              onTranscript: (turn) => {
                setTurns((prev) => [...prev, turn])
                // F3: a transcript is the SIGNAL the bot is alive — clear a false 'degraded'/'error' back to
                // 'connected' (the "it started responding to me while the error showed" recovery).
                if (degradedRef.current || connRef.current === 'error') { clearRecovery(); connectedRef.current = true; setConn('connected') }
                // Persist each voice turn durably so the conversation survives a revisit (idempotent on the turn id).
                if (threadId !== 'unknown')
                  void api
                    .postMessage(threadId, { role: turn.role === 'voxi' ? 'guide' : 'user', text: turn.text, source: 'voice', clientKey: turn.id })
                    .catch(() => {})
              },
              onMinutesExhausted: () => setExhausted(true),
              onError: () => {
                // F3: a transient error while CONNECTED → 'degraded' (recoverable), not a hard error. During
                // connecting, ignore — the connect watchdog (20s) handles a real connect failure.
                if (connectedRef.current) enterDegraded()
              },
              onDisconnected: (reason) => {
                if (pausingRef.current) return // a deliberate pause/resume disconnect is expected, not a drop
                if (reason === 'client_closed') return
                if (watchdogFallbackRef.current) return // F3: watchdog-triggered disconnect — keyboard fallback already set, don't re-error
                if (!connectedRef.current) { setConn('error'); return } // a drop during connecting
                // F3: a post-connect drop → degraded + a recovery window; if no transcript arrives, escalate.
                connectedRef.current = false
                enterDegraded()
              },
            },
          })
        : null,
    [voice, threadId, api],
  )
  const sessionRef = useRef(session)
  sessionRef.current = session

  // Mint a BFF-scoped voice session on mount. The BFF charges a voice minute + returns the per-session connectUrl;
  // we feed it to createVoiceSession above. A dismiss during mint refunds (the charge happened before the URL
  // returned). A 404 (no /v1/voice route mounted — the web harness) / 503 (voice server unconfigured) → keyboard
  // fallback; a 402 → minutes exhausted.
  useEffect(() => {
    if (!VOICE_AVAILABLE || threadId === 'unknown') return
    let cancelled = false
    connectedRef.current = false
    setVoice(null)
    void api
      .createVoiceSession(threadId)
      .then(({ url, token, connectId }) => {
        if (cancelled) { void api.refundVoiceSession(connectId).catch(() => {}) ; return } // unmounted during mint
        connectIdRef.current = connectId
        setVoice({ url, token })
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof Error && /402|voice_limit/.test(e.message)) setExhausted(true)
        else {
          // Voice unavailable on this build → keyboard-only fallback.
          setVoiceUnavailable(true); setKeyboard(true); setConn('connected')
        }
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, api])

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

  async function connect(): Promise<void> {
    const s = sessionRef.current
    if (!s) return
    // F1: await the previous disconnect (5s safety timeout) so a close+reopen never opens a 2nd peer before the
    // 1st tears down — the two-streams root cause. The voice-bot ALSO dedups on thread (voice_server.py) as a
    // structural backstop; this is the client-side ordering guarantee.
    if (disconnectingRef.current) {
      await Promise.race([
        disconnectingRef.current.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ])
      disconnectingRef.current = null
    }
    setConn('connecting')
    // Watchdog on the onConnected SIGNAL (not the connect() promise): a connect() that resolves without firing
    // onConnected (a hung ICE/mic-permission path) would otherwise spin "Reaching the Guide…" forever. ~20s budget
    // for the real cold-start (mic permission dialog + ICE gathering). Cleared by onConnected above.
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
    // Test seam: shorten the 20s watchdog so the watchdog→keyboard fallback (F3) is provable in the web harness
    // without a 20s wait. The production default is 20s (Bug B: real WebRTC peer up but RTVI never delivers).
    const watchdogMs = (globalThis as { __voxiWatchdogMs?: number }).__voxiWatchdogMs ?? 20000
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = undefined
      // F3 (Bug B): 20s with no onConnected means the WebRTC peer came up but the RTVI data channel / audio track
      // never delivered (a real-device failure mode the web harness can't reproduce). Instead of a dead "failed"
      // error, fall back to keyboard — the text chat path (/v1/threads/:id/ask) is INDEPENDENT of WebRTC and works
      // on every surface. Set the override guard BEFORE disconnect so the late onDisconnected('transport_closed')
      // doesn't re-error the screen we just moved to keyboard.
      watchdogFallbackRef.current = true
      disconnectingRef.current = s.disconnect().catch(() => {}).then(() => { watchdogFallbackRef.current = false })
      setVoiceUnavailable(true) // hide the "Use voice" toggle — the dead session can't be re-entered
      setKeyboard(true)
      setConn('connected') // keyboard is usable now (the lie is intentional: keyboard mode, not voice)
    }, watchdogMs)
    s.connect().catch(() => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = undefined }
      if (watchdogFallbackRef.current) return // F3: watchdog already routed to keyboard fallback
      setConn('error')
    })
  }

  // F4: PAUSE stops the voice stream (disconnect → the voice-bot tears the pipeline down) + keeps the transcript
  // + the minted voiceUrl/connectId. RESUME reconnects the SAME session (no re-mint, no re-charge). A deliberate
  // pause sets pausingRef so the disconnect's onDisconnected isn't read as a session drop.
  function pause(): void {
    const s = sessionRef.current
    if (!s || conn !== 'connected' || paused) return
    pausingRef.current = true
    setPaused(true)
    setTalking(false)
    disconnectingRef.current = s.disconnect().catch(() => {}).then(() => { pausingRef.current = false })
  }
  function resume(): void {
    if (!voice || !paused) return
    setPaused(false)
    void connect()
  }

  useEffect(() => {
    if (!session) return
    void connect()
    return () => {
      clearRecovery()
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = undefined }
      // F1: record the in-flight disconnect so the NEXT connect awaits it (no two peers at once).
      const s = sessionRef.current
      if (s) disconnectingRef.current = s.disconnect().catch(() => {})
      // Refund the minute if we never reached the media plane (dismiss-during-connect or a connect failure): the
      // charge happened at mint, before connect. Idempotent on connectId; skipped once connectedRef is true OR the
      // user is mid-pause (resume will reconnect the same session).
      const cid = connectIdRef.current
      if (cid && !connectedRef.current && !paused) void api.refundVoiceSession(cid).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // keep the newest turn in view
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: !reduceMotion })
  }, [turns, reduceMotion])

  function onPressTalk(): void {
    const s = sessionRef.current
    if (!s || exhausted || conn !== 'connected') return
    if (talking) {
      s.stopTalking()
      setTalking(false)
    } else {
      s.startTalking()
      setTalking(true)
    }
  }

  // Keyboard path: route the question through the REAL BFF (`api.ask`), which grounds the reply in the item's
  // durable reveal + honesty-gates it server-side. The stub/voice `session.sendText` is NOT called here (it would
  // fire a canned voxi turn → a double reply) — voice turns arrive only over the transport (WS2) via onTranscript.
  async function onSend(): Promise<void> {
    const t = text.trim()
    if (!t || exhausted || sending || threadId === 'unknown') return
    const userClientKey = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    setText('')
    setSending(true)
    // Optimistic user turn so the transcript reacts instantly; the server persists it idempotently too.
    setTurns((prev) => [...prev, { id: userClientKey, role: 'user', text: t, final: true }])
    setOrb('thinking')
    try {
      const res = await api.ask(threadId, { text: t, userClientKey })
      setTurns((prev) => [...prev, { id: res.id ?? `v_${userClientKey}`, role: 'voxi', text: res.text, final: true }])
      setOrb('idle')
    } catch (err) {
      // 402 → minutes exhausted (the /ask voice-min charge failed fail-closed); anything else → in-persona retry.
      if (err instanceof Error && /402|voice_limit/.test(err.message)) setExhausted(true)
      setOrb('uncertain')
      setTurns((prev) => [
        ...prev,
        { id: `e_${userClientKey}`, role: 'voxi', text: "I've lost the thread of our conversation. A momentary lapse — try asking again.", final: true },
      ])
    } finally {
      setSending(false)
    }
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

      {/* F3: degraded — a transient mid-call blip; the bot is recovering. Not a hard error. */}
      {conn === 'degraded' ? (
        <Muted style={styles.statusLine}>A brief hiccup — reconnecting…</Muted>
      ) : null}

      {/* error: connection/session failure with a retry */}
      {errored ? (
        <View style={styles.errorBlock}>
          <Body style={{ textAlign: 'center' }}>
            I've lost the thread of our conversation. A momentary lapse — shall we try again?
          </Body>
          <Button id={ids.conversation.micButton} label="Reconnect" onPress={() => void connect()} style={{ marginTop: space.md }} />
        </View>
      ) : null}

      {/* transcript thread (the official caption path — every Voxi turn is persisted text, PLAN §10.3) */}
      <ScrollView ref={scrollRef} style={styles.transcript} contentContainerStyle={{ gap: space.sm }}>
        {conn === 'connected' && turns.length === 0 ? (
          // empty: connected but no turns yet — keyboard-first invite (voice is WS2)
          <Muted style={styles.emptyHint}>
            {keyboard ? 'Ask me anything about this object.' : 'Hold to talk, or tap the keyboard to type. Ask me anything about this object.'}
          </Muted>
        ) : null}
        {turns.map((t) => (
          <View key={t.id} {...(t.role === 'voxi' ? tid(ids.conversation.voxiTurn) : {})} style={styles.turn}>
            <Muted>{t.role === 'voxi' ? 'Voxi' : 'You'}</Muted>
            <Body {...(t.role === 'voxi' ? tid(ids.conversation.transcriptText) : {})}>{t.text}</Body>
          </View>
        ))}
      </ScrollView>

      {/* input row: keyboard thread, resume (paused), or push-to-talk + pause */}
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
      ) : paused ? (
        <View style={styles.controls}>
          <PressableTile
            id={ids.conversation.resumeButton}
            onPress={resume}
            style={[styles.talkBtn, { backgroundColor: surface.accent }]}
          >
            <Body style={{ color: surface.onAccent, fontFamily: typeTokens.family.sans['600'] }}>▶ Resume voice</Body>
          </PressableTile>
        </View>
      ) : errored ? null : (
        <View style={[styles.controls, { flexDirection: 'row', gap: space.md }]}>
          <PressableTile
            id={ids.conversation.micButton}
            onPress={onPressTalk}
            style={[
              styles.talkBtn,
              { flex: 1, backgroundColor: talking ? surface.danger : surface.accent, opacity: conn === 'connected' ? 1 : 0.5 },
            ]}
          >
            <Body style={{ color: surface.onAccent, fontFamily: typeTokens.family.sans['600'] }}>
              {conn !== 'connected' ? 'Connecting…' : talking ? 'Tap to stop' : 'Hold to talk'}
            </Body>
          </PressableTile>
          {conn === 'connected' && !talking ? (
            <PressableTile
              id={ids.conversation.pauseButton}
              onPress={pause}
              style={[styles.pauseBtn, { backgroundColor: surface.sunken, borderColor: surface.border }]}
            >
              <Body style={{ color: surface.text }}>⏸</Body>
            </PressableTile>
          ) : null}
        </View>
      )}

      {!voiceUnavailable ? (
        <Button
          id={ids.conversation.keyboardToggle}
          label={keyboard ? 'Use voice' : 'Use keyboard'}
          variant="secondary"
          onPress={() => setKeyboard((k) => !k)}
        />
      ) : null}
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
  pauseBtn: {
    width: 64,
    minHeight: 64,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.md,
  },
  inputRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  exhaustedMsg: { marginTop: space.xl, textAlign: 'center', maxWidth: 420 },
})
