/**
 * Realtime voice session seam (LiveKit edition).
 *
 * The voice layer runs on LiveKit: the app's @livekit/react-native Room connects to a BFF-minted per-session
 * token (POST /v1/voice/session → { url, token }); LiveKit dispatches the voice-bot (services/voice-bot, a
 * livekit-agents Worker) into the room; the cascade (Deepgram→OpenAI→ElevenLabs) runs server-side. LiveKit owns
 * the WebRTC media plane + ICE/TURN — the pipecat SmallWebRTC transport (pipecat-ai #2755 + a deeper
 * MediaStreamError) is retired. The mic is ALWAYS on (VAD detects speech server-side; the #2755 disabled-mic
 * lesson carries over).
 *
 * This module is a SEAM, not the wire implementation: a `VoiceSession` interface + a `createVoiceSession`
 * factory that returns a deterministic in-process stub by default (so the conversation screen renders + the
 * E2E watchdog/keyboard tests run without @livekit/react-native). The real LiveKit transport is a drop-in.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'uncertain'

export interface TranscriptTurn {
  id: string
  role: 'user' | 'voxi'
  text: string
  /** finalized vs in-flight partial. */
  final: boolean
}

export interface VoiceSessionEvents {
  onOrbState?: (state: OrbState) => void
  onTranscript?: (turn: TranscriptTurn) => void
  onMinutesWarning?: (pct: number) => void
  onMinutesExhausted?: () => void
  onConnected?: () => void
  onDisconnected?: (reason: string) => void
  onError?: (err: Error) => void
}

export interface VoiceSession {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** orb-state hints only — the mic is always on, the server's VAD detects speech. */
  startTalking(): void
  stopTalking(): void
  /** keyboard fallback path (still metered server-side). */
  sendText(text: string): Promise<void>
  readonly connected: boolean
}

export interface VoiceConfig {
  /** LiveKit server URL (ws/wss) — the BFF returns it from POST /v1/voice/session. */
  url: string
  /** LiveKit JWT — the BFF-minted per-session token (carries the userId↔threadId↔connectId capability). */
  token: string
  threadId: string
  /** push-to-talk (orb hint) vs continuous barge-in. Mic is always on either way. */
  mode?: 'pushToTalk' | 'barge'
  events?: VoiceSessionEvents
}

/** Factory seam — the real impl is the LiveKit Room; the stub is the default (web/E2E). */
export type VoiceSessionFactory = (config: VoiceConfig) => VoiceSession

/**
 * Deterministic stub session. Renders the full conversation UX (orb states, transcript turns) without a media
 * stack — used in the E2E web harness + as the default until the native build wires LiveKit. Test seam
 * `__voxiHangVoiceConnect`: connect() never fires onConnected (simulates a hung media plane) so the F3 watchdog →
 * keyboard fallback + its override guard are provable in the web harness.
 */
