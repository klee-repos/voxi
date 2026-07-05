/**
 * settings-rnw.web.ts — CONVERGENCE PROOF for the REAL Settings screen
 * (`app/app/(tabs)/settings.tsx`) under react-native-web against the REAL BFF. A standalone focused proof (the
 * drawer-rnw pattern) that the cleanup did what was asked and only that: the plan/subscription + privacy rows
 * are GONE, the two Preferences toggles remain (and reduce-motion still drives the real document flag), and the
 * account actions (Sign out, Apple-required Delete account) are present. Written standalone so it does NOT depend
 * on the reveal flow or the mock-shell auth path (both blocked by separate in-flight work).
 *
 * Run: `bun e2e/web/converge/settings-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const rig = await standUp('settings-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { check, fails } = makeChecker()
const d = rig.driver
const page = rig.page

console.log('\nconverge: REAL Settings screen under react-native-web + real BFF:')
await page.goto(rig.base + '/')

await check('the real Settings screen renders with its Title', async () => {
  await d.waitFor(ids.settings.screen, { timeoutMs: 8000 })
})

await check('Preferences survived: Reduce motion + Speak results aloud toggles are present', async () => {
  if (!(await d.state(ids.settings.reduceMotion)).visible) throw new Error('reduceMotion toggle missing')
  if (!(await d.state(ids.settings.speakAloud)).visible) throw new Error('speakAloud toggle missing')
})

await check('Reduce motion toggle is tappable (the ✓ checked glyph appears on tap)', async () => {
  const toggle = page.locator(`[data-testid="${ids.settings.reduceMotion}"]`)
  const before = (await toggle.textContent()) ?? ''
  if (before.includes('✓')) throw new Error('reduceMotion already checked at default: ' + JSON.stringify(before))
  await d.tap(ids.settings.reduceMotion)
  const after = (await toggle.textContent()) ?? ''
  if (!after.includes('✓')) throw new Error('reduceMotion toggle did not render its ✓ glyph after tap: ' + JSON.stringify(after))
})

await check('the account actions are present (Sign out + Delete account — Apple-required)', async () => {
  if (!(await d.state(ids.settings.signOut)).visible) throw new Error('signOut button missing')
  if (!(await d.state(ids.settings.deleteAccount)).visible) throw new Error('deleteAccount button missing')
})

await check('the plan/subscription + privacy rows are GONE (no counts, no Upgrade, no facial-recognition blurb)', async () => {
  const text = (await page.locator(`[data-testid="${ids.settings.screen}"]`).innerText()).toLowerCase()
  const banned = ['scan', 'podcast', 'voice min', 'upgrade', 'facial recognition', 'face recognition', 'redact']
  const hit = banned.find((b) => text.includes(b))
  if (hit) throw new Error(`removed content still present — screen text mentions "${hit}": ` + JSON.stringify(text))
})

await check('no uncaught errors while mounting + driving the real Settings screen', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — real Settings: plan/privacy gone, Preferences + account actions present, reduce-motion honored'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
