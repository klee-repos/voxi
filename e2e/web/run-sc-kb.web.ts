/**
 * Executable web E2E: interview + contributions + moderation (web parts). Drives the REAL BFF (voxi-api
 * createApp) + the web reference shell through the framework PlaywrightDriver in a real Chromium. Every
 * assertion bottoms out on real observable DOM state behind the real testIDs; the only injected collaborators
 * are the deterministic, seeded in-memory interview/contribution services in the harness — no stub forces a
 * green, no app internals are reached into, elements are located ONLY by ids from testids.ts.
 *
 * Covers docs/TEST-PLAN.md §9 rows:
 *   kb-01  interview capped at 2–3 Qs + skip/later + thread kept on bail (reached via the real UNKNOWN scan)
 *   kb-02  shared/private visibility toggle defaults to PRIVATE
 *   kb-03  add-a-tip status: TL0 → "a moderator will review"; TL2+ → "live now" (server-side trust gate)
 *   kb-04  report a tip → auto-hide on first report (banner reflects the BFF's autoHidden disposition)
 *
 * Structure mirrors e2e/web/run-auth.web.ts / run-agent-pw.web.ts: boot the harness via createWebHarness +
 * Bun.serve, drive via PlaywrightDriver, deterministic checks only, write a durable result file, set
 * process.exitCode, fail-closed on exceptions. Run: `bun e2e/web/run-sc-kb.web.ts`.
 */
import { chromium, type Browser } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Seed the contribution trust gate per-user: `qa` is TL0 (review queue), `trusted` is TL2 (goes live).
// userId is derived from the email local-part by the shell (token = `test:<local>`), so the emails below
// map to these seeded users. Nothing in the contribute / report / interview paths charges an entitlement.
const { fetch } = createWebHarness({ trust: { qa: 0, trusted: 2 } })
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`

const browser: Browser = await chromium.launch()

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

/** Open a fresh, isolated page (own context = own client state) and sign the given user in. */
async function signedInPage(opts: { email: string; scan?: string; hash?: string }) {
  const page = await (await browser.newContext()).newPage()
  const d = new PlaywrightDriver(page)
  const q = opts.scan ? `?scan=${opts.scan}` : ''
  const h = opts.hash ? `#/${opts.hash}` : ''
  await page.goto(base + q + h)
  await d.waitFor(ids.welcome.emailInput)
  await d.type(ids.welcome.emailInput, opts.email)
  await d.tap(ids.welcome.eulaAccept)
  await d.tap(ids.welcome.ageConfirm)
  await d.tap(ids.welcome.continueBtn) // → reveals OTP
  await d.waitFor(ids.welcome.otpInput)
  await d.type(ids.welcome.otpInput, '424242')
  await d.tap(ids.welcome.continueBtn) // → routes to startScreen (hash) or camera
  return { page, d }
}

