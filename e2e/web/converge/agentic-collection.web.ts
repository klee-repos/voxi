/**
 * agentic-collection.web.ts — AGENTIC capture → revisit over the REAL screens (replaces mock-shell run-agent-collection).
 *
 * An autonomous Agent, navigating ONLY by perceiving the live testID tree, signs in through the REAL welcome +
 * first-run, photographs an object with the REAL camera shutter, then reopens it from the REAL collection — every
 * step a real click on a real screen (react-native-web, real Zustand store, real ApiClient → real voxi-api BFF).
 * The agent NAVIGATES; the outcomes are pinned DETERMINISTICALLY:
 *   1. the capture settles on a real reveal with a real identified title;
 *   2. the item is listed in the real collection and reopening it REVISITS the reveal (routes back through the real
 *      /processing replay — the BFF re-serves the persisted reveal, it is NOT a fresh capture): proven behaviorally
 *      by the fact that the revisit creates NO new thread and charges NO extra scan;
 *   3. the identification (title + CONFIDENT band) is DURABLY persisted server-side — read straight off the BFF.
 *
 * The confident capture is steered by `?scan=confident` (the harness reads it off the Referer for a genuine shutter
 * tap — see e2e/web/server.ts), so the real shutter produces a real identified label to persist.
 *
 * Run: `bun e2e/web/converge/agentic-collection.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, makeDrawerNavPlanner, capturePlanner, CONVERGE_EMAIL } from './agentic-shared'

const { check, fails } = makeChecker()
const rig = await standUp('app-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Read a JSON endpoint from the page (same-origin), owner-scoped to the signed-in test user. */
const apiGet = <T>(path: string): Promise<T> =>
  page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { authorization: 'Bearer test:converge' } })
    return r.json()
  }, path) as Promise<T>
const remainingScan = async () => (await apiGet<{ remaining: { scan: number } }>('/api/v1/me')).remaining.scan
const threadCount = async () => (await apiGet<{ threads: unknown[] }>('/api/v1/threads')).threads.length

console.log('\nagentic COLLECTION — real sign-in → real shutter → real revisit from the collection:')
await page.goto(`${base}/?scan=confident`) // a CONFIDENT capture → a real identified label to persist
await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })

// AGENTIC: sign in, then photograph an object with the real shutter.
await new Agent(d, makeSignInPlanner(CONVERGE_EMAIL)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })
await new Agent(d, capturePlanner).achieve('photograph the object', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 }) // real camera → processing → reveal

let capturedTitle = ''
await check('the capture settled on a real reveal with a real identified title', async () => {
  capturedTitle = (await d.state(ids.reveal.title)).text ?? ''
  if (!capturedTitle.trim()) throw new Error('reveal.title empty after capture')
})

// Baseline AFTER the capture (one scan already charged, one thread persisted). The revisit must not move these.
const scanAfterCapture = await remainingScan()
const countAfterCapture = await threadCount()

// AGENTIC: open the collection through the real drawer (reveal → back to camera → hamburger → Collection row).
await new Agent(d, makeDrawerNavPlanner(ids.nav.threadsTab, ids.threads.screen)).achieve('open the collection', { maxSteps: 8, settleMs: 250 })
await d.waitFor(ids.threads.item, { timeoutMs: 8000 })

await check('the captured item is listed in the real collection', async () => {
  const n = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
  if (n < 1) throw new Error('no threads.item tiles in the collection')
})

// Reopen the persisted tile — the deterministic reopen of the specific past capture (the agent navigated here; the
// value that matters, that the reveal REVISITS, is pinned below). A real DOM click on the real tile.
await d.tap(ids.threads.item)
await d.waitFor(ids.reveal.card, { timeoutMs: 12000 })

await check('reopening the tile REVISITS the real reveal (same identified title)', async () => {
  const t = (await d.state(ids.reveal.title)).text ?? ''
  if (!t.trim()) throw new Error('reveal.title empty on revisit')
  if (t.trim() !== capturedTitle.trim()) throw new Error(`revisit title "${t}" != captured "${capturedTitle}"`)
})

await check('the revisit REPLAYED, not re-captured (no new thread, no extra scan charged)', async () => {
  const count = await threadCount()
  const scan = await remainingScan()
  if (count !== countAfterCapture) throw new Error(`thread count changed on revisit: ${countAfterCapture} → ${count}`)
  if (scan !== scanAfterCapture) throw new Error(`a scan was charged on revisit: ${scanAfterCapture} → ${scan}`)
})

await check('the identification is DURABLY persisted server-side (revealTitle + CONFIDENT band)', async () => {
  let ok = false
  for (let i = 0; i < 12 && !ok; i++) {
    const body = await apiGet<{ threads: { revealTitle?: string | null; band?: string | null }[] }>('/api/v1/threads')
    const item = body.threads[0]
    if (item && item.band === 'CONFIDENT' && item.revealTitle && /Cannondale|SuperSix/.test(item.revealTitle)) ok = true
    else await sleep(150)
  }
  if (!ok) throw new Error('persisted revealTitle + CONFIDENT band never appeared on GET /v1/threads')
})

await check('no uncaught errors across the real capture → revisit journey', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC COLLECTION GREEN — an agent captured with the real shutter and revisited the persisted item from the real collection (revisit replayed, not re-billed; identification durable server-side)'
    : `\nAGENTIC COLLECTION FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
