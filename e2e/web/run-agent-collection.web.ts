/**
 * AGENTIC collection-revisit E2E (COLLECTION-PERSISTENCE). An autonomous Agent — navigating ONLY by perceiving
 * the live testid tree, exactly as a real user would find their way — signs in, photographs an object, then
 * reopens it from the collection. The agent decides every tap; it may NEVER decide pass/fail. The outcomes are
 * pinned DETERMINISTICALLY: (1) the revisited item shows its reveal card again (reached via a real REVISIT, not
 * the capture — `data-resumes=true`), and (2) the generated identification (label + confidence band) is DURABLY
 * persisted server-side — read straight off the real BFF.
 *
 * The flow is two agent phases with a deterministic "wait for the Guide to settle" between them (as a user
 * waits for the screen). That ordering matters: revisiting only AFTER the capture has fully settled avoids the
 * shell's background auto-advance racing the revisit — it does not weaken the proof (both phases are agent-driven).
 *
 * Run: `bun e2e/web/run-agent-collection.web.ts`.
 */
import { chromium } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { Agent, type Planner, type PlannedAction } from '../framework/agent'
import { ids } from '../framework/testids'

const harness = createWebHarness({ seed: { qa: { scan: 2, podcast: 1, voiceMin: 10 } } })
const server = Bun.serve({ port: 0, fetch: harness.fetch })
const base = `http://localhost:${server.port}`
const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
const driver = new PlaywrightDriver(page)

const did = (h: PlannedAction[], kind: PlannedAction['kind'], id: string) => h.some((a) => a.kind === kind && a.id === id)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Phase 1 — the agent signs in and photographs an object (stops once it has tapped the shutter). */
const signInAndCapture: Planner = async (_goal, obs, history) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (did(history, 'tap', ids.camera.shutter)) return { kind: 'done', rationale: 'captured — the Guide is now analysing' }
  if (v(ids.camera.shutter)) return { kind: 'tap', id: ids.camera.shutter, rationale: 'photograph the object' }
  if (v(ids.welcome.otpInput)) {
    if (!did(history, 'type', ids.welcome.otpInput)) return { kind: 'type', id: ids.welcome.otpInput, text: '424242', rationale: 'enter code' }
    return { kind: 'tap', id: ids.welcome.continueBtn, rationale: 'submit code' }
  }
  if (v(ids.welcome.emailInput)) {
    if (!did(history, 'type', ids.welcome.emailInput)) return { kind: 'type', id: ids.welcome.emailInput, text: 'qa@voxi.test', rationale: 'enter email' }
    if (!did(history, 'tap', ids.welcome.eulaAccept)) return { kind: 'tap', id: ids.welcome.eulaAccept, rationale: 'accept terms' }
    if (!did(history, 'tap', ids.welcome.ageConfirm)) return { kind: 'tap', id: ids.welcome.ageConfirm, rationale: 'confirm age' }
    return { kind: 'tap', id: ids.welcome.continueBtn, rationale: 'continue' }
  }
  return { kind: 'done', rationale: 'no sign-in affordance perceived' }
}

/** Phase 2 — from the settled reveal, the agent opens the collection (done once the collection is showing). */
const openCollection: Planner = async (_goal, obs) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.threads.screen)) return { kind: 'done', rationale: 'the collection is open' }
  if (v(ids.nav.threadsTab)) return { kind: 'tap', id: ids.nav.threadsTab, rationale: 'open the collection' }
  return { kind: 'done', rationale: 'no collection affordance perceived' }
}

let fails = 0
const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}
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
  await page.goto(`${base}/?scan=confident`) // a CONFIDENT capture → a real identified label to persist
  log('agentic collection revisit (autonomous nav; deterministic assertions):')

  // AGENTIC phase 1: the agent finds its own way from welcome → a captured object.
  await new Agent(driver, signInAndCapture).achieve('sign in and photograph an object', { maxSteps: 12 })
  // Sync: wait for the Guide to settle on a reveal (as a real user does) — this is a WAIT, not a pass/fail call.
  await driver.waitFor(ids.reveal.card, { timeoutMs: 10000 })
  log('  (the capture settled on a reveal)')
  // AGENTIC phase 2: the agent opens the collection by perception; the tile reopen is then driven deterministically
  // (the CLAUDE.md balance — the agent NAVIGATES; the values that matter are pinned by the deterministic layer).
  await new Agent(driver, openCollection).achieve('open the collection', { maxSteps: 4 })
  await driver.waitFor(ids.threads.item, { timeoutMs: 8000 }) // the owner-scoped list loads (as a user waits)
  await page.locator(`[data-testid="${ids.threads.item}"]`).first().click() // reopen the persisted past capture
  await driver.waitFor(ids.reveal.card, { timeoutMs: 8000 })

  // DETERMINISTIC (UI): the revisited item shows its reveal card again with a non-empty title.
  await check('the reopened past item shows its reveal card again', async () => {
    const card = await driver.state(ids.reveal.card)
    if (!card.visible) throw new Error('reveal.card not visible after the agentic revisit')
  })
  await check('the reveal was reached via a genuine REVISIT (data-resumes=true — never set on a fresh capture)', async () => {
    const card = await driver.state(ids.reveal.card)
    if (card.attrs['resumes'] !== 'true') throw new Error('reveal.card resumes=' + JSON.stringify(card.attrs['resumes']) + ' — the agent did not actually revisit')
  })
  await check('the revisited reveal carries a non-empty title (the item was not a blank shell)', async () => {
    const t = (await driver.state(ids.reveal.title)).text ?? ''
    if (!t.trim()) throw new Error('reveal.title empty on revisit')
  })

  // DETERMINISTIC (SERVER): the generated identification is DURABLY persisted — read off the real BFF, the ONLY
  // authority. The agent's navigation is irrelevant to this assertion; the durable content is what's checked.
  await check('the collection durably kept the generated content (label + CONFIDENT band) on the past item', async () => {
    let ok = false
    for (let i = 0; i < 12 && !ok; i++) {
      const res = await harness.fetch(new Request(`${base}/api/v1/threads`, { headers: { authorization: 'Bearer test:qa' } }))
      const body = (await res.json()) as { threads: { revealTitle?: string | null; band?: string | null }[] }
      const item = body.threads[0]
      if (item && item.band === 'CONFIDENT' && item.revealTitle && /Cannondale|SuperSix/.test(item.revealTitle)) ok = true
      else await sleep(150)
    }
    if (!ok) throw new Error('the persisted reveal (revealTitle + CONFIDENT band) never appeared on GET /v1/threads')
  })
} catch (e) {
  fails++
  log('  FAIL ' + (e as Error).message)
} finally {
  await browser.close()
  server.stop()
}

log(fails === 0 ? 'AGENTIC COLLECTION-REVISIT E2E GREEN' : `AGENTIC COLLECTION-REVISIT E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.agent-collection-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
