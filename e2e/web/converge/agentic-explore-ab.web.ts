/**
 * agentic-explore-ab.web.ts — the SAME agentic sign-in + capture as the Playwright runners, but over the
 * agent-browser native backend, on the REAL screens (replaces the mock-shell run-explore-mcp.web.ts).
 *
 * This is the coherence payoff: agent-browser is wrapped as a `Driver` (framework/drivers/agent-browser-driver.ts),
 * so the IDENTICAL `makeSignInPlanner` / `capturePlanner` that drive the Playwright runners drive this one too —
 * perceiving the real welcome→first-run→camera→reveal by its testID/a11y tree and acting with real clicks. Every
 * outcome is pinned DETERMINISTICALLY by a getByTestId read against the real BFF + real react-native-web screens.
 *
 * The app bundle is served from a SEPARATE process (app-harness-server.ts) because agent-browser's daemon inherits
 * open fds — a listening socket in THIS process would wedge the launch handshake (see that file's header).
 *
 * If agent-browser (CLI or Chrome/Chromium for its daemon) is unavailable, the runner SKIPS cleanly (exit 0): the
 * four Playwright agentic runners already deliver the real-screen agentic coverage in CI. We NEVER fake a green.
 *
 * Run: `bun e2e/web/converge/agentic-explore-ab.web.ts`
 */
import { AgentBrowser } from '../../framework/drivers/agent-browser'
import { AgentBrowserDriver } from '../../framework/drivers/agent-browser-driver'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, capturePlanner } from './agentic-shared'

let fails = 0
const log = (s: string) => console.log(s)

const probe = AgentBrowser.probe()
if (!probe.ok) {
  log('agentic-explore (agent-browser backend, REAL screens): SKIPPED')
  log(`  reason: ${probe.reason}`)
  log('  real-screen agentic coverage is delivered by the Playwright runners (agentic-auth/collection/reveal/sweep). No green faked.')
  log('AGENTIC (agent-browser, real screens) E2E SKIPPED')
  process.exit(0)
}

// Start the app bundle server in its OWN process (see header: keeps agent-browser's daemon from inheriting a socket).
const harness = Bun.spawn(['bun', 'e2e/web/converge/app-harness-server.ts'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })

async function readHarnessPort(timeoutMs = 20_000): Promise<number> {
  const reader = harness.stdout.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value)
      const m = /"port":(\d+)/.exec(buf)
      if (m) return Number(m[1])
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error('app-harness-server did not report a port')
}

const ab = new AgentBrowser()
const d = new AgentBrowserDriver(ab)
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn()
    log('  PASS ' + name)
  } catch (e) {
    fails++
    log('  FAIL ' + name + ' :: ' + (e as Error).message)
  }
}

try {
  const base = `http://localhost:${await readHarnessPort()}`
  log('\nagentic-explore (agent-browser backend, REAL screens) — the same planners, the native backend:')

  // A PROBABLE capture: the harness steers the seeded object off the page URL's ?scan (carried on the Referer).
  ab.open(`${base}/?scan=probable`)
  await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })

  // SAME planner as the Playwright runners: sign in through the real welcome + first-run to the real camera.
  await new Agent(d, makeSignInPlanner('abx@voxi.dev')).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })
  await check('agent reached the REAL camera by perception over the agent-browser backend', async () => {
    if (!ab.getByTestId(ids.camera.screen).visible) throw new Error('camera.screen not visible')
  })

  // SAME capture planner: tap the real shutter → real processing → real reveal.
  await new Agent(d, capturePlanner).achieve('photograph the object', { maxSteps: 4, settleMs: 200 })
  ab.waitForTestId(ids.reveal.card, 15000)
  await check('the real reveal settles to band=PROBABLE (read via getByTestId on the native backend)', async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (ab.getByTestId(ids.reveal.howSure).attrs['band'] === 'PROBABLE') return
    }
    throw new Error('band did not settle to PROBABLE; last=' + ab.getByTestId(ids.reveal.howSure).attrs['band'])
  })

  log(fails === 0 ? 'AGENTIC (agent-browser, real screens) E2E GREEN' : `AGENTIC (agent-browser, real screens) E2E FAILURES: ${fails}`)
} catch (e) {
  fails++
  log('  FAIL (exception) ' + (e as Error).message)
  log(`AGENTIC (agent-browser, real screens) E2E FAILURES: ${fails}`)
} finally {
  ab.close()
  harness.kill()
  await harness.exited.catch(() => {})
}

process.exit(fails === 0 ? 0 : 1)
