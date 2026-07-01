/**
 * Web E2E — REVEAL CARD + PROCESSING STATES (deterministic backbone).
 *
 * Drives the REAL BFF (voxi-api createApp) + the web reference shell through the framework PlaywrightDriver in
 * a real Chromium. Every outcome (REVEAL/PARTIAL/INTERVIEW/longWait/failure/safety-refusal) is selected by the
 * seeded object carried through the real NDJSON stream — never forced, never stubbed-to-green.
 *
 * TEST-PLAN rows covered (surface = W):
 *   reveal-01  leads with a specific title + band-colored chip (title-led hierarchy, not photo-hero).
 *   reveal-02  exactly ONE primary action on the card; "How sure?" hidden when CONFIDENT.
 *   reveal-03  "How sure?" auto-elevates ONLY in PROBABLE; evidence panel reads as Voxi "working".
 *   reveal-04  confidence-chip color (warm gold) ≠ safety-refusal color (caution red) — distinct, real CSS.
 *   reveal-05  user correction of the ID feeds the catalog (a real server-side write via the correction flow).
 *   proc-02    PARTIAL "confident maybe" — title is the hedge and is NOT silently mutated by the streamed prose.
 *   proc-03    INTERVIEW branch (UNKNOWN → orb-curious → Q&A opens, default-private visibility).
 *   proc-04    >8–12s wait → in-persona long-wait ack (no dead spinner), then a real settle.
 *   proc-06    hard failure (quota/refusal) → in-persona failure state + next action (retry).
 *
 * Pattern copied EXACTLY from run-auth.web.ts / run-coverage.web.ts: boot the harness via createWebHarness +
 * Bun.serve, drive via PlaywrightDriver, deterministic checks only, write a durable result file, set
 * process.exitCode. Fail-closed: any thrown exception is a FAIL, and a top-level catch marks the run failed.
 *
 * Run: `bun e2e/web/run-sc-reveal-proc.web.ts`.
 */
