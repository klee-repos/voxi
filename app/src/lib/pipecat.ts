/**
 * Realtime voice session seam (PLAN §6.3 / D4 — Pipecat over SmallWebRTC).
 *
 * Voxi is always 1 user ↔ 1 bot, so the transport is peer-to-peer SmallWebRTC (no SFU). The client connects
 * to a BFF-minted, per-session scoped endpoint; the persona, item record, and prior transcript are loaded by
 * the sidecar on connect. Mic model = push-to-hold / tap-to-toggle by default (protects minute caps; clear
 * privacy indicator) — VAD/barge-in is a paid-tier flag, not the default.
 *
 * This module is a SEAM, not the wire implementation: a `VoiceSession` interface + a `createVoiceSession`
 * factory that returns a deterministic in-process stub by default (so the conversation screen renders and the
 * E2E push-to-talk flow runs without react-native-webrtc). The real Pipecat transport is a drop-in factory.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'uncertain'

export interface TranscriptTurn {
  id: string
  role: 'user' | 'voxi'
  text: string
  /** finalized vs in-flight partial (barge-in turns are committed-as-interrupted or discarded). */
  final: boolean
}

export interface VoiceSessionEvents {
  onOrbState?: (state: OrbState) => void
  onTranscript?: (turn: TranscriptTurn) => void
  /** minute-cap signals (soft warning at 80/90%; hard disconnect at the cap with an in-persona message). */
  onMinutesWarning?: (pct: number) => void
  onMinutesExhausted?: () => void
  onConnected?: () => void
  onDisconnected?: (reason: string) => void
  onError?: (err: Error) => void
}

export interface VoiceSession {
  connect(): Promise<void>
  disconnect(): Promise<void>
  /** push-to-talk: begin/end capturing the user's turn. */
  startTalking(): void
  stopTalking(): void
  /** keyboard fallback path (still metered server-side). */
  sendText(text: string): Promise<void>
  readonly connected: boolean
}

export interface VoiceConfig {
  /** BFF-minted per-session scoped connect URL (carries the userId↔sessionId ACL). */
  connectUrl: string
  threadId: string
  /** push-to-talk (default) vs continuous barge-in (paid). */
  mode?: 'pushToTalk' | 'barge'
  events?: VoiceSessionEvents
}

/** Factory seam — swapped for the real SmallWebRTC transport when react-native-webrtc is available. */
export type VoiceSessionFactory = (config: VoiceConfig) => VoiceSession

/**
 * Deterministic stub session. Renders the full conversation UX (orb states, transcript turns, mic indicator)
 * without a media stack — used in the E2E web harness and as the default until the native build wires Pipecat.
 */
