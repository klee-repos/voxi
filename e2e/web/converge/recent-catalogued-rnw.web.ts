/**
 * recent-catalogued-rnw.web.ts — CONVERGENCE PROOF for the camera-home "Recently catalogued" redesign. Renders
 * the REAL app/app/(tabs)/camera.tsx under react-native-web against the REAL voxi-api BFF, AFTER seeding a durable
 * capture WITH a real photo, and drives the floating `RecentCard` with real clicks:
 *
 *   toggle → card OPENS (data-open flips false→true) → the recent tile shows a persisted thumbnail the browser
 *   ACTUALLY DECODES (naturalWidth>0, DRY parity with the Collection grid) → tapping the tile REVISITS the item
 *   IN PLACE (the camera-as-a-page merge: the ONE home pager scrolls onto the item — no /reveal route hop), the
 *   store `photoUri` is SEEDED (the lost-photo regression guard), and the whole viewfinder overlay (RecentCard
 *   included) tears down as we leave the viewfinder, so its scrim can never block the shutter.
 *
 * This is the "no cheating" proof: real observable state (a decoded <img>, a real navigation intent, the real
 * store) through stable testIDs — the LLM never decides pass/fail. Run: `bun e2e/web/converge/recent-catalogued-rnw.web.ts`.
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

const SHOT = '/private/tmp/claude-501/-Users-kvnlee-dev-voxi/0561a9c9-e891-4d0c-acdb-945df355975e/scratchpad/recent-card-open.png'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rig = await standUp('recent-catalogued-client.tsx', { seed: { converge: { scan: 9, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

console.log('\nconverge: REAL camera.tsx RecentCard (floating) over the real BFF, with a seeded recent capture:')
await page.goto(`${rig.base}/`)

await check('camera home renders after seeding a durable recent capture', () => d.waitFor(ids.camera.screen, { timeoutMs: 20000 }))
await check('the Recently-catalogued toggle is present', () => d.waitFor(ids.camera.recentToggle, { timeoutMs: 5000 }))

await check('the RecentCard starts CLOSED (data-open=false)', async () => {
  // give the query a beat to settle so the card has content but stays closed until the toggle is tapped
  await sleep(400)
  const s = await d.state(ids.camera.recent)
  if (s.attrs?.open === 'true') throw new Error('card was open before the toggle was tapped: ' + JSON.stringify(s.attrs))
})

await check('tapping the toggle OPENS the floating RecentCard (data-open flips to true)', async () => {
  await d.tap(ids.camera.recentToggle)
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if ((await d.state(ids.camera.recent)).attrs?.open === 'true') return
    await sleep(100)
  }
  throw new Error('RecentCard did not open (data-open never true)')
})

await check('a recent tile renders (camera.recentItem — the shared CatalogTile, carousel variant)', () =>
  d.waitFor(ids.camera.recentItem, { timeoutMs: 5000 }),
)

await check('carousel tile keeps surface.card (#FBF9F3) — the sunken-bg polish is GRID-only (regression pin)', async () => {
  // CatalogTile is shared by the Collection grid + the camera carousel; the sunken-while-loading bg is variant-gated
  // to `grid`. Pin that the carousel tile's bg is still surface.card (#FBF9F3 = rgb(251,249,243)), NOT surface.sunken
  // (#EDEAE0 = rgb(237,234,224)) — a gate leak would shift the carousel tile hue on a shipped surface.
  const bg = await page.locator(`[data-testid="${ids.camera.recentItem}"]`).first().evaluate((el) => getComputedStyle(el).backgroundColor)
  if (!/251\s*,\s*249\s*,\s*243/.test(bg)) throw new Error('carousel tile bg=' + JSON.stringify(bg) + ' — expected surface.card rgb(251,249,243); the grid-only sunken gate leaked to the carousel')
})

await check('the recent tile shows a persisted thumbnail <img> that ACTUALLY DECODED (naturalWidth>0) — DRY with the Collection', async () => {
  const img = page.locator(`[data-testid="${ids.camera.recentItemPhoto}"] img`).first()
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const nw = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth).catch(() => 0)
    if (nw && nw > 0) return
    await sleep(150)
  }
  throw new Error('recent thumbnail <img> never decoded (naturalWidth 0) — the photo was not persisted/served or the tile is title-only')
})

await check('the tile carries the identified label from the durable reveal (never blank)', async () => {
  const s = await d.state(ids.camera.recentItem)
  if (!(s.text ?? '').trim()) throw new Error('recent tile label is blank: ' + JSON.stringify(s.text))
})

// Visual verification artifact — the real camera screen with the RecentCard open over it (design cleanliness).
await page.screenshot({ path: SHOT }).catch(() => {})
console.log(`   ↳ screenshot: ${SHOT}`)

await check('tapping a recent tile OPENS the item IN PLACE: no route hop + store.photoUri seeded + overlay tears down', async () => {
  const navBefore = (await page.evaluate(() => document.body.getAttribute('data-last-nav'))) ?? ''
  await d.tap(ids.camera.recentItem)
  // (a) NO navigation — the recent tile loads the item into the ONE home pager IN PLACE (the merge), scrolling off
  //     the viewfinder onto the item. The over-photo back chevron surfacing proves we left the viewfinder.
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if ((await d.state(ids.nav.back)).visible) break
    await sleep(100)
  }
  if (!(await d.state(ids.nav.back)).visible) throw new Error('recent tile did not open the item in place (no over-photo back chevron appeared)')
  const nav = (await page.evaluate(() => document.body.getAttribute('data-last-nav'))) ?? ''
  if (nav !== navBefore && /reveal|processing/.test(nav)) throw new Error('a navigation fired opening a recent tile — it must open in place: ' + JSON.stringify(nav))
  // (b) the lost-photo regression: revisit SEEDS the durable photo into the store (was reset() WITHOUT startCapture,
  //     so photoUri stayed null → a blank reveal). photoUrl is a signed /media URL, so the guard is simply non-null.
  const photoUri = await page.evaluate(
    () => (window as unknown as { __captureStore?: { getState: () => { photoUri: string | null } } }).__captureStore?.getState().photoUri ?? null,
  )
  if (!photoUri) throw new Error('revisit did not seed photoUri (was null) — the lost-photo bug')
  // (c) leaving the viewfinder tears down the RecentCard overlay entirely, so its scrim can never block the shutter.
  if ((await d.state(ids.camera.recent)).visible) throw new Error('the RecentCard overlay is still mounted after opening an item — its scrim would block the shutter')
})

// ---- UPDATE LOGIC: a brand-new capture must APPEAR in Recently catalogued (the reported bug) ----
// The Home is a persistent surface (never remounts), so a bare staleTime never refetches it; onShutter must
// invalidateQueries(['threads']) after createThread or the newest capture never shows. Prove the list grows.
// We are on the item page from the previous check — slide back to the viewfinder to reach the shutter + tray.
await check('a NEW capture APPEARS in Recently catalogued — the collection query refetches after createThread', async () => {
  const count = () => page.locator(`[data-testid="${ids.camera.recentItem}"]`).count()
  // back to the viewfinder, open the tray, count the baseline
  await d.tap(ids.nav.back)
  await d.waitFor(ids.camera.screen, { timeoutMs: 6000 })
  await d.tap(ids.camera.recentToggle)
  await d.waitFor(ids.camera.recentItem, { timeoutMs: 5000 })
  let before = 0
  { const dl = Date.now() + 3000; while (Date.now() < dl) { before = await count(); if (before > 0) break; await sleep(120) } }
  // close the tray (its scrim would swallow the shutter tap), then photograph a NEW object
  await d.tap(ids.camera.recentClose)
  await sleep(300)
  await d.tap(ids.camera.shutter) // web shutter → real BFF createThread (a new durable thread), opens the item in place
  // the capture opens the item in place; slide back to the viewfinder and re-open the tray to see the grown list
  await d.waitFor(ids.nav.back, { timeoutMs: 10000 })
  await d.tap(ids.nav.back)
  await d.waitFor(ids.camera.screen, { timeoutMs: 6000 })
  await d.tap(ids.camera.recentToggle)
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if ((await count()) > before) return
    await sleep(200)
  }
  throw new Error(`recent list did not grow after a new capture (stayed ${before}) — invalidateQueries(['threads']) missing`)
})

await check('no uncaught errors across the recent-card journey', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — the floating RecentCard opens, renders a decoded thumbnail (DRY CatalogTile), and revisit seeds the photo + closes the card — all real, behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
