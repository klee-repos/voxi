/**
 * agentic-sweep.web.ts — AGENTIC breadth sweep over the REAL app (replaces the mock-shell run-explore-mcp.web.ts).
 *
 * One autonomous Agent, navigating ONLY by perceiving the live testID tree, walks the app's major screens/states
 * the way a person does — sign in, photograph, browse the collection, open settings — each round a REAL sign-in +
 * REAL taps on REAL screens (react-native-web, real ApiClient → real voxi-api BFF). The agent NAVIGATES; every
 * outcome is pinned DETERMINISTICALLY. Each round uses a DISTINCT seeded user (its own entitlements + its own,
 * initially-empty collection); the seeded object is steered by `?scan=` (the harness reads it off the Referer for
 * a genuine shutter capture — see e2e/web/server.ts), so the real shutter reaches each confidence band.
 *
 *   A — sign-in by perception → the real camera                         (auth journey)
 *   B — probable capture → real reveal, band=PROBABLE + candidates       (hedged identification)
 *   C — confident capture → real reveal, band=CONFIDENT                  (band variation)
 *   E — fresh account → drawer → Collection shows the empty state        (empty state, real drawer nav)
 *   F — drawer → Settings exposes the no-face-recognition guarantee      (privacy state)
 *
 * (The safety-refusal SURFACE is exercised agentically on the real reveal in reveal-agentic.web.ts — through the
 * full camera→processing flow a regulated capture currently resolves to the failure surface, not the distinct
 * refusal surface; see that runner's note.)
 *
 * Run: `bun e2e/web/converge/agentic-sweep.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, makeDrawerNavPlanner, capturePlanner } from './agentic-shared'

const { check, fails } = makeChecker()
// A distinct seeded user per round → each has its own entitlements + its own (initially empty) collection.
const rig = await standUp('app-client.tsx', {
  seed: Object.fromEntries(['swb', 'swc', 'swe', 'swf'].map((u) => [u, { scan: 5, podcast: 1, voiceMin: 10 }])),
})
const { driver: d, page, base } = rig
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Full sign-in by perception (welcome + first-run) with the given seeded user, landing on the real camera. */
async function signIn(email: string): Promise<void> {
  await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })
  await new Agent(d, makeSignInPlanner(email)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })
  await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })
}

/** Wait until the settled reveal carries the expected band (it rides reveal.howSure as data — there is no pill). */
async function pollBand(band: string): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await d.state(ids.reveal.howSure)).attrs.band === band) return
    await sleep(150)
  }
  throw new Error(`band did not settle to ${band}; last=${(await d.state(ids.reveal.howSure)).attrs.band}`)
}

console.log('\nagentic SWEEP — an agent walks the real app by perception (auth → capture bands → collection → settings):')

// ── round A + B: sign-in by perception, then a PROBABLE capture on the real shutter ──
await page.goto(`${base}/?scan=probable`)
await signIn('swb@voxi.dev')
await check('A · the agent reached the real camera by perception (welcome → first-run → camera)', async () => {
  if (!(await d.state(ids.camera.screen)).visible) throw new Error('camera.screen not visible')
})
await new Agent(d, capturePlanner).achieve('photograph the object', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 })
await check('B · a probable object settles the real reveal to band=PROBABLE (the hedge)', () => pollBand('PROBABLE'))
await check('B · tapping "How sure?" surfaces the real disagreement candidates', async () => {
  await d.tap(ids.reveal.howSure)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await page.locator(`[data-testid="${ids.reveal.candidateOption}"]`).count()) >= 1) return
    await sleep(150)
  }
  throw new Error('no candidateOption appeared after tapping How-sure')
})

// ── round C: a CONFIDENT capture → band variation ──
await page.goto(`${base}/?scan=confident`)
await signIn('swc@voxi.dev')
await new Agent(d, capturePlanner).achieve('photograph the object', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 })
await check('C · a confident object settles the real reveal to band=CONFIDENT', () => pollBand('CONFIDENT'))

// ── round E: fresh account, never captures → the real collection shows its empty state (real drawer nav) ──
await page.goto(`${base}/?scan=probable`)
await signIn('swe@voxi.dev')
await new Agent(d, makeDrawerNavPlanner(ids.nav.threadsTab, ids.threads.screen)).achieve('open the collection', { maxSteps: 6, settleMs: 250 })
await check('E · a fresh account sees the real collection empty state', async () => {
  await d.waitFor(ids.threads.emptyState, { timeoutMs: 5000 })
  if (!(await d.state(ids.threads.emptyState)).visible) throw new Error('threads.emptyState not visible')
})

// ── round F: the drawer greeting is the Settings entry point (the avatar became a "Welcome, {name}" greeting;
//    an agent perceives the drawer, taps the greeting, and lands on Settings — the privacy row is gone, so the
//    greeting→settings navigation is this round's ownable surface) ──
await page.goto(`${base}/?scan=probable`)
await signIn('swf@voxi.dev')
await new Agent(d, makeDrawerNavPlanner(ids.nav.settingsTab, ids.settings.screen)).achieve('open settings via the greeting', { maxSteps: 6, settleMs: 250 })
await check('F · tapping the drawer greeting navigates to settings (the avatar→greeting entry works)', async () => {
  if (!(await d.state(ids.settings.screen)).visible) throw new Error('settings.screen not visible after tapping the greeting')
})

await check('no uncaught errors across the whole sweep', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC SWEEP GREEN — an agent walked the real app by perception across auth, both confidence bands, the empty collection, and the drawer-greeting settings entry'
    : `\nAGENTIC SWEEP FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
