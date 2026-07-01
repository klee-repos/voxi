/**
 * Concrete, AUDIO-ONLY MediaManager for the Pipecat RN SmallWebRTC transport (native / on-device only).
 *
 * The transport (`@pipecat-ai/react-native-small-webrtc-transport`) ships an ABSTRACT `MediaManager` base and
 * expects the host app to supply a concrete one that owns the mic (and, in a full client, cam + screen share).
 * Voxi is a voice Pokédex — 1 user talking to the Guide — so this manager is deliberately audio-only: cam and
 * screen share are hard-disabled no-ops, and `tracks().local.video` / `.screenVideo` are always null.
 *
 * This file is native-only. Metro resolves it over `voiceMediaManager.ts` (a null stub) on device via the
 * `.native` platform suffix, so `react-native-webrtc` never enters the web/E2E bundle. It is wired at startup
 * by the native entrypoint (app/index.js): `setVoiceMediaManagerFactory(createVoiceMediaManager)`.
 *
 * ── Transport contract (verified against lib/commonjs/transport.js @ v1.8.0) ──────────────────────────────
 * Construction (`new RNSmallWebRTCTransport({ mediaManager })`):
 *   - transport sets `mediaManager.onTrackStarted = _handleTrackStarted.bind(transport)` (base setter stores
 *     it in `_onTrackStartedCallback`; we invoke it via `this.onTrackStarted?.(event)`).
 * PipecatClient.connect() call order:
 *   1. transport.initialize(opts)   -> mediaManager.setClientOptions(opts)   (base; sets _micEnabled from
 *      opts.enableMic ?? true — for push-to-talk the app passes enableMic:false, so the mic starts gated).
 *   2. transport.initDevices()      -> mediaManager.initialize()             (WE acquire the mic here).
 *   3. transport.connect()          -> mediaManager.connect()                (idempotent re-acquire if needed),
 *      then startNewPeerConnection() -> addUserMedia() reads `tracks().local.audio` and calls
 *      getAudioTransceiver().sender.replaceTrack(audioTrack). So `tracks().local.audio` MUST be the live track.
 *   4. syncTrackStatus() reads `isMicEnabled`, `isCamEnabled`, and (only if supportsScreenShare) tracks().local
 *      .screenVideo. We report supportsScreenShare=false, so the screenVideo branch is never taken.
 *   onTrackStarted({track, type:'audio'}) -> transport._handleTrackStarted -> if pc exists, replaceTrack on the
 *   audio transceiver. Safe to call before pc exists (transport early-returns); addUserMedia() then wires it.
 * disconnect(): transport.stop() -> mediaManager.disconnect() — we stop tracks + release the stream.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ASSUMPTIONS (flagged for on-device verification — this file cannot run headlessly):
 *  A1. The transport imports `MediaStreamTrack` from `@daily-co/react-native-webrtc`; this manager imports from
 *      the SAME package (a direct app dependency — no metro alias). So the track objects we hand back come from
 *      the exact native module the transport's `sender.replaceTrack` expects. Keep BOTH on `@daily-co/*`: an
 *      earlier build aliased the transport to the community `react-native-webrtc`, the forks diverged at runtime,
 *      and voice silently degraded to the stub on device. Do not reintroduce a cross-fork alias.
 *  A2. Base `MediaManager` (JS) has no constructor args and sets `_micEnabled=true` before setClientOptions
 *      runs. We keep our own mic-enabled truth in the acquired track's `.enabled` and mirror `_micEnabled`.
 *  A3. `mediaDevices.enumerateDevices()` is typed `Promise<unknown>` and may return an empty/partial list on
 *      iOS before permission is granted. getAllMics() defends against non-arrays and shapes each entry into a
 *      MediaDeviceInfo-like record; it never throws.
 *  A4. `getUserMedia({audio:true})` may reject (permission denied / no device). We surface a clear Error via
 *      the transport's onError callback (when available) and re-throw so PipecatClient's initDevices() reports
 *      a DeviceError — pipecat.ts's createVoiceSession catches transport construction/throws and falls back to
 *      the stub, so a mic failure can never crash the conversation screen.
 */

