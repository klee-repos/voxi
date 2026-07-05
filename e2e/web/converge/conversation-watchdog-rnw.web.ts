/**
 * conversation-watchdog-rnw.web.ts — CONVERGENCE PROOF for the F3 watchdog→keyboard fallback (Bug B mitigation).
 *
 * Bug B (device-gated RCA): on a real device the WebRTC peer establishes but the RTVI data channel + audio track
 * never deliver → the bot idle-times out + the client 20s connect watchdog fires → "failed" UI. The web harness
 * has no real WebRTC media plane, so this is reproduced via TWO sanctioned test seams (the codebase already uses
 * the __voxiListThreadsGets / __deepDiveTest pattern):
 *   1. `__voxiHangVoiceConnect` (pipecat.ts) — the stub's connect() NEVER fires onConnected (Bug B) + disconnect()
 *      fires 'transport_closed' (the REAL transport's reason, pipecat.ts:185) so the override guard is exercised.
 *   2. `__voxiWatchdogMs` (conversation.tsx) — shortens the 20s watchdog to 1s so the proof runs in seconds.
 *
 * Plus `voiceServerBaseUrl` (HarnessOpts) so the BFF /v1/voice/session mint SUCCEEDS (returns a connectUrl) instead
 * of 503ing — the stub transport is used (the real transport is null on web), and the stub never fetches the URL,
 * so any non-empty base is fine; what matters is the screen reaches connect() with a non-null session.
 *
 * What it proves (the F3 state machine, end-to-end on the REAL conversation screen):
 *  1. The watchdog fires (1s, no onConnected) → the screen falls back to KEYBOARD (conversation.textInput present)
 *     — NOT the dead "I've lost the thread" error block. This is Bug B's mitigation: the user gets a working text
 *     chat instead of a dead failed screen.
 *  2. The override guard works: the watchdog's s.disconnect() fires onDisconnected('transport_closed') AFTER the
 *     watchdog set conn='connected'; the guard (watchdogFallbackRef) stops that late callback from re-erroring.
 *     Proven by asserting the error block stays ABSENT after the disconnect lands.
 *  3. setVoiceUnavailable(true) hides the "Use voice" toggle (conversation.keyboardToggle absent) — the dead
 *     session can't be re-entered.
 *
 * Red/green: with F3 reverted (watchdog → setConn('error')), the error block WOULD appear instead of the keyboard.
 *
 * Run: `bun e2e/web/converge/conversation-watchdog-rnw.web.ts`  (exit 0 = F3 proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const rig = await standUp(
  'conversation-client.tsx',
  {
    seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } },
    chatFixture: { threadId: 'thr_converge', userId: 'converge', title: 'Converge Object', fact: 'Made in Pennsylvania.' },
    // Mount the voice sub-app so /v1/voice/session mint SUCCEEDS (returns a connectUrl). The stub transport is
    // used on web; the stub never fetches this URL, so any non-empty base is fine — what matters is the screen
    // reaches connect() with a non-null session so the watchdog arms.
    livekit: true,
  },
)
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

// Inject the two test seams BEFORE the page loads (addInitScript runs on every new document, before any script).
// The fetch-shim init script standUp already added runs first; ours runs after, both before the bundle.
await page.addInitScript(() => {
  ;(globalThis as unknown as { __voxiHangVoiceConnect?: boolean }).__voxiHangVoiceConnect = true
  ;(globalThis as unknown as { __voxiWatchdogMs?: number }).__voxiWatchdogMs = 1000
})

console.log('\nconverge: REAL app/app/conversation.tsx — F3 watchdog→keyboard fallback (Bug B mitigation):')
await page.goto(`${rig.base}/`)

// The screen mounts + mints a voice session (succeeds, voiceServerBaseUrl set) + calls connect() → the stub hangs
// (no onConnected) → the 1s watchdog fires → keyboard fallback.
await check('real conversation surface renders its container (the mint succeeded + connect() ran)', () =>
  d.waitFor(ids.conversation.orb, { timeoutMs: 8000 }),
)

// F3 core proof: the watchdog fired → keyboard fallback landed. The text input MUST be present (the user has a
// working text chat path — /v1/threads/:id/ask is independent of WebRTC). With F3 reverted, this would NOT appear
// (the watchdog would set conn='error' → the error block renders instead).
await check('F3: watchdog fired → keyboard fallback (conversation.textInput present, NOT the error block)', async () => {
  const deadline = Date.now() + 4000 // watchdog is 1s; allow buffer for the disconnect + state settle
  let txtVisible = false
  while (Date.now() < deadline) {
    const txt = await d.state(ids.conversation.textInput)
    if (txt.visible) { txtVisible = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!txtVisible) throw new Error('keyboard fallback never landed — the watchdog did not fire or F3 is missing')
})

// F3 override guard proof: the watchdog's s.disconnect() fires onDisconnected('transport_closed') AFTER the
// watchdog set conn='connected'. The watchdogFallbackRef guard must stop that late callback from re-erroring.
// Proven by asserting the error block ("I've lost the thread") is ABSENT after the disconnect lands. With the
// guard removed, the late onDisconnected would setConn('error') and the error block would appear.
await check('F3 override guard: the late onDisconnected did NOT re-error (error block ABSENT)', async () => {
  // Give the disconnect's onDisconnected time to land (it fires async after s.disconnect() resolves).
  await new Promise((r) => setTimeout(r, 800))
  const err = await d.state(ids.conversation.micButton) // the Reconnect button lives INSIDE the error block
  if (err.attrs?.['aria-label'] === 'Reconnect' || err.text === 'Reconnect') {
    throw new Error('the error block rendered — the override guard failed; the late onDisconnected re-errored')
  }
  // The error block also surfaces the "I've lost the thread" text; assert it is not in the transcript surface.
  const body = await page.evaluate(() => document.body.innerText ?? '')
  if (body.includes("I've lost the thread")) {
    throw new Error('the error block text rendered — the override guard failed')
  }
})

// F3: setVoiceUnavailable(true) hides the "Use voice" toggle — the dead session can't be re-entered.
await check('F3: setVoiceUnavailable hid the "Use voice" toggle (keyboardToggle ABSENT)', async () => {
  const toggle = await d.state(ids.conversation.keyboardToggle)
  if (toggle.visible) throw new Error('keyboardToggle is visible — setVoiceUnavailable did not hide it')
})

await check('no uncaught errors while the watchdog fallback ran', () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — F3 watchdog→keyboard fallback + override guard work on the REAL conversation screen'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)