/**
 * conversation-rnw.web.ts — CONVERGENCE PROOF for app/app/conversation.tsx (companion to reveal-rnw.web.ts).
 *
 * Renders the REAL Expo conversation (full-screen voice) screen (unmodified app source, real ui.tsx primitives,
 * real Orb, the REAL pipecat voice seam's deterministic stub session, real Zustand capture store) under
 * react-native-web in a real Chromium via Playwright, driven through the framework PlaywrightDriver by the SAME
 * testIDs the harness shell uses. Proves the real screen connects, exposes its real push-to-talk + keyboard
 * affordances, and round-trips a real keyboard turn through the real session into the real transcript surface.
 * server.ts's harness conversation screen is swappable for it.
 *
 * Run: `bun e2e/web/converge/conversation-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const rig = await standUp('conversation-client.tsx')
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

console.log('\nconverge: REAL app/app/conversation.tsx under react-native-web (real pipecat stub session):')
await page.goto(`${rig.base}/`)

// The full-screen voice surface container renders immediately.
await check('real conversation surface renders its container (data-testid from RNW testID)', () =>
  d.waitFor(ids.conversation.orb, { timeoutMs: 8000 }),
)

// The stub session connects on mount: connecting → connected drives the orb from 'thinking' to 'idle' and the
// persistent live-mic indicator appears (only rendered while connected && !keyboard).
await check('the real orb settles to idle once the stub session connects (orbVisual carries orb.state)', async () => {
  const deadline = Date.now() + 6000
  let st = ''
  while (Date.now() < deadline) {
    st = (await d.state(ids.conversation.orbVisual)).attrs.state ?? ''
    if (st === 'idle') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('orbVisual state=' + JSON.stringify(st))
})
await check('persistent live-mic indicator renders once connected', () =>
  d.waitFor(ids.conversation.liveMicIndicator, { timeoutMs: 4000 }),
)
await check('connected state exposes the real push-to-talk mic affordance', async () => {
  const s = await d.state(ids.conversation.micButton)
  if (!/hold to talk/i.test(s.text ?? '')) throw new Error('micButton text=' + JSON.stringify(s.text))
})
await check('no uncaught errors while mounting the real conversation tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// Deterministic behavior 1: the keyboard toggle collapses the voice control to a real text thread (textInput +
// sendBtn appear; the contract ids for both reach the DOM).
await check('keyboard toggle reveals the real text input + send affordances', async () => {
  await d.tap(ids.conversation.keyboardToggle)
  await d.waitFor(ids.conversation.textInput, { timeoutMs: 3000 })
  await d.waitFor(ids.conversation.sendBtn, { timeoutMs: 3000 })
})

// Deterministic behavior 2: typing + send round-trips through the REAL stub session, which commits a user turn
// then a Voxi turn — the Voxi turn renders the real transcript surface (conversation.voxiTurn carries the label;
// its Body carries conversation.transcriptText with the stub's in-persona reply).
await check('a sent keyboard turn round-trips through the real session into the real transcript surface', async () => {
  await d.type(ids.conversation.textInput, 'What is this object?')
  await d.tap(ids.conversation.sendBtn)
  const deadline = Date.now() + 5000
  let txt = ''
  while (Date.now() < deadline) {
    const s = await d.state(ids.conversation.transcriptText)
    txt = s.text ?? ''
    // the real stub reply for a keyboard turn (pipecat.ts createStubVoiceSession.sendText)
    if (/here is what the guide has to say/i.test(txt)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('transcriptText=' + JSON.stringify(txt))
})
await check('the Voxi turn label surface (conversation.voxiTurn) is present in the transcript', () =>
  d.waitFor(ids.conversation.voxiTurn, { timeoutMs: 3000 }),
)

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — real conversation.tsx renders + is E2E-testable behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