export function createStubVoiceSession(config: VoiceConfig): VoiceSession {
  const ev = config.events ?? {}
  let connected = false
  let talking = false
  const hang = (globalThis as { __voxiHangVoiceConnect?: boolean }).__voxiHangVoiceConnect === true

  return {
    get connected() {
      return connected
    },
    async connect() {
      if (hang) return // simulate a hung media plane → the 20s watchdog arms + falls back to keyboard (F3)
      connected = true
      ev.onConnected?.()
      ev.onOrbState?.('idle')
    },
    async disconnect() {
      connected = false
      ev.onOrbState?.('idle')
      if (hang) {
        // The watchdog's disconnect fires onDisconnected ASYNC (a later tick); a microtask fire exercises the
        // override guard in a SEPARATE React batch (a sync fire would batch with + be hidden by the watchdog).
        queueMicrotask(() => ev.onDisconnected?.('transport_closed'))
      } else {
        ev.onDisconnected?.('client_closed')
      }
    },
    startTalking() {
      if (!connected) return
      talking = true
      ev.onOrbState?.('listening')
    },
    stopTalking() {
      if (!connected || !talking) return
      talking = false
      ev.onOrbState?.('thinking')
      const uid = `u_${Date.now().toString(36)}`
      ev.onTranscript?.({ id: uid, role: 'user', text: '(spoken)', final: true })
      ev.onOrbState?.('speaking')
      ev.onTranscript?.({
        id: `v_${Date.now().toString(36)}`,
        role: 'voxi',
        text: 'A reasonable question. Allow me a moment with the Guide.',
        final: true,
      })
      ev.onOrbState?.('idle')
    },
    async sendText(text: string) {
      if (!connected) return
      ev.onTranscript?.({ id: `u_${Date.now().toString(36)}`, role: 'user', text, final: true })
      ev.onOrbState?.('thinking')
      ev.onOrbState?.('speaking')
      ev.onTranscript?.({
        id: `v_${Date.now().toString(36)}`,
        role: 'voxi',
        text: 'Noted. Here is what the Guide has to say.',
        final: true,
      })
      ev.onOrbState?.('idle')
    },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

// LiveKit's registerGlobals() must run once before any Room. Idempotent — calling per session is safe.
let livekitGlobalsRegistered = false

/**
 * The REAL LiveKit voice session: a @livekit/react-native Room connected to the BFF-minted url+token. LiveKit
 * owns the WebRTC media plane + ICE/TURN; the bot's TTS audio plays automatically (subscribed track); the user's
 * mic is always on (VAD detects speech server-side). Transcript segments arrive via RoomEvent.TranscriptionReceived.
 *
 * Requires: url + token AND @livekit/react-native (native-only — absent on web/E2E). Returns null otherwise so
 * the caller falls back to the deterministic stub (the web/E2E path never needs the media stack).
 */
export function createRealVoiceSession(config: VoiceConfig): VoiceSession | null {
  if (!config.url || !config.token) return null
  // The LiveKit native module must be LINKED into the running binary — true only on a dev/prod build made
  // AFTER the @livekit/react-native deps were added (pods installed), NOT on web/E2E and NOT on an un-rebuilt
  // dev client whose hot-reloaded JS has this code but whose native binary predates the dep. Probe the SAME
  // native module @livekit/react-native guards on (NativeModules.LivekitReactNativeModule), but NON-throwingly:
  // touching the library when it's absent hits its Proxy that throws a LINKING_ERROR the RN dev loader LOGS on
  // every call (the "lots of errors" when opening Ask on a stale build). A falsy probe → degrade to the
  // deterministic stub (→ watchdog → keyboard /ask), silently. Rebuild the app (expo run:ios) to enable voice.
  let RN: any
  try {
    RN = require('react-native')
  } catch {
    return null // 'react-native' unavailable (shouldn't happen on device) — be safe, use the stub
  }
  // New Architecture (newArchEnabled: true / bridgeless): a legacy RCT_EXTERN_MODULE like LivekitReactNativeModule
  // may resolve via TurboModuleRegistry rather than the legacy NativeModules map. Probe BOTH so a New-Arch build
  // isn't misclassified as "native absent" and silently downgraded to the stub.
  const nmLK = RN?.NativeModules?.LivekitReactNativeModule
  let tmLK: unknown = null
  try {
    tmLK = RN?.TurboModuleRegistry?.get?.('LivekitReactNativeModule')
  } catch {
    /* not a turbo module — fall back to the NativeModules result */
  }
  const bridgeless = (globalThis as any).__turboModuleProxy != null || (globalThis as any).RN$Bridgeless === true
  console.log('[voice] LiveKit native probe → NativeModules:', !!nmLK, '· TurboModule:', !!tmLK, '· bridgeless:', bridgeless)
  if (!nmLK && !tmLK) {
    console.log('[voice] LiveKit native module ABSENT → using deterministic stub (voice will NOT connect on this build)')
    return null
  }
  let Room: any, RoomEvent: any, registerGlobals: any, AudioSession: any
  try {
    const lk = require('@livekit/react-native')
    Room = lk.Room
    RoomEvent = lk.RoomEvent
    registerGlobals = lk.registerGlobals
    AudioSession = lk.AudioSession // iOS/Android AVAudioSession mgmt — REQUIRED or voice connects with no audio
  } catch {
    return null // @livekit/react-native absent (web/E2E bundle) — caller uses the stub
  }
  if (!Room || !RoomEvent || !registerGlobals) return null

  const ev = config.events ?? {}
  let connected = false
  const room: any = new Room()

  if (!livekitGlobalsRegistered) {
    try {
      registerGlobals()
      livekitGlobalsRegistered = true
    } catch {
      /* idempotent guard: a second call can throw; swallow + the prior registration holds */
    }
  }

  // Map LiveKit room events → VoiceSession callbacks.
  room.on(RoomEvent.Connected, () => {
    connected = true
    console.log('[voice] connected: LiveKit room joined')
    ev.onConnected?.()
    ev.onOrbState?.('idle')
  })
  room.on(RoomEvent.Disconnected, (reason: unknown) => {
    connected = false
    console.log('[voice] disconnected', String(reason ?? ''))
    ev.onOrbState?.('idle')
    ev.onDisconnected?.('transport_closed')
  })
  // The agent (voice-bot) joining = the bot is live in the room. LiveKit fires this for the remote participant.
  room.on(RoomEvent.ParticipantConnected, (p: any) => {
    if (p?.identity === room.localParticipant?.identity) return
    console.log('[voice] bot joined:', p?.identity ?? 'agent')
    // The bot's presence means the cascade is up; mark connected if the room-level Connected already did.
    if (!connected) {
      connected = true
      ev.onConnected?.()
    }
  })
  // Transcript: LiveKit Agents publishes conversation transcript via the transcription protocol. Map final
  // segments to our TranscriptTurn (user segments = local; everything else = the Guide).
  room.on(
    RoomEvent.TranscriptionReceived,
    (segments: any[], participant: any) => {
      const isLocal = participant?.identity === room.localParticipant?.identity
      for (const seg of segments ?? []) {
        const text = (seg?.text ?? '').trim()
        if (!text) continue
        ev.onTranscript?.({
          id: seg.id ?? `${isLocal ? 'u' : 'v'}_${Date.now().toString(36)}`,
          role: isLocal ? 'user' : 'voxi',
          text,
          final: seg.final ?? true,
        })
        if (seg.final !== false) ev.onOrbState?.(isLocal ? 'thinking' : 'speaking')
      }
    },
  )

  return {
    get connected() {
      return connected
    },
    async connect() {
      console.log('[voice] connect() — joining LiveKit room for', config.threadId)
      // iOS/Android: configure the native audio session (AVAudioSession playAndRecord) BEFORE connecting, or the
      // mic won't capture + the bot's TTS won't play. Best-effort — never block the join on an audio-session hiccup.
      try {
        await AudioSession?.startAudioSession?.()
      } catch {
        /* audio-session config failed — proceed; the join can still succeed (audio may be degraded) */
      }
      // LiveKit handles ICE/TURN server-side. AdaptiveStreaming + the default audio publish options are fine.
      await room.connect(config.url, config.token, {
        // The caller publishes mic + subscribes to the bot's audio. LiveKit negotiates the rest.
        autoSubscribe: true,
      })
      // ALWAYS-ON mic (the #2755 lesson): VAD on the bot detects speech. setMicrophoneEnabled(true) publishes
      // the mic track; the bot's AgentSession subscribes to it.
      await room.localParticipant.setMicrophoneEnabled(true)
      // After the mic is up, the bot (dispatched by the token's agent grant) joins + the cascade runs.
    },
    async disconnect() {
      await room.disconnect(true)
      // Release the native audio session so the AVAudioSession category reverts (else reveal/podcast playback
      // can inherit the playAndRecord category → quieter/earpiece routing). Best-effort.
      try {
        await AudioSession?.stopAudioSession?.()
      } catch {
        /* ignore — the room is already disconnected */
      }
    },
    startTalking() {
      if (!connected) return
      // Orb hint only — the mic is always on. (No enableMic toggle: LiveKit's mic stays published.)
      ev.onOrbState?.('listening')
    },
    stopTalking() {
      if (!connected) return
      ev.onOrbState?.('thinking')
    },
    async sendText(text: string) {
      if (!connected) return
      // Publish the text as a data message (the bot can be extended to accept text turns; the keyboard path is
      // primarily the BFF /ask route, which is independent). Optimistic local echo:
      ev.onTranscript?.({ id: `u_${Date.now().toString(36)}`, role: 'user', text, final: true })
      ev.onOrbState?.('thinking')
      try {
        await room.localParticipant.publishData(new TextEncoder().encode(text), { reliable: true })
      } catch {
        /* best-effort: the keyboard path (/ask) is the primary text route */
      }
    },
  }
}

/**
 * Returns the REAL LiveKit session when url+token + @livekit/react-native are available, else the deterministic
 * stub. The stub is load-bearing for the web/E2E harness (no native WebRTC there).
 */
export const createVoiceSession: VoiceSessionFactory = (config) => {
  // Fail-safe: the real transport touches native media (LiveKit Room, react-native-webrtc) which can throw for
  // reasons we can't fully anticipate on device. Voice must NEVER crash the conversation screen — any throw
  // degrades to the deterministic stub so the UX (orb, transcript) still renders.
  try {
    const real = createRealVoiceSession(config)
    if (real) return real
  } catch (err) {
    config.events?.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
  return createStubVoiceSession(config)
}
