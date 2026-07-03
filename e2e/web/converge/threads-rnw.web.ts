/**
 * threads-rnw.web.ts — CONVERGENCE PROOF for app/app/(tabs)/threads.tsx (companion to reveal-rnw.web.ts).
 *
 * Renders the REAL Expo threads/collection screen (unmodified app source, real ui.tsx primitives, real TanStack
 * useQuery against the real ApiClient → real voxi-api BFF GET /v1/threads, real Zustand capture store) under
 * react-native-web in a real Chromium via Playwright, driven through the framework PlaywrightDriver by the SAME
 * testIDs the harness shell uses. Proves BOTH real states off the real BFF: the designed empty state and the
 * populated grid, plus the real revisit navigation. server.ts's harness threads screen is swappable for it.
 *
 * Run: `bun e2e/web/converge/threads-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { ids } from '../../framework/testids'
import { standUp, makeChecker } from './harness'

// Seed enough scans for the populated run's 3 real createThread calls.
const rig = await standUp('threads-client.tsx', { seed: { converge: { scan: 12, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, errors } = rig
const { check, fails } = makeChecker()

// ---------------------------------------------------------------------------
// State 1 — EMPTY: a fresh owner has no threads → the designed first-run empty state off the real BFF.
// ---------------------------------------------------------------------------
console.log('\nconverge: REAL app/app/(tabs)/threads.tsx under react-native-web + real BFF (EMPTY):')
await page.goto(`${rig.base}/`)

await check('real threads screen renders its screen container (data-testid from RNW testID)', () =>
  d.waitFor(ids.threads.screen, { timeoutMs: 8000 }),
)
await check('empty owner renders the designed empty state', () =>
  d.waitFor(ids.threads.emptyState, { timeoutMs: 8000 }),
)
await check('empty-state copy is the warm first-run invite and drops the ∞ motif', async () => {
  const s = await d.state(ids.threads.emptyState)
  const text = s.text ?? ''
  if (/∞/.test(text)) throw new Error('empty state still shows the ∞ symbol: ' + JSON.stringify(text.slice(0, 80)))
  if (!/awaits your first find|Nothing catalogued yet/i.test(text)) throw new Error('emptyState text=' + JSON.stringify(text.slice(0, 80)))
})
await check('empty state exposes the real capture CTA', () => d.waitFor(ids.threads.captureCta, { timeoutMs: 3000 }))
await check('no threads.item rendered when the collection is empty', async () => {
  const n = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
  if (n !== 0) throw new Error('expected 0 items, got ' + n)
})
await check('no uncaught errors while mounting the real empty threads tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})

// ---------------------------------------------------------------------------
// State 2 — POPULATED: the entry first creates 3 real threads on the real BFF, then the real useQuery lists them
// owner-scoped → the real date-grouped grid. (Same owner; the 3 captures now exist server-side.)
// ---------------------------------------------------------------------------
console.log('\nconverge: REAL threads.tsx (POPULATED — 3 real BFF threads, real owner-scoped listThreads):')
await page.goto(`${rig.base}/?state=populated`)

await check('populated collection renders the real grid container', () =>
  d.waitFor(ids.threads.grid, { timeoutMs: 10000 }),
)
await check('the real grid renders exactly the 3 seeded threads as threads.item tiles', async () => {
  const deadline = Date.now() + 8000
  let n = 0
  while (Date.now() < deadline) {
    n = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
    if (n === 3) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('expected exactly 3 threads.item tiles, got ' + n)
})
// The bottom "Capture another" button is GONE — the whole populated screen has no threads.captureCta (the empty +
// error states keep theirs; here the tab/drawer is the capture entry). Assert it is absent, not just off-screen.
await check('the populated collection has NO capture button (the bottom "Capture another" was removed)', async () => {
  const n = await page.locator(`[data-testid="${ids.threads.captureCta}"]`).count()
  if (n !== 0) throw new Error('expected 0 threads.captureCta on the populated grid, got ' + n)
})
// The count subtitle shows the real number of catalogued items and NO ∞ ("infinity" removed).
await check('the count subtitle reads "3 catalogued" — a real number, no ∞', async () => {
  const s = await d.state(ids.threads.count)
  const text = s.text ?? ''
  if (/∞/.test(text)) throw new Error('count still shows ∞: ' + JSON.stringify(text))
  if (!/\b3\b/.test(text) || !/catalogued/i.test(text)) throw new Error('count text=' + JSON.stringify(text))
})

// Deterministic behavior: tapping a real tile does the canonical REVISIT — reset(); setThread(id);
// router.push('/processing') — which re-streams the durable thread then hands off to /reveal|/interview
// (threads.tsx openThread; PLAN §3.2). Code is canonical; this assertion tracks the real revisit navigation.
await check('tapping a thread tile fires the real revisit navigation to /processing (expo-router seam)', async () => {
  await d.tap(ids.threads.item)
  const deadline = Date.now() + 6000
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
    ? '\nCONVERGE PROOF GREEN — real threads.tsx renders (empty + populated) + is E2E-testable behind the testID contract'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
