/**
 * RevealAudioController — serializes ALL access to the process-global native player so the reveal narration
 * can never race itself.
 *
 * ── Why this exists (RCA: docs/RCA-reveal-audio-avfoundation.md) ─────────────────────────────────────────
 * The old AudioElement.native.tsx drove react-native-track-player (a singleton) from THREE independent async
 * React effects. On reveal speak-aloud-open, `playing` is already true when the element mounts, so the
 * `[src]` effect (resolveUrl → reset → add → play, gated behind file I/O) and the `[playing]` effect
 * (seekTo(0) → play, zero I/O) both fired in one commit. The I/O-free `[playing]` effect reached the player
 * FIRST, so `play()` ran on an empty queue and a SECOND `play()`/`playWhenReady` flip followed — driving
 * redundant AVAudioSession configureAudioSession/setCategory churn during one AVPlayerItem load. That churn
 * invalidated the loading CoreMedia "Fig" player → AVFoundationErrorDomain -11800 / kCMBaseObjectError_ParamErr
 * (-12780). Proven by scratchpad/race-demo.ts + a 6-agent adversarial RCA.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────────────────────────────────
 *   load(src) ─┐
 *              ├─► ONE serial chain ─► [supersede check] ─► ensurePlaybackSession ─► resolveUrl
 *   setPlaying ┘                        (gen counter)         (Part B: force .playback)   (slow I/O)
 *                                          │
 *                                          └─► reset ─► add ─► (if desiredPlaying: seekTo? ─► play ONCE)
 *
 * Every operation runs on a single promise chain (never concurrently). `play` is folded into the load and
 * issued exactly once, so RNTP's configureAudioSession runs once, not thrice. A newer `src` bumps a
 * generation counter; a superseded load bails BEFORE touching the player (no reset/add/play from a stale
 * load — this is the rapid-bucket-switch case). Pure: it imports nothing native and is unit-tested under bun
 * against an injected player (mirrors the pipecat.ts seam pattern).
 */

/** The subset of the native player the controller drives. Wired to react-native-track-player on device. */
export interface AudioPlayer {
  setup(): Promise<void>
  reset(): Promise<void>
  add(url: string): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seekTo(seconds: number): Promise<void>
}

export interface RevealAudioControllerDeps {
  player: AudioPlayer
  /** Resolve a playable URL for `src` (a `data:` URI → a cache-file `file://` URL on device). */
  resolveUrl: (src: string) => Promise<string>
  /** Part B (H_session): force the iOS AVAudioSession to a playback category before a load, so a session
   *  left in `.playAndRecord` by a prior WebRTC voice call can't invalidate the item. Optional / injected. */
  ensurePlaybackSession?: () => Promise<void>
  /** Loud, non-fatal error sink (a stray native failure degrades to "no audio", never an uncaught throw). */
  onError?: (stage: 'load' | 'apply' | 'stop', err: unknown) => void
}

export interface UpdateInput {
  /** The narration data URI, or undefined when the bucket's audio isn't ready / on unmount. */
  src: string | undefined
  playing: boolean
  seekToStart?: boolean
}

export interface RevealAudioController {
  /** Idempotent: call from ONE effect on [src, playing, seekToStart]. Serialized internally. */
  update(input: UpdateInput): void
  /** Unmount hook. Pause ONLY if the player is still on `src` — so one element leaving the screen can't
   *  pause another screen's audio on the shared singleton (reveal-narration vs podcast). */
  stopIfCurrent(src: string | undefined): void
  /** Permanent teardown (rarely needed for the shared singleton). */
  stop(): void
  /** Test seam: resolves when the internal chain drains. */
  settled(): Promise<void>
}

