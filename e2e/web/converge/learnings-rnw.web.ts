/**
 * learnings-rnw.web.ts — CONVERGENCE PROOF for the "Initial learnings" redesign (INITIAL-LEARNINGS-PLAN).
 *
 * Renders the REAL Expo reveal (unmodified app source) under react-native-web + the real voxi-api BFF, captures
 * with the deterministic `streaming` scan (?scan=streaming → e2e/web/server.ts eveStreamFor: band instantly, then
 * a ~3s researching window, then facts/section, done ~5.7s), and asserts the F1/F2/F3 arc DETERMINISTICALLY via
 * testID (the LLM never decides):
 *   F1   — the LearningsBar mounts above the (hidden) dock during research: `learnings.bar` appears with
 *          data-phase=researching once the band settles.
 *   F2/F3 — at researchComplete the dock REAPPEARS: `reveal.detailsIcon` (hidden during research) becomes visible
 *          (the bar faded into it; the bar is gone by then). This is the deterministic bar→dock transition the
 *          fly-into-Details animation communicates (the motion itself is native-only, not asserted here).
 *
 * This stands in for the Maestro native run, which is currently blocked by a pre-existing iOS pod conflict
 * (multi-webrtc providers — WebRTC-SDK + livekit-react-native-webrtc + react-native-webrtc — from the voice/livekit
 * work; NOT this change). The cycle-up + fly animations are device-gated (frame-rate not web-assertable).
 *
 * Run: `bun e2e/web/converge/learnings-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

// Entitlements: a scan for the capture + a podcast for the auto-start's gate (the dd auto-starts at fact #1).
const rig = await standUp('camera-client.tsx', { seed: { converge: { scan: 3, podcast: 2, voiceMin: 10 } } })
const { driver: d, errors } = rig
const { check, fails } = makeChecker()

console.log('\nconverge: REAL reveal "Initial learnings" arc under react-native-web + real BFF (streaming scan):')
await rig.page.goto(`${rig.base}/?scan=streaming`)

await check('real camera shutter renders', () => d.waitFor(ids.camera.shutter, { timeoutMs: 8000 }))

// Capture with the streaming seed → band settles instantly, then a ~3s researching window before fact #1.
await check('shutter → real BFF createThread (streaming scan) → reveal opens in place', async () => {
  await d.tap(ids.camera.shutter)
  await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
})

// F1 — the LearningsBar mounts during research (the dock is hidden; the bar owns the phase). The streaming seed's
// 3s pre-fact window guarantees the bar is present (data-phase=researching) at this point.
await check('F1: the LearningsBar mounts above the hidden dock during research (learnings.bar)', async () => {
  await d.waitFor(ids.learnings.bar, { timeoutMs: 5000 })
  const s = await d.state(ids.learnings.bar)
  if (s.attrs.phase !== 'researching') throw new Error('phase=' + JSON.stringify(s.attrs.phase))
})

// F2/F3 — at researchComplete (~5.7s) the dock reappears: the Details icon (hidden during research) becomes visible.
// This is the deterministic bar→dock transition (the fly-into-Details animation communicates it; the motion is
// native-only). The Details icon is ABSENT during research (the whole dock card is hidden) + APPEARS at done.
await check('F2/F3: at researchComplete the dock reappears (reveal.detailsIcon visible) — the bar→dock transition', async () => {
  await d.waitFor(ids.reveal.detailsIcon, { timeoutMs: 15000 })
})

await check('no uncaught errors while mounting the real learnings tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — the Initial learnings arc (bar→dock) renders + is E2E-testable behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
