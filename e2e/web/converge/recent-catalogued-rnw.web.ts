/**
 * recent-catalogued-rnw.web.ts — CONVERGENCE PROOF for the camera-home "Recently catalogued" redesign. Renders
 * the REAL app/app/(tabs)/camera.tsx under react-native-web against the REAL voxi-api BFF, AFTER seeding a durable
 * capture WITH a real photo, and drives the floating `RecentCard` with real clicks:
 *
 *   toggle → card OPENS (data-open flips false→true) → the recent tile shows a persisted thumbnail the browser
 *   ACTUALLY DECODES (naturalWidth>0, DRY parity with the Collection grid) → tapping the tile REVISITS: real nav
 *   to /processing, the store `photoUri` is SEEDED (the lost-photo regression guard), and the card CLOSES on tap
 *   (the shared revisit hook is state-agnostic, so RecentCard clears its own open state — otherwise its scrim
 *   would block the shutter on return to the camera tab).
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

await check('tapping a recent tile REVISITS: nav /processing + store.photoUri seeded + card CLOSES', async () => {
  await d.tap(ids.camera.recentItem)
  // (a) real navigation intent
  const deadline = Date.now() + 6000
  let nav = ''
  while (Date.now() < deadline) {
    nav = (await page.evaluate(() => document.body.getAttribute('data-last-nav'))) ?? ''
    if (/processing/.test(nav)) break
    await sleep(100)
  }
  if (!/processing/.test(nav)) throw new Error('data-last-nav=' + JSON.stringify(nav))
  // (b) the lost-photo regression: revisit SEEDS the durable photo into the store (was reset() WITHOUT startCapture,
  //     so photoUri stayed null → a blank reveal). photoUrl is a signed /media URL, so the guard is simply non-null.
  const photoUri = await page.evaluate(
    () => (window as unknown as { __captureStore?: { getState: () => { photoUri: string | null } } }).__captureStore?.getState().photoUri ?? null,
  )
  if (!photoUri) throw new Error('revisit did not seed photoUri (was null) — the lost-photo bug')
  // (c) the card closed on the tile tap (RecentCard clears its own open state; the shared hook can't)
  const s = await d.state(ids.camera.recent)
  if (s.attrs?.open === 'true') throw new Error('RecentCard stayed OPEN after a tile tap — its scrim would block the shutter on return')
})

// ---- UPDATE LOGIC: a brand-new capture must APPEAR in Recently catalogued (the reported bug) ----
// The camera is a persistent tab (never remounts), so a bare staleTime never refetches it; onShutter must
// invalidateQueries(['threads']) after createThread or the newest capture never shows. Prove the list grows.
await check('a NEW capture APPEARS in Recently catalogued — the collection query refetches after createThread', async () => {
  const count = () => page.locator(`[data-testid="${ids.camera.recentItem}"]`).count()
  const before = await count()
  await d.tap(ids.camera.shutter) // web shutter → real BFF createThread (a new durable thread)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if ((await count()) > before) return
    await sleep(150)
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
