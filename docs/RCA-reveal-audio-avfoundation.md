# RCA — reveal narration `AVFoundationErrorDomain -11800 / OSStatus -12780` (native iOS)

**Status:** root cause proven to high confidence (static + native-source + adversarial + deterministic dynamic
proof); on-device before/after capstone pending a fresh build. **Severity:** narration playback fails on the
reveal screen (degrades to "no audio", never red-screens). **Not** caused by the ElevenLabs voice change
(voice-independent — the mp3 is valid and the error reproduced on the prior voice).

## Symptom
`ERROR [unknown/unknown: Error Domain=AVFoundationErrorDomain Code=-11800 "The operation could not be
completed" UserInfo={NSLocalizedFailureReason=An unknown error occurred (-12780), NSUnderlyingError=…
{Error Domain=NSOSStatusErrorDomain Code=-12780}}]`, ~2× around reveal narration playback. Device: iPhone,
iOS 26.5.

## The trace — every hop verified

| # | Claim | How verified |
|---|---|---|
| 1 | `-11800` = `AVErrorUnknown` (generic; no signal) | iPhoneOS26.2 SDK `AVError.h:34` |
| 2 | `-12780` = `kCMBaseObjectError_ParamErr` (CoreMedia/MediaToolbox "Fig" player) = "media pipeline handed an invalid parameter/asset". Local, **not** network (`NSOSStatusErrorDomain`, not `NSURLErrorDomain`) | Full iOS+macOS SDK header sweep (no public `-12780`; internal SPI) + web research inferring from header-confirmed neighbor `-12785=kCMBaseObjectError_Invalidated` (fwd 682278). *Caveat: ParamErr-vs-Invalidated is an SPI inference, not decisive.* |
| 3 | Audio content is fine (rules out codec `-11828/-11829`) | `bun spikes/live-tts.ts` + `ffprobe`: valid ID3v2.4 / MPEG-1 L3 / 128k / 44.1k mono |
| 4 | Genuine `AVPlayerItem` failure, forwarded **code-less** → logs as `[unknown/unknown:]` | SwiftAudioEx `AVPlayerWrapper.swift:460-467` reads raw `item.error`; RNTP `RNTrackPlayer.swift:837-839` emits `PlaybackError {"error": localizedDescription}` only |
| 5 | On reveal, ONE `AudioElement` drives the **process-global** singleton `TrackPlayer` | `RevealDock.tsx:340`, `AudioElement.native.tsx:13,27` |
| 6 | On speak-aloud-open, `playing` is already `true` at mount and `seekToStartOnPlay` is set → **both** effects fire in one commit | `reveal.tsx:285`, `RevealDock.tsx:340` |
| 7 | The `[playing]` effect (`seekTo(0)+play()`, **no I/O**) reaches the singleton before the `[src]` effect (`resolveUrl→reset→add→play`, gated behind async file I/O) → **play-on-empty-queue + double `play()`** | `AudioElement.native.tsx:66-103` (no `cancelled` guard between 75/76/78; effects unsynchronized) |
| 8 | Each `play()`/`playWhenReady` flip re-runs RNTP `configureAudioSession` (`setCategory`/`setActive`) → **redundant session-activation churn during one item load** → invalidates the loading Fig player → `-11800/-12780` | `RNTrackPlayer.swift:25,295-311,865,916`; deterministic demo (below) |

**Deterministic dynamic proof** (`scratchpad/race-demo.ts`, exit 0): faithfully simulating the two effects vs a
mock player that models `configureAudioSession` → current code: **2 plays, play-on-empty-queue, 3 session
state changes** during one load; serialized fix: **1 play, no play-before-add**.

## Adversarial adjudication (6-agent workflow)
- **Primary — H_race (session-activation form): posterior 0.55.** Unconditionally present in the exact cold-reveal
  speak-aloud flow. The fix must **collapse the redundant `play()`/`configureAudioSession`**, not merely add a mutex
  (RNTP marshals *item* ops on a serial queue; the damage is *session* churn).
- **H_session: 0.14 — separate latent bug, fix regardless.** Nothing restores `.playback` after Daily forces
  `playAndRecord` (`WebRTCModule+DailyDevicesManager.m:225`; `voiceMediaManager.native.ts:137-155`,
  `pipecat.ts:209-210`). A reveal *after* a voice call is a live crash risk — but not this cold-reveal signature.
- **H_staleBinary: 0.13 — exclude first.** Device build frozen Jul 1; reveal/audio rewritten Jul 2 (`f14bf27`).
  Causally empty, but the capstone must run on a fresh HEAD build.
