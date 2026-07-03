/**
 * Deterministic proof that RevealAudioController eliminates the reveal-audio race
 * (RCA: docs/RCA-reveal-audio-avfoundation.md). No RN runtime — an injected mock player records the exact
 * call order, mirroring scratchpad/race-demo.ts but as a durable regression guard.
 *
 * The bug was: on speak-aloud-open two effects raced the singleton player → play() on an empty queue + a
 * double play()/configureAudioSession → AVFoundation -11800 / kCMBaseObjectError_ParamErr -12780.
 * These tests pin the invariants that make that impossible: one serial chain, one play, no play-before-add,
 * supersede-before-touch, graceful error degrade.
 */
import { test, expect, describe } from 'bun:test'
import { createRevealAudioController, type AudioPlayer } from './revealAudioController'

function makeMock() {
  const log: string[] = []
  const player: AudioPlayer = {
    setup: async () => void log.push('setup'),
    reset: async () => void log.push('reset'),
    add: async (url) => void log.push(`add:${url}`),
    play: async () => void log.push('play'),
    pause: async () => void log.push('pause'),
    seekTo: async (s) => void log.push(`seekTo:${s}`),
  }
  return { log, player }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('RevealAudioController — serialization kills the -11800/-12780 race', () => {
  test('load(playing=true) issues ONE serial ensureSession→resolve→reset→add→seek→play (no play-before-add)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({
      player,
      resolveUrl: async () => { log.push('resolve'); return 'file:///narration.mp3' },
      ensurePlaybackSession: async () => void log.push('ensureSession'),
    })
    c.update({ src: 'data:AAA', playing: true, seekToStart: true })
    await c.settled()
    expect(log).toEqual(['setup', 'ensureSession', 'resolve', 'reset', 'add:file:///narration.mp3', 'seekTo:0', 'play'])
    expect(log.filter((x) => x === 'play')).toHaveLength(1) // exactly one play — no double play()/configureAudioSession churn
    expect(log.indexOf('play')).toBeGreaterThan(log.indexOf('add:file:///narration.mp3')) // never play-on-empty-queue
  })

  test('rapid bucket switch: a newer src supersedes synchronously; the stale load never touches the player or does I/O', async () => {
    const { log, player } = makeMock()
    let resolves = 0
    const c = createRevealAudioController({ player, resolveUrl: async (s) => { resolves++; await tick(); return `${s}.mp3` } })
    c.update({ src: 'A', playing: true })
    c.update({ src: 'B', playing: true }) // supersede before the chain runs
    await c.settled()
    expect(log.filter((x) => x.startsWith('add:'))).toEqual(['add:B.mp3'])
    expect(log).not.toContain('add:A.mp3')
    expect(resolves).toBe(1) // the stale load bailed before resolveUrl — no wasted I/O
  })

  test('supersede DURING resolveUrl I/O: stale load bails after I/O, before reset/add', async () => {
    const { log, player } = makeMock()
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })
    const c = createRevealAudioController({
      player,
      resolveUrl: async (src) => { if (src === 'A') await gateA; return `${src}.mp3` },
    })
    c.update({ src: 'A', playing: true })
    await tick() // let A's load reach resolveUrl and block
    c.update({ src: 'B', playing: true }) // supersede while A is mid-I/O
    releaseA() // A resumes → must bail on the post-I/O generation check
    await c.settled()
    expect(log).not.toContain('add:A.mp3')
    expect(log).toContain('add:B.mp3')
  })

  test('playing=false at mount loads but NEVER calls play (the control that must not error)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: false, seekToStart: true })
    await c.settled()
    expect(log).toEqual(['setup', 'reset', 'add:A.mp3'])
    expect(log).not.toContain('play')
  })

  test('a resolveUrl failure degrades via onError and does not wedge the chain', async () => {
    const { log, player } = makeMock()
    const errs: string[] = []
    let fail = true
    const c = createRevealAudioController({
      player,
      resolveUrl: async (s) => { if (fail) throw new Error('io'); return `${s}.mp3` },
      onError: (stage) => errs.push(stage),
    })
    c.update({ src: 'A', playing: true })
    await c.settled()
    expect(errs).toEqual(['load'])
    expect(log).not.toContain('reset') // failed before touching the player
    fail = false
    c.update({ src: 'B', playing: true }) // chain still usable
    await c.settled()
    expect(log).toContain('add:B.mp3')
  })

  test('toggling playing on the same src applies play/pause WITHOUT reloading', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true })
    await c.settled()
    const afterLoad = log.length
    c.update({ src: 'A', playing: false })
    await c.settled()
    c.update({ src: 'A', playing: true })
    await c.settled()
    expect(log.slice(afterLoad)).toEqual(['pause', 'play'])
    expect(log.filter((x) => x === 'reset')).toHaveLength(1) // no extra reset/add from toggles
    expect(log.filter((x) => x.startsWith('add:'))).toHaveLength(1)
  })

  test('stopIfCurrent only stops when still on that src (cross-screen safety on the shared singleton)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true }); await c.settled()
    c.update({ src: 'B', playing: true }); await c.settled() // B (e.g. podcast) took over the singleton
    const n = log.length
    c.stopIfCurrent('A') // A's element unmounts, but B is active — must NOT pause B
    await c.settled()
    expect(log.length).toBe(n)
    c.stopIfCurrent('B') // B's element unmounts while B is active — pauses
    await c.settled()
    expect(log).toContain('pause')
  })

  // ── Adversarial-review regressions (double-play + failed-load wrong-bucket) ──────────────────────────────
  test('REGRESSION: play toggled true DURING the load I/O issues exactly ONE play + ONE seekTo (no double-play churn)', async () => {
    const { log, player } = makeMock()
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })
    const c = createRevealAudioController({ player, resolveUrl: async (s) => { if (s === 'A') await gateA; return `${s}.mp3` } })
    c.update({ src: 'A', playing: false, seekToStart: true }) // mounts not playing; load starts, blocks in resolveUrl
    await tick()
    c.update({ src: 'A', playing: true, seekToStart: true }) // the "Hear it" tap DURING the load (NO settled() between)
    releaseA()
    await c.settled()
    expect(log.filter((x) => x === 'play')).toHaveLength(1) // exactly one play — the -11800/-12780 double-play cannot form
    expect(log.filter((x) => x === 'seekTo:0')).toHaveLength(1)
  })

  test('REGRESSION: a failed load never plays the previous bucket (wrong-audio)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({
      player,
      resolveUrl: async (s) => { if (s === 'B') throw new Error('io'); return `${s}.mp3` },
      onError: () => {},
    })
    c.update({ src: 'A', playing: true }); await c.settled() // A loads + plays
    const nA = log.length
    c.update({ src: 'B', playing: false }); await c.settled() // B's load FAILS (resolveUrl throws before reset)
    c.update({ src: 'B', playing: true }); await c.settled() // tap play on B — must NOT play A's audio
    expect(log.slice(nA).filter((x) => x === 'play')).toHaveLength(0)
    expect(log).not.toContain('add:B.mp3')
  })

  test('REGRESSION: first load fails then a play tap does not play an empty queue', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async () => { throw new Error('io') }, onError: () => {} })
    c.update({ src: 'A', playing: false }); await c.settled() // load fails, nothing added
    c.update({ src: 'A', playing: true }); await c.settled() // tap play
    expect(log).not.toContain('play') // loadedSrc(undefined) !== targetSrc('A') → guard blocks the empty-queue play
  })

  test('REGRESSION (R2): supersede DURING reset() bails — stale bucket never added or played (post-resolveUrl window)', async () => {
    const log: string[] = []
    let releaseReset!: () => void
    const gate = new Promise<void>((r) => { releaseReset = r })
    let firstReset = true
    const player: AudioPlayer = {
      setup: async () => void log.push('setup'),
      reset: async () => { log.push('reset'); if (firstReset) { firstReset = false; await gate } },
      add: async (u) => void log.push(`add:${u}`),
      play: async () => void log.push('play'),
      pause: async () => void log.push('pause'),
      seekTo: async (s) => void log.push(`seekTo:${s}`),
    }
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true })
    await tick() // A's load: setup→resolve→reset (blocks in gate)
    c.update({ src: 'B', playing: true }) // rapid switch while A's reset() is in flight
    releaseReset()
    await c.settled()
    expect(log).not.toContain('add:A.mp3') // stale A never added
    expect(log.filter((x) => x.startsWith('add:'))).toEqual(['add:B.mp3'])
    expect(log.filter((x) => x === 'play')).toHaveLength(1) // only B plays
  })

  test('REGRESSION (R2): a Stop landing during the load\'s own play() await is honored, not dropped', async () => {
    const log: string[] = []
    let releasePlay!: () => void
    const gate = new Promise<void>((r) => { releasePlay = r })
    let firstPlay = true
    const player: AudioPlayer = {
      setup: async () => void log.push('setup'),
      reset: async () => void log.push('reset'),
      add: async (u) => void log.push(`add:${u}`),
      play: async () => { log.push('play'); if (firstPlay) { firstPlay = false; await gate } },
      pause: async () => void log.push('pause'),
      seekTo: async (s) => void log.push(`seekTo:${s}`),
    }
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true, seekToStart: true }) // autoplay
    await tick() // load reaches play() and blocks in gate
    c.update({ src: 'A', playing: false }) // Stop tap during the play() await
    releasePlay()
    await c.settled()
    expect(log).toContain('pause') // the stop was reconciled
    expect(log[log.length - 1]).toBe('pause') // ends paused
  })

  test('REGRESSION (R3): a re-play landing during the reconcile pause() await is honored (last-writer-wins, ends playing)', async () => {
    const log: string[] = []
    let releasePlay!: () => void, releasePause!: () => void
    const playGate = new Promise<void>((r) => { releasePlay = r })
    const pauseGate = new Promise<void>((r) => { releasePause = r })
    let firstPlay = true, firstPause = true
    const player: AudioPlayer = {
      setup: async () => void log.push('setup'),
      reset: async () => void log.push('reset'),
      add: async (u) => void log.push(`add:${u}`),
      play: async () => { log.push('play'); if (firstPlay) { firstPlay = false; await playGate } },
      pause: async () => { log.push('pause'); if (firstPause) { firstPause = false; await pauseGate } },
      seekTo: async (s) => void log.push(`seekTo:${s}`),
    }
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true, seekToStart: true }) // autoplay → play() blocks
    await tick()
    c.update({ src: 'A', playing: false }) // Stop during play() await
    releasePlay() // play resolves → reconcile issues pause() which blocks
    await tick()
    c.update({ src: 'A', playing: true }) // re-play during the pause() await — the R3 drop
    releasePause()
    await c.settled()
    expect(log[log.length - 1]).toBe('play') // last intent (play) wins; audio ends playing, button not stuck
  })

  test('stop() pauses + detaches; further updates are ignored', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true })
    await c.settled()
    c.stop()
    await c.settled()
    expect(log).toContain('pause')
    const n = log.length
    c.update({ src: 'B', playing: true })
    await c.settled()
    expect(log.length).toBe(n)
  })
})

