/**
 * agentic-swipe.web.ts — AGENTIC swipe-paging across catalogued items over the REAL reveal screen.
 *
 * An autonomous Agent signs in through the REAL welcome + first-run and photographs TWO objects with the REAL
 * camera shutter (react-native-web, real Zustand store, real ApiClient → real voxi-api BFF). The reveal renders
 * a horizontal paging FlatList of the catalogued items; this test drives a REAL horizontal scroll (the native
 * pager) and pins the outcome deterministically:
 *   1. the reveal exposes a multi-item pager once ≥2 items are catalogued (`reveal.position` count ≥ 2);
 *   2. scrolling the pager PAGES IN PLACE — `reveal.position` `data-index` advances, `reveal.card` stays mounted,
 *      and NO navigation fires (`data-last-nav` unchanged — it is not a route trip through /processing);
 *   3. paging REPLAYS, it does not re-capture — no new thread, no scan charged;
 *   4. scrolling back returns to the newer item.
 *
 * Two captures use the SAME `?scan=confident` fixture (FakeAuth is in-memory, so a second `page.goto` for a
 * different fixture would sign the agent out) — identical titles are fine because paging is proven by POSITION.
 *
 * Run: `bun e2e/web/converge/agentic-swipe.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent, type Planner } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, capturePlanner, CONVERGE_EMAIL } from './agentic-shared'

const { check, fails } = makeChecker()
const rig = await standUp('app-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const apiGet = <T>(path: string): Promise<T> =>
  page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { authorization: 'Bearer test:converge' } })
    return r.json()
  }, path) as Promise<T>
const remainingScan = async () => (await apiGet<{ remaining: { scan: number } }>('/api/v1/me')).remaining.scan
const threadCount = async () => (await apiGet<{ threads: unknown[] }>('/api/v1/threads')).threads.length
const lastNav = () => page.evaluate(() => document.body.getAttribute('data-last-nav'))
const posAttr = async (k: 'index' | 'count') => (await d.state(ids.reveal.position)).attrs[k]
const pagerScroll = () => page.evaluate((pid) => (document.querySelector(`[data-testid="${pid}"]`) as HTMLElement | null)?.scrollLeft ?? 0, ids.reveal.pager)

/** Drive a REAL horizontal scroll of the paging FlatList to page `i` (native scroll → the reveal's onScroll settle). */
const swipeToPage = (i: number): Promise<void> =>
  page.evaluate(
    ({ pagerId, idx }) => {
      const el = document.querySelector(`[data-testid="${pagerId}"]`) as HTMLElement | null
      if (!el) throw new Error('reveal.pager not found')
      el.scrollLeft = el.clientWidth * idx
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    },
    { pagerId: ids.reveal.pager, idx: i },
  )

/** Return to the camera from wherever we are (reveal → back chevron lands on the camera shell). */
const toCamera: Planner = async (_g, obs) => {
  if (obs.visibleIds.includes(ids.camera.screen)) return { kind: 'done', rationale: 'at the camera' }
  if (obs.visibleIds.includes(ids.nav.back)) return { kind: 'tap', id: ids.nav.back, rationale: 'back to the camera' }
  return { kind: 'done', rationale: 'no back affordance' }
}

console.log('\nagentic SWIPE — real sign-in → two real captures → swipe-paging on the reveal:')
await page.goto(`${base}/?scan=confident`)
await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })

await new Agent(d, makeSignInPlanner(CONVERGE_EMAIL)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })
await new Agent(d, capturePlanner).achieve('photograph the first object', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 })
await new Agent(d, toCamera).achieve('return to the camera', { maxSteps: 4, settleMs: 200 })
await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })
await new Agent(d, capturePlanner).achieve('photograph the second object', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 }) // viewing item #2 (the newest)

// The `['threads']` query populates asynchronously on this fresh reveal mount (converge shim has no cross-mount
// cache), so WAIT for the pager to see both items before driving it.
await check('the reveal exposes a multi-item pager (both catalogued items)', async () => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await posAttr('count')) === '2' && (await d.state(ids.reveal.pager)).visible) return
    await sleep(150)
  }
  throw new Error(`pager never saw 2 items (count=${await posAttr('count')})`)
})