export function createStubVoiceSession(config: VoiceConfig): VoiceSession {
  const ev = config.events ?? {}
  let connected = false
  let talking = false

  return {
    get connected() {
      return connected
    },
    async connect() {
      connected = true
      ev.onConnected?.()
      ev.onOrbState?.('idle')
    },
    async disconnect() {
      connected = false
      ev.onOrbState?.('idle')
      ev.onDisconnected?.('client_closed')
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
      // simulate a finalized user turn → Voxi reply (deterministic, in-persona register)
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

/**
 * A MediaManager factory (mic capture / native WebRTC media). The RN SmallWebRTC transport needs a concrete
 * MediaManager (e.g. DailyMediaManager or a react-native-webrtc-backed one) — a native-only peer that cannot
 * load in the web/E2E bundle. The native build injects it via `setVoiceMediaManagerFactory`; on web it stays
 * null and `createVoiceSession` returns the stub.
 */
type MediaManagerFactory = () => unknown
let mediaManagerFactory: MediaManagerFactory | null = null

/** Native entrypoint calls this once at startup to enable the REAL transport (e.g. from a native init file). */
export function setVoiceMediaManagerFactory(factory: MediaManagerFactory | null): void {
  mediaManagerFactory = factory
}

/**
 * The REAL Pipecat SmallWebRTC session: a PipecatClient over RNSmallWebRTCTransport, pointed at the
 * BFF-minted per-session connect URL (config.connectUrl, from EXPO_PUBLIC_PIPECAT_CONNECT_URL /v1/voice).
 * Maps the RTVI event stream to our VoiceSession callbacks (orb state, transcript turns, mic control).
 *
 * Requires: a configured connectUrl AND a native MediaManager (mic + react-native-webrtc). Returns null when
 * either is missing so the caller can fall back to the stub — the web/E2E path never needs the media stack.
 */
export function createRealVoiceSession(config: VoiceConfig): VoiceSession | null {
  if (!config.connectUrl || !mediaManagerFactory) return null
  let PipecatClient: new (opts: Record<string, unknown>) => RealClient
  let RNSmallWebRTCTransport: new (opts: Record<string, unknown>) => unknown
  let RTVIEventLike: { UserTranscript: string; BotTranscript: string } | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientMod = require('@pipecat-ai/client-js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transportMod = require('@pipecat-ai/react-native-small-webrtc-transport')
    PipecatClient = clientMod.PipecatClient
    RNSmallWebRTCTransport = transportMod.RNSmallWebRTCTransport
    RTVIEventLike = clientMod.RTVIEvent ?? null
  } catch {
    return null // native modules absent (web/E2E bundle) — caller uses the stub
  }
  if (!PipecatClient || !RNSmallWebRTCTransport) return null

  const ev = config.events ?? {}
  const barge = config.mode === 'barge'
  let connected = false
  let idCounter = 0
  const nextId = (p: string) => `${p}_${(idCounter++).toString(36)}_${Date.now().toString(36)}`

  const transport = new RNSmallWebRTCTransport({
    // BFF-minted per-session SmallWebRTC /offer signalling endpoint (see voice-routes.ts).
    connectionUrl: config.connectUrl,
    waitForICEGathering: true,
    mediaManager: mediaManagerFactory(),
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' } as unknown],
  })

  const client: RealClient = new PipecatClient({
    transport,
    enableMic: barge, // push-to-talk keeps the mic gated until startTalking; barge mode opens it continuously
    enableCam: false,
    callbacks: {
      onConnected: () => {
        connected = true
        ev.onConnected?.()
        ev.onOrbState?.('idle')
      },
      onDisconnected: () => {
        connected = false
        ev.onOrbState?.('idle')
        ev.onDisconnected?.('transport_closed')
      },
      onUserStartedSpeaking: () => ev.onOrbState?.('listening'),
      onBotStartedSpeaking: () => ev.onOrbState?.('speaking'),
      onBotStoppedSpeaking: () => ev.onOrbState?.('idle'),
      onUserTranscript: (data: { text: string; final?: boolean }) => {
        ev.onTranscript?.({ id: nextId('u'), role: 'user', text: data.text, final: data.final ?? true })
        if (data.final ?? true) ev.onOrbState?.('thinking')
      },
      onBotTranscript: (data: { text: string }) => {
        ev.onTranscript?.({ id: nextId('v'), role: 'voxi', text: data.text, final: true })
      },
      onError: (msg: unknown) => ev.onError?.(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))),
    },
  })
  void RTVIEventLike // event names available for finer-grained wiring if needed

  return {
    get connected() {
      return connected
    },
    async connect() {
      await client.connect({ connectionUrl: config.connectUrl })
    },
    async disconnect() {
      await client.disconnect()
    },
    startTalking() {
      if (!connected) return
      client.enableMic(true)
      ev.onOrbState?.('listening')
    },
    stopTalking() {
      if (!connected) return
      if (!barge) client.enableMic(false) // push-to-hold: close the mic to end the turn
      ev.onOrbState?.('thinking')
    },
    async sendText(text: string) {
      if (!connected) return
      ev.onTranscript?.({ id: nextId('u'), role: 'user', text, final: true })
      ev.onOrbState?.('thinking')
      await client.sendText(text)
    },
  }
}

/** Minimal shape of the PipecatClient we rely on (typed loosely to avoid a hard dep in the web bundle). */
interface RealClient {
  connect(params?: unknown): Promise<unknown>
  disconnect(): Promise<void>
  enableMic(enable: boolean): void
  sendText(content: string, options?: unknown): Promise<void>
}

/**
 * Returns the REAL Pipecat SmallWebRTC session when a connect URL + native MediaManager are configured, else
 * the deterministic stub. The stub is load-bearing for the web/E2E harness (no react-native-webrtc there).
 */
export const createVoiceSession: VoiceSessionFactory = (config) => {
  // Fail-safe: the real transport touches native media (MediaManager construction, react-native-webrtc,
  // SmallWebRTC peer setup) which can throw for reasons we can't fully anticipate on device (a bad injected
  // MediaManager, a transport internal, a mic-permission path). Voice must NEVER crash the conversation
  // screen — any throw degrades to the deterministic stub so the UX (orb, transcript, push-to-talk) still runs.
  try {
    const real = createRealVoiceSession(config)
    if (real) return real
  } catch (err) {
    config.events?.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
  return createStubVoiceSession(config)
}