import { chromium, type Page } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Generous scans so a fresh page per scenario never hits the metering cap (cap is exercised in run-auth).
const generous = { scan: 20, podcast: 5, voiceMin: 10 }
const { fetch } = createWebHarness({
  seed: { qa: generous },
  trust: {}, // qa is TL0 → a correction/tip routes to human review (the real, server-decided disposition).
})
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`

const browser = await chromium.launch()

let fails = 0
let total = 0
const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}
async function check(name: string, fn: () => Promise<void>) {
  total++
  try {
    await fn()
    log('  PASS ' + name)
  } catch (e) {
    fails++
    log('  FAIL ' + name + ' :: ' + (e as Error).message)
  }
}

/** Authenticate a fresh page for a seeded object, optionally landing on a direct screen route post-auth. */
async function authedPage(scan: string, route = ''): Promise<{ page: Page; d: PlaywrightDriver }> {
  const page = await (await browser.newContext()).newPage()
  const d = new PlaywrightDriver(page)
  await page.goto(`${base}/?scan=${scan}${route ? '#/' + route : ''}`)
  await d.waitFor(ids.welcome.emailInput)
  await d.type(ids.welcome.emailInput, 'qa@voxi.test')
  await d.tap(ids.welcome.eulaAccept)
  await d.tap(ids.welcome.ageConfirm)
  await d.tap(ids.welcome.continueBtn)
  await d.waitFor(ids.welcome.otpInput)
  await d.type(ids.welcome.otpInput, '424242')
  await d.tap(ids.welcome.continueBtn)
  return { page, d }
}

/** Capture once on a seeded object and wait for the reveal card to rise from the real stream. */
async function captureToReveal(scan: string): Promise<{ page: Page; d: PlaywrightDriver }> {
  const { page, d } = await authedPage(scan)
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await d.waitFor(ids.reveal.card)
  return { page, d }
}

/** Computed style of an element's named CSS property, from the live DOM. */
function computed(page: Page, id: string, prop: string): Promise<string> {
  return page.locator(`[data-testid="${id}"]`).first().evaluate(
    (el, p) => getComputedStyle(el as Element).getPropertyValue(p as string).trim(),
    prop,
  )
}

log('web E2E — reveal + processing states (real BFF + real NDJSON stream):')

// Fail-closed: any exception thrown OUTSIDE a check() (e.g. during auth/setup) is caught here, counted as a
// failure, and still writes the durable result + non-zero exit — the run can never silently pass on a crash.
try {

// ============================================================================
// reveal-01 — title-led hierarchy + band-colored chip (NOT a photo-hero).
// ============================================================================
{
  const { page, d } = await captureToReveal('probable')

  await check('reveal-01: leads with a SPECIFIC title (the band hedge), not an empty/placeholder', async () => {
    const t = await d.state(ids.reveal.title)
    if (!t.visible) throw new Error('title not visible')
    if (!(t.text && t.text.trim().length > 0)) throw new Error('title is empty: ' + JSON.stringify(t.text))
    if (!/confident maybe/i.test(t.text)) throw new Error('PROBABLE title should be the hedge, got: ' + t.text)
  })

  await check('reveal-01: confidence chip is band-colored from the real stream (data-band=PROBABLE)', async () => {
    const c = await d.state(ids.reveal.confidenceChip)
    if (!c.visible) throw new Error('chip not visible')
    if (c.attrs.band !== 'PROBABLE') throw new Error('chip band=' + JSON.stringify(c.attrs))
    // the chip actually carries a non-transparent background (the warm-gold band color, not bare text).
    const bg = await computed(page, ids.reveal.confidenceChip, 'background-color')
    if (!bg || /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) throw new Error('chip has no band color: ' + bg)
  })

  await check('reveal-01: title-led hierarchy — title comes BEFORE the photo thumb in the DOM order', async () => {
    // Title leads the card; the photo is a thumbnail beneath it (anti photo-hero). Asserted on real layout order.
    const order = await page.evaluate(
      (sel) => {
        const title = document.querySelector(`[data-testid="${sel.title}"]`)
        const thumb = document.querySelector(`[data-testid="${sel.thumb}"]`)
        if (!title || !thumb) return null
        // Node.DOCUMENT_POSITION_FOLLOWING (4) means thumb follows title in document order.
        return (title.compareDocumentPosition(thumb) & 4) !== 0
      },
      { title: ids.reveal.title, thumb: ids.reveal.photoThumb },
    )
    if (order === null) throw new Error('title or thumb missing')
    if (order !== true) throw new Error('photo thumb is not after the title (photo-hero regression)')
  })

  await page.close()
}

// ============================================================================
// reveal-02 — exactly ONE primary action; "How sure?" hidden when CONFIDENT.
// ============================================================================
{
  // PROBABLE card: assert there is exactly ONE primary CTA on the reveal card (single primary action rule).
  const { page, d } = await captureToReveal('probable')
  await check('reveal-02: exactly ONE primary action on the reveal card', async () => {
    const primaryCount = await page
      .locator('[data-testid="reveal.card"] button.primary:visible')
      .count()
    if (primaryCount !== 1) throw new Error('expected exactly 1 primary action, got ' + primaryCount)
    // and it is the generate-story primary, with "Add a tip" present but NOT primary (secondary).
    if (!(await d.state(ids.reveal.primaryAction)).visible) throw new Error('primaryAction missing')
    const addTipPrimary = await page
      .locator(`[data-testid="${ids.reveal.addTip}"]`)
      .first()
      .evaluate((el) => (el as HTMLElement).classList.contains('primary'))
    if (addTipPrimary) throw new Error('"Add a tip" must be SECONDARY, not primary')
  })
  await page.close()
}
{
  // CONFIDENT card: "How sure?" must be HIDDEN (the band is certain — no hedge affordance needed).
  const { page, d } = await captureToReveal('confident')
  await check('reveal-02: CONFIDENT band → "How sure?" is hidden', async () => {
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'CONFIDENT') throw new Error('band=' + JSON.stringify(c.attrs))
    if ((await d.state(ids.reveal.howSure)).visible) throw new Error('"How sure?" must be hidden when CONFIDENT')
  })
  await page.close()
}

// ============================================================================
// reveal-03 — "How sure?" auto-elevates ONLY in PROBABLE; evidence panel = Voxi "working".
// ============================================================================
{
  const { page, d } = await captureToReveal('probable')
  await check('reveal-03: PROBABLE → "How sure?" is auto-elevated (visible)', async () => {
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'PROBABLE') throw new Error('band=' + JSON.stringify(c.attrs))
    if (!(await d.state(ids.reveal.howSure)).visible) throw new Error('"How sure?" should be auto-elevated in PROBABLE')
  })
  await check('reveal-03: evidence panel hidden until asked, then reads as Voxi cross-checking sources', async () => {
    if ((await d.state(ids.reveal.evidencePanel)).visible) throw new Error('evidence panel should start hidden')
    await d.tap(ids.reveal.howSure)
    await d.waitFor(ids.reveal.evidencePanel)
    const ev = await d.state(ids.reveal.evidencePanel)
    if (!/cross-check|sources|settle|working/i.test(ev.text ?? ''))
      throw new Error('evidence panel does not read as Voxi working: ' + ev.text)
  })
  await page.close()
}

// ============================================================================
// reveal-04 — chip color (warm gold) ≠ safety-refusal color (caution red).
// Two real renders compared by their actual computed CSS colors.
// ============================================================================
{
  // (a) read the confidence-chip color off a real PROBABLE reveal.
  const { page: pChip, d: dChip } = await captureToReveal('probable')
  const chipBg = await computed(pChip, ids.reveal.confidenceChip, 'background-color')
  const chipBand = (await dChip.state(ids.reveal.confidenceChip)).attrs.band
  await pChip.close()

  // (b) read the safety-refusal color off a real refusal render (the 'pill' object).
  const { page: pRef, d: dRef } = await authedPage('pill')
  await dRef.waitFor(ids.camera.screen)
  await dRef.tap(ids.camera.shutter)
  await dRef.waitFor(ids.global.safetyRefusal)
  const refusalBorder = await computed(pRef, ids.global.safetyRefusal, 'border-top-color')
  const refusalVisible = (await dRef.state(ids.global.safetyRefusal)).visible
  // On the refusal render the confidence chip must carry NO band (it is suppressed, not recolored).
  const chipOnRefusal = await dRef.state(ids.reveal.confidenceChip)
  await pRef.close()

  await check('reveal-04: a real PROBABLE chip color was captured (warm gold band)', async () => {
    if (chipBand !== 'PROBABLE') throw new Error('expected PROBABLE chip, got band=' + chipBand)
    if (!chipBg || /transparent|rgba?\(0,\s*0,\s*0,\s*0\)/.test(chipBg)) throw new Error('no chip color: ' + chipBg)
  })
  await check('reveal-04: safety refusal shows a distinct caution treatment and NO confidence band', async () => {
    if (!refusalVisible) throw new Error('safety refusal not shown')
    if (chipOnRefusal.attrs.band) throw new Error('safety refusal must not carry a confidence band: ' + JSON.stringify(chipOnRefusal.attrs))
    if (!refusalBorder || /transparent|rgba?\(0,\s*0,\s*0,\s*0\)/.test(refusalBorder)) throw new Error('no refusal color: ' + refusalBorder)
  })
  await check('reveal-04: chip color ≠ safety-refusal color (gold vs caution are NOT the same)', async () => {
    if (chipBg === refusalBorder) throw new Error('chip color and refusal color are identical: ' + chipBg)
  })
  await page_noop()
}

// ============================================================================
// reveal-05 — user correction of the ID feeds the catalog (a real server-side write).
// "That's not it" → contribute/correction → submit → the REAL BFF returns a disposition.
// ============================================================================
{
  const { page, d } = await captureToReveal('probable')

  // capture the network write the correction triggers so we assert it actually hit the BFF (real catalog feed).
  const writePromise = page.waitForResponse(
    (r) => r.url().includes('/api/v1/tips') && r.request().method() === 'POST',
    { timeout: 8000 },
  )

  await check('reveal-05: "That\'s not it" opens the correction flow', async () => {
    await d.tap(ids.reveal.correctId)
    await d.waitFor(ids.contribute.tipInput)
  })

  await d.type(ids.contribute.tipInput, "That's not a SuperSix — it's a CAAD10, the badge on the down tube reads CAAD10.")
  await d.tap(ids.contribute.submit)

  await check('reveal-05: correction is WRITTEN through the real BFF (POST /v1/tips → 200)', async () => {
    const res = await writePromise
    if (res.status() !== 200) throw new Error('correction write returned ' + res.status())
    const body = await res.json().catch(() => null)
    if (!body?.tipId) throw new Error('no tipId in correction response: ' + JSON.stringify(body))
    if (body.status !== 'pending_review' && body.status !== 'live')
      throw new Error('correction has no server disposition: ' + JSON.stringify(body))
  })

  await check('reveal-05: the card surfaces the server-decided disposition (not a client-faked banner)', async () => {
    await page.waitForFunction(
      (sel) => !!document.querySelector(sel)?.getAttribute('data-status'),
      `[data-testid="${ids.contribute.statusBanner}"]`,
      { timeout: 5000 },
    )
    const s = await d.state(ids.contribute.statusBanner)
    // qa is TL0, so the real trust gate routes the correction to human review before it can mutate the catalog.
    if (s.attrs.status !== 'pending_review') throw new Error('expected pending_review, got ' + JSON.stringify(s.attrs))
    if (!/moderator|review/i.test(s.text ?? '')) throw new Error('banner text not a review notice: ' + s.text)
  })

  await page.close()
}

// ============================================================================
// proc-02 — PARTIAL "confident maybe": title is the hedge and is NOT silently mutated by the streamed prose.
// The stream emits a `token` (descriptive prose) AND a `confidence_band` (the authoritative title). The
// reveal title must stay the band hedge — the descriptive prose lands in `whatItIs`, never overwriting the title.
// ============================================================================
{
  const { page, d } = await captureToReveal('probable')

  await check('proc-02: PARTIAL settles the chip to PROBABLE (not silently promoted to CONFIDENT)', async () => {
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'PROBABLE') throw new Error('band=' + JSON.stringify(c.attrs))
  })

  await check('proc-02: the streamed descriptive prose is shown in whatItIs (the model DID say something)', async () => {
    const w = await d.state(ids.reveal.whatItIs)
    if (!/cannondale|supersix|thereabouts/i.test(w.text ?? '')) throw new Error('whatItIs missing streamed prose: ' + w.text)
  })

  await check('proc-02: the title is the HEDGE and was NOT mutated into the asserted token prose', async () => {
    const t = await d.state(ids.reveal.title)
    const w = await d.state(ids.reveal.whatItIs)
    // The title must remain the band-register hedge, never the confident assertion in whatItIs.
    if (!/confident maybe/i.test(t.text ?? '')) throw new Error('title is not the hedge: ' + t.text)
    if (t.text && w.text && t.text.trim() === w.text.trim()) throw new Error('title was silently mutated to match the prose: ' + t.text)
    // a PROBABLE card must NOT assert a specific year as the *title* (registerFor(PROBABLE).mayAssertSpecificModel=false).
    if (/\b(19|20)\d{2}\b/.test(t.text ?? '')) throw new Error('PROBABLE title silently asserts a specific year: ' + t.text)
  })

  await check('proc-02: both candidate years are surfaced (disagreement shown, not collapsed silently)', async () => {
    const cnt = await page.locator(`[data-testid="${ids.reveal.candidateOption}"]`).count()
    if (cnt < 2) throw new Error('expected ≥2 candidates on a PARTIAL, got ' + cnt)
  })

  await page.close()
}

// ============================================================================
// proc-03 — INTERVIEW branch (UNKNOWN): orb→curious, Q&A opens, default-private visibility.
// ============================================================================
{
  const { page, d } = await authedPage('unknown')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)

  await check('proc-03: UNKNOWN routes to the INTERVIEW screen (not a reveal card)', async () => {
    await d.waitFor(ids.interview.screen)
    // it should NOT have fallen through to a confident reveal card.
    const card = await d.state(ids.reveal.card)
    if (card.visible) throw new Error('UNKNOWN should not show a reveal card')
  })

  await check('proc-03: the first interview question + "why I ask" are rendered from the real BFF', async () => {
    const q = await d.state(ids.interview.question)
    if (!(q.text && q.text.trim().length > 0)) throw new Error('no interview question')
    const why = await d.state(ids.interview.whyAsked)
    if (!/why i ask/i.test(why.text ?? '')) throw new Error('no "why I ask" rationale: ' + why.text)
  })

  await check('proc-03: visibility toggle DEFAULTS to private (consent-before-global)', async () => {
    const checked = await page.locator(`[data-testid="${ids.interview.visibilityToggle}"]`).isChecked()
    if (checked) throw new Error('interview visibility must default to private')
  })

  await check('proc-03: answer + skip affordances present (interview is interactive, not a dead end)', async () => {
    if (!(await d.state(ids.interview.answerInput)).visible) throw new Error('no answer input')
    if (!(await d.state(ids.interview.skip)).visible) throw new Error('no skip affordance')
  })

  await page.close()
}

// ============================================================================
// proc-04 — >8–12s wait → in-persona long-wait ack (no dead spinner), then a real settle.
// The seeded 'slow' object stalls the stream; the client raises an in-persona ack, THEN a real band arrives.
// ============================================================================
{
  const { page, d } = await authedPage('slow')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)

  await check('proc-04: processing screen is up while the Guide consults (no premature reveal)', async () => {
    await d.waitFor(ids.processing.screen)
    if ((await d.state(ids.reveal.card)).visible) throw new Error('reveal should not be up yet')
  })

  await check('proc-04: a long-wait acknowledgement appears in-persona (no dead spinner)', async () => {
    await d.waitFor(ids.processing.longWaitAck)
    const ack = await d.state(ids.processing.longWaitAck)
    if (!(ack.text && ack.text.trim().length > 0)) throw new Error('long-wait ack has no in-persona copy')
  })

  await check('proc-04: the stall STILL settles into a real reveal afterwards (not stuck)', async () => {
    await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'PROBABLE') throw new Error('post-stall band=' + JSON.stringify(c.attrs))
  })

  await page.close()
}

// ============================================================================
// proc-06 — hard failure (quota/refusal) → in-persona failure state + next action (retry).
// ============================================================================
{
  const { page, d } = await authedPage('fail')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)

  await check('proc-06: hard failure surfaces an in-persona failure state (not a reveal card)', async () => {
    await d.waitFor(ids.processing.failureState)
    const fs = await d.state(ids.processing.failureState)
    if (!(fs.text && fs.text.trim().length > 0)) throw new Error('failure state has no copy')
    if ((await d.state(ids.reveal.card)).visible) throw new Error('a failure must not render a reveal card')
  })

  await check('proc-06: a "next action" (retry) is offered — the failure is recoverable, not a dead end', async () => {
    if (!(await d.state(ids.processing.retryBtn)).visible) throw new Error('no retry affordance')
  })

  await check('proc-06: the orb reflects the uncertain/failed state (orb.state=uncertain)', async () => {
    const orb = await d.state(ids.processing.orb)
    if (orb.attrs.state !== 'uncertain') throw new Error('orb state on failure=' + JSON.stringify(orb.attrs))
  })

  await page.close()
}

} catch (e) {
  fails++
  log('  FAIL (uncaught — fail-closed) :: ' + (e as Error).message)
} finally {
  await browser.close().catch(() => {})
  server.stop()
}

log(`\n${total - fails}/${total} checks passed`)
log(fails === 0 ? 'WEB SC-REVEAL-PROC E2E GREEN' : `WEB SC-REVEAL-PROC E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.sc-reveal-proc-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1

/** no-op so the reveal-04 block (which closes its own pages) reads symmetrically with the others. */
async function page_noop(): Promise<void> {}
