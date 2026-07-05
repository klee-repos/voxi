/**
 * Executable web E2E for SUBSCRIPTIONS/METERING + ACCESSIBILITY + SAFETY-SURFACING (web-testable parts).
 * Drives the REAL BFF (voxi-api createApp under /api) + the real web shell through the framework
 * PlaywrightDriver in a real Chromium, locating elements ONLY by ids from testids.ts (no coordinate/CSS taps).
 *
 * TEST-PLAN rows covered (surface=W):
 *  - sub-01   free-tier scan cap reached → in-persona limit screen (refusals don't count).
 *             Two observable invariants, both bottomed out in real BFF metering:
 *               (a) cap reached → the next scan surfaces the in-persona paywall (real /api/v1/threads → 402 →
 *                   paywall.limitMessage). No internal forcing — the BFF's atomic decrement is the gate.
 *               (b) refusals don't count: a safety-refused scan must NOT consume a free scan, so after it the
 *                   live entitlement count (sourced from real /api/v1/me — Settings no longer surfaces counts;
 *                   the plan is the static "Unlimited" label) is unchanged and a subsequent real scan still
 *                   REVEALS (does not hit the paywall).
 *  - a11y-01  reduce-motion preference is honored: toggling settings.reduceMotion sets the document-root
 *             reduce-motion flag the orb/particle animation keys off (the iOS shell swaps particle sequences for
 *             a cross-fade and stills the orb behind this same preference). Asserted via the real, observable
 *             document state + the checkbox's checked state, and that the preference clears when toggled off.
 *  - a11y-03  every Voxi SPOKEN turn has a paired TEXT TRANSCRIPT (VoiceOver/caption path). Drives a real voice
 *             turn (push-to-talk) AND a typed turn, and asserts that each spoken-turn marker
 *             (conversation.voxiTurn) is accompanied by a non-empty conversation.transcriptText.
 *  - safe (web surfacing of the safety refusal): a safety refusal (regulated/medical object) is rendered as a
 *             VISUALLY DISTINCT surface (global.safetyRefusal, caution-red) that is NOT the gold confidence chip
 *             (reveal.confidenceChip is suppressed, carries NO band), and it BLOCKS generation — no confidence
 *             band, no candidate identifications, a non-identifying title. (TEST-PLAN reveal-04 / safe-01 surface.)
 *
 * Pattern copied from run-auth.web.ts / run-sc-conversation.web.ts: boot the harness via createWebHarness +
 * Bun.serve, drive via PlaywrightDriver, deterministic checks only, write a durable result file
 * (e2e/web/.sc-subs-a11y-safety-result.txt), set process.exitCode. Fail-closed on any exception.
 *
 * Run: `bun e2e/web/run-sc-subs-a11y-safety.web.ts`.
 */
import { chromium, type Page } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

