/**
 * sentry-capture.web.ts — AGENTIC proof that error monitoring works end-to-end through REAL user clicks.
 *
 * An agent signs in through the REAL welcome + first-run (perception-driven, like every other agentic runner),
 * landing on the REAL camera with the SHIPPING observability module initialized (@sentry/browser on web). Then a
 * REAL click on a DSN-gated dev affordance captures a secret-bearing error, which the app's real SDK POSTs as an
 * envelope to a SAME-ORIGIN local sink (no network, no real project). We assert deterministically that:
 *   - init actually ran (window.__voxiSentryFlush exists) — a mis-wire fails LOUDLY, not as an empty-negative,
 *   - a normal signed-in session captures NOTHING (no spurious events),
 *   - the click produces ≥1 envelope at the sink (capture works),
 *   - every secret shape is REDACTED in that envelope (deep, value-aware — DB password, vendor key, data-URI, sig),
 *   - the run has zero uncaught pageerrors (the trigger uses direct capture, not an uncatchable event-handler throw).
 *
 * The DSN + sink + dev button are OPT-IN via `{ sentry: true }`, so no other agentic runner is affected.
 * Run: `bun e2e/web/converge/sentry-capture.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, CONVERGE_EMAIL } from './agentic-shared'

const SECRETS = ['PROBE_PGPW', 'sk_live_PROBEKEY123', 'base64,QUJDREVG', 'PROBESIG']

const { check, fails } = makeChecker()
const rig = await standUp('app-client.tsx', { sentry: true, seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig
if (!rig.sentry) throw new Error('rig.sentry missing — the harness sentry opt is not wired')
const sentry = rig.sentry

console.log('\nagentic SENTRY — an agent signs in, then a real click captures + redacts an error to the local sink:')
await page.goto(base + '/')
await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })
await new Agent(d, makeSignInPlanner(CONVERGE_EMAIL)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })
await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })

await check('the SHIPPING observability init ran (window.__voxiSentryFlush is a function)', async () => {
  const ok = await page.evaluate(() => typeof (window as unknown as { __voxiSentryFlush?: unknown }).__voxiSentryFlush === 'function')
  if (!ok) throw new Error('__voxiSentryFlush missing — initObservability did not run or the DSN was not injected')
})

await check('a normal signed-in session captures nothing (no spurious Sentry events)', async () => {
  await page.evaluate(() => (window as unknown as { __voxiSentryFlush?: () => Promise<boolean> }).__voxiSentryFlush?.())
  const evs = await sentry.waitFor(() => false, 400) // drain briefly; expect an empty sink
  if (evs.length !== 0) throw new Error(`expected 0 envelopes pre-trigger, got ${evs.length}`)
})

await check('a REAL user click captures an error to the local Sentry sink', async () => {
  sentry.reset()
  await d.tap(ids.dev.sentryThrow)
  await page.evaluate(() => (window as unknown as { __voxiSentryFlush?: () => Promise<boolean> }).__voxiSentryFlush?.())
  const evs = await sentry.waitFor((e) => e.length >= 1, 5000)
  if (evs.length < 1) throw new Error('no Sentry envelope reached the sink after the trigger tap')
})

await check('every secret is redacted in the captured envelope (deep, value-aware)', async () => {
  const blob = sentry.events().join('\n')
  if (!blob.includes('e2e sentry probe')) throw new Error('the probe event was not found in the envelope')
  for (const secret of SECRETS) {
    if (blob.includes(secret)) throw new Error(`SECRET LEAKED to Sentry: ${secret}`)
  }
})

await check('zero uncaught pageerrors across the run', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC SENTRY GREEN — a real click captured a real error, the sink received it, and every secret was redacted'
    : `\nAGENTIC SENTRY FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
