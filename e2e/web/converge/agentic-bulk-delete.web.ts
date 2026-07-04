/**
 * agentic-bulk-delete.web.ts — multi-select bulk delete over the REAL collection grid (Google/Apple-Photos pattern).
 *
 * An autonomous Agent navigates the REAL screens (sign-in → 2 real captures so the grid has ≥2 tiles → drawer to
 * the collection), then the deterministic layer drives + pins the multi-select flow:
 *   1. header "Select" enters selection mode — the title + count STAY, Select swaps to a header [Delete (red)] [Done];
 *   2. long-press the FIRST tile selects it; tapping the SECOND DISTINCT tile (.nth(1) — d.tap targets .first()
 *      which would just deselect #1) selects a second;
 *   3. the header Delete opens a two-step ConfirmDialog ("Delete 2 items?");
 *   4. the destructive confirm commits; the grid shrinks by 2 (read off the threads.window data-total anchor —
 *      REAL cache-derived state, not a mock) and selection mode exits.
 *
 * Every value that matters is pinned deterministically (selected-tile count via [data-selected="true"], grid total
 * via the window anchor) — the LLM never decides pass/fail. Two real captures (no pre-seed stub) honor the
 * no-fake-green invariant. Run: `bun e2e/web/converge/agentic-bulk-delete.web.ts` (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent } from '../../framework/agent'
import { ids } from '../../framework/testids'
import { makeSignInPlanner, makeDrawerNavPlanner, capturePlanner, CONVERGE_EMAIL } from './agentic-shared'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'

const { check, fails } = makeChecker()
const rig = await standUp('app-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const shotDir = path.resolve(process.cwd(), '.full-send/bulk-delete-shots')
const shoot = async (name: string): Promise<void> => {
  try { mkdirSync(shotDir, { recursive: true }); writeFileSync(path.join(shotDir, name + '.png'), await d.screenshot(name)) } catch { /* shots are a visual aid, not an assertion */ }
}

const items = () => page.locator(`[data-testid="${ids.threads.item}"]`)
const selectedItems = () => page.locator(`[data-testid="${ids.threads.item}"][data-selected="true"]`)
const windowTotal = async (): Promise<number> => Number((await d.state(ids.threads.window)).attrs.total ?? '0')

console.log('\nagentic BULK-DELETE — real sign-in → 2 real captures → multi-select + two-step delete:')
await page.goto(`${base}/?scan=confident`)
await d.waitFor(ids.welcome.screen, { timeoutMs: 8000 })

// AGENTIC: sign in to the real camera.
await new Agent(d, makeSignInPlanner(CONVERGE_EMAIL)).achieve('sign in and reach the camera', { maxSteps: 22, settleMs: 250 })

// Two REAL captures so the collection grid has ≥2 tiles to multi-select (no pre-seed stub — the no-cheat path).
await new Agent(d, capturePlanner).achieve('capture object #1', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 })
await d.tap(ids.nav.back) // reveal → camera (the reveal IS the camera tab; back returns to the viewfinder)
await d.waitFor(ids.camera.shutter, { timeoutMs: 5000 })
await new Agent(d, capturePlanner).achieve('capture object #2', { maxSteps: 4, settleMs: 150 })
await d.waitFor(ids.reveal.card, { timeoutMs: 15000 })

// AGENTIC: open the collection through the real drawer (reveal → camera → hamburger → Collection row).
await new Agent(d, makeDrawerNavPlanner(ids.nav.threadsTab, ids.threads.screen)).achieve('open the collection', { maxSteps: 10, settleMs: 250 })
await d.waitFor(ids.threads.item, { timeoutMs: 8000 })

const totalBefore = await windowTotal()
await check('the collection has at least 2 tiles to multi-select', async () => {
  if (totalBefore < 2) throw new Error(`only ${totalBefore} tile(s) after 2 captures`)
})

// Enter selection mode via the header "Select" button (the visible door; long-press is the shortcut).
await shoot('00-normal-grid') // visual proof: the populated grid BEFORE selection (diagnose borders/separation)
// DOM ground truth for the "Select" right-alignment: distance-from-right-edge of Select vs the grid container.
// They must match (both on the space.xl right gutter) — the symmetric counterpart of the hamburger's left nudge.
const align = await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="threads.selectEntry"]')
  const grid = document.querySelector('[data-testid="threads.grid"]')
  const item = document.querySelector('[data-testid="threads.item"]')
  if (!sel || !grid) return null
  const s = sel.getBoundingClientRect()
  const g = grid.getBoundingClientRect()
  const t = item?.getBoundingClientRect()
  const vw = window.innerWidth
  return { vw, selectRightFromEdge: Math.round(vw - s.right), gridRightFromEdge: Math.round(vw - g.right), tileRightFromEdge: t ? Math.round(vw - t.right) : null, selectLeft: Math.round(s.left) }
})
console.log('ALIGN_DOM', JSON.stringify(align))
await d.tap(ids.threads.selectEntry)
await d.waitFor(ids.threads.bulkDelete, { timeoutMs: 3000 }) // Select → header Delete + Done (no bottom bar)
await shoot('01-select-empty') // visual proof: selection mode just entered, 0 selected, title+count still up

