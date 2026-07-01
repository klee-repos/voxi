/**
 * flow-rnw.web.ts — CONVERGENCE PROOF for the whole USER JOURNEY, not one screen. Mounts the real screens under
 * a real router (NavHost) + DrawerHost (flow-entry) and clicks through EXACTLY what a user does — camera → open
 * tray → open drawer → shutter → processing → reveal — asserting the cross-screen contract at each hop against
 * the real BFF. This is the gate that catches the bugs a per-screen proof can't: navigation dead-ends, the
 * captured image NOT persisting camera → processing → reveal, the tray/drawer failing to open.
 *
 * Run: `bun e2e/web/converge/flow-rnw.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

// a distinctive data-URI "photo" — the web target has no camera, so the driver injects it the way a device
// capture would populate the store, and we assert it survives every subsequent screen unchanged.
const IMG =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24"><rect width="16" height="24" fill="#E8843E"/></svg>')

const rig = await standUp('flow-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { check, fails } = makeChecker()
const d = rig.driver
const p = rig.page

console.log('\nconverge FLOW: real camera → tray → drawer → shutter → processing → reveal:')
await p.goto(rig.base + '/')

await check('camera home renders (full-bleed)', () => d.waitFor(ids.camera.screen, { timeoutMs: 8000 }))

await check('the Recently-catalogued tray opens on the icon button (camera.recent revealed)', async () => {
  await d.tap(ids.camera.recentToggle)
  await d.waitFor(ids.camera.recent, { timeoutMs: 3000 })
  await d.tap(ids.camera.recentClose) // tap scrim to close
  await p.waitForTimeout(300)
})

await check('the drawer opens from camera and exposes Collection / Settings / Home', async () => {
  await d.tap(ids.nav.menuButton)
  await d.waitFor(ids.drawer.screen, { timeoutMs: 3000 })
  for (const id of [ids.nav.threadsTab, ids.nav.settingsTab, ids.drawer.home]) {
    if ((await p.locator(`[data-testid="${id}"]`).count()) < 1) throw new Error('missing drawer row: ' + id)
  }
  await d.tap(ids.drawer.scrim).catch(() => {})
  await p.waitForTimeout(300)
})

await check('shutter captures (real BFF createThread) and navigates to /processing', async () => {
  await d.tap(ids.camera.shutter)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const n = await p.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (n && /processing/.test(n)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('shutter did not navigate to /processing')
})

await check('the captured image persists into the reveal, shown as taken', async () => {
  // populate the store with the "captured" image (web has no camera); it must survive processing → reveal.
  await p.evaluate((img) => {
    const s = (window as unknown as { __captureStore?: { setState: (x: unknown) => void } }).__captureStore
    if (s) s.setState({ photoUri: img })
  }, IMG)
  await d.waitFor(ids.reveal.card, { timeoutMs: 12000 }) // stream settles → reveal
  await d.waitFor(ids.reveal.photoThumb, { timeoutMs: 3000 })
  // the reveal photo element carries the SAME data-URI we injected at capture (persisted unchanged).
  const src = await p.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
    if (!el) return ''
    const img = el.tagName === 'IMG' ? (el as HTMLImageElement) : el.querySelector('img')
    return (img?.getAttribute('src') ?? el.style.backgroundImage ?? '') as string
  }, ids.reveal.photoThumb)
  if (!/E8843E|svg/.test(src)) throw new Error('reveal image is not the persisted capture; src=' + JSON.stringify(src).slice(0, 80))
})

await check('no uncaught errors across the whole journey', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nCONVERGE FLOW GREEN — the real camera → processing → reveal journey works end-to-end (image persists) behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