// The pager prepends a CAMERA page at index 0, so the newest item sits at pager index 1 and older items follow.
// Confirm it OPENED on the newest (initialScrollIndex worked), not stuck on the leading camera page.
await check('the pager opens on the newest item, not the leading camera page', async () => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if ((await pagerScroll()) > 10) return // scrolled past the camera page (pager index ≥ 1)
    await sleep(150)
  }
  throw new Error(`pager stuck on the camera page (scrollLeft=${await pagerScroll()})`)
})

const idxBefore = await posAttr('index') // '0' — the newest (real item index)
const navBefore = await lastNav()
const scanBefore = await remainingScan()
const countBefore = await threadCount()

// A REAL swipe to the OLDER item (real index 1 → pager index 2, past the camera + newest).
await swipeToPage(2)

await check('swiping the pager PAGES IN PLACE (index advances, reveal stays, NO navigation fires)', async () => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const idx = await posAttr('index')
    if (idx !== idxBefore) {
      if (!(await d.state(ids.reveal.card)).visible) throw new Error('reveal.card unmounted during paging')
      if ((await lastNav()) !== navBefore) throw new Error(`a navigation fired during item paging (in-place violated): ${await lastNav()}`)
      return
    }
    await sleep(150)
  }
  throw new Error(`reveal.position index never advanced from ${idxBefore} on a real swipe`)
})

await check('paging REPLAYED, it did not re-capture (no new thread, no scan charged)', async () => {
  await sleep(400)
  const count = await threadCount()
  const scan = await remainingScan()
  if (count !== countBefore) throw new Error(`thread count changed on paging: ${countBefore} → ${count}`)
  if (scan !== scanBefore) throw new Error(`a scan was charged on paging: ${scanBefore} → ${scan}`)
})

await check('swiping back returns to the newest item', async () => {
  await swipeToPage(1) // pager index 1 = the newest item
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if ((await posAttr('index')) === idxBefore) return
    await sleep(150)
  }
  throw new Error(`did not page back to index ${idxBefore} (now ${await posAttr('index')})`)
})

// THE MERGE (camera-as-a-page): page 0 is the LIVE VIEWFINDER on the SAME pager — swiping to it is pure scrolling,
// NO navigation (no screen swap → no fade). It exposes the `camera.screen` home marker.
await check('swiping to the viewfinder (page 0) shows the camera home IN PLACE — no navigation fires', async () => {
  const navBefore = await lastNav()
  await swipeToPage(0)
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if ((await d.state(ids.camera.screen)).visible) {
      if ((await lastNav()) !== navBefore) throw new Error(`a navigation fired swiping to the viewfinder (merge violated): ${await lastNav()}`)
      return
    }
    await sleep(150)
  }
  throw new Error(`swiping to page 0 did not surface the viewfinder home (last-nav=${await lastNav()})`)
})

// And back: viewfinder → newest item is the SAME pager scroll — reveal dock appears IN PLACE, NO navigation, no
// "opening" beat. This is the whole point: camera⇄item is one surface, nothing to fade or remount.
await check('swiping viewfinder → newest item is CONTINUOUS + IN PLACE — no navigation, no "opening" beat', async () => {
  const navBefore = await lastNav()
  await swipeToPage(1) // page 1 = the newest item
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await d.state(ids.reveal.card)).visible && (await posAttr('index')) === idxBefore) {
      if ((await lastNav()) !== navBefore) throw new Error(`a navigation fired on the viewfinder→item swipe (merge violated): ${await lastNav()}`)
      if ((await d.state(ids.camera.opening)).visible) throw new Error('the retired camera.opening beat is still rendering')
      return
    }
    await sleep(150)
  }
  throw new Error('swiping viewfinder→item did not settle on the newest item in place')
})

await check('no uncaught errors across the real capture → paging journey', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC SWIPE GREEN — an agent captured two items and swipe-paged between them IN PLACE on the real reveal (position advanced, no nav, no re-bill), every outcome pinned deterministically'
    : `\nAGENTIC SWIPE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