await check('the "Select" button enters selection mode WITHOUT changing the screen (title + count stay; Select→Delete+Done in the header; circles appear)', async () => {
  // the title + count are STILL mounted (select mode must not hide them):
  const count = await d.state(ids.threads.count)
  if (!count.visible) throw new Error('"N catalogued" count disappeared on entering select mode (screen must not change)')
  // Select became Delete + Done in the header (no bottom bar):
  const del = await d.state(ids.threads.bulkDelete)
  if (!del.visible) throw new Error('header Delete not visible in select mode')
  const done = await d.state(ids.threads.cancelSelect)
  if (!done.visible) throw new Error('header Done not visible in select mode')
  // every visible tile carries data-selected="false" (a selection circle is shown, none selected yet):
  const unselected = await page.locator(`[data-testid="${ids.threads.item}"][data-selected="false"]`).count()
  if (unselected < 2) throw new Error(`expected ≥2 unselected-circle tiles, got ${unselected}`)
  if ((await selectedItems().count()) !== 0) throw new Error('a tile was selected on entry (should be none)')
})

// Long-press the FIRST tile (d.hold targets .first() — exactly the tile we want).
await d.hold(ids.threads.item, 600)
await check('long-pressing the first tile selects it (1 selected)', async () => {
  const n = await selectedItems().count()
  if (n !== 1) throw new Error(`expected 1 selected after long-press, got ${n}`)
})

// B2: select a SECOND, DISTINCT tile. d.tap(ids.threads.item) targets .first() → would deselect #1. Address the
// second tile by index (the run-sc-threads.web.ts established `.nth()` pattern; lint-clean).
await items().nth(1).click()
await check('tapping the SECOND tile selects it too (2 selected; Delete button label reflects the count)', async () => {
  const n = await selectedItems().count()
  if (n !== 2) throw new Error(`expected 2 selected, got ${n}`)
  const del = (await d.state(ids.threads.bulkDelete)).text ?? ''
  if (!/delete 2/i.test(del.trim())) throw new Error(`Delete button label "${del}"`)
})

// Two-step delete — STEP 1: the HEADER Delete opens the confirm.
// GROUND-TRUTH DOM read (vision models misread state — this is unambiguous): dump the actual rendered styles so
// the verify step doesn't depend on a vision model's reading of a screenshot.
const domTruth = await page.evaluate(() => {
  const header = document.querySelector('[data-testid="nav.header"]')
  const del = document.querySelector('[data-testid="threads.bulkDelete"]')
  const tile = document.querySelector('[data-testid="threads.item"]')
  const cs = (el: Element | null) => { if (!el) return null; const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor } }
  return {
    headerText: (header?.textContent ?? '').trim().slice(0, 80),
    deleteBg: del ? getComputedStyle(del).backgroundColor : null,
    deleteText: (del?.textContent ?? '').trim(),
    deleteCs: cs(del),
    tileBorder: tile ? getComputedStyle(tile).borderTopWidth + ' ' + getComputedStyle(tile).borderTopStyle + ' ' + getComputedStyle(tile).borderTopColor : null,
  }
})
console.log('GROUND_TRUTH_DOM', JSON.stringify(domTruth))
await shoot('02-two-selected') // visual proof: 2 selected (blue checks) + header Delete/Done
await d.tap(ids.threads.bulkDelete)
await d.waitFor(ids.threads.deleteConfirm, { timeoutMs: 3000 })
await shoot('03-two-step-confirm') // visual proof: the destructive confirm dialog ("Delete 2 items?")
await check('step 1: the header Delete opens the confirm ("Delete 2 items?")', async () => {
  const title = (await d.state(ids.threads.deleteConfirm)).text ?? ''
  if (!/delete 2 items/i.test(title)) throw new Error(`confirm title "${title}"`)
})

// STEP 2: the destructive confirm commits the bulk delete.
await d.tap(ids.threads.deleteConfirmAccept)

await check('step 2: confirming deletes BOTH tiles (rendered tile count = totalBefore − 2)', async () => {
  // Read the rendered tile count directly (the cache-derived window anchor unmounts when the grid empties to the
  // designed empty state, which would make a window-anchor read auto-wait + time out). The tiles ARE the rendered
  // cache, so their count is the honest observable.
  let ok = false
  for (let i = 0; i < 30; i++) {
    if ((await items().count()) === totalBefore - 2) { ok = true; break }
    await sleep(150)
  }
  if (!ok) throw new Error(`tile count never reached ${totalBefore - 2} (started ${totalBefore})`)
})

if (totalBefore === 2) {
  await check('deleting the WHOLE collection lands on the designed empty state', async () => {
    await d.waitFor(ids.threads.emptyState, { timeoutMs: 5000 })
  })
}

await check('a clean bulk delete exits selection mode (Done no longer in the header)', async () => {
  // Done (threads.cancelSelect) only renders in select mode. After a clean delete it's gone — whether the grid
  // returned to Select (partial delete) or the whole collection emptied to the empty state (which has no
  // right-action at all). Either way, Done disappearing = exited.
  let exited = false
  for (let i = 0; i < 30; i++) {
    const done = await d.state(ids.threads.cancelSelect)
    if (!done.visible) { exited = true; break }
    await sleep(100)
  }
  if (!exited) throw new Error('selection mode did not exit (Done still visible)')
})

await check('no uncaught errors across the real bulk-delete journey', async () => {
  if (rig.errors.length) throw new Error(rig.errors.join(' | '))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC BULK-DELETE GREEN — an agent captured 2 real objects, multi-selected both (long-press + a distinct second tile), and two-step-deleted them (grid −2, selection exited)'
    : `\nAGENTIC BULK-DELETE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
