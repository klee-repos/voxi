/**
 * collection-loading.web.ts — COLD-LOAD SKELETON proof for the REAL app/app/(tabs)/threads.tsx.
 *
 * Proves the elegant loading experience end-to-end on the REAL screen under react-native-web + the REAL BFF:
 *   1. PRIMARY (skeleton→empty): ?state=loading mounts the screen with the GET listThreads call delayed 400ms
 *      (the honest fetch-wrapper seam in threads-entry.tsx) → the cold-load SKELETON grid is observable.
 *      Assert: threads.skeleton present, threads.grid ABSENT (loading is honest), a real GET /v1/threads
 *      fired (globalThis.__voxiListThreadsGets ≥ 1 — a fake-success stub would leave it 0, closing R3), then
 *      after the delay threads.emptyState present + threads.skeleton gone (the skeleton→empty transition).
 *   2. SECONDARY (skeleton→grid): ?state=loading&count=1 seeds ONE real thread, so after the delay the grid
 *      mounts → skeleton→populated-grid transition proven (1 tile, count=1 — never N=24, which would blow
 *      the waitFor budget before the loading state is ever seen).
 * The verdict is a deterministic testID read + a real-request counter — the LLM never decides pass/fail.
 * Ends with a skeleton screenshot for a multimodal visual read.
 *
 * Run: `bun e2e/web/converge/collection-loading.web.ts`  (exit 0 = GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const SHOT = '/tmp/voxi-collection-loading-skeleton.png'
const DELAY_MS = 400 // must match the threads-entry.tsx fetch-wrapper delay
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Seed scan entitlement so Proof 2's createThread (count=1) doesn't 402. Proof 1 (count=0) issues no creates.
const rig = await standUp('threads-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

const skeletonCount = () => page.locator(`[data-testid="${ids.threads.skeleton}"]`).count()
const gridCount = () => page.locator(`[data-testid="${ids.threads.grid}"]`).count()
const emptyCount = () => page.locator(`[data-testid="${ids.threads.emptyState}"]`).count()
const itemCount = () => page.locator(`[data-testid="${ids.threads.item}"]`).count()
const listGets = () => page.evaluate(() => (globalThis as unknown as { __voxiListThreadsGets?: number }).__voxiListThreadsGets ?? 0)

await page.setViewportSize({ width: 390, height: 844 })

// ---------------------------------------------------------------------------
// Proof 1 — skeleton → empty (count=0): the deterministic split-proof.
// ---------------------------------------------------------------------------
console.log('\nconverge: REAL threads.tsx COLD-LOAD — skeleton grid, then the designed empty state:')
await page.goto(`${rig.base}/?state=loading`)

await check('the cold-load SKELETON grid mounts (the loading state is observable, not a bare spinner)', async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await skeletonCount()) > 0) return
    await sleep(50)
  }
  throw new Error('threads.skeleton never mounted within 5s')
})

await check('while loading, the real grid is ABSENT (the skeleton is the honest loading state, not the grid)', async () => {
  if ((await gridCount()) !== 0) throw new Error('threads.grid mounted during loading — skeleton + grid both visible')
})

await check('a real GET /v1/threads fired during the delay (delegation is load-bearing — a fake-success stub leaves this at 0)', async () => {
  const gets = await listGets()
  if (gets < 1) throw new Error(`expected ≥1 delayed GET /v1/threads, counter=${gets} — the fetch-wrapper seam did not fire (or did not delegate)`)
})

// Grab the skeleton screenshot WHILE the loading state is live (before the delay resolves).
await page.screenshot({ path: SHOT })
console.log('  skeleton screenshot →', SHOT)

await check('after the delay, the designed EMPTY state replaces the skeleton (skeleton→empty transition)', async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await emptyCount()) > 0 && (await skeletonCount()) === 0) return
    await sleep(80)
  }
  throw new Error(`emptyState did not replace skeleton — empty=${await emptyCount()}, skeleton=${await skeletonCount()}`)
})

// ---------------------------------------------------------------------------
// Proof 2 — skeleton → populated grid (count=1): one real seed, then the grid.
// ---------------------------------------------------------------------------
console.log('\nconverge: REAL threads.tsx COLD-LOAD — skeleton grid, then the populated grid (1 seeded thread):')
await page.goto(`${rig.base}/?state=loading&count=1`)

await check('the skeleton mounts before the populated grid (loading state observable with 1 seed)', async () => {
  // The 1-thread seed (converge.seeding) must clear first, then <Threads/> mounts with isLoading=true → skeleton.
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if ((await skeletonCount()) > 0) return
    await sleep(80)
  }
  throw new Error('threads.skeleton never mounted (seeding may have eaten the window — check the seed entitlement)')
})

await check('after the delay, the populated GRID replaces the skeleton with the 1 seeded tile (skeleton→grid transition)', async () => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await gridCount()) > 0 && (await skeletonCount()) === 0 && (await itemCount()) >= 1) return
    await sleep(80)
  }
  throw new Error(`grid did not replace skeleton — grid=${await gridCount()}, skeleton=${await skeletonCount()}, items=${await itemCount()}`)
})

await check('no uncaught errors across the cold-load journey (skeleton loops cleaned up on unmount)', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nCOLLECTION LOADING GREEN — cold-load skeleton mounts (grid absent, real GET fired), then resolves to empty/grid; no errors'
    : `\nCOLLECTION LOADING FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
