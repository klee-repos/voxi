/**
 * agentic-auth.web.ts — AGENTIC sign-in over the REAL screens (replaces the mock-shell run-agent-pw.web.ts).
 *
 * An autonomous Agent drives the REAL app/app/welcome.tsx + app/app/first-run.tsx (react-native-web, real FakeAuth
 * seam, real ApiClient → real voxi-api BFF) in a real Chromium, navigating ONLY by PERCEIVING the live testID/a11y
 * tree — it fills the email, taps the two consent gates, verifies the OTP, then clicks through onboarding — landing
 * on the REAL camera. Real screens, real clicks, as close to a real user as the web target allows. The agent only
 * NAVIGATES; the outcome (camera reached, zero mount errors) is pinned deterministically (framework/agent.ts rules).
 *
 * Run: `bun e2e/web/converge/agentic-auth.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, CONVERGE_EMAIL } from './agentic-shared'

const { check, fails } = makeChecker()
const rig = await standUp('app-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig

console.log('\nagentic AUTH — an agent signs in through the REAL welcome + first-run to the REAL camera:')
await page.goto(base + '/')
await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })

// settleMs paces the agent like a person (no same-millisecond taps): it lets each screen re-render / navigation
// land before the next perception — e.g. the verify → /first-run hop, and the FakeAuth token-client rebuild.
await new Agent(d, makeSignInPlanner(CONVERGE_EMAIL)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })

await check('the agent reached the REAL camera by perception (welcome → OTP → first-run → camera)', async () => {
  await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })
  if (!(await d.state(ids.camera.screen)).visible) throw new Error('camera.screen not visible after sign-in')
})
await check('no uncaught errors across the real sign-in journey', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC AUTH GREEN — an agent signed in through the real welcome + first-run UI (real taps) and reached the real camera'
    : `\nAGENTIC AUTH FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
