/**
 * Web E2E — Threads / collection (TEST-PLAN §8). Drives the REAL BFF + web shell through the framework
 * PlaywrightDriver in real Chromium. Covers:
 *   thread-01  empty-collection state ("0 of ∞") with a capture CTA
 *   thread-02  populated grid + auto-titled, date-(createdAt-)ordered threads
 *   thread-03  revisit a thread → durable eve session continues (history intact), asserted via the BFF
 *
 * Pattern copied from run-auth.web.ts / run-coverage.web.ts: boot the harness via createWebHarness + Bun.serve,
 * drive via PlaywrightDriver, deterministic checks only, write a durable result file, set process.exitCode.
 * Fail-closed on any exception. Every selector comes from the testID registry; the durable-session and
 * date-ordering claims are asserted against the real BFF (GET /v1/threads, GET /v1/threads/:id), never internals.
 *
 * Run: `bun e2e/web/run-sc-threads.web.ts`.
 */
import { chromium, type Page } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Generous entitlements so a single user can capture several threads without tripping the scan cap.
const generous = { scan: 20, podcast: 5, voiceMin: 10 }
const { fetch } = createWebHarness({
  seed: {
    emptythreads: generous,
    collector: generous,
  },
})
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`

const browser = await chromium.launch()

let fails = 0
const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    log('  PASS ' + name)
  } catch (e) {
    fails++
    log('  FAIL ' + name + ' :: ' + (e as Error).message)
  }
}

/** Authenticate a fresh page for a user + seeded object, optionally landing on a direct screen route. */
async function authedPage(user: string, scan: string, route = ''): Promise<{ page: Page; d: PlaywrightDriver }> {
  const page = await (await browser.newContext()).newPage()
  const d = new PlaywrightDriver(page)
  await page.goto(`${base}/?scan=${scan}${route ? '#/' + route : ''}`)
  await d.waitFor(ids.welcome.emailInput)
  await d.type(ids.welcome.emailInput, `${user}@voxi.test`)
  await d.tap(ids.welcome.eulaAccept)
  await d.tap(ids.welcome.ageConfirm)
  await d.tap(ids.welcome.continueBtn)
  await d.waitFor(ids.welcome.otpInput)
  await d.type(ids.welcome.otpInput, '424242')
  await d.tap(ids.welcome.continueBtn)
  return { page, d }
}

/** Authenticated call straight to the REAL BFF (the same Hono app the UI drives), for server-side assertions. */
function bff(user: string, path: string): Promise<Response> {
  return fetch(
    new Request(`${base}/api${path}`, { headers: { authorization: `Bearer test:${user}` } }),
  )
}

log('web E2E — threads/collection (real BFF + framework PlaywrightDriver):')

// ============================================================================
// thread-01 — empty-collection state ("0 of ∞") with capture CTA.
// ============================================================================
{
  // A fresh user with zero captures lands directly on the collection screen.
  const { page, d } = await authedPage('emptythreads', 'probable', 'threads')

  await check('thread-01: lands on the collection screen', () => d.waitFor(ids.threads.screen))
  await check('thread-01: empty-collection state is shown', () => d.waitFor(ids.threads.emptyState))
  await check('thread-01: empty copy reads "0 of ∞"', async () => {
    const s = await d.state(ids.threads.emptyState)
    if (!/0 of ∞/.test(s.text ?? '')) throw new Error('emptyState text=' + JSON.stringify(s.text))
  })
  await check('thread-01: a capture CTA is present and visible', async () => {
    const s = await d.state(ids.threads.captureCta)
    if (!s.visible) throw new Error('captureCta not visible')
    if (!/capture/i.test(s.text ?? '')) throw new Error('captureCta text=' + JSON.stringify(s.text))
  })
  await check('thread-01: the grid holds no items yet', async () => {
    const cnt = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
    if (cnt !== 0) throw new Error('expected 0 items, got ' + cnt)
  })
  // Server-side ground truth: the BFF collection for this user is genuinely empty (not just hidden in the UI).
  await check('thread-01: BFF /v1/threads returns an empty collection', async () => {
    const r = await bff('emptythreads', '/v1/threads')
    if (r.status !== 200) throw new Error('status=' + r.status)
    const body = (await r.json()) as { threads: unknown[] }
    if (body.threads.length !== 0) throw new Error('threads=' + JSON.stringify(body.threads))
  })
  // The CTA actually routes to the camera (so the empty state is escapable, not a dead end).
  await check('thread-01: capture CTA opens the camera', async () => {
    await d.tap(ids.threads.captureCta)
    await d.waitFor(ids.camera.screen)
  })
  await page.close()
}

// ============================================================================
// thread-02 — populated grid + auto-titled, date-(createdAt-)ordered threads.
// ============================================================================
{
  // Capture three objects; each capture mints a real thread row in the BFF with an auto-title + createdAt.
  const { page, d } = await authedPage('collector', 'confident')
  await d.waitFor(ids.camera.screen)

  const captures = 3
  for (let i = 0; i < captures; i++) {
    if (i > 0) {
      await d.tap(ids.threads.captureCta) // tab-bar capture → camera
      await d.waitFor(ids.camera.screen)
      // distinct timestamps so the deterministic sessionIds + createdAt never collide on the same ms.
      await page.waitForTimeout(40)
    }
    await d.tap(ids.camera.shutter)
    await d.waitFor(ids.reveal.card)
  }

  await d.tap(ids.nav.threadsTab)
  await d.waitFor(ids.threads.screen)

  await check('thread-02: populated grid is shown (empty state gone)', async () => {
    await d.waitFor(ids.threads.grid)
    const empty = await d.state(ids.threads.emptyState)
    if (empty.visible) throw new Error('emptyState still visible on a populated collection')
  })
  await check('thread-02: grid renders one item per capture', async () => {
    const cnt = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
    if (cnt !== captures) throw new Error('expected ' + captures + ' items, got ' + cnt)
  })
  await check('thread-02: every item is auto-titled (non-empty, the "Capture ·" title)', async () => {
    const items = page.locator(`[data-testid="${ids.threads.item}"]`)
    const cnt = await items.count()
    for (let i = 0; i < cnt; i++) {
      const t = ((await items.nth(i).textContent()) ?? '').trim()
      if (!t) throw new Error('item ' + i + ' has an empty title')
      if (!/Capture\s+·/.test(t)) throw new Error('item ' + i + ' not auto-titled: ' + JSON.stringify(t))
    }
  })
  await check('thread-02: every item carries a durable thread id (data-thread.id)', async () => {
    const items = page.locator(`[data-testid="${ids.threads.item}"]`)
    const cnt = await items.count()
    const seen = new Set<string>()
    for (let i = 0; i < cnt; i++) {
      const id = await items.nth(i).getAttribute('data-thread.id')
      if (!id) throw new Error('item ' + i + ' missing data-thread.id')
      seen.add(id)
    }
    if (seen.size !== cnt) throw new Error('thread ids not unique: ' + cnt + ' items, ' + seen.size + ' ids')
  })
  // Date-grouping ground truth: the BFF returns each thread's createdAt and orders newest-first, so the grid
  // can group/sort by day. Assert the ordering invariant against the REAL BFF (the data behind the grouping).
  await check('thread-02: BFF returns threads newest-first with a createdAt per thread', async () => {
    const r = await bff('collector', '/v1/threads')
    if (r.status !== 200) throw new Error('status=' + r.status)
    const body = (await r.json()) as { threads: { threadId: string; title: string; createdAt: number }[] }
    if (body.threads.length !== captures) throw new Error('count=' + body.threads.length)
    for (const t of body.threads) {
      if (typeof t.createdAt !== 'number') throw new Error('thread missing createdAt: ' + JSON.stringify(t))
      if (!/Capture\s+·/.test(t.title)) throw new Error('thread not auto-titled: ' + JSON.stringify(t.title))
    }
    const times = body.threads.map((t) => t.createdAt)
    const sortedDesc = [...times].sort((a, b) => b - a)
    if (JSON.stringify(times) !== JSON.stringify(sortedDesc)) {
      throw new Error('threads not date-ordered newest-first: ' + JSON.stringify(times))
    }
  })
  // The grid order must MATCH the BFF's newest-first order (the UI honours the date sort, not a random order).
  await check('thread-02: grid order matches the BFF newest-first order', async () => {
    const r = await bff('collector', '/v1/threads')
    const body = (await r.json()) as { threads: { threadId: string }[] }
    const bffOrder = body.threads.map((t) => t.threadId)
    const gridOrder = await page
      .locator(`[data-testid="${ids.threads.item}"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-thread.id')))
    if (JSON.stringify(gridOrder) !== JSON.stringify(bffOrder)) {
      throw new Error('grid=' + JSON.stringify(gridOrder) + ' bff=' + JSON.stringify(bffOrder))
    }
  })

  // ==========================================================================
  // thread-03 — revisit a thread → durable session continues (history intact), asserted via the BFF.
  // ==========================================================================
  await check('thread-03: revisiting an item opens its reveal card', async () => {
    await page.locator(`[data-testid="${ids.threads.item}"]`).first().click()
    await d.waitFor(ids.reveal.card)
  })
  await check('thread-03: the revisited card is marked as resuming a durable session', async () => {
    // the revisit fetch is async; wait for the reveal card to carry the durable resume marker.
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        return !!el && el.getAttribute('data-resumes') === 'true' && el.offsetParent !== null
      },
      `[data-testid="${ids.reveal.card}"]`,
      { timeout: 5000 },
    )
  })

  // Capture the revisited thread id off the reveal card, then assert the DURABLE session via the BFF directly.
  const revisitedId = await page
    .locator(`[data-testid="${ids.reveal.card}"]`)
    .getAttribute('data-thread.id')

  await check('thread-03: BFF GET /v1/threads/:id resumes the SAME durable session', async () => {
    if (!revisitedId) throw new Error('no data-thread.id on the reveal card')
    const r = await bff('collector', '/v1/threads/' + revisitedId)
    if (r.status !== 200) throw new Error('status=' + r.status)
    const body = (await r.json()) as {
      threadId: string
      title: string
      continuationToken: string
      resumes: boolean
    }
    if (body.threadId !== revisitedId) throw new Error('threadId mismatch: ' + body.threadId)
    if (body.resumes !== true) throw new Error('resumes=' + body.resumes)
    if (!body.continuationToken) throw new Error('no durable continuationToken — history not resumable')
    if (!/Capture\s+·/.test(body.title)) throw new Error('title not preserved: ' + JSON.stringify(body.title))
  })
  await check('thread-03: the durable session belongs ONLY to its owner (cross-user revisit denied)', async () => {
    if (!revisitedId) throw new Error('no revisitedId')
    // A different authenticated user must NOT be able to resume collector's session.
    const r = await bff('emptythreads', '/v1/threads/' + revisitedId)
    if (r.status === 200) throw new Error('cross-user revisit was allowed (status 200) — ACL breach')
    if (r.status !== 403 && r.status !== 404) throw new Error('unexpected status=' + r.status)
  })
  await check('thread-03: history survives a fresh app load (durable, not in-page state)', async () => {
    // Reload the SPA (drops all in-page JS state) and re-enter the collection: the thread is still there,
    // proving persistence lives in the BFF, not the page.
    const reload = await (await browser.newContext()).newPage()
    const rd = new PlaywrightDriver(reload)
    await reload.goto(`${base}/?scan=confident#/threads`)
    await rd.waitFor(ids.welcome.emailInput)
    await rd.type(ids.welcome.emailInput, 'collector@voxi.test')
    await rd.tap(ids.welcome.eulaAccept)
    await rd.tap(ids.welcome.ageConfirm)
    await rd.tap(ids.welcome.continueBtn)
    await rd.waitFor(ids.welcome.otpInput)
    await rd.type(ids.welcome.otpInput, '424242')
    await rd.tap(ids.welcome.continueBtn)
    await rd.waitFor(ids.threads.grid)
    const cnt = await reload.locator(`[data-testid="${ids.threads.item}"]`).count()
    if (cnt !== captures) throw new Error('after reload expected ' + captures + ' items, got ' + cnt)
    await reload.close()
  })

  await page.close()
}

await browser.close()
server.stop()
log(fails === 0 ? '\nWEB SC-THREADS E2E GREEN' : `\nWEB SC-THREADS E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.sc-threads-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
