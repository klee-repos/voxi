/**
 * collection-scroll.web.ts — INFINITE-SCROLL proof for the REAL app/app/(tabs)/threads.tsx photo-book grid.
 *
 * Seeds N=24 real threads on the real BFF (fail-loud if the entitlement is short — never a silent under-seed),
 * mounts the REAL screen under react-native-web, and proves the client-side windowed FlatList behaves:
 *   1. NOT all 24 tiles mount at once — the window (`threads.window` data-shown) starts ≤ PAGE (the fix for the
 *      "too many images loading at once" jank);
 *   2. scrolling GROWS the window a page at a time until it reveals all 24 (the literal infinite scroll);
 *   3. the count subtitle shows the true total (24) with NO ∞.
 * The window growth is read off a hidden anchor (real app state), NOT volatile DOM tile counts (react-native-web
 * virtualizes the tiles), so the seam is honest and deterministic. Ends with a screenshot for a visual read.
 *
 * Run: `bun e2e/web/converge/collection-scroll.web.ts`  (exit 0 = GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const N = 24
const PAGE = 12 // must match threads.tsx PAGE (the initial + per-scroll window step)
const SHOT = '/private/tmp/claude-501/-Users-kvnlee-dev-voxi/94f8455e-d97b-4971-bb2d-f7a369d5fb20/scratchpad/collection-photobook.png'

const rig = await standUp('threads-client.tsx', { seed: { converge: { scan: N + 6, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const attr = (id: string, name: string) => page.locator(`[data-testid="${id}"]`).first().getAttribute(name)
const shown = async () => Number((await attr(ids.threads.window, 'data-shown')) ?? '-1')
const total = async () => Number((await attr(ids.threads.window, 'data-total')) ?? '-1')
const itemCount = () => page.locator(`[data-testid="${ids.threads.item}"]`).count()

// A phone viewport so the 2-col photo-book grid renders at real tile sizes (and 12 tiles overflow → scrollable).
await page.setViewportSize({ width: 390, height: 844 })

console.log('\nconverge: REAL threads.tsx INFINITE SCROLL — 24 seeded threads, windowed FlatList:')
await page.goto(`${rig.base}/?state=many&count=${N}`)

await check('grid renders with all 24 seeded (no silent seed shortfall)', async () => {
  // If the seeder falls short (e.g. a 402 mid-seed), threads-entry renders its fail-loud marker instead of the
  // screen, so the grid never appears → this check fails with the on-page reason (no silent under-seed).
  await d.waitFor(ids.threads.grid, { timeoutMs: 20000 }).catch(async () => {
    const body = await page.evaluate(() => document.body.innerText)
    throw new Error('grid never rendered — page says: ' + JSON.stringify(body.slice(0, 200)))
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await total()) === N) return
    await sleep(150)
  }
  throw new Error('data-total never reached ' + N + ' (got ' + (await total()) + ') — the collection was under-seeded')
})

await check('count subtitle shows the true total (24) with NO ∞', async () => {
  const s = await d.state(ids.threads.count)
  const text = s.text ?? ''
  if (/∞/.test(text)) throw new Error('count shows ∞: ' + JSON.stringify(text))
  if (!/\b24\b/.test(text) || !/catalogued/i.test(text)) throw new Error('count text=' + JSON.stringify(text))
})

let initialItems = 0
await check(`the window starts capped at ≤ ${PAGE} (NOT all ${N} at once — the loading fix)`, async () => {
  const s = await shown()
  if (s < 1 || s > PAGE) throw new Error(`initial window data-shown=${s}, expected 1..${PAGE}`)
  initialItems = await itemCount()
  if (initialItems < 1) throw new Error('no tiles mounted initially')
  if (initialItems > PAGE) throw new Error(`expected ≤ ${PAGE} tiles mounted initially, got ${initialItems}`)
})

await check('scrolling GROWS the window a page at a time until all 24 are revealed (infinite scroll)', async () => {
  const box = await page.locator(`[data-testid="${ids.threads.grid}"]`).first().boundingBox()
  if (!box) throw new Error('no grid bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  for (let i = 0; i < 20 && (await shown()) < N; i++) {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, 1800) // real wheel over the grid → onScroll → onEndReached → window += PAGE
    await sleep(220)
  }
  const s = await shown()
  if (s !== N) throw new Error(`window did not grow to ${N} on scroll (data-shown=${s}) — infinite scroll stalled`)
})

await check('the "loading more" footer resolves once the whole catalogue is revealed', async () => {
  const more = await page.locator(`[data-testid="${ids.threads.loadingMore}"]`).count()
  if (more !== 0) throw new Error('loadingMore footer still present after revealing all items')
})

await check('more tiles are mounted after scrolling than at first (the grid actually grew)', async () => {
  const after = await itemCount()
  if (after <= initialItems) throw new Error(`tiles did not grow: initial=${initialItems}, after=${after}`)
})

await check('no uncaught errors across the infinite-scroll journey', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// Scroll back to the top for a clean hero screenshot of the photo-book grid, then capture it for a visual read.
await page.mouse.wheel(0, -40000)
await sleep(400)
await page.screenshot({ path: SHOT })
console.log('screenshot →', SHOT)

await rig.stop()
console.log(
  fails() === 0
    ? '\nCOLLECTION SCROLL GREEN — 24 seeded; the window starts ≤12 and grows to 24 on real wheel-scroll (infinite scroll), count shows 24 (no ∞)'
    : `\nCOLLECTION SCROLL FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
