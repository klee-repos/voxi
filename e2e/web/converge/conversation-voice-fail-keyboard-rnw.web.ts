/**
 * conversation-voice-fail-keyboard-rnw.web.ts — the Ask lifecycle a real user hits when voice is broken.
 *
 * The two existing converge tests each prove ONE half:
 *   - conversation-rnw.web.ts: keyboard /ask sentinel round-trip (voice never attempted — no voiceServerBaseUrl)
 *   - conversation-watchdog-rnw.web.ts: the F3 watchdog→keyboard fallback (stops at "the keyboard input EXISTS")
 *
 * Neither proves the COMPOSITION that matters on a device where voice is broken: voice is attempted, HANGS
 * (Bug B: WebRTC peer up but RTVI never delivers), the 20s watchdog fires, the screen falls back to keyboard —
 * AND a typed turn STILL round-trips through the REAL /ask route into the transcript. That last step is the
 * observable neither existing test covers: the keyboard is not merely PRESENT after voice fails, it WORKS
 * (the user can actually Ask). This is the actual user story for "Ask is broken" → the rescue path.
 *
 * SANCTIONED SEAMS (the codebase already uses this pattern — __voxiListThreadsGets / __deepDiveTest):
 *   - __voxiHangVoiceConnect (pipecat.ts): the stub's connect() never fires onConnected (Bug B) + disconnect()
 *     fires 'transport_closed' async so the F3 override guard is exercised. Reproduces a REAL failure mode.
 *   - __voxiWatchdogMs (conversation.tsx): shortens the 20s watchdog to 1s so the proof runs in seconds.
 *   - voiceServerBaseUrl (HarnessOpts): the BFF /v1/voice/session mint SUCCEEDS (returns a connectUrl) so the
 *     screen reaches connect() with a non-null session — voice is genuinely ATTEMPTED, not skipped.
 *
 * HARD RULE (test-integrity): this test MUST NOT assert on `conn` / `liveMicIndicator` / voice-connected state —
 * the watchdog's intentional `setConn('connected')` lie is NOT voice working. Deterministic testID verdicts +
 * the EXACT /ask sentinel only (never a loose string a canned stub could satisfy). The web harness has no real
 * WebRTC media plane, so voice-on-device stays device-gated (F5) — this test proves the keyboard RESCUE.
 *
 * Run: `bun e2e/web/converge/conversation-voice-fail-keyboard-rnw.web.ts`  (exit 0 = GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const rig = await standUp(
  'conversation-client.tsx',
  {
    seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } },
    // Seed an owner-scoped thread + reveal so the /ask ACL + grounded-context checks pass for `converge`.
    chatFixture: { threadId: 'thr_converge', userId: 'converge', title: 'Converge Object', fact: 'Made in Pennsylvania.' },
    // Mount the voice sub-app so the mint SUCCEEDS — voice is genuinely attempted (then hangs via the seam).
    voiceServerBaseUrl: 'http://localhost:7071',
  },
)
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

// Inject the seams BEFORE the page loads. The stub transport is used on web (real transport is null); the stub
// never fetches the connectUrl, so the base value only matters insofar as the mint succeeds + connect() runs.
await page.addInitScript(() => {
  ;(globalThis as unknown as { __voxiHangVoiceConnect?: boolean }).__voxiHangVoiceConnect = true
  ;(globalThis as unknown as { __voxiWatchdogMs?: number }).__voxiWatchdogMs = 1000
})

console.log('\nconverge: REAL conversation.tsx — voice fails (Bug B) → watchdog → keyboard STILL works end-to-end:')
await page.goto(`${rig.base}/`)

// The screen mounts, mints a voice session (succeeds), calls connect() → the stub hangs → the 1s watchdog fires.
await check('real conversation surface renders (mint succeeded + connect() ran)', () =>
  d.waitFor(ids.conversation.orb, { timeoutMs: 8000 }),
)

// Step 1 — voice was attempted and HUNG: the watchdog fired → keyboard fallback landed. The text input is the
// observable (NOT conn/liveMicIndicator — the watchdog's setConn('connected') is the intentional keyboard lie).
// This overlaps the watchdog test on purpose: it is the SETUP for the novel step 2 assertion below.
await check('voice hung (Bug B) → watchdog fired → keyboard fallback landed (textInput present)', async () => {
  const deadline = Date.now() + 4000 // watchdog is 1s; allow buffer for the disconnect + state settle
  while (Date.now() < deadline) {
    const txt = await d.state(ids.conversation.textInput)
    if (txt.visible) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('keyboard fallback never landed — the watchdog did not fire')
})

// Step 2 — THE NOVEL OBSERVABLE: after voice failed + the watchdog fell back to keyboard, a typed turn STILL
// round-trips through the REAL /ask route. The exact sentinel only the harness FakeChat emits (GUIDE_SENTINEL::<q>)
// proves the keyboard is USABLE post-fallback, not merely present. This is what neither existing test covers.
const question = 'where was it made?'
const sentinel = `GUIDE_SENTINEL::${question}`
await check('after voice failed, the keyboard /ask path STILL works (exact sentinel reaches the transcript)', async () => {
  await d.type(ids.conversation.textInput, question)
  await d.tap(ids.conversation.sendBtn)
  const deadline = Date.now() + 6000
  let txt = ''
  while (Date.now() < deadline) {
    txt = (await d.state(ids.conversation.transcriptText)).text ?? ''
    if (txt.includes(sentinel)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('sentinel never reached the transcript post-fallback; transcriptText=' + JSON.stringify(txt))
})

await check('the Voxi turn surface (conversation.voxiTurn) rendered for the reply', () =>
  d.waitFor(ids.conversation.voxiTurn, { timeoutMs: 3000 }),
)

await check('no uncaught errors across the voice-fail → keyboard lifecycle', () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — voice fail (Bug B) → watchdog fallback → keyboard /ask STILL works on the REAL screen'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
