/**
 * conversation-rnw.web.ts — CONVERGENCE PROOF for app/app/conversation.tsx (WS1: grounded "Ask Voxi" chat).
 *
 * Renders the REAL Expo conversation screen (unmodified app source) under react-native-web in a real Chromium
 * via Playwright, driven through the framework PlaywrightDriver by the SAME testIDs the harness shell uses.
 *
 * What it proves (post-F1/F2):
 *  1. The screen mounts keyboard-FIRST — the push-to-talk mic affordance is ABSENT (voice is WS2; the stub no
 *     longer fakes voice turns) and the text input is present by default. (R1: the prior green proof asserted the
 *     stub's canned "hold to talk"/"here is what the guide has to say" strings; F2 rerouted keyboard through the
 *     real BFF, so those assertions are GONE and this is the rewrite.)
 *  2. A typed turn round-trips through the REAL `/ask` route (F1) into the REAL transcript surface: the harness
 *     FakeChat returns a unique sentinel `GUIDE_SENTINEL::<question>` and the runner matches it EXACTLY — never a
 *     loose regex a canned stub string could satisfy (F3-2: no fake green). The sentinel only arrives if the
 *     route is wired (ACL + grounded reveal fixture) AND the screen calls `api.ask` (F2) instead of the stub.
 *
 * The harness pre-seeds an owner-scoped thread + reveal for the fixture threadId `thr_converge` (the id
 * conversation-entry primes) so the route's fail-closed ACL + grounded-context checks pass for the signed-in
 * `converge` user — no synthetic stub of the route.
 *
 * Run: `bun e2e/web/converge/conversation-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const rig = await standUp('conversation-client.tsx', {
  // The converge auth-gate signs in as `converge@voxi.dev` → userId `converge`; seed it with voice minutes so
  // the /ask voice-min charge succeeds. The fixture primes the thread + reveal for that owner.
  seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } },
  chatFixture: { threadId: 'thr_converge', userId: 'converge', title: 'Converge Object', fact: 'Made in Pennsylvania.' },
})
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

console.log('\nconverge: REAL app/app/conversation.tsx — grounded /ask round-trip + keyboard-first surface (WS1):')
await page.goto(`${rig.base}/`)

// The full-screen voice surface container renders immediately.
await check('real conversation surface renders its container (data-testid from RNW testID)', () =>
  d.waitFor(ids.conversation.orb, { timeoutMs: 8000 }),
)

// WS1: keyboard is the conversation surface. Voice (push-to-talk) is OFF until WS2, so the mic affordance must be
// ABSENT (it was previously asserted PRESENT + "hold to talk" — F2 removed it). The text input is the default.
await check('web falls back to keyboard (the harness BFF mounts no /v1/voice route → mint 404 → keyboard-only)', async () => {
  const mic = await d.state(ids.conversation.micButton)
  if (mic.visible) throw new Error('mic must be absent on web — voice needs the native WebRTC transport (device-proven)')
  // The mint failed gracefully into the keyboard fallback, so the text input is present.
  await d.waitFor(ids.conversation.textInput, { timeoutMs: 4000 })
})
await check('no uncaught errors while mounting the real conversation tree', () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// The REAL /ask round-trip: type a question, send, and assert the EXACT sentinel from the harness FakeChat lands
// in the transcript surface. The sentinel is unique per question + could never be produced by a canned stub — so
// this greens ONLY when the real route (F1) + real screen wiring (F2) are both in place (F3-2: no fake green).
const question = 'where was it made?'
const sentinel = `GUIDE_SENTINEL::${question}`
await check('a typed turn round-trips through the REAL /ask route into the transcript (exact sentinel)', async () => {
  await d.type(ids.conversation.textInput, question)
  await d.tap(ids.conversation.sendBtn)
  const deadline = Date.now() + 6000
  let txt = ''
  while (Date.now() < deadline) {
    txt = (await d.state(ids.conversation.transcriptText)).text ?? ''
    if (txt.includes(sentinel)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('sentinel never reached the transcript; transcriptText=' + JSON.stringify(txt))
})
await check('the Voxi turn label surface (conversation.voxiTurn) is present in the transcript', () =>
  d.waitFor(ids.conversation.voxiTurn, { timeoutMs: 3000 }),
)

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — grounded Ask chat (F1 route + F2 screen wiring) works on the REAL conversation screen'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