try {
  log('web E2E — interview + contributions + moderation (real BFF + framework PlaywrightDriver):')

  // ---------------------------------------------------------------------------
  // kb-01 / kb-02 — UNKNOWN scan settles into the interview (the "first witness" path).
  // Real flow: camera → shutter → real NDJSON stream → band=UNKNOWN → openInterview() (which POSTs the real
  // /v1/interview with the just-created threadId). We assert the cap (2–3 Qs), the skip/later affordance,
  // the default-PRIVATE visibility, and that the thread is KEPT when the user bails out of the interview.
  // ---------------------------------------------------------------------------
  {
    const { page, d } = await signedInPage({ email: 'qa@voxi.test', scan: 'unknown' })

    await check('kb-01: UNKNOWN scan routes into the interview', async () => {
      await d.waitFor(ids.camera.screen)
      await d.tap(ids.camera.shutter)
      await d.waitFor(ids.interview.screen)
    })

    // First question present, with a why-asked rationale (trust/transparency).
    let q1Text = ''
    await check('kb-01: Q1 present with a why-asked rationale', async () => {
      const q = await d.state(ids.interview.question)
      q1Text = (q.text ?? '').trim()
      if (!q1Text) throw new Error('no question text shown')
      const why = await d.state(ids.interview.whyAsked)
      if (!/why i ask/i.test(why.text ?? '')) throw new Error('whyAsked missing: ' + JSON.stringify(why.text))
    })

    // kb-02 — visibility toggle DEFAULTS to private (checkbox unchecked; label "Private (only you)").
    await check('kb-02: visibility toggle defaults to PRIVATE (unchecked)', async () => {
      const toggle = await d.state(ids.interview.visibilityToggle)
      if (!toggle.visible) throw new Error('visibility toggle not visible on interview screen')
      const checked = await page.locator(`[data-testid="${ids.interview.visibilityToggle}"]`).isChecked()
      if (checked) throw new Error('visibility toggle defaulted to global/shared, expected private')
    })
    // (default-private is already proven above via the testid'd toggle's checked state — no brittle label read)

    // kb-01 — the cap: skip/later through the interview. The service caps Q-count at 2–3; we must NOT be
    // offered a 4th. Skip Q1 → a DISTINCT Q2 appears → skip Q2 → the capped interview ends. (Skip is the
    // "skip/later"/bail affordance; we exercise it via the real `interview.skip` testid only.)
    await check('kb-01: skipping Q1 advances to a DISTINCT Q2 (still within the 2–3 cap)', async () => {
      await d.tap(ids.interview.skip)
      // wait for the question text to change off Q1
      await page.waitForFunction(
        (prev) =>
          (document.querySelector('[data-testid="interview.question"]')?.textContent ?? '').trim() !== prev &&
          (document.querySelector('[data-testid="interview.question"]')?.textContent ?? '').trim().length > 0,
        q1Text,
        { timeout: 5000 },
      )
      const q2 = await d.state(ids.interview.question)
      if ((q2.text ?? '').trim() === q1Text) throw new Error('Q2 identical to Q1')
    })

    await check('kb-01: cap reached after Q2 → leaves the interview (no 4th question)', async () => {
      await d.tap(ids.interview.skip) // bail out of the (final) question
      // The interview screen must no longer be active; we should land on the collection.
      await d.waitFor(ids.interview.screen, { visible: false, timeoutMs: 5000 })
      await d.waitFor(ids.threads.screen, { timeoutMs: 5000 })
    })

    await check('kb-01: thread is KEPT on bail (the UNKNOWN capture is in the collection)', async () => {
      // loadThreads() ran on entering the collection; the seeded UNKNOWN scan persisted a thread row via the
      // real BFF /v1/threads. The grid must contain it (empty-state hidden).
      const grid = page.locator(`[data-testid="${ids.threads.grid}"] [data-testid="${ids.threads.item}"]`)
      await grid.first().waitFor({ state: 'visible', timeout: 5000 })
      const n = await grid.count()
      if (n < 1) throw new Error('collection empty after bail — thread was not kept')
      const empty = await d.state(ids.threads.emptyState)
      if (empty.visible) throw new Error('empty-state shown despite a kept thread')
    })

    await page.close()
  }

  // ---------------------------------------------------------------------------
  // kb-03 (TL0) — a low-trust contributor's tip is routed to human review: "a moderator will review".
  // The disposition is computed SERVER-side from the seeded trust level (0); the banner reflects the real
  // /v1/tips response (status=pending_review), never a client flag.
  // ---------------------------------------------------------------------------
  {
    const { page, d } = await signedInPage({ email: 'qa@voxi.test', hash: 'contribute' })

    await check('kb-03(TL0): contribute screen reachable', () => d.waitFor(ids.contribute.screen))
    await check('kb-03(TL0): submitting a tip → "a moderator will review" (pending_review)', async () => {
      await d.type(ids.contribute.tipInput, 'This is a 2008 SuperSix, the badge is under the seat tube.')
      await d.tap(ids.contribute.submit)
      // wait for the banner to be populated by the real BFF response
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="contribute.statusBanner"]')?.textContent ?? '').trim().length > 0,
        undefined,
        { timeout: 5000 },
      )
      const banner = await d.state(ids.contribute.statusBanner)
      if (banner.attrs['status'] !== 'pending_review')
        throw new Error('expected status=pending_review, got attrs=' + JSON.stringify(banner.attrs))
      if (!/moderator will review/i.test(banner.text ?? ''))
        throw new Error('banner text=' + JSON.stringify(banner.text))
    })

    await page.close()
  }

  // ---------------------------------------------------------------------------
  // kb-03 (TL2) — a trusted contributor's tip goes live immediately: "Live now".
  // Same screen, different SERVER-side trust level (2). The banner must read live + status=live.
  // ---------------------------------------------------------------------------
  {
    const { page, d } = await signedInPage({ email: 'trusted@voxi.test', hash: 'contribute' })

    await check('kb-03(TL2): contribute screen reachable', () => d.waitFor(ids.contribute.screen))
    await check('kb-03(TL2): submitting a tip → "Live now" (status=live)', async () => {
      await d.type(ids.contribute.tipInput, 'Confirmed: 2008 Cannondale SuperSix EVO, carbon frame.')
      await d.tap(ids.contribute.submit)
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="contribute.statusBanner"]')?.textContent ?? '').trim().length > 0,
        undefined,
        { timeout: 5000 },
      )
      const banner = await d.state(ids.contribute.statusBanner)
      if (banner.attrs['status'] !== 'live')
        throw new Error('expected status=live, got attrs=' + JSON.stringify(banner.attrs))
      if (!/live now/i.test(banner.text ?? '')) throw new Error('banner text=' + JSON.stringify(banner.text))
    })

    await check('kb-03: TL gate is differential — TL2 disposition differs from TL0', async () => {
      const banner = await d.state(ids.contribute.statusBanner)
      if (banner.attrs['trust'] !== '2') throw new Error('expected trust=2 on banner, got ' + JSON.stringify(banner.attrs))
    })

    await page.close()
  }

  // ---------------------------------------------------------------------------
  // kb-04 — reporting a catalog entry/tip auto-hides it on the FIRST report (<24h SLA). The harness wires the
  // real /v1/reports route → ContributionService.report → { autoHidden: true }; the banner must reflect that
  // the entry was pulled pending review (observable state change from a single report action).
  // ---------------------------------------------------------------------------
  {
    const { page, d } = await signedInPage({ email: 'qa@voxi.test', hash: 'contribute' })

    await check('kb-04: contribute screen reachable', () => d.waitFor(ids.contribute.screen))

    // Capture the REAL /v1/reports response so the UI assertion is tied to the server's disposition, not just
    // the client's optimistic banner. (Observing the network is not reaching into app internals.) We arm the
    // waiter BEFORE the action so the response is never missed, and read the parsed body from it.
    const reportResponse = page.waitForResponse(
      (res) => res.url().endsWith('/api/v1/reports') && res.request().method() === 'POST',
      { timeout: 5000 },
    )

    await check('kb-04: first report → entry auto-hidden pending review', async () => {
      // banner starts empty on entry (openContribute clears it)
      const before = await d.state(ids.contribute.statusBanner)
      if ((before.text ?? '').trim().length > 0) throw new Error('banner not clear on entry: ' + before.text)
      await d.tap(ids.contribute.reportBtn)
      await page.waitForFunction(
        () => /hidden pending review/i.test(document.querySelector('[data-testid="contribute.statusBanner"]')?.textContent ?? ''),
        undefined,
        { timeout: 5000 },
      )
      const banner = await d.state(ids.contribute.statusBanner)
      if (!/hidden pending review/i.test(banner.text ?? ''))
        throw new Error('expected auto-hide banner, got=' + JSON.stringify(banner.text))
    })

    await check('kb-04: the real BFF disposition for the first report is autoHidden=true', async () => {
      const res = await reportResponse
      const body = (await res.json().catch(() => null)) as { autoHidden?: boolean } | null
      if (body?.autoHidden !== true)
        throw new Error('real /v1/reports did not return autoHidden=true, got ' + JSON.stringify(body))
    })

    await page.close()
  }
} catch (e) {
  fails++
  log('  FATAL ' + (e as Error).message)
} finally {
  await browser.close()
  server.stop()
}

log(fails === 0 ? 'SC-KB WEB E2E GREEN' : `SC-KB WEB E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.sc-kb-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
