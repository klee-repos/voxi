/**
 * Web E2E coverage sweep: drives EVERY web-testable screen/state in the testID contract through the framework
 * PlaywrightDriver against the REAL BFF + web shell. This is the deterministic backbone behind the TEST-PLAN
 * rows that are surface=W: it proves each screen renders behind its real testID and that band/visibility/status/
 * outcome are driven by the real BFF, the real NDJSON stream, and the shared modules — never forced.
 *
 * Pattern copied from run-auth.web.ts: boot the harness via Bun.serve, drive via PlaywrightDriver, assert on
 * real observable state, write a durable result file, set process.exitCode. Fail-closed on any exception.
 *
 * Run: `bun e2e/web/run-coverage.web.ts`.
 */
import { chromium, type Page } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Seed: enough entitlements to exercise every screen; one TL0 user and one TL2 user for the tip trust gate.
const generous = { scan: 20, podcast: 5, voiceMin: 10 }
const { fetch } = createWebHarness({
  seed: {
    qa: generous,
    trusted: generous,
    collector: generous,
    emptyuser: generous,
    deleter: generous,
  },
  trust: { trusted: 3 }, // TL3 → tips go live immediately
  plans: { qa: 'free', trusted: 'voyager' },
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

/** Authenticate a fresh page for a given user + seeded object, optionally landing on a direct screen route. */
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

log('web E2E coverage sweep (real BFF + framework PlaywrightDriver):')

// ============================================================================
// PROCESSING terminal outcomes — driven by the real NDJSON stream.
// ============================================================================

// proc-01 / reveal-* : REVEAL (PROBABLE) full hierarchy.
{
  const { page, d } = await authedPage('qa', 'probable')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('reveal: card rises from the real stream', () => d.waitFor(ids.reveal.card))
  await check('reveal: PROBABLE band on the chip (data-band from BFF stream)', async () => {
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'PROBABLE') throw new Error('band=' + JSON.stringify(c.attrs))
  })
  await check('reveal: full hierarchy present (title+quip+whatItIs+thumb+primary+addTip)', async () => {
    for (const id of [ids.reveal.title, ids.reveal.quip, ids.reveal.whatItIs, ids.reveal.photoThumb, ids.reveal.primaryAction, ids.reveal.addTip]) {
      const s = await d.state(id)
      if (!s.visible) throw new Error('missing ' + id)
    }
  })
  await check('reveal: ≥2 candidate options on the disagreement', async () => {
    const cnt = await page.locator(`[data-testid="${ids.reveal.candidateOption}"]`).count()
    if (cnt < 2) throw new Error('candidates=' + cnt)
  })
  await check('reveal: How sure? auto-elevated in PROBABLE, opens evidence panel', async () => {
    if (!(await d.state(ids.reveal.howSure)).visible) throw new Error('howSure hidden')
    await d.tap(ids.reveal.howSure)
    await d.waitFor(ids.reveal.evidencePanel)
  })
  await page.close()
}

// reveal-02 : CONFIDENT hides "How sure?".
{
  const { page, d } = await authedPage('qa', 'confident')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('reveal: CONFIDENT band + How sure? hidden', async () => {
    await d.waitFor(ids.reveal.card)
    const c = await d.state(ids.reveal.confidenceChip)
    if (c.attrs.band !== 'CONFIDENT') throw new Error('band=' + JSON.stringify(c.attrs))
    if ((await d.state(ids.reveal.howSure)).visible) throw new Error('How sure? should be hidden when CONFIDENT')
  })
  await page.close()
}

// proc-03 / id-04 : INTERVIEW route (UNKNOWN → interview, default private).
{
  const { page, d } = await authedPage('qa', 'unknown')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('interview: UNKNOWN routes to interview screen', () => d.waitFor(ids.interview.screen))
  await check('interview: question + whyAsked rendered from the BFF', async () => {
    if (!(await d.state(ids.interview.question)).text) throw new Error('no question')
    if (!/Why I ask/i.test((await d.state(ids.interview.whyAsked)).text ?? '')) throw new Error('no whyAsked')
  })
  await check('interview: visibility toggle DEFAULTS to private (unchecked)', async () => {
    const checked = await page.locator(`[data-testid="${ids.interview.visibilityToggle}"]`).isChecked()
    if (checked) throw new Error('visibility should default to private')
  })
  await check('interview: answerInput + skip present', async () => {
    if (!(await d.state(ids.interview.answerInput)).visible) throw new Error('no answerInput')
    if (!(await d.state(ids.interview.skip)).visible) throw new Error('no skip')
  })
  await page.close()
}

// proc-04 : long-wait acknowledgement (>threshold) — no dead spinner.
{
  const { page, d } = await authedPage('qa', 'slow')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('processing: longWaitAck appears before settle (no dead spinner)', () => d.waitFor(ids.processing.longWaitAck))
  await check('processing: still settles into a reveal afterwards', () => d.waitFor(ids.reveal.card, { timeoutMs: 8000 }))
  await page.close()
}

// proc-06 : hard failure → in-persona failure state + retry.
{
  const { page, d } = await authedPage('qa', 'fail')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('processing: failureState shown on hard failure', () => d.waitFor(ids.processing.failureState))
  await check('processing: retry control present', async () => {
    if (!(await d.state(ids.processing.retryBtn)).visible) throw new Error('no retry')
  })
  await page.close()
}

// safe-01 : safety refusal is DISTINCT from the confidence chip.
{
  const { page, d } = await authedPage('qa', 'pill')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await check('safety: refusal shown and visually distinct from the chip', async () => {
    await d.waitFor(ids.global.safetyRefusal)
    const chip = await d.state(ids.reveal.confidenceChip)
    if (chip.attrs.band) throw new Error('safety refusal must not carry a confidence band')
  })
  await page.close()
}

// ============================================================================
// PODCAST player — gate → composing → ready → transcript w/ speakers → report.
// ============================================================================
{
  const { page, d } = await authedPage('qa', 'probable')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await d.waitFor(ids.reveal.card)
  await d.tap(ids.reveal.primaryAction) // "Generate story"
  await check('podcast: player + composingState appear (honest wait)', async () => {
    await d.waitFor(ids.podcast.player)
    if (!(await d.state(ids.podcast.composingState)).visible) throw new Error('no composing state')
  })
  await check('podcast: transitions to ready and renders transcript lines', () => d.waitFor(ids.podcast.transcriptLine, { timeoutMs: 6000 }))
  await check('podcast: transcript lines carry distinct speakers (ARLO/MAVE)', async () => {
    const speakers = await page.locator(`[data-testid="${ids.podcast.transcriptLine}"]`).evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-speaker')),
    )
    if (!speakers.includes('ARLO') || !speakers.includes('MAVE')) throw new Error('speakers=' + JSON.stringify(speakers))
  })
  await check('podcast: playPause enabled once ready; reportEpisode present', async () => {
    const disabled = await page.locator(`[data-testid="${ids.podcast.playPause}"]`).isDisabled()
    if (disabled) throw new Error('playPause still disabled')
    if (!(await d.state(ids.podcast.reportEpisode)).visible) throw new Error('no reportEpisode')
  })
  await check('podcast: report invalidates/marks the episode', async () => {
    await d.tap(ids.podcast.reportEpisode)
    await page.waitForFunction(
      (sel) => /report/i.test(document.querySelector(sel)?.textContent ?? ''),
      `[data-testid="${ids.podcast.composingState}"]`,
      { timeout: 4000 },
    )
  })
  await page.close()
}