import { MediaManager } from '@pipecat-ai/react-native-small-webrtc-transport'
// Import from '@daily-co/react-native-webrtc' — the SAME fork the transport requires (app/package.json depends on
// it directly; the old metro alias that pointed it at the community fork is gone). Sharing one WebRTC module is
// what makes `sender.replaceTrack` accept the tracks this manager hands back (see A1).
import { mediaDevices } from '@daily-co/react-native-webrtc'

// Local structural aliases: the transport's abstract signatures reference MediaStreamTrack / MediaDeviceInfo /
// Tracks from '@daily-co/react-native-webrtc' + '@pipecat-ai/client-js', which are not exported as concrete
// values. We type against structural shapes and let the `unknown` factory return absorb the nominal gap.
type RNMediaStreamTrack = {
  readonly id: string
  readonly kind: string
  enabled: boolean
  stop(): void
}
type RNMediaStream = {
  getAudioTracks(): RNMediaStreamTrack[]
  getTracks(): RNMediaStreamTrack[]
  release(releaseTracks?: boolean): void
}
type MediaDeviceInfoLike = {
  deviceId: string
  kind: string
  label: string
  groupId: string
}
/** The exact shape transport.js reads: addUserMedia() -> tracks().local.audio; syncTrackStatus() (guarded by
 *  supportsScreenShare, which is false here) -> tracks().local.screenVideo. */
type TracksShape = {
  local: {
    audio: RNMediaStreamTrack | null
    video: null
    screenAudio: null
    screenVideo: null
  }
  bot: {
    audio: null
    video: null
    screenAudio: null
    screenVideo: null
  }
}

/** react-native-webrtc's `mediaDevices` typed to just the two calls we make. */
const rnMediaDevices = mediaDevices as unknown as {
  getUserMedia(constraints: { audio?: boolean; video?: boolean }): Promise<RNMediaStream>
  enumerateDevices(): Promise<unknown>
}

class VoxiAudioMediaManager extends MediaManager {
  private stream: RNMediaStream | null = null
  private audioTrack: RNMediaStreamTrack | null = null

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────────────

  /** Called by transport.initDevices() (before connect). Acquire the mic and stash the stream + audio track. */
  async initialize(): Promise<void> {
    await this.acquireMic()
  }

  /** Called by transport.connect() before startNewPeerConnection()/addUserMedia(). Idempotent: acquire only if
   *  we don't already hold a live track (initialize() usually ran first via initDevices()). */
  async connect(): Promise<void> {
    if (!this.audioTrack) await this.acquireMic()
  }

