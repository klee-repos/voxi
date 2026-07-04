/**
 * flow-rnw.web.ts — CONVERGENCE PROOF for the whole USER JOURNEY, not one screen. Mounts the real screens under
 * a real router (NavHost) + DrawerHost (flow-entry) and clicks through EXACTLY what a user does — camera → open
 * tray → open drawer → shutter → item (IN PLACE, the camera-as-a-page merge) — asserting the cross-screen
 * contract at each hop against the real BFF. This is the gate that catches the bugs a per-screen proof can't:
 * navigation dead-ends, the captured image NOT persisting into the item, the tray/drawer failing to open.
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

console.log('\nconverge FLOW: real camera → tray → drawer → shutter → reveal (loading overlay in place):')
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

await check('shutter captures (real BFF createThread) and opens the fresh item IN PLACE (no route hop, loading overlay over the SAME surface)', async () => {
  // The camera-as-a-page merge: the viewfinder and the item reveal are ONE pager on ONE surface, so a fresh
  // capture scrolls onto the new item with NO navigation — nothing to remount or fade. The over-photo back
  // chevron (nav.back) surfacing proves the pager advanced off the viewfinder onto the item.
  await d.tap(ids.camera.shutter)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const n = await p.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (n && /reveal/.test(n)) throw new Error('a /reveal navigation fired — the merged capture must open in place, not route')
    if ((await d.state(ids.nav.back)).visible) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('shutter did not open the item in place (no over-photo back chevron appeared)')
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

// A read/write handle on the REAL capture store (exposed by flow-entry) — used to observe reset timing across a
// REAL NavHost screen swap (where reveal actually unmounts), which the single-screen reveal proof can't exercise.
type StoreHandle = { getState: () => { threadId: string | null }; setState: (x: unknown) => void }
const readThreadId = (pg: typeof p): Promise<string | null> =>
  pg.evaluate(() => (window as unknown as { __captureStore?: StoreHandle }).__captureStore?.getState().threadId ?? null)

// ── Exit rig A: the merged home. Tapping back on an item slides to the viewfinder IN PLACE — the Home never
//    unmounts and the item is DELIBERATELY PRESERVED (it stays one swipe away, the whole point of the merge), so
//    there is no store reset and structurally no empty-branch flash. NO navigation fires. ──
console.log('\nconverge FLOW: reveal → back → viewfinder IN PLACE, item preserved (no unmount, no nav):')
const rigA = await standUp('flow-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
{
  const da = rigA.driver
  const pa = rigA.page
  await pa.goto(rigA.base + '/')
  await da.waitFor(ids.camera.screen, { timeoutMs: 8000 })
  await da.tap(ids.camera.shutter)
  await da.waitFor(ids.reveal.card, { timeoutMs: 12000 })
  await da.waitFor(ids.nav.back, { timeoutMs: 8000 }) // the fresh item's over-photo back chevron
  let threadId0: string | null = null
  await check('the READY item has a threadId before sliding back', async () => {
    threadId0 = await readThreadId(pa)
    if (!threadId0) throw new Error('expected a threadId on the READY item')
  })
  await check('tapping back slides to the viewfinder IN PLACE, PRESERVING the item (no unmount, no navigation)', async () => {
    await pa.evaluate(() => document.body.removeAttribute('data-last-nav'))
    await da.tap(ids.nav.back)
    await da.waitFor(ids.camera.screen, { timeoutMs: 5000 }) // the viewfinder surfaced
    if (!(await da.state(ids.reveal.card)).visible) throw new Error('reveal.card unmounted on back — the Home must be one persistent surface')
    const nav = await pa.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (nav && /camera|reveal|processing/.test(nav)) throw new Error('a navigation fired sliding back to the viewfinder (merge violated): ' + nav)
    if ((await readThreadId(pa)) !== threadId0) throw new Error('the item was cleared on back — the merge must keep it one swipe away')
  })
}
await rigA.stop()

// ── Exit rig B: the reveal→/processing retry must PRESERVE the store (adversarial regression guard). A blanket
//    unmount reset would wipe threadId here and strand the user on a dead processing screen. ──
console.log('\nconverge FLOW: unavailable bucket → /processing KEEPS threadId (no blanket unmount reset):')
const rigB = await standUp('flow-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
{
  const db = rigB.driver
  const pb = rigB.page
  await pb.goto(rigB.base + '/')
  await db.waitFor(ids.camera.screen, { timeoutMs: 8000 })
  await db.tap(ids.camera.shutter)
  await db.waitFor(ids.reveal.card, { timeoutMs: 12000 })
  let threadId0: string | null = null
  await check('capture the reveal threadId, then force a post-band research DROP (buckets → unavailable)', async () => {
    threadId0 = await readThreadId(pb)
    if (!threadId0) throw new Error('expected a threadId on the READY reveal')
    // a post-band stream drop settles loading buckets to `unavailable` (retriable) — force it deterministically.
    await pb.evaluate(() =>
      (window as unknown as { __captureStore?: StoreHandle }).__captureStore?.setState({
        researchError: true,
        researchComplete: false,
        sections: {},
        facts: [],
        sawAnySection: false,
        whatItIs: '',
      }),
    )
    await db.waitFor(ids.reveal.buckets, { timeoutMs: 3000 })
  })
  await check('tapping Details when research dropped routes to /processing WITHOUT wiping the store (threadId survives)', async () => {
    // The research lane collapsed to Details; with all buckets forced unavailable (the dropped-stream case), the
    // Details aggregate reads 'empty' and F2 routes its tap to /processing to resume the stream.
    await db.waitFor(ids.reveal.detailsIcon, { timeoutMs: 3000 })
    await db.tap(ids.reveal.detailsIcon)
    await db.waitFor(ids.processing.screen, { timeoutMs: 5000 })
    const now = await readThreadId(pb)
    if (now !== threadId0) throw new Error(`threadId must survive reveal→/processing (blanket-reset regression); was ${threadId0}, now ${now}`)
  })
}
await rigB.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE FLOW GREEN — the merged camera→item journey works end-to-end in place (image persists, no route hop), sliding back to the viewfinder preserves the item, and a reveal→/processing retry preserves the store'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