// Per-user seeds keyed by the email local-part the shell turns into a `test:<userId>` bearer. Each scenario block
// uses its OWN user so the shared in-memory store does not let one block's decrements bleed into another.
//  - subcap : exactly 1 free scan — the minimum to exercise the cap (and to prove a refusal must not consume it).
//  - a11y   : a few scans (a11y blocks don't capture, but a real user exists in /api/v1/me for settings).
//  - safety : a couple of scans for the pill-refusal surface.
const { fetch } = createWebHarness({
  seed: {
    subcap: { scan: 1, podcast: 1, voiceMin: 10 },
    a11y: { scan: 3, podcast: 1, voiceMin: 10 },
    safety: { scan: 3, podcast: 1, voiceMin: 10 },
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

/** Read the live "scans left" count straight off the REAL BFF metering via /api/v1/me. The Settings UI no longer
 *  surfaces plan/counts (the plan is the static "Unlimited" label in the drawer), so the sub-01 "refusals don't
 *  count" invariant is observed at its source — the same real metering store the old settings row rendered. */
async function scansLeftFromApi(page: Page): Promise<number> {
  const scan = await page.evaluate(async () => {
    // `token` is the mock shell's post-OTP bearer (test:<user>); the BFF's testVerifier honors it.
    const r = await fetch('/api/v1/me', { headers: { authorization: 'Bearer ' + (globalThis as { token?: string }).token } })
    if (!r.ok) throw new Error('/api/v1/me ' + r.status)
    const me = await r.json()
    return me.remaining.scan
  })
  if (typeof scan !== 'number') throw new Error('could not read scans-left from /api/v1/me: ' + JSON.stringify(scan))
  return scan
}

log('web E2E — subscriptions/metering + a11y + safety (real BFF + framework PlaywrightDriver):')

try {
  // ==========================================================================
  // sub-01 : free-tier scan cap → in-persona paywall, AND refusals don't count.
  // ==========================================================================
  {
    // The `subcap` user is seeded with exactly ONE free scan. We FIRST burn it on a safety-refused scan (pill):
    // per the spec, a refusal must NOT consume the free scan, so the user should still have 1 scan left and the
    // NEXT real scan must REVEAL (not paywall). Then, with the budget genuinely exhausted, the following scan
    // must surface the paywall.
    const { page, d } = await authedPage('subcap', 'pill', 'camera')
    await d.waitFor(ids.camera.screen)

    // Baseline: the real /api/v1/me metering reports the seeded single free scan.
    await check('sub-01: baseline — 1 free scan reported by the real /api/v1/me metering', async () => {
      const left = await scansLeftFromApi(page)
      if (left !== 1) throw new Error('expected 1 scan at baseline, /me says ' + left)
    })

    // Drive the refused scan through the real UI/BFF (the pill object yields a safety_refusal in the eve stream).
    await check('sub-01: a safety-refused scan surfaces the refusal (not a reveal)', async () => {
      await d.tap(ids.threads.captureCta)
      await d.waitFor(ids.camera.screen)
      await d.tap(ids.camera.shutter)
      await d.waitFor(ids.global.safetyRefusal)
    })

    // The load-bearing sub-01 invariant: the refusal did NOT consume the free scan. We assert against the REAL
    // /api/v1/me metering — no internals. (If the BFF charges before the refusal is known, this FAILS, and we
    // report it honestly rather than weaken the assertion.)
    await check('sub-01: refusals do NOT count — 1 free scan still remains after the refused scan', async () => {
      const left = await scansLeftFromApi(page)
      if (left !== 1) throw new Error('refusal consumed the free scan: /me reports scans left=' + left + ' (spec: refusals do not count)')
    })

    // With the (still-available, per spec) free scan, a REAL scan must reveal — not hit the paywall.
    await check('sub-01: the still-available free scan reveals a real identification (not the paywall)', async () => {
      await page.goto(`${base}/?scan=confident#/camera`)
      // re-auth on the fresh navigation (same user → same store/entitlements).
      await reauth(page, d, 'subcap')
      await d.waitFor(ids.camera.screen)
      await d.tap(ids.camera.shutter)
      // Either the reveal card (free scan honored) or the paywall (free scan was wrongly consumed) appears.
      await Promise.race([
        d.waitFor(ids.reveal.confidenceChip, { timeoutMs: 5000 }),
        d.waitFor(ids.paywall.limitMessage, { timeoutMs: 5000 }),
      ])
      if ((await d.state(ids.paywall.limitMessage)).visible)
        throw new Error('hit the paywall on the free scan — the prior refusal must have consumed it (spec: refusals do not count)')
      const chip = await d.state(ids.reveal.confidenceChip)
      if (chip.attrs.band !== 'CONFIDENT') throw new Error('expected a CONFIDENT reveal, chip=' + JSON.stringify(chip.attrs))
    })

    await page.close()
  }

  // A SEPARATE, isolated proof of the cap → paywall mechanic itself (independent of the refusal-accounting bug):
  // a user whose free scan is genuinely spent hits the in-persona paywall on the next real scan, via real metering.
  {
    const { page, d } = await authedPage('safety', 'confident', 'camera')
    await d.waitFor(ids.camera.screen)
    await check('sub-01: cap mechanic — first real scan reveals (free scan honored)', async () => {
      await d.tap(ids.camera.shutter)
      await d.waitFor(ids.reveal.confidenceChip)
      const chip = await d.state(ids.reveal.confidenceChip)
      if (chip.attrs.band !== 'CONFIDENT') throw new Error('first scan band=' + JSON.stringify(chip.attrs))
    })
    await check('sub-01: cap mechanic — burn remaining scans then next scan → in-persona paywall (real 402)', async () => {
      // `safety` seeded with 3 scans; 1 spent above. Burn the rest, then the next scan must 402 → paywall.
      for (let i = 0; i < 3; i++) {
        await d.tap(ids.threads.captureCta)
        await d.waitFor(ids.camera.screen)
        await d.tap(ids.camera.shutter)
        // Wait for either another reveal (scan honored) or the paywall (cap reached).
        await Promise.race([
          d.waitFor(ids.reveal.confidenceChip, { timeoutMs: 5000 }).catch(() => {}),
          d.waitFor(ids.paywall.limitMessage, { timeoutMs: 5000 }).catch(() => {}),
        ])
        if ((await d.state(ids.paywall.limitMessage)).visible) break
      }
      if (!(await d.state(ids.paywall.limitMessage)).visible)
        throw new Error('never reached the paywall after exhausting the seeded scans')
      // The paywall is in-persona (the limit message + subscribe/restore affordances), driven by the real BFF.
      const msg = await d.state(ids.paywall.limitMessage)
      if (!msg.text) throw new Error('paywall shown with no in-persona limit message')
      if (!(await d.state(ids.paywall.subscribeBtn)).visible) throw new Error('paywall missing subscribe affordance')
      if (!(await d.state(ids.paywall.restoreBtn)).visible) throw new Error('paywall missing restore affordance')
    })
    await page.close()
  }

  // ==========================================================================
  // a11y-01 : reduce-motion preference is honored on the document root the animation keys off.
  // ==========================================================================
  {
    const { page, d } = await authedPage('a11y', 'probable', 'settings')
    await d.waitFor(ids.settings.screen)

    await check('a11y-01: reduce-motion defaults OFF (no reduced-motion flag on the document)', async () => {
      const flag = await page.evaluate(() => document.body.getAttribute('data-reduce-motion'))
      if (flag === 'true') throw new Error('reduce-motion already on at default: ' + flag)
      if (await page.locator(`[data-testid="${ids.settings.reduceMotion}"]`).isChecked())
        throw new Error('reduce-motion toggle checked at default')
    })

    await check('a11y-01: toggling reduce-motion ON sets the document reduced-motion flag (anim/particle hook)', async () => {
      await d.tap(ids.settings.reduceMotion)
      if (!(await page.locator(`[data-testid="${ids.settings.reduceMotion}"]`).isChecked()))
        throw new Error('toggle not checked after tap')
      const flag = await page.evaluate(() => document.body.getAttribute('data-reduce-motion'))
      if (flag !== 'true') throw new Error('document reduce-motion flag not set: ' + flag)
    })

    await check('a11y-01: toggling reduce-motion OFF clears the flag again (preference is reversible)', async () => {
      await d.tap(ids.settings.reduceMotion)
      if (await page.locator(`[data-testid="${ids.settings.reduceMotion}"]`).isChecked())
        throw new Error('toggle still checked after second tap')
      const flag = await page.evaluate(() => document.body.getAttribute('data-reduce-motion'))
      if (flag !== 'false') throw new Error('document reduce-motion flag not cleared: ' + flag)
    })

    await page.close()
  }

  // ==========================================================================
  // a11y-03 : every Voxi SPOKEN turn has a paired TEXT TRANSCRIPT (caption/VoiceOver path).
  // ==========================================================================
  {
    const { page, d } = await authedPage('a11y', 'probable', 'conversation')
    await d.waitFor(ids.conversation.orb)

    await check('a11y-03: before any turn, neither the spoken-turn marker nor the transcript is populated', async () => {
      if ((await d.state(ids.conversation.voxiTurn)).text) throw new Error('voxiTurn populated before any turn')
      if ((await d.state(ids.conversation.transcriptText)).text) throw new Error('transcript populated before any turn')
    })

    // A real VOICE turn (push-to-talk): press → orb listening; release → orb speaking + BOTH a spoken-turn marker
    // and a text transcript are written. The transcript existing alongside the spoken turn IS the a11y guarantee.
    await check('a11y-03: a spoken (voice) turn writes BOTH a spoken-turn marker and a text transcript', async () => {
      await page.locator(`[data-testid="${ids.conversation.micButton}"]`).dispatchEvent('mousedown')
      const listening = await d.state(ids.conversation.orbVisual)
      if (listening.attrs.state !== 'listening') throw new Error('orb not listening on press: ' + JSON.stringify(listening.attrs))
      await page.locator(`[data-testid="${ids.conversation.micButton}"]`).dispatchEvent('mouseup')
      const speaking = await d.state(ids.conversation.orbVisual)
      if (speaking.attrs.state !== 'speaking') throw new Error('orb not speaking after release: ' + JSON.stringify(speaking.attrs))
      const spoken = await d.state(ids.conversation.voxiTurn)
      if (!spoken.text) throw new Error('no spoken-turn marker (voxiTurn) after the voice turn')
      const caption = await d.state(ids.conversation.transcriptText)
      if (!caption.text) throw new Error('spoken turn has NO paired text transcript (a11y/caption path missing)')
    })

    // A typed turn must ALSO carry a transcript (the caption path is not voice-only) and advance it.
    await check('a11y-03: a typed turn also pairs a spoken-turn marker with an advancing text transcript', async () => {
      const before = (await d.state(ids.conversation.transcriptText)).text ?? ''
      await d.tap(ids.conversation.keyboardToggle)
      await d.waitFor(ids.conversation.textInput)
      await d.type(ids.conversation.textInput, 'Is the frame carbon?')
      await d.tap(ids.conversation.sendBtn)
      const spoken = await d.state(ids.conversation.voxiTurn)
      if (!spoken.text) throw new Error('no spoken-turn marker after the typed turn')
      const after = await d.state(ids.conversation.transcriptText)
      if (!after.text) throw new Error('typed turn produced no text transcript')
      if (after.text === before) throw new Error('transcript did not advance on the typed turn')
      if (!/Is the frame carbon\?/.test(after.text)) throw new Error('typed turn not reflected in transcript: ' + after.text)
    })

    await page.close()
  }

  // ==========================================================================
  // safe (web surfacing): a safety refusal is visually distinct from the confidence chip AND blocks generation.
  // ==========================================================================
  {
    // A FRESH user with budget, scanning a regulated/medical object (pill) → the persona refuses to identify it.
    const { page, d } = await authedPage('a11y', 'pill', 'camera')
    await d.waitFor(ids.camera.screen)
    await d.tap(ids.camera.shutter)

    await check('safe: a pill/medical scan surfaces the distinct safety-refusal surface', async () => {
      await d.waitFor(ids.global.safetyRefusal)
      const r = await d.state(ids.global.safetyRefusal)
      if (!r.visible || !r.text) throw new Error('safety refusal not shown with a message')
      if (!/will not identify|describe the category|not medicine/i.test(r.text))
        throw new Error('refusal message is not the in-persona non-identifying refusal: ' + r.text)
    })

    await check('safe: the refusal is NOT a confidence band — the gold chip is suppressed and carries no band', async () => {
      const chip = await d.state(ids.reveal.confidenceChip)
      if (chip.visible) throw new Error('confidence chip is visible alongside a safety refusal (should be suppressed)')
      if (chip.attrs.band) throw new Error('confidence chip carries a band on a safety refusal: ' + chip.attrs.band)
    })

    await check('safe: the refusal surface is VISUALLY DISTINCT from the confidence chip (caution red ≠ warm gold)', async () => {
      const styles = await page.evaluate(
        ([refusalSel, chipSel]) => {
          const px = (el: Element | null) => {
            if (!el) return null
            const s = getComputedStyle(el as HTMLElement)
            return { borderColor: s.borderColor, background: s.backgroundColor }
          }
          return {
            refusal: px(document.querySelector(refusalSel)),
            chip: px(document.querySelector(chipSel)),
          }
        },
        [`[data-testid="${ids.global.safetyRefusal}"]`, `[data-testid="${ids.reveal.confidenceChip}"]`] as const,
      )
      if (!styles.refusal) throw new Error('could not read refusal styles')
      // The refusal uses the caution red (#C0392B → rgb(192, 57, 43)); the confidence chip uses warm gold
      // (#E6B24A → rgb(230, 178, 74)). They must NOT share the same accent — that is the "distinct visual" guarantee.
      const refusalAccent = styles.refusal.borderColor
      if (refusalAccent === 'rgb(230, 178, 74)')
        throw new Error('refusal uses the gold confidence accent — not visually distinct')
      if (!/192,\s*57,\s*43/.test(refusalAccent))
        throw new Error('refusal is not rendered in the caution-red accent: ' + refusalAccent)
      // The chip, if it were shown, would carry gold; here it is suppressed entirely (asserted above).
    })

    await check('safe: the refusal BLOCKS generation — no band, no candidate identifications, non-identifying title', async () => {
      // No confidence band was emitted (no identification committed).
      const chip = await d.state(ids.reveal.confidenceChip)
      if (chip.attrs.band) throw new Error('a confidence band was emitted on a refusal: ' + chip.attrs.band)
      // No candidate make/model options were generated (the identification itself was suppressed).
      const candVisible = await page.evaluate(
        (sel) => {
          const el = document.querySelector(sel) as HTMLElement | null
          return !!el && el.offsetParent !== null
        },
        `[data-testid="${ids.reveal.candidateOption}"]`,
      )
      if (candVisible) throw new Error('candidate identifications were generated despite the safety refusal')
      // The title is the non-identifying, category-only line — not a committed make/model identification.
      const title = (await d.state(ids.reveal.title)).text ?? ''
      if (!/describe the category|not identify/i.test(title))
        throw new Error('title is not the non-identifying category-only line: ' + title)
    })

    await page.close()
  }
} catch (e) {
  // Fail-closed: any unexpected exception in setup/teardown counts as a failure, never a silent green.
  fails++
  log('  FAIL <suite> :: unexpected exception :: ' + (e as Error).message)
}

await browser.close()
server.stop()
log(fails === 0 ? '\nWEB SC-SUBS-A11Y-SAFETY E2E GREEN' : `\nWEB SC-SUBS-A11Y-SAFETY E2E FAILURES: ${fails}`)
await Bun.write('e2e/web/.sc-subs-a11y-safety-result.txt', out.join('\n') + '\n')
process.exitCode = fails === 0 ? 0 : 1

/** Re-run the auth flow on the current page after a fresh navigation (same user → same store/entitlements). */
async function reauth(page: Page, d: PlaywrightDriver, user: string): Promise<void> {
  await d.waitFor(ids.welcome.emailInput)
  await d.type(ids.welcome.emailInput, `${user}@voxi.test`)
  await d.tap(ids.welcome.eulaAccept)
  await d.tap(ids.welcome.ageConfirm)
  await d.tap(ids.welcome.continueBtn)
  await d.waitFor(ids.welcome.otpInput)
  await d.type(ids.welcome.otpInput, '424242')
  await d.tap(ids.welcome.continueBtn)
}
