/**
 * drawer-rnw.web.ts — CONVERGENCE PROOF for the LEFT PUSH-DRAWER (app/src/components/Drawer.tsx `DrawerHost` +
 * `DrawerMenu`) wrapping the REAL camera screen, under react-native-web against the REAL BFF. Closes the "no
 * automated gate for the Tabs→DrawerHost swap" gap (UI-REDESIGN-PLAN Unresolved #7): the drawer is the app's
 * riskiest structural change, and neither the frozen mock shell nor the screen-body converge entries exercised
 * it. This mounts the real DrawerHost + camera (drawer-entry.tsx), taps the real hamburger, and asserts the real
 * menu opens and navigates behind the SAME testID contract.
 *
 * Run: `bun e2e/web/converge/drawer-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const rig = await standUp('drawer-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { check, fails } = makeChecker()
const d = rig.driver
const page = rig.page

console.log('\nconverge: REAL DrawerHost + camera.tsx under react-native-web + real BFF:')
await page.goto(rig.base + '/')

await check('the camera shell renders with the hamburger (drawer closed)', async () => {
  await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })
  await d.waitFor(ids.nav.menuButton, { timeoutMs: 3000 })
  await d.waitFor(ids.camera.shutter, { timeoutMs: 3000 })
})

await check('tapping the hamburger opens the drawer — menu + scrim + every row present', async () => {
  await d.tap(ids.nav.menuButton)
  await d.waitFor(ids.drawer.screen, { timeoutMs: 3000 })
  for (const id of [ids.drawer.scrim, ids.drawer.home, ids.nav.threadsTab, ids.nav.settingsTab, ids.drawer.signOut]) {
    const n = await page.locator(`[data-testid="${id}"]`).count()
    if (n < 1) throw new Error('missing drawer element: ' + id)
  }
})

await check('the real drawer greeting shows "Welcome" (the avatar became a greeting; no fake name)', async () => {
  const greeting = await page.locator(`[data-testid="${ids.nav.settingsTab}"]`).innerText()
  if (!/welcome/i.test(greeting)) throw new Error('greeting did not read "Welcome": ' + JSON.stringify(greeting))
})

await check('Collection row fires the real router.navigate to /(tabs)/threads (expo-router seam)', async () => {
  await d.tap(ids.nav.threadsTab)
  const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  if (!nav || !/threads/.test(nav)) throw new Error('data-last-nav=' + nav)
})

await check('no uncaught errors while mounting + driving the real drawer', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — real DrawerHost opens, reveals the menu, and navigates behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
