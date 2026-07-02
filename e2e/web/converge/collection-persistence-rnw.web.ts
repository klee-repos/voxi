/**
 * collection-persistence-rnw.web.ts — CONVERGENCE PROOF that a past collection item durably keeps its PHOTO and
 * its GENERATED CONTENT, rendered by the REAL Expo screens over the REAL voxi-api BFF (COLLECTION-PERSISTENCE).
 *
 * This is the "like a real user" proof the fix is about: a real capture with a REAL photo persists its bytes +
 * its reveal; the real collection grid then shows a thumbnail <img> the browser ACTUALLY DECODES (naturalWidth>0)
 * plus the identified label — and both SURVIVE a full page reload (a fresh JS context, so the data provably lives
 * server-side, not in the page's memory). Tapping the tile fires the real revisit navigation. The server-restart
 * durability (close→reopen the durable store) is proven at the integration layer in app-persistence.test.ts.
 *
 * Run: `bun e2e/web/converge/collection-persistence-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const rig = await standUp('collection-persistence-client.tsx', { seed: { converge: { scan: 9, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll the DESCENDANT <img> (RNW/expo-image put the testID on the wrapper; the <img> carries naturalWidth). */
async function thumbnailDecoded(timeoutMs = 10000): Promise<number> {
  const img = page.locator(`[data-testid="${ids.threads.itemPhoto}"] img`).first()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const nw = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0)
    if (nw && nw > 0) return nw
    await sleep(150)
  }
  return 0
}
async function tileCount(): Promise<number> {
  return page.locator(`[data-testid="${ids.threads.item}"]`).count()
}
async function waitTiles(n: number, timeoutMs = 9000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let got = 0
  while (Date.now() < deadline) {
    got = await tileCount()
    if (got === n) return
    await sleep(150)
  }
  throw new Error(`expected ${n} tile(s), got ${got}`)
}

console.log('\nconverge: REAL capture (real photo) → durable thumbnail + identified label, over the real BFF:')
await page.goto(`${rig.base}/`)

await check('the collection grid renders after a real capture', () => d.waitFor(ids.threads.grid, { timeoutMs: 15000 }))
await check('exactly ONE durable capture tile', () => waitTiles(1))
await check('the tile shows a persisted thumbnail <img> that ACTUALLY DECODED from the signed /media URL (naturalWidth>0)', async () => {
  const nw = await thumbnailDecoded()
  if (!nw) throw new Error('thumbnail <img> never decoded (naturalWidth 0) — the photo was not persisted/served')
})
await check('the tile carries the identified label from the durable reveal (never the "Untitled capture" stub)', async () => {
  const s = await d.state(ids.threads.item)
  const t = (s.text ?? '').trim()
  if (!t || /Untitled capture/.test(t)) throw new Error('tile label=' + JSON.stringify(t.slice(0, 80)))
})
await check('no uncaught errors mounting the real capture → collection tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// ---- durability: a full page RELOAD (fresh JS context, same durable BFF) still shows the capture ----
console.log('\nconverge: RELOAD (fresh JS context) — the capture lives SERVER-SIDE, not in page memory:')
await page.reload()
await check('after a reload the collection STILL renders exactly one tile (durable, re-fetched from the BFF)', () => waitTiles(1, 15000))
await check('the persisted thumbnail STILL decodes after the reload (photo bytes are durable + re-served)', async () => {
  const nw = await thumbnailDecoded()
  if (!nw) throw new Error('thumbnail did not reload after a fresh page context')
})
await check('the identified label STILL shows after the reload', async () => {
  const s = await d.state(ids.threads.item)
  if (/Untitled capture/.test(s.text ?? '') || !(s.text ?? '').trim()) throw new Error('label lost on reload: ' + JSON.stringify(s.text))
})

// ---- revisit: tapping a tile fires the real revisit navigation (which hydrates the durable photo + replays) ----
// A known-band tile revisits straight to /reveal (READY from the cached band, no /processing detour); the reveal
// surface owns the replay stream (LOADING-EXPERIENCE-PLAN §3).
await check('tapping the tile fires the real revisit navigation to /reveal', async () => {
  await d.tap(ids.threads.item)
  const deadline = Date.now() + 6000
  let nav = ''
  while (Date.now() < deadline) {
    nav = (await page.evaluate(() => document.body.getAttribute('data-last-nav'))) ?? ''
    if (/reveal/.test(nav)) return
    await sleep(100)
  }
  throw new Error('data-last-nav=' + JSON.stringify(nav))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — a real capture persists its photo + reveal; the real collection shows a decoded thumbnail + the identified label, survives a full reload, and revisits — all through the real screens + real BFF'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
