/**
 * reveal-menu.web.ts — E2E over the REAL reveal ⋯ MORE menu (delete + regenerate) on the actual `app/app/reveal.tsx`
 * under react-native-web: real Zustand store, real ApiClient → the real voxi-api `createApp` (via the converge
 * harness), driven by real testID taps with every outcome pinned deterministically (the converge rule: navigate by
 * the live tree, never decide pass/fail by vibes).
 *
 * Proves, with real clicks on the real screen:
 *   1. the ⋯ (nav.more) opens the MORE sheet with BOTH actions (Regenerate + Delete, destructive last);
 *   2. REGENERATE → confirm dialog → accept → the dark LOADING overlay REAPPEARS (a real re-stream, the honest
 *      discriminator — a stale title is always visible) → a fresh reveal re-settles;
 *   3. DELETE is TWO-STEP (menu row → a separate confirm dialog → the destructive accept), and committing removes the
 *      item and slides to the viewfinder IN PLACE (no router navigation — the adversarial-flagged failure mode).
 *
 * Run: `bun e2e/web/converge/reveal-menu.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const { check, fails } = makeChecker()
const rig = await standUp('client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig

const lastNav = (): Promise<string | null> => page.evaluate(() => document.body.getAttribute('data-last-nav'))

// A CONFIDENT reveal renders on an item page (real capture → band-steered → real store → the real reveal.tsx).
await page.goto(`${base}/?scan=confident`)
await d.waitFor(ids.reveal.buckets, { timeoutMs: 8000 })
await d.waitFor(ids.reveal.title, { timeoutMs: 6000 })

await check('the ⋯ (nav.more) opens the MORE sheet with Regenerate + Delete', async () => {
  await d.tap(ids.nav.more)
  await d.waitFor(ids.reveal.moreMenu, { timeoutMs: 3000 })
  if (!(await d.state(ids.reveal.menuRegenerate)).visible) throw new Error('Regenerate row missing from the sheet')
  if (!(await d.state(ids.reveal.menuDelete)).visible) throw new Error('Delete row missing from the sheet')
})

await check('Regenerate → confirm dialog → accept → the loading overlay REAPPEARS (real re-run) → a fresh reveal re-settles', async () => {
  await d.tap(ids.reveal.menuRegenerate)
  await d.waitFor(ids.reveal.regenConfirm, { timeoutMs: 3000 })
  await d.tap(ids.reveal.regenConfirmAccept)
  // The dark loading overlay comes back — proof the live cascade RE-RAN (not a cached repaint of the same title).
  await d.waitFor(ids.processing.loadingLine, { timeoutMs: 8000 })
  // …and a fresh reveal re-settles in place.
  await d.waitFor(ids.reveal.title, { timeoutMs: 12000 })
  if (!(await d.state(ids.reveal.buckets)).visible) throw new Error('the dock did not return after regenerate')
})

await check('Delete is two-step (menu → confirm dialog); the destructive accept removes the item and returns to the viewfinder IN PLACE (no navigation)', async () => {
  await d.tap(ids.nav.more)
  await d.waitFor(ids.reveal.moreMenu, { timeoutMs: 3000 })
  await d.tap(ids.reveal.menuDelete)
  // Step 2: a SEPARATE confirmation dialog — deletion has NOT happened yet (this is the two-step guarantee).
  await d.waitFor(ids.reveal.deleteConfirm, { timeoutMs: 3000 })
  if ((await d.state(ids.camera.screen)).visible) throw new Error('the item vanished before the confirm — delete is not two-step')
  const navBefore = await lastNav()
  await d.tap(ids.reveal.deleteConfirmAccept)
  // The item is gone; we're on the viewfinder, reached by an in-place scroll — NOT a router hop (adversarial #6/#8).
  await d.waitFor(ids.camera.screen, { timeoutMs: 6000 })
  await page.waitForTimeout(350) // let a (buggy) synchronous nav/reset settle
  const navAfter = await lastNav()
  if (navAfter && navAfter !== navBefore && /reveal|processing|threads|camera/.test(navAfter)) {
    throw new Error('delete fired a navigation — it must slide to the viewfinder in place: ' + navAfter)
  }
  if ((await d.state(ids.reveal.title)).visible) throw new Error('the deleted item still shows its title — the store was not reset')
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nREVEAL MENU PROOF GREEN — real taps on the real reveal screen: the ⋯ sheet opened with both actions, Regenerate re-ran the live cascade (loading overlay reappeared → fresh reveal), and the two-step Delete removed the item and slid to the viewfinder in place (no nav), every outcome pinned deterministically'
    : `\nREVEAL MENU FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