  /** Acquire mic exactly once per live stream. Applies the current gate (_micEnabled) to the track, then fires
   *  the transport's onTrackStarted so it can replaceTrack once the peer connection exists. */
  private async acquireMic(): Promise<void> {
    if (this.audioTrack) return
    let stream: RNMediaStream
    try {
      stream = await rnMediaDevices.getUserMedia({ audio: true })
    } catch (cause) {
      const err = new Error(
        `voxi mic acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      // Surface via the transport's error callback if wired, then re-throw so initDevices() reports a
      // DeviceError. createVoiceSession (pipecat.ts) wraps this and falls back to the stub.
      // RTVIMessage shape is { id, label, type, data } — build a faithful error envelope without a hard
      // client-js value dependency (this file only ever loads on device).
      const onError = this._callbacks?.onError as ((m: unknown) => void) | undefined
      onError?.({
        id: `mic-error-${Date.now().toString(36)}`,
        label: 'rtvi-ai',
        type: 'error',
        data: { error: err.message, fatal: false },
      })
      throw err
    }
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) {
      stream.release?.(true)
      throw new Error('voxi mic acquisition returned no audio track')
    }
    // Respect the mic gate the transport pushed via setClientOptions (push-to-talk => start muted).
    track.enabled = this._micEnabled
    this.stream = stream
    this.audioTrack = track
    // TrackEvent: { track, type }. type must be 'audio' to hit the audio transceiver branch in transport.js.
    this.onTrackStarted?.({ track: track as never, type: 'audio' })
  }

  /** Called by transport.disconnect()/stop(). Stop tracks + release the native stream so the OS mic frees. */
  async disconnect(): Promise<void> {
    try {
      this.audioTrack?.stop()
    } catch {
      /* stop is best-effort; a dead track throwing must not block teardown */
    }
    try {
      // release(true) also stops any remaining tracks on the native side.
      this.stream?.release?.(true)
    } catch {
      /* ignore */
    }
    this.audioTrack = null
    this.stream = null
  }

  // ── Mic ────────────────────────────────────────────────────────────────────────────────────────────────

  enableMic(enable: boolean): void {
    this._micEnabled = enable
    if (this.audioTrack) this.audioTrack.enabled = enable
  }

  get isMicEnabled(): boolean {
    // The track's live state is the source of truth once acquired; before acquisition, the gate we were given.
    return this.audioTrack ? this.audioTrack.enabled : this._micEnabled
  }

  async getAllMics(): Promise<MediaDeviceInfoLike[]> {
    let raw: unknown
    try {
      raw = await rnMediaDevices.enumerateDevices()
    } catch {
      return []
    }
    if (!Array.isArray(raw)) return []
    return raw
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && (d as Record<string, unknown>).kind === 'audioinput')
      .map((d) => ({
        deviceId: typeof d.deviceId === 'string' ? d.deviceId : '',
        kind: 'audioinput',
        label: typeof d.label === 'string' ? d.label : '',
        groupId: typeof d.groupId === 'string' ? d.groupId : '',
      }))
  }

  get selectedMic(): MediaDeviceInfoLike | Record<string, never> {
    // We don't track a specific device id (default system input); return {} per the base contract when unknown.
    return {}
  }

  updateMic(_micId: string): void {
    // Voxi uses the default system input; explicit device switching is out of scope for the audio-only loop.
  }

  // ── Camera (hard-disabled) ─────────────────────────────────────────────────────────────────────────────

  async getAllCams(): Promise<MediaDeviceInfoLike[]> {
    return []
  }
  get selectedCam(): MediaDeviceInfoLike | Record<string, never> {
    return {}
  }
  updateCam(_camId: string): void {
    /* no-op: audio-only */
  }
  enableCam(_enable: boolean): void {
    /* no-op: audio-only */
  }
  get isCamEnabled(): boolean {
    return false
  }

  // ── Speakers (default routing) ─────────────────────────────────────────────────────────────────────────

  async getAllSpeakers(): Promise<MediaDeviceInfoLike[]> {
    return []
  }
  get selectedSpeaker(): MediaDeviceInfoLike | Record<string, never> {
    return {}
  }
  updateSpeaker(_speakerId: string): void {
    /* no-op: default output routing */
  }

  // ── Screen share (unsupported) ─────────────────────────────────────────────────────────────────────────
  // Base `_supportsScreenShare` defaults to false in the constructor, so `supportsScreenShare` (base getter)
  // already returns false and the transport skips the screenVideo transceiver + syncTrackStatus branch.

  enableScreenShare(_enable: boolean): void {
    /* no-op: unsupported */
  }
  get isSharingScreen(): boolean {
    return false
  }

  // ── Tracks ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Exactly the shape transport.js reads. addUserMedia() pulls `.local.audio` onto the audio transceiver;
   *  video / screenVideo are null so those branches are inert. */
  tracks(): TracksShape {
    return {
      local: {
        audio: this.audioTrack,
        video: null,
        screenAudio: null,
        screenVideo: null,
      },
      bot: {
        audio: null,
        video: null,
        screenAudio: null,
        screenVideo: null,
      },
    }
  }
}

/**
 * Factory injected on native via `setVoiceMediaManagerFactory`. Returns an audio-only MediaManager instance.
 * Typed `unknown` to match the seam in pipecat.ts (which does `mediaManager: mediaManagerFactory()`), keeping
 * the transport's nominal types out of the shared voice module.
 */
export function createVoiceMediaManager(): unknown {
  return new VoxiAudioMediaManager()
}
