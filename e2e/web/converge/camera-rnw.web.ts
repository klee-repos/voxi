/**
 * camera-rnw.web.ts — CONVERGENCE PROOF for app/app/(tabs)/camera.tsx (companion to reveal-rnw.web.ts).
 *
 * Renders the REAL Expo camera screen (unmodified app source, real ui.tsx primitives, real Orb, real camera
 * permission seam, real ApiClient → real voxi-api BFF, real Zustand capture store) under react-native-web in a
 * real Chromium via Playwright, driven through the framework PlaywrightDriver by the SAME testIDs the harness
 * shell uses. The falsifiable claim: if the real camera screen renders its contract testIDs in the DOM and the
 * shutter drives a real deterministic behavior (real BFF createThread → navigation intent), the real camera
 * screen is E2E-testable behind the contract — server.ts's harness camera is swappable for it.
 *
 * Run: `bun e2e/web/converge/camera-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

// 5 scans seeded for the `converge` user (userId test:converge) so the shutter's createThread never 402s.
const rig = await standUp('camera-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

console.log('\nconverge: REAL app/app/(tabs)/camera.tsx under react-native-web + real BFF:')
await page.goto(`${rig.base}/`)

// The web permission seam starts `undetermined` then request() resolves to `granted`, so the granted viewfinder
// renders with the shutter. (camera.screen is the same id across the priming + granted states.)
await check('real camera screen renders its screen container (data-testid from RNW testID)', () =>
  d.waitFor(ids.camera.screen, { timeoutMs: 8000 }),
)
await check('granted viewfinder renders the real shutter affordance', () =>
  d.waitFor(ids.camera.shutter, { timeoutMs: 8000 }),
)
await check('real viewfinder renders the retake hint copy', async () => {
  const s = await d.state(ids.camera.retakeHint)
  if (!/one object|fill the frame/i.test(s.text ?? '')) throw new Error('retakeHint text=' + JSON.stringify(s.text))
})
// The granted home no longer docks a narrator orb (removed per redesign — it was the ambiguous top-right icon);
// instead it exposes the Recently-catalogued tray toggle. The narrator processing.orb now lives only on the
// priming/denied camera states and the processing screen.
await check('granted home exposes the Recently-catalogued tray toggle (icon button)', () =>
  d.waitFor(ids.camera.recentToggle, { timeoutMs: 3000 }),
)
await check('no uncaught errors while mounting the real camera tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// Deterministic behavior: tapping the REAL shutter calls api.signUpload + api.createThread on the REAL BFF
// (charges a scan from the seeded entitlement, real metering), then router.push('/processing'). We observe the
// real navigation intent via the expo-router shim's data-last-nav (the same seam reveal-rnw asserts on).
await check('shutter drives a real BFF createThread → navigation to /processing (expo-router seam)', async () => {
  // Tapping the REAL shutter calls api.signUpload + api.createThread on the REAL BFF (charges a scan from the
  // seeded entitlement — real metering), then router.push('/processing'). We observe the real navigation intent
  // via the expo-router shim's data-last-nav (the same seam reveal-rnw asserts on) and poll until the async
  // round-trip settles.
  await d.tap(ids.camera.shutter)
  const deadline = Date.now() + 8000
  let nav = ''
  while (Date.now() < deadline) {
    nav = (await page.evaluate(() => document.body.getAttribute('data-last-nav'))) ?? ''
    if (/processing/.test(nav)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('data-last-nav=' + JSON.stringify(nav))
})

await rig.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — real camera.tsx renders + is E2E-testable behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
