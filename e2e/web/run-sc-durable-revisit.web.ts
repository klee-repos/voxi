/**
 * Executable web E2E for the durable-revisit fix (the tmux `/stream → 403` bug). Real Chromium + the real BFF.
 *
 * Deterministic↔agentic balance (CLAUDE.md): the AGENT does the real clicks (capture → reveal → revisit from the
 * collection); the VALUES that matter are asserted deterministically against the real BFF. Faithfulness: we call
 * the harness `evict(threadId)` to model an actual restart (the in-memory session/photo is dropped; the durable
 * thread + reveal rows survive) — so "revisit works" cannot pass for the wrong reason. Before the fix, the second
 * /stream would 403 and the app would show the offline banner; after it, the persisted reveal replays.
 *
 * Run: `bun e2e/web/run-sc-durable-revisit.web.ts`
 */
import { chromium } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

const { fetch, evict } = createWebHarness({ seed: { qa: { scan: 3, podcast: 1, voiceMin: 10 } } })
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`

const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
const d = new PlaywrightDriver(page)

let fails = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log('  PASS', name)
  } catch (e) {
    fails++
    console.log('  FAIL', name, (e as Error).message)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
async function bffStream(user: string, id: string, startIndex = 0) {
  const res = await fetch(new Request(`${base}/api/v1/threads/${id}/stream?startIndex=${startIndex}`, { headers: { authorization: `Bearer test:${user}` } }))
  const text = await res.text()
  const events = text.trim() ? text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  return { status: res.status, events }
}

await page.goto(base + '?scan=confident') // seed a CONFIDENT capture (a real identification worth revisiting)
console.log('web E2E — durable revisit (real BFF + PlaywrightDriver):')

// --- agentic: authenticate, then capture a CONFIDENT reveal (this persists the reveal to the durable store) ---
await d.waitFor(ids.welcome.emailInput)
await d.type(ids.welcome.emailInput, 'qa@voxi.test')
await d.tap(ids.welcome.eulaAccept)
await d.tap(ids.welcome.ageConfirm)
await d.tap(ids.welcome.continueBtn)
await d.waitFor(ids.welcome.otpInput)
await d.type(ids.welcome.otpInput, '424242')
await d.tap(ids.welcome.continueBtn)
await d.waitFor(ids.camera.screen)
await d.tap(ids.camera.shutter)
await check('capture settles on a CONFIDENT reveal', async () => {
  await d.waitFor(ids.reveal.card)
  const chip = await d.state(ids.reveal.confidenceChip)
  assert(chip.attrs.band === 'CONFIDENT', 'band=' + JSON.stringify(chip.attrs))
})

const threadId = await page.locator(`[data-testid="${ids.reveal.card}"]`).getAttribute('data-thread.id')
assert(threadId, 'no data-thread.id on the reveal card')

// Drain the stream once via the BFF (awaited) so the reveal is durably PINNED before we simulate the restart —
// removes any race between the browser breaking on `done` and the route finishing its persist.
await check('the reveal is served + persisted (200, CONFIDENT) while the session is live', async () => {
  const { status, events } = await bffStream('qa', threadId!)
  assert(status === 200, 'status=' + status)
  assert(events.find((e) => e.type === 'confidence_band')?.band === 'CONFIDENT', 'no CONFIDENT band')
})

// --- the bug: simulate a BFF restart (evict the in-memory session/ownership; durable rows survive) ---
evict(threadId!)

await check('REGRESSION: after a restart the owner replays the reveal (200, CONFIDENT) — NOT a 403', async () => {
  const { status, events } = await bffStream('qa', threadId!)
  assert(status === 200, 'status=' + status + ' (the pre-restart 403 bug)')
  assert(events.find((e) => e.type === 'confidence_band')?.band === 'CONFIDENT', 'reveal did not replay')
  assert(events.find((e) => e.type === 'token')?.text?.includes('Cannondale'), 'whatItIs missing on replay')
  assert(!events.some((e) => e.type === 'error'), 'got a hard_failure instead of the replay')
})

await check('after a restart a non-owner is denied (404) — no cross-tenant replay', async () => {
  const { status } = await bffStream('intruder', threadId!)
  assert(status === 404, 'status=' + status)
})

await check('reconnect replay honours ?startIndex= against the pinned events', async () => {
  const { status, events } = await bffStream('qa', threadId!, 2)
  assert(status === 200, 'status=' + status)
  assert(events.every((e) => e.index >= 2), 'startIndex filter leaked earlier events')
  assert(!events.some((e) => e.type === 'token'), 'token(0) should have been skipped')
})

// --- agentic: the collection stays usable after the restart — tap the past capture, land on its reveal ---
await check('real click: revisiting the collection item after a restart lands on the reveal card', async () => {
  await d.tap(ids.nav.threadsTab)
  await d.waitFor(ids.threads.screen)
  await page.locator(`[data-testid="${ids.threads.item}"]`).first().click()
  await d.waitFor(ids.reveal.card)
})

await browser.close()
server.stop()
console.log(fails === 0 ? '\nDURABLE-REVISIT E2E GREEN' : `\nDURABLE-REVISIT E2E FAILURES: ${fails}`)
process.exit(fails === 0 ? 0 : 1)