- **H_url: 0.05 — refuted.** No `[speech] native audio load failed` warn ⇒ `cacheDirectory` non-null ⇒ valid
  `file://`; a bad file yields a different code/domain. (The length-only cache key `voxi-narration-${b64.length}.mp3`
  is a real smell — wrong-audio/collision risk — but not this `-12780`.)

## Fix plan

### Part A — serialize + collapse (primary; `AudioElement.native.tsx`)
1. Replace the three independent effects with **one serialized command chain** on the singleton: `load(src, playing, seek)` and `setPlaying(playing)` never run concurrently.
2. **Fold `play` into the load**: after `reset→add`, read the *latest* `playing` and issue a single `play()` (with optional leading `seekTo(0)`). Remove the separate `[playing]`-effect `seekTo/play` path → no second play racing the load.
3. **Supersede**: a generation counter cancels a stale load when a newer `src` arrives (rapid bucket switch) — no `reset/add/play` from a superseded load.
4. **Single session assertion**: one `play()`/`playWhenReady` flip per open ⇒ `configureAudioSession` runs once.
5. Extract the chain into a **pure, injected-player module** (`revealAudioController`) so it is unit-tested deterministically with no RN runtime.
6. Add an `Event.PlaybackError` listener that logs structured + resets UI state (a stray native error never surfaces as an uncaught red `ERROR`, button never sticks).

### Part B — restore the audio session after voice (latent H_session; recommended, scoped separately)
- Force a playback-capable `AVAudioSession` before narration and/or on voice disconnect. Candidate mechanisms
  (decide in review): `expo-audio` `setAudioModeAsync` (JS API, needs the dep), a ~6-line Expo native helper
  `setPlaybackAudioSession()`, or restoring category in `voiceMediaManager.disconnect`. Requires a native rebuild.

### Verification
1. **Unit (deterministic):** `revealAudioController` — serial ops, single play, no play-before-add, supersede cancels stale. `bun test`.
2. **e2e agentic (web):** reveal-audio UX regression (open bucket→plays, switch, replay). *Guards the contract; cannot exercise the native path (web = DOM `<audio>`).*
3. **Device capstone:** fresh HEAD build (excludes H_staleBinary) + JS instrumentation → reproduce `-12780` (before) → apply fix → confirm gone with the instrumented `seq` showing no effect overlap. Needs device UI driving.

## Implemented (branch fix/reveal-audio-avfoundation)
- `app/src/lib/revealAudioController.ts` — the pure serialized controller (fold-play-into-load, generation supersede, `stopIfCurrent`, `ensurePlaybackSession` hook).
- `app/src/lib/revealAudioController.test.ts` — 8 deterministic tests.
- `app/src/components/AudioElement.native.tsx` — thin wrapper: one drive effect, stable listeners, module-once `PlaybackError` recovery, FNV-1a cache key (was length-only), lazy-guarded `expo-audio`.
- `app/src/lib/voiceMediaManager.native.ts` — `disconnect()` restores `.playback` (Part B root-cause site) via lazy `expo-audio`.
- `expo-audio@57.0.0` added (native rebuild activates Part B).

## Verification results
- ✅ **Controller unit tests: 13/13.** Adversarial review hardened the fix across rounds:
  - **R1** confirmed 2 real defects → fixed: (P1) `play` toggled true during the load's I/O enqueued a 2nd play; (P2) a failed load could play the wrong bucket / empty queue. Guard: `loadingSrc` play-ownership + `applyPlaying` requires `loadedSrc === targetSrc`.
  - **R2** confirmed 2 more → fixed: (P1) supersede in the `reset()/add()` window still added+played the stale bucket (gen guard only ran pre-`reset`); (P3) a Stop during the load's own `play()` await was dropped. Guard: gen re-checks after every native await + a `didPlay` reconcile pause.
  - Each defect has a dedicated regression test (toggle-during-load, failed-load-wrong-bucket, supersede-during-reset, dropped-Stop).
  - **R3** convergence round: in progress.
- ✅ **Full repo suite: 442/442.**
- ✅ **e2e agentic (web), all 5 runners GREEN** — auth, collection, reveal (incl. bucket audio `/speech` round-trip + playback), swipe, sweep. Regression guard: the native-only change did not disturb the shared reveal wiring. (Web uses DOM `<audio>`, so it cannot exercise the native path.)
- ✅ **Part A live on device** via Metro fast-refresh against the current binary (expo-audio lazy no-op); clean re-bundle, and **zero `-11800/-12780` signatures** in the device log since the fix loaded (suggestive, pending an explicit speak-aloud repro).
- ⏳ Adversarial implementation review (workflow) — in progress.
- ⏳ Device rebuild capstone (activates Part B + excludes H_staleBinary; before/after `-12780` needs a device tap).
