/**
 * Agentic exploration over the PROVEN PlaywrightDriver (explore-01 seed), against the real BFF + web shell.
 * The Agent navigates by reading the live accessibility tree (visibleIds) and deciding the next action toward
 * a goal — outcomes pinned by deterministic testid assertions. The planner here is scripted (deterministic CI
 * run); in production it is an LLM, or the agent-browser backend for scale. Run: `bun e2e/web/run-agent-pw.web.ts`.
 */
import { chromium } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { Agent, type Planner, type PlannedAction } from '../framework/agent'
import { ids } from '../framework/testids'

const { fetch } = createWebHarness()
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`
const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
const driver = new PlaywrightDriver(page)

const did = (h: PlannedAction[], kind: PlannedAction['kind'], id: string) => h.some((a) => a.kind === kind && a.id === id)

/** Scripted planner: navigates the real sign-in→camera flow purely from the observed a11y tree + history. */
const planner: Planner = async (_goal, obs, history) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.camera.screen)) return { kind: 'done', rationale: 'reached camera' }
  if (v(ids.welcome.otpInput)) {
    if (!did(history, 'type', ids.welcome.otpInput)) return { kind: 'type', id: ids.welcome.otpInput, text: '424242', rationale: 'enter code' }
    return { kind: 'tap', id: ids.welcome.continueBtn, rationale: 'submit code' }
  }
  if (!did(history, 'type', ids.welcome.emailInput)) return { kind: 'type', id: ids.welcome.emailInput, text: 'qa@voxi.test', rationale: 'enter email' }
  if (!did(history, 'tap', ids.welcome.eulaAccept)) return { kind: 'tap', id: ids.welcome.eulaAccept, rationale: 'accept terms' }
  if (!did(history, 'tap', ids.welcome.ageConfirm)) return { kind: 'tap', id: ids.welcome.ageConfirm, rationale: 'confirm age' }
  return { kind: 'tap', id: ids.welcome.continueBtn, rationale: 'continue' }
}

let fails = 0
const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}
try {
  await page.goto(base)
  log('agentic exploration over PlaywrightDriver (real app):')
  await new Agent(driver, planner).achieve('sign in and reach the camera', { maxSteps: 10 })
  const cam = await driver.state(ids.camera.screen)
  if (!cam.visible) throw new Error('camera screen not reached')
  log('  PASS agent navigated sign-in → camera (by perception, asserted deterministically)')
} catch (e) {
  fails++
  log('  FAIL ' + (e as Error).message)
} finally {
  await browser.close()
  server.stop()
}
log(fails === 0 ? 'AGENTIC (Playwright) E2E GREEN' : `AGENTIC (Playwright) E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.agentic-pw-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
