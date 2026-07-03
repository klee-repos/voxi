/**
 * Web E2E — PODCAST (web parts). Drives the REAL BFF + web shell through the framework PlaywrightDriver in a
 * real Chromium, asserting only on real observable state. Covers TEST-PLAN rows:
 *
 *   pod-01  "Generate story" → honest "composing" wait → plays (audio actually advances).
 *   pod-02  two-host transcript renders line-by-line with DISTINCT speakers (Arlo/Mave).
 *   pod-03  re-viewing the SAME catalog item streams the cached render and does NOT regenerate —
 *           asserted on the real BFF's idempotency contract: the second POST /v1/podcast returns
 *           replay:true with the SAME generation token (no second generation token is minted) and
 *           does NOT decrement the paid entitlement a second time.
 *   pod-04  report-episode control is present and reporting pulls the episode pending review.
 *
 * Structure copied verbatim from run-auth.web.ts / run-coverage.web.ts: boot the harness via
 * createWebHarness + Bun.serve, drive via PlaywrightDriver, deterministic checks only, write a durable result
 * file (.sc-podcast-result.txt), set process.exitCode, fail-closed on any exception.
 *
 * No vendor stubbing and no reaching into app internals: the podcast gate (atomic decrement + idempotent
 * token), the worker-status proxy (composing → ready), the transcript, the report route and the /me meter
 * surface are all the production Hono routes. pod-03's "no regen" is observed from the REAL BFF responses on
 * the wire (a test-owned page.on('response') tap) and from the real /me entitlement counter — never forced.
 *
 * Run: `bun e2e/web/run-sc-podcast.web.ts`.
 */