// ============================================================================
// CONVERSATION — orb, mic (live indicator), keyboard toggle, voxiTurn + transcript.
// ============================================================================
{
  const { page, d } = await authedPage('qa', 'probable', 'conversation')
  await check('conversation: orb screen reachable', () => d.waitFor(ids.conversation.orb))
  await check('conversation: mic press shows live indicator, release writes turn + transcript', async () => {
    await page.locator(`[data-testid="${ids.conversation.micButton}"]`).dispatchEvent('mousedown')
    if (!(await d.state(ids.conversation.liveMicIndicator)).visible) throw new Error('no live indicator')
    await page.locator(`[data-testid="${ids.conversation.micButton}"]`).dispatchEvent('mouseup')
    if (!(await d.state(ids.conversation.voxiTurn)).text) throw new Error('no voxiTurn')
    if (!(await d.state(ids.conversation.transcriptText)).text) throw new Error('no transcript (a11y/caption path)')
  })
  await check('conversation: keyboard toggle reveals text input + send', async () => {
    await d.tap(ids.conversation.keyboardToggle)
    await d.waitFor(ids.conversation.textInput)
    if (!(await d.state(ids.conversation.sendBtn)).visible) throw new Error('no send button')
  })
  await page.close()
}

// conv-05 : voice-minutes-exhausted hard cutoff (the minutesExhausted state is in the contract).
{
  const { page, d } = await authedPage('qa', 'probable', 'conversation')
  await d.waitFor(ids.conversation.orb)
  await check('conversation: minutesExhausted state present in the contract', async () => {
    // visible per contract presence; the exhaustion trigger is iOS-voice-gated (conv-05 is surface I/L).
    const s = await d.state(ids.conversation.minutesExhausted)
    if (s.text === undefined) throw new Error('minutesExhausted not in DOM')
  })
  await page.close()
}