export function createRevealAudioController(deps: RevealAudioControllerDeps): RevealAudioController {
  const { player, resolveUrl, ensurePlaybackSession, onError } = deps

  let chain: Promise<void> = Promise.resolve()
  let generation = 0 // bumps on every src change → supersede in-flight loads
  let targetSrc: string | undefined // the src we are loading or have loaded
  let loadedSrc: string | undefined // the src actually add()ed to the player
  // The src of the load that currently OWNS "play". While set, that load will issue the single play itself; a
  // same-src play/pause toggle must NOT enqueue its own play (that second play is the -11800/-12780 churn).
  let loadingSrc: string | undefined
  let desiredPlaying = false
  let started = false
  let disposed = false

  const ensureSetup = async () => {
    if (!started) {
      started = true
      await player.setup()
    }
  }

  // Serialize: each op runs only after the previous settles (success OR failure), so the player is never
  // mutated by two ops at once. `.then(op, op)` keeps the chain alive even when an op rejects.
  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op, op)
  }

  const runLoad = async (src: string, myGen: number, seekToStart: boolean): Promise<void> => {
    if (disposed || myGen !== generation) return // superseded before we even started
    try {
      await ensureSetup()
      if (ensurePlaybackSession) await ensurePlaybackSession()
      const url = await resolveUrl(src) // the slow step; a newer src may supersede us here
      if (disposed || myGen !== generation) return // superseded during I/O → do NOT touch the player
      await player.reset()
      if (disposed || myGen !== generation) return // superseded during reset() → don't add/play the stale bucket
      await player.add(url)
      if (disposed || myGen !== generation) return // superseded during add() → don't play the stale bucket
      loadedSrc = src
      // This load owns play/pause for `src` until it releases loadingSrc (below), so update()'s same-src branch
      // returns without enqueuing. Apply the LATEST desiredPlaying and RE-READ it after each of our own awaits:
      // a toggle (Stop, or a re-play) that lands during our play()/pause() is honored — last-writer wins. Absent
      // a real user toggle this issues exactly one play(); a supersede bails without touching the stale bucket.
      let applied = false // the freshly-added item is not playing yet
      while (!disposed && myGen === generation && applied !== desiredPlaying) {
        if (desiredPlaying) {
          if (seekToStart) await player.seekTo(0)
          if (disposed || myGen !== generation) return // superseded during seek → don't play the stale bucket
          await player.play()
          applied = true
        } else {
          await player.pause()
          applied = false
        }
      }
    } catch (err) {
      onError?.('load', err)
    }
    // Release ownership of "play" (unless a newer load already took over) so future toggles apply directly.
    if (myGen === generation) loadingSrc = undefined
  }

  const applyPlaying = async (seekToStart: boolean): Promise<void> => {
    if (disposed) return
    try {
      if (desiredPlaying) {
        // Only play what is ACTUALLY loaded AND currently wanted. If a load failed (loadedSrc stale/undefined ≠
        // targetSrc) this refuses to play the previous bucket's audio or an empty queue.
        if (loadedSrc !== targetSrc) return
        if (seekToStart) await player.seekTo(0)
        await player.play()
      } else {
        await player.pause()
      }
    } catch (err) {
      onError?.('apply', err)
    }
  }

  const runStop = async (myGen: number): Promise<void> => {
    if (myGen !== generation) return // a newer update already took over
    loadedSrc = undefined
    try {
      await player.pause()
    } catch (err) {
      onError?.('stop', err)
    }
  }

  return {
    update({ src, playing, seekToStart = false }: UpdateInput): void {
      if (disposed) return
      desiredPlaying = playing
      if (src && src !== targetSrc) {
        // New source → serialized reload; bump generation so any in-flight load for the old src bails.
        targetSrc = src
        loadingSrc = src // this load owns "play" until it completes
        const myGen = ++generation
        enqueue(() => runLoad(src, myGen, seekToStart))
      } else if (!src) {
        // Source cleared (bucket not ready / navigating away) → stop, don't reload.
        targetSrc = undefined
        loadingSrc = undefined
        const myGen = ++generation
        enqueue(() => runStop(myGen))
      } else if (loadingSrc === src) {
        // Same source, but its load is still in flight → it will honor the (already-updated) desiredPlaying
        // itself. Enqueuing a play here would be the SECOND play/configureAudioSession flip → -11800/-12780.
        return
      } else {
        // Same source, load already settled → apply play/pause on the SAME serial chain.
        enqueue(() => applyPlaying(seekToStart))
      }
    },
    stopIfCurrent(src: string | undefined): void {
      if (disposed) return
      if (src !== undefined && src !== targetSrc) return // a newer source took over the shared player
      targetSrc = undefined
      loadingSrc = undefined
      const myGen = ++generation
      enqueue(() => runStop(myGen))
    },
    stop(): void {
      if (disposed) return
      disposed = true
      loadingSrc = undefined
      generation++
      enqueue(async () => {
        loadedSrc = undefined
        try {
          await player.pause()
        } catch (err) {
          onError?.('stop', err)
        }
      })
    },
    settled(): Promise<void> {
      return chain
    },
  }
}