import { chromium, type Page, type Response as PWResponse } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Seed: the qa user gets exactly ONE paid podcast entitlement. This is load-bearing for pod-03 — if the
// second view regenerated (minted a new token + decremented), the SECOND generation would be blocked at 0
// and the cached-replay assertion could not pass. The idempotent gate is what lets one entitlement serve
// every re-view of the same item.
const { fetch } = createWebHarness({
  seed: { qa: { scan: 5, podcast: 1, voiceMin: 10 } },
  plans: { qa: 'free' },
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

/** A single record of a real POST /v1/podcast gate response observed on the wire. */
interface GateObservation {
  token: string
  replay: boolean
}

/** Authenticate a fresh page for the qa user + seeded object. Mirrors run-coverage.web.ts's helper. */
async function authedPage(scan: string): Promise<{ page: Page; d: PlaywrightDriver; gates: GateObservation[] }> {
  const page = await (await browser.newContext()).newPage()
  const d = new PlaywrightDriver(page)
  // Test-owned network tap: capture the REAL BFF response to each paid-generation gate. This observes real
  // observable state (HTTP responses produced by driving the real UI), it does NOT stub or read internals.
  const gates: GateObservation[] = []
  page.on('response', async (res: PWResponse) => {
    const u = new URL(res.url())
    if (res.request().method() === 'POST' && u.pathname === '/api/v1/podcast' && res.status() === 200) {
      const body = await res.json().catch(() => null)
      if (body && typeof body.token === 'string') gates.push({ token: body.token, replay: body.replay === true })
    }
  })
  await page.goto(`${base}/?scan=${scan}`)
  // Landing → sign-up flow (post onboarding redesign; mirrors run-auth.web.ts). The old inline welcome form
  // (welcome.emailInput + eula/age consent + otpInput) was split into a landing CTA → /sign-up email + code.
  await d.waitFor(ids.welcome.getStarted)
  await d.tap(ids.welcome.getStarted)
  await d.waitFor(ids.auth.emailInput)
  await d.type(ids.auth.emailInput, 'qa@voxi.test') // localpart → token test:qa, matching readMeRemaining
  await d.tap(ids.auth.continue) // reveals the code field
  await d.waitFor(ids.auth.codeInput)
  await d.type(ids.auth.codeInput, '424242')
  await d.tap(ids.auth.continue) // authenticates → camera
  return { page, d, gates }
}

/** Read the exact remaining `podcast` meter from the real BFF /me route via the authenticated page. */
async function readMeRemaining(page: Page, meter: 'scan' | 'podcast' | 'voiceMin'): Promise<number> {
  return await page.evaluate(async (m) => {
    // reuse the page's own auth token the shell already minted (test:<localpart>)
    const tok = 'test:qa'
    const r = await fetch('/api/v1/me', { headers: { authorization: 'Bearer ' + tok } })
    const me = await r.json()
    return me.remaining[m] as number
  }, meter)
}

log('web E2E (podcast, real BFF + framework PlaywrightDriver):')

// ============================================================================
// pod-01 / pod-02 / pod-04 — generate → honest composing wait → plays →
// two-host distinct-speaker transcript → report control present + reports.
// ============================================================================
const { page, d, gates } = await authedPage('probable')
await d.waitFor(ids.camera.screen)
await d.tap(ids.camera.shutter)
await d.waitFor(ids.reveal.card)

// Capture the threadId the reveal card is bound to so pod-03 can re-target the SAME catalog item.
const threadId = await page.locator(`[data-testid="${ids.reveal.card}"]`).getAttribute('data-thread.id')

await d.tap(ids.reveal.primaryAction) // "Generate story"

await check('pod-01: player opens with an honest "composing" wait (no instant fake ready)', async () => {
  await d.waitFor(ids.podcast.player)
  const composing = await d.state(ids.podcast.composingState)
  if (!composing.visible) throw new Error('composing state not shown')
  // While composing, the BFF has NOT yet reported ready, so the play control must still be disabled.
  const disabledWhileComposing = await page.locator(`[data-testid="${ids.podcast.playPause}"]`).isDisabled()
  if (!disabledWhileComposing) throw new Error('playPause enabled before worker reported ready')
})

await check('pod-01: composing → ready transition renders the episode (worker status proxied, not faked)', async () => {
  await d.waitFor(ids.podcast.transcriptLine, { timeoutMs: 8000 })
  if ((await d.state(ids.podcast.composingState)).visible) throw new Error('composing state still showing after ready')
})

await check('pod-01: audio actually PLAYS (currentTime advances), not just a play icon', async () => {
  const disabled = await page.locator(`[data-testid="${ids.podcast.playPause}"]`).isDisabled()
  if (disabled) throw new Error('playPause still disabled after ready')
  await d.tap(ids.podcast.playPause)
  // expect.playing() semantics: prove currentTime increases on the real <audio> element.
  const advanced = await page.waitForFunction(
    (sel) => {
      const a = document.querySelector(sel) as HTMLAudioElement | null
      if (!a) return false
      const start = a.currentTime
      return new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(!a.paused && a.currentTime > start), 250)
      })
    },
    `[data-testid="${ids.podcast.audio}"]`,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  if (!advanced) throw new Error('audio currentTime did not advance (not actually playing)')
})

await check('pod-02: two-host transcript renders multiple lines', async () => {
  const cnt = await page.locator(`[data-testid="${ids.podcast.transcriptLine}"]`).count()
  if (cnt < 2) throw new Error('transcript lines=' + cnt)
})