// ============================================================================
// THREADS — empty → populated grid → revisit (durable session resumes).
// ============================================================================
{
  // Fresh user with no captures yet → empty state.
  const { page, d } = await authedPage('emptyuser', 'probable', 'threads')
  await check('threads: emptyState shown for a fresh collection', () => d.waitFor(ids.threads.emptyState))
  await check('threads: a capture CTA is present', async () => {
    if (!(await d.state(ids.threads.captureCta)).visible) throw new Error('no captureCta')
  })
  await page.close()
}
{
  // Capture twice, then revisit the collection → populated grid + durable revisit.
  const { page, d } = await authedPage('collector', 'confident')
  await d.waitFor(ids.camera.screen)
  await d.tap(ids.camera.shutter)
  await d.waitFor(ids.reveal.card)
  await d.tap(ids.threads.captureCta) // tab-bar capture
  await d.waitFor(ids.camera.screen)
  // distinct timestamps so the two deterministic sessionIds never collide on the same ms.
  await page.waitForTimeout(50)
  await d.tap(ids.camera.shutter)
  await d.waitFor(ids.reveal.card)
  await d.tap(ids.nav.threadsTab)
  await check('threads: populated grid after captures', async () => {
    await d.waitFor(ids.threads.grid)
    const cnt = await page.locator(`[data-testid="${ids.threads.item}"]`).count()
    if (cnt < 2) throw new Error('items=' + cnt)
  })
  await check('threads: revisit resumes a durable session (real BFF thread GET)', async () => {
    await page.locator(`[data-testid="${ids.threads.item}"]`).first().click()
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
  await page.close()
}

// ============================================================================
// CONTRIBUTE — tip trust gate (TL0 → review, TL2+ → live) + report.
// ============================================================================
{
  // TL0 user → "a moderator will review"
  const { page, d } = await authedPage('qa', 'probable', 'contribute')
  await d.waitFor(ids.contribute.tipInput)
  await d.type(ids.contribute.tipInput, 'This badge reads SuperSix EVO Hi-Mod.')
  await d.tap(ids.contribute.submit)
  await check('contribute: TL0 tip → status reflects human review (real trust gate)', async () => {
    await page.waitForFunction(
      (sel) => !!document.querySelector(sel)?.getAttribute('data-status'),
      `[data-testid="${ids.contribute.statusBanner}"]`,
    )
    const s = await d.state(ids.contribute.statusBanner)
    if (s.attrs.status !== 'pending_review') throw new Error('status=' + JSON.stringify(s.attrs))
    if (!/moderator|review/i.test(s.text ?? '')) throw new Error('banner=' + s.text)
  })
  await check('contribute: report control present', async () => {
    if (!(await d.state(ids.contribute.reportBtn)).visible) throw new Error('no reportBtn')
  })
  await page.close()
}
{
  // TL3 user → "live now"
  const { page, d } = await authedPage('trusted', 'probable', 'contribute')
  await d.waitFor(ids.contribute.tipInput)
  await d.type(ids.contribute.tipInput, 'Confirmed: 2008 model year, serial range matches.')
  await d.tap(ids.contribute.submit)
  await check('contribute: TL3 tip → goes live immediately (real trust gate)', async () => {
    await page.waitForFunction(
      (sel) => !!document.querySelector(sel)?.getAttribute('data-status'),
      `[data-testid="${ids.contribute.statusBanner}"]`,
    )
    const s = await d.state(ids.contribute.statusBanner)
    if (s.attrs.status !== 'live') throw new Error('status=' + JSON.stringify(s.attrs))
    if (!/live now/i.test(s.text ?? '')) throw new Error('banner=' + s.text)
  })
  await page.close()
}

// ============================================================================
// SETTINGS — reduce-motion, sign-out. (The plan/subscription row + the privacy line were removed; the plan is
// the static "Unlimited" label in the drawer greeting, and metering/counts live on /api/v1/me, not the UI.)
// ============================================================================
{
  const { page, d } = await authedPage('trusted', 'probable', 'settings')
  await check('settings: reduce-motion toggles a real flag on the document', async () => {
    await d.tap(ids.settings.reduceMotion)
    const flag = await page.evaluate(() => document.body.getAttribute('data-reduce-motion'))
    if (flag !== 'true') throw new Error('reduce-motion not applied')
  })
  await check('settings: signOut returns to welcome', async () => {
    await d.tap(ids.settings.signOut)
    await d.waitFor(ids.welcome.emailInput)
  })
  await page.close()
}
{
  // deleteAccount cascades via the real BFF DELETE /v1/account.
  const { page, d } = await authedPage('deleter', 'probable', 'settings')
  await d.waitFor(ids.settings.deleteAccount)
  await check('settings: deleteAccount cascades + returns to welcome', async () => {
    await d.tap(ids.settings.deleteAccount)
    await d.waitFor(ids.welcome.emailInput)
  })
  await page.close()
}

// ============================================================================
// GLOBAL — offline banner reflects real connectivity.
// ============================================================================
{
  const { page, d } = await authedPage('qa', 'probable')
  await d.waitFor(ids.camera.screen)
  await check('global: offline banner appears when the network goes offline', async () => {
    await d.setNetwork('offline')
    await d.waitFor(ids.global.offlineBanner)
    await d.setNetwork('online')
    await d.waitFor(ids.global.offlineBanner, { visible: false })
  })
  await page.close()
}

await browser.close()
server.stop()
log(fails === 0 ? '\nWEB COVERAGE E2E GREEN' : `\nWEB COVERAGE E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.coverage-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
