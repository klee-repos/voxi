/**
 * reveal-deepdive.web.ts — E2E over the new "Deep Dive" affordance on the REAL screens (react-native-web, converge):
 * real testID taps, every outcome pinned deterministically.
 *
 * PROOF A — the reveal DOCK (single-screen reveal client; nav is recorded, not swapped, like reveal-menu):
 *   1. the Deep Dive icon renders in the dock's X-scroll content row AFTER the research buckets;
 *   2. the chat (Ask Voxi) icon is PINNED to the right of Deep Dive — the special people lane;
 *   3. tapping Deep Dive records a navigation to the Deep Dive player (`push:/podcast`).
 * PROOF B — the Deep Dive PLAYER (its own entry mounts the REAL app/app/podcast.tsx with a REAL owned thread):
 *   4. the player opens in IDLE with an explicit "Generate a Deep Dive" CTA and the composing state ABSENT —
 *      generation does NOT auto-fire on mount (the §F2 contract / adversarial D2/D7 / the "external button" ask);
 *   5. the Deep Dive screen never shows the words "podcast" / "episode" to the user;
 *   6. tapping Generate (and only then) starts composing — the explicit action works.
 *
 * Run: `bun e2e/web/converge/reveal-deepdive.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const { check, fails } = makeChecker()

// ── PROOF A — the dock, on the real reveal screen ────────────────────────────────────────────────────────────
{
  const rig = await standUp('client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
  const { driver: d, page, base } = rig
  const lastNav = (): Promise<string | null> => page.evaluate(() => document.body.getAttribute('data-last-nav'))
  const boxX = async (id: string): Promise<number> => {
    const b = await page.locator(`[data-testid="${id}"]`).first().boundingBox()
    if (!b) throw new Error(`${id} is not in the layout`)
    return b.x
  }

  await page.goto(`${base}/?scan=confident`)
  await d.waitFor(ids.reveal.buckets, { timeoutMs: 8000 })
  await d.waitFor(ids.reveal.title, { timeoutMs: 6000 })

  await check('A1 · the Deep Dive icon renders in the dock, AFTER "What" and LEFT of the pinned chat', async () => {
    await d.waitFor(ids.reveal.deepDiveIcon, { timeoutMs: 5000 })
    const whatX = await boxX(ids.reveal.bucketWhat)
    const deepX = await boxX(ids.reveal.deepDiveIcon)
    const askX = await boxX(ids.reveal.conversationIcon)
    if (!(whatX < deepX)) throw new Error(`Deep Dive (${deepX}) is not right of What (${whatX}) — it must sit after the research buckets`)
    if (!(deepX < askX)) throw new Error(`the chat icon (${askX}) is not pinned RIGHT of Deep Dive (${deepX})`)
  })

  await check('A2 · the chat (Ask Voxi) icon is PINNED and visible (the special people lane, set off by the divider)', async () => {
    if (!(await d.state(ids.reveal.conversationIcon)).visible) throw new Error('the pinned Ask/conversation icon is not visible')
  })

  await check('A3 · tapping Deep Dive navigates to the Deep Dive player (records push:/podcast)', async () => {
    await d.tap(ids.reveal.deepDiveIcon)
    await page.waitForTimeout(200)
    const nav = await lastNav()
    if (nav !== 'push:/podcast') throw new Error(`expected push:/podcast, got ${nav}`)
  })

  await rig.stop()
}

// ── PROOF B — the Deep Dive player, mounting the real screen with a real thread ───────────────────────────────
{
  const rig = await standUp('deepdive-client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
  const { driver: d, page, base } = rig
  await page.goto(`${base}/`)

  await check('B1 · the player opens in IDLE with an explicit Generate CTA and NO auto-compose (the contract)', async () => {
    await d.waitFor(ids.podcast.player, { timeoutMs: 8000 })
    await d.waitFor(ids.podcast.generate, { timeoutMs: 8000 }) // the explicit CTA — the "external button"
    if ((await d.state(ids.podcast.composingState)).visible) throw new Error('the composing state showed on mount — compose() auto-fired (contract violation: it must wait for the explicit Generate tap)')
  })

  await check('B2 · the Deep Dive screen never says "podcast" or "episode" to the user', async () => {
    const txt = (await page.evaluate(() => (document.body as HTMLElement).innerText)) as string
    const m = txt.match(/\bpodcasts?\b|\bepisodes?\b/i)
    if (m) throw new Error(`user-facing text leaked "${m[0]}": …${txt.slice(Math.max(0, txt.indexOf(m[0]) - 30), txt.indexOf(m[0]) + 30)}…`)
  })

  await check('B3 · tapping Generate (and only then) starts composing — the explicit action works', async () => {
    await d.tap(ids.podcast.generate)
    // compose() sets 'composing' synchronously on tap (before the network call), so the composing state must appear.
    await d.waitFor(ids.podcast.composingState, { timeoutMs: 8000 })
  })

  await rig.stop()
}

console.log(
  fails() === 0
    ? '\nDEEP DIVE PROOF GREEN — the Deep Dive icon sits in the dock after the research buckets with the chat pinned right and taps through to the player (push:/podcast); the real player opens in IDLE (explicit Generate CTA, no auto-compose), never says "podcast/episode", and Generate starts composing on demand'
    : `\nDEEP DIVE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