await check('pod-02: speakers are DISTINCT — both ARLO and MAVE present (data-speaker contract)', async () => {
  const speakers = await page
    .locator(`[data-testid="${ids.podcast.transcriptLine}"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-speaker')))
  if (!speakers.includes('ARLO') || !speakers.includes('MAVE'))
    throw new Error('expected both ARLO and MAVE, got ' + JSON.stringify(speakers))
})

await check('pod-02: distinct speakers render with distinct styling (visual separation, not just a label)', async () => {
  // Arlo and Mave lines must be visually distinguishable. The contract carries data-speaker; assert the two
  // speaker groups resolve to DIFFERENT computed background colors (the harness styles each speaker lane).
  const bgBySpeaker = await page.locator(`[data-testid="${ids.podcast.transcriptLine}"]`).evaluateAll((els) => {
    const m: Record<string, string> = {}
    for (const e of els) {
      const sp = e.getAttribute('data-speaker') ?? ''
      m[sp] = getComputedStyle(e as Element).backgroundColor
    }
    return m
  })
  if (!bgBySpeaker.ARLO || !bgBySpeaker.MAVE) throw new Error('missing styled speaker lane: ' + JSON.stringify(bgBySpeaker))
  if (bgBySpeaker.ARLO === bgBySpeaker.MAVE)
    throw new Error('Arlo and Mave are NOT visually distinct: ' + JSON.stringify(bgBySpeaker))
})

await check('pod-04: report-episode control is present', async () => {
  const s = await d.state(ids.podcast.reportEpisode)
  if (!s.visible) throw new Error('reportEpisode control not visible')
})

await check('pod-04: reporting the episode pulls it pending review (real reports route)', async () => {
  await d.tap(ids.podcast.reportEpisode)
  // The report posts to the real /v1/reports route; the player reflects the pulled-pending-review state.
  await page.waitForFunction(
    (sel) => /report/i.test(document.querySelector(sel)?.textContent ?? ''),
    `[data-testid="${ids.podcast.composingState}"]`,
    { timeout: 4000 },
  )
})

// Sanity: exactly one paid generation has happened so far, and it was NOT a replay.
await check('pod-01: the first generation minted a real token and was NOT an idempotent replay', async () => {
  if (gates.length !== 1) throw new Error('expected exactly 1 podcast gate so far, saw ' + gates.length)
  if (gates[0].replay !== false) throw new Error('first generation should not be a replay')
  if (!gates[0].token) throw new Error('first generation minted no token')
})

// ============================================================================
// pod-03 — re-view the SAME catalog item → cached replay, NO regeneration.
//
// Through the UI: go to the Collection, revisit the SAME captured item (same threadId == same catalogItemId),
// and tap "Generate story" again. The real BFF idempotency gate must return the SAME generation token with
// replay:true (no second generation token minted) AND must NOT decrement the paid entitlement again.
// ============================================================================
await check('pod-03: same item is in the Collection and revisits to the SAME thread', async () => {
  await d.tap(ids.nav.threadsTab)
  await d.waitFor(ids.threads.grid)
  const item = page.locator(`[data-testid="${ids.threads.item}"]`).first()
  if ((await item.count()) === 0) throw new Error('captured item not in collection')
  await item.click()
  await d.waitFor(ids.reveal.card)
  const revisitId = await page.locator(`[data-testid="${ids.reveal.card}"]`).getAttribute('data-thread.id')
  if (!threadId || revisitId !== threadId)
    throw new Error('revisit landed on a different thread: ' + revisitId + ' != ' + threadId)
})

// Record the paid-podcast entitlement BEFORE the second generation, read from the real /me surface.
const remainingBefore = await readMeRemaining(page, 'podcast')

await check('pod-03: re-generating the SAME item does NOT mint a second generation token (cached replay)', async () => {
  await d.tap(ids.reveal.primaryAction) // "Generate story" again, same catalogItemId
  await d.waitFor(ids.podcast.player)
  // wait for the second gate response to be observed on the wire
  await page.waitForFunction(() => true) // microtask flush
  const deadline = Date.now() + 5000
  while (gates.length < 2 && Date.now() < deadline) {
    await page.waitForTimeout(50)
  }
  if (gates.length < 2) throw new Error('second podcast gate never observed on the wire')
  const second = gates[1]
  if (second.replay !== true) throw new Error('second generation was NOT a cached replay (replay=' + second.replay + ')')
  if (second.token !== gates[0].token)
    throw new Error('a NEW generation token was minted (' + second.token + ' != ' + gates[0].token + '); cache was regenerated')
})

await check('pod-03: cached replay did NOT decrement the paid entitlement a second time', async () => {
  const remainingAfter = await readMeRemaining(page, 'podcast')
  if (remainingAfter !== remainingBefore)
    throw new Error('podcast entitlement changed on a cached replay: ' + remainingBefore + ' → ' + remainingAfter)
})

await check('pod-03: the replayed view still renders a playable episode (cached audio, no re-render)', async () => {
  await d.waitFor(ids.podcast.transcriptLine, { timeoutMs: 8000 })
  const disabled = await page.locator(`[data-testid="${ids.podcast.playPause}"]`).isDisabled()
  if (disabled) throw new Error('replayed episode not playable')
})

await page.close()
await browser.close()
server.stop()

log(fails === 0 ? '\nWEB PODCAST E2E GREEN' : `\nWEB PODCAST E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.sc-podcast-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1
