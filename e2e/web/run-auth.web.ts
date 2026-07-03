/**
 * Executable web E2E: drives the real BFF + web shell through the framework PlaywrightDriver in a real
 * Chromium. Covers auth-01 (welcome→camera), id-03 (PROBABLE confident-maybe from the real NDJSON stream),
 * sub-01 (scan cap → paywall via real BFF metering). Run: `bun e2e/web/run-auth.web.ts`.
 */
import { chromium } from 'playwright'
import { createWebHarness } from './server'
import { PlaywrightDriver } from '../framework/drivers/playwright'
import { ids } from '../framework/testids'

const { fetch } = createWebHarness()
const server = Bun.serve({ port: 0, fetch })
const base = `http://localhost:${server.port}`

const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
const d = new PlaywrightDriver(page)

let fails = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log('  PASS', name)
  } catch (e) {
    fails++
    console.log('  FAIL', name, (e as Error).message)
  }
}

await page.goto(base)
console.log('web E2E (real BFF + framework PlaywrightDriver):')

// --- auth-01 (landing → sign-up → code → camera; no consent checkboxes) ---
await check('lands on the landing', () => d.waitFor(ids.welcome.getStarted))
await d.tap(ids.welcome.getStarted)
await check('sign-up email step', () => d.waitFor(ids.auth.emailInput))
await d.type(ids.auth.emailInput, 'qa@voxi.test')
await d.tap(ids.auth.continue)
await check('code step appears', () => d.waitFor(ids.auth.codeInput))
await d.type(ids.auth.codeInput, '424242')
await d.tap(ids.auth.continue)
await check('auth-01: lands on camera', () => d.waitFor(ids.camera.screen))

// --- id-03 (reveal driven by the real BFF NDJSON stream) ---
await d.tap(ids.camera.shutter)
await check('reveal card appears (from real BFF stream)', () => d.waitFor(ids.reveal.card))
await check('id-03: confidence chip band = PROBABLE', async () => {
  const c = await d.state(ids.reveal.confidenceChip)
  if (c.attrs.band !== 'PROBABLE') throw new Error('band=' + JSON.stringify(c.attrs))
})
await check('id-03: title is the "confident maybe" hedge, not an assertion', async () => {
  const t = await d.state(ids.reveal.title)
  if (!/confident maybe/i.test(t.text ?? '')) throw new Error('title=' + t.text)
})

// --- sub-01 (free scan cap = 1 → second scan → paywall, via real BFF metering) ---
await d.tap(ids.threads.captureCta)
await d.waitFor(ids.camera.screen)
await d.tap(ids.camera.shutter)
await check('sub-01: scan cap reached → paywall (real BFF metering)', () => d.waitFor(ids.paywall.limitMessage))

await browser.close()
server.stop()
console.log(fails === 0 ? '\nWEB E2E GREEN' : `\nWEB E2E FAILURES: ${fails}`)
process.exit(fails === 0 ? 0 : 1)
