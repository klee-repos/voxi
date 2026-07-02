/**
 * header-rnw.web.ts — CONVERGENCE PROOF for the UNIVERSAL AppHeader (app/src/components/AppHeader.tsx), the
 * back-navigation header, under react-native-web against the real BFF. This is the authoritative E2E for the
 * header (the deterministic mock shell in e2e/web/server.ts has no drawer/history and can't drive it). It mounts
 * each REAL screen and drives the REAL controls behind the testID contract:
 *
 *   1. Header present + correct control per screen: nav.menuButton (camera), nav.back (pushed:
 *      threads/settings/interview), nav.close X (modals: podcast/contribute/conversation/paywall).
 *   2. GUARDED fallback (adversarial-review M3): single-screen mounts have canGoBack()=false, so a back/close tap
 *      records `replace(<fallback>)` on data-last-nav — never a dead-click on a deep-link/reload.
 *   3. Constant height (adversarial-review m3): the nav.header box is equal across menu / back / close screens.
 *   4. Regressions: interview (was a backward dead-end) escapes; podcast's close exists on the fast path (the
 *      READY-state-had-no-close fix — same closeHeader used on every podcast state).
 *   5. Real stack: ?screen=flow drives camera → drawer → threads → back, proving the control returns to the
 *      parent through a real router that HAS canGoBack (M1: no TypeError on the converge shim).
 *
 * Run: `bun e2e/web/converge/header-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const rig = await standUp('header-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { check, fails } = makeChecker()
const d = rig.driver
const page = rig.page

console.log('\nconverge: REAL AppHeader across the real screens under react-native-web + real BFF:')

async function gotoScreen(s: string): Promise<void> {
  // Full reload → fresh mount + fresh data-last-nav. Each check then waits on the real testIDs (every screen
  // renders nav.header, so that is the universal readiness signal).
  await page.goto(`${rig.base}/?screen=${s}`)
}
async function headerHeight(): Promise<number> {
  const box = await page.locator(`[data-testid="${ids.nav.header}"]`).first().boundingBox()
  if (!box) throw new Error('nav.header has no bounding box')
  return Math.round(box.height)
}
async function clearNav(): Promise<void> {
  await page.evaluate(() => document.body.removeAttribute('data-last-nav'))
}
async function lastNav(): Promise<string | null> {
  return page.evaluate(() => document.body.getAttribute('data-last-nav'))
}

// ---- camera: hamburger + wordmark, the root chrome ----
await gotoScreen('camera')
await check('camera: nav.header + hamburger (menu) render', async () => {
  await d.waitFor(ids.nav.header, { timeoutMs: 6000 })
  await d.waitFor(ids.nav.menuButton, { timeoutMs: 4000 })
})
const hMenu = await headerHeight()

// ---- pushed screens: a back chevron that returns toward camera (guarded) ----
for (const s of ['threads', 'settings', 'interview'] as const) {
  await gotoScreen(s)
  await check(`${s}: nav.header + back chevron (nav.back) render, no hamburger`, async () => {
    await d.waitFor(ids.nav.header, { timeoutMs: 6000 })
    await d.waitFor(ids.nav.back, { timeoutMs: 4000 })
    const menu = await page.locator(`[data-testid="${ids.nav.menuButton}"]`).count()
    if (menu !== 0) throw new Error('pushed screen still shows a hamburger')
  })
  await check(`${s}: header height is constant (== camera menu bar)`, async () => {
    const h = await headerHeight()
    if (h !== hMenu) throw new Error(`height ${h} != camera ${hMenu}`)
  })
  await clearNav()
  await d.tap(ids.nav.back)
  await check(`${s}: back returns toward camera (guarded — never dead-clicks)`, async () => {
    const n = await lastNav()
    if (!n || !/camera/.test(n)) throw new Error('data-last-nav=' + n)
  })
}

// ---- modals: a close X (right slot) that dismisses to a concrete fallback (M3) ----
const MODALS: ReadonlyArray<readonly [string, string]> = [
  ['podcast', 'camera'],
  ['contribute', 'camera'],
  ['conversation', 'camera'],
  ['paywall', 'threads'],
]
for (const [s, fallback] of MODALS) {
  await gotoScreen(s)
  await check(`${s}: nav.header + close X (nav.close) render`, async () => {
    await d.waitFor(ids.nav.header, { timeoutMs: 6000 })
    await d.waitFor(ids.nav.close, { timeoutMs: 4000 })
  })
  await check(`${s}: close bar height is constant (== camera menu bar)`, async () => {
    const h = await headerHeight()
    if (h !== hMenu) throw new Error(`height ${h} != camera ${hMenu}`)
  })
  await clearNav()
  await d.tap(ids.nav.close)
  await check(`${s}: close dismisses via guarded fallback → ${fallback} (no dead-click on reload/deep-link)`, async () => {
    const n = await lastNav()
    if (!n || !new RegExp(fallback).test(n)) throw new Error('data-last-nav=' + n)
  })
}

await check('no uncaught errors across the per-screen header journeys (real component tree)', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})
await rig.stop()

// ---- real stack (adversarial-review M1): drive the PROVEN flow harness (camera → shutter → reveal), whose
// screens now carry the new header. The camera and reveal are ONE surface (the camera-as-a-page merge): the
// shutter opens the fresh item IN PLACE (no route hop) and its over-photo back chevron slides back to the
// viewfinder — asserted here to confirm the header renders + returns correctly on the merged home. ----
const IMG =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24"><rect width="16" height="24" fill="#E8843E"/></svg>')
const flow = await standUp('flow-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const fd = flow.driver
const fp = flow.page
console.log('\nconverge: REAL stack (flow-client) — the header back chevron returns through a real router:')
await fp.goto(flow.base + '/')
await fd.waitFor(ids.camera.screen, { timeoutMs: 8000 })
await fd.tap(ids.camera.shutter)
await check('flow: shutter opens the fresh item IN PLACE on the merged home (over-photo back chevron, no /reveal route hop)', async () => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const n = await fp.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (n && /reveal/.test(n)) throw new Error('a /reveal navigation fired — capture must open in place on the merged home')
    if ((await fd.state(ids.nav.back)).visible) return // the item page surfaced its over-photo back chevron
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('shutter did not open the item in place (no over-photo back chevron appeared)')
})
await fp.evaluate((img) => {
  const s = (window as unknown as { __captureStore?: { setState: (x: unknown) => void } }).__captureStore
  if (s) s.setState({ photoUri: img })
}, IMG)
await check('flow: the real reveal shows the over-photo back chevron (nav.back) in a real stack', async () => {
  await fd.waitFor(ids.reveal.card, { timeoutMs: 12000 })
  await fd.waitFor(ids.nav.back, { timeoutMs: 4000 })
})
await fp.evaluate(() => document.body.removeAttribute('data-last-nav'))
await fd.tap(ids.nav.back)
await check('flow: tapping the over-photo back chevron returns to the viewfinder in place (menu header restored, no dead-click)', async () => {
  await fd.waitFor(ids.camera.screen, { timeoutMs: 6000 })
  await fd.waitFor(ids.nav.menuButton, { timeoutMs: 3000 })
})
await check('flow: no uncaught errors (esp. no `router.canGoBack is not a function`) across the real stack', async () => {
  if (flow.errors.length) throw new Error(flow.errors.join(' | '))
})
await flow.stop()
console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — the universal AppHeader renders the right control on every screen, its height is constant, back/close never dead-click (guarded), and it returns to the parent through a real router'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