// ── seek() — the Deep Dive scrubber + ±15 client path (the native half of the seek RCA) ──────────────────────
// The scrubber (onSeek → seekTo) and ±15 (seekBy → seek) both route through controller.seek(). These pin that
// a loaded episode actually seeks, and that a seek can never fire on an unloaded / stale / wrong bucket (which
// would seek the wrong or an empty queue). The SERVER-side 206 fix makes the platform honor these seeks; this
// proves the JS chain that issues them is correct without a device.
describe('RevealAudioController — seek (Deep Dive scrubber + ±15)', () => {
  test('seek(s) on a loaded episode calls player.seekTo(s) exactly once', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true })
    await c.settled()
    const n = log.length
    c.seek(42)
    await c.settled()
    expect(log.slice(n)).toEqual(['seekTo:42'])
  })

  test('seek clamps a negative target to 0 (a −15 back-skip from near the start)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true }); await c.settled()
    const n = log.length
    c.seek(-15)
    await c.settled()
    expect(log.slice(n)).toEqual(['seekTo:0'])
  })

  test('seek ignores a non-finite target (never enqueues a bad seekTo)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true }); await c.settled()
    const n = log.length
    c.seek(Number.NaN)
    c.seek(Number.POSITIVE_INFINITY)
    await c.settled()
    expect(log.slice(n)).toEqual([])
  })

  test('seek before anything is loaded is DROPPED (no seek on an empty queue)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.seek(30)
    await c.settled()
    expect(log.filter((x) => x.startsWith('seekTo'))).toEqual([])
  })

  test('seek after a FAILED load is DROPPED (never seeks the previous/empty bucket)', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async () => { throw new Error('io') }, onError: () => {} })
    c.update({ src: 'A', playing: false }); await c.settled() // load fails → loadedSrc stays undefined
    c.seek(20)
    await c.settled()
    expect(log.filter((x) => x.startsWith('seekTo'))).toEqual([])
  })

  test('after a bucket switch, a seek only ever targets the CURRENT loaded episode', async () => {
    const { log, player } = makeMock()
    const c = createRevealAudioController({ player, resolveUrl: async (s) => `${s}.mp3` })
    c.update({ src: 'A', playing: true }); await c.settled()
    c.update({ src: 'B', playing: true }); await c.settled() // B (a different episode) takes the singleton
    const n = log.length
    c.seek(12)
    await c.settled()
    // one seekTo, and it ran while B was loaded — it can never have addressed A's timeline
    expect(log.slice(n)).toEqual(['seekTo:12'])
    expect(log.filter((x) => x.startsWith('add:'))).toEqual(['add:A.mp3', 'add:B.mp3'])
  })
})
