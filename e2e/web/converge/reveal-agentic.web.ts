/**
 * reveal-agentic.web.ts — AGENTIC E2E over the REAL reveal dock (ANALYSIS-UX redesign).
 *
 * An autonomous Agent drives the REAL Expo `app/app/reveal.tsx` (under react-native-web, real Zustand store, real
 * ApiClient → real voxi-api BFF) in a real Chromium, navigating ONLY by PERCEIVING the live testID/a11y tree —
 * exactly as a user finds their way — and deciding each tap. The two hard rules hold (e2e/framework/agent.ts):
 * the agent may only tap a testId actually on screen (anti-hallucination), and it NEVER decides pass/fail — every
 * value that matters is pinned by a DETERMINISTIC assertion after the agent navigates.
 *
 * It proves the redesigned dock with real clicks: the agent opens the "What it is" bucket (→ morph card + the
 * per-bucket spoken reveal round-tripping the real /speech route), opens "Curious facts" (→ ≥3 verified chips),
 * and asks Voxi (→ the /conversation nav intent). The planner is scripted here (deterministic CI); in production
 * it is an LLM reading the same perceived tree.
 *
 * Run: `bun e2e/web/converge/reveal-agentic.web.ts`  (exit 0 = agentic proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { Agent, type Planner, type PlannedAction } from '../../framework/agent'
import { ids } from '../../framework/testids'

const { check, fails } = makeChecker()
const rig = await standUp('client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
const { driver: d, page, base } = rig

// Faithfully model the browser/iOS autoplay policy: play() is blocked until a real DOM gesture — so the bucket's
// audio only plays because the agent's TAP is the gesture (exactly as on device).
await page.addInitScript(() => {
  let gestured = false
  const mark = () => { gestured = true }
  document.addEventListener('pointerdown', mark, true)
  document.addEventListener('click', mark, true)
  const realPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function play() {
    if (!gestured) return Promise.reject(new DOMException('autoplay blocked (test policy)', 'NotAllowedError'))
    return realPlay.call(this)
  }
})

const did = (h: PlannedAction[], kind: PlannedAction['kind'], id: string) => h.some((a) => a.kind === kind && a.id === id)
const audioMpeg = async (): Promise<{ src: string; paused: boolean; t: number } | null> =>
  page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLAudioElement | null
    return el ? { src: el.getAttribute('src') || '', paused: el.paused, t: el.currentTime } : null
  }, ids.reveal.narrationAudio)

await page.goto(`${base}/?scan=confident`)
await d.waitFor(ids.reveal.buckets, { timeoutMs: 8000 })

// ── Goal 1: the agent opens the identity bucket to hear what it is. ──
const openWhat: Planner = async (_g, obs) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.reveal.bucketCard)) return { kind: 'done', rationale: 'the What card is open' }
  if (v(ids.reveal.bucketWhat)) return { kind: 'tap', id: ids.reveal.bucketWhat, rationale: 'open "What it is"' }
  return { kind: 'done', rationale: 'dock not ready' }
}
await new Agent(d, openWhat).achieve('open the identity bucket', { maxSteps: 4 })
await check('agent opened the What card (morph) via a real perceived tap', async () => {
  await d.waitFor(ids.reveal.bucketCard, { timeoutMs: 3000 })
  if ((await d.state(ids.reveal.bucketCard)).attrs.bucket !== 'what') throw new Error('card is not the What bucket')
})
await check('the bucket audio round-trips the REAL /speech route and plays after the agent tap', async () => {
  const deadline = Date.now() + 9000
  let tapped = false
  while (Date.now() < deadline) {
    const st = await audioMpeg()
    if (st && /^data:audio\/mpeg/.test(st.src) && !st.paused && st.t > 0) return
    if (st && /^data:audio\/mpeg/.test(st.src) && st.paused && !tapped) { tapped = true; await d.tap(ids.reveal.playNarration) }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('bucket audio never played from /speech')
})

// ── Goal 2: the agent closes the card and opens Curious facts. ──
const openFacts: Planner = async (_g, obs, history) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.reveal.facts)) return { kind: 'done', rationale: 'facts are shown' }
  if (v(ids.nav.close) && !did(history, 'tap', ids.reveal.bucketFacts)) return { kind: 'tap', id: ids.nav.close, rationale: 'close the open card first' }
  if (v(ids.reveal.bucketFacts)) return { kind: 'tap', id: ids.reveal.bucketFacts, rationale: 'open "Curious facts"' }
  return { kind: 'done', rationale: 'cannot reach facts' }
}
await new Agent(d, openFacts).achieve('open the curious facts', { maxSteps: 5 })
await check('agent reached the facts card with ≥3 verified chips (real clicks)', async () => {
  await d.waitFor(ids.reveal.facts, { timeoutMs: 3000 })
  const deadline = Date.now() + 6000
  let n = 0
  while (Date.now() < deadline) {
    n = await page.locator(`[data-testid="${ids.reveal.fact}"]`).count()
    if (n >= 3) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('expected ≥3 fact chips, got ' + n)
})

// ── Goal 3: the agent asks Voxi about the item. ──
const askVoxi: Planner = async (_g, obs, history) => {
  // The converge mounts only the reveal screen (nav is recorded, not swapped), so terminate once we've tapped Ask.
  if (did(history, 'tap', ids.reveal.conversationIcon)) return { kind: 'done', rationale: 'asked Voxi' }
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.nav.close)) return { kind: 'tap', id: ids.nav.close, rationale: 'close the card before asking' }
  if (v(ids.reveal.conversationIcon)) return { kind: 'tap', id: ids.reveal.conversationIcon, rationale: 'ask Voxi' }
  return { kind: 'done', rationale: 'no conversation entry' }
}
await new Agent(d, askVoxi).achieve('ask Voxi about the item', { maxSteps: 4 })
await check('agent tapping Ask-Voxi fires the real /conversation navigation intent', async () => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (nav && /conversation/.test(nav)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('data-last-nav never became /conversation')
})

// ── Goal 4: a REGULATED object → the real reveal REFUSAL surface (distinct from a confidence band). Reloading the
// same reveal entry with ?scan=pill drives the real BFF safety-refusal event into the real store → reveal.tsx
// renders SafetyRefusal. The agent perceives the refusal and takes the real recovery action. (NB: reached via the
// reveal entry, not the full camera→processing flow — through processing a regulated capture currently resolves to
// the generic FAILURE surface, not this distinct refusal surface; worth a look as a separate product question.) ──
await page.goto(`${base}/?scan=pill`)
await check('a regulated capture renders the real reveal REFUSAL surface, in persona (describe, not identify)', async () => {
  await d.waitFor(ids.global.safetyRefusal, { timeoutMs: 8000 })
  const t = (await d.state(ids.global.safetyRefusal)).text ?? ''
  if (!/describe|identify|will not|won'?t|category/i.test(t)) throw new Error('refusal copy not in-persona: ' + t)
})
await check('the agent perceives + taps the refusal recovery action (real click → back-to-camera intent)', async () => {
  const openRecovery: Planner = async (_g, obs, history) => {
    if (did(history, 'tap', ids.reveal.primaryAction)) return { kind: 'done', rationale: 'recovery tapped' }
    if (obs.visibleIds.includes(ids.reveal.primaryAction)) return { kind: 'tap', id: ids.reveal.primaryAction, rationale: 'try another photo' }
    return { kind: 'done', rationale: 'no recovery action' }
  }
  await new Agent(d, openRecovery).achieve('recover from the refusal', { maxSteps: 3 })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (nav && /camera/.test(nav)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('refusal recovery did not fire the camera nav intent')
})

// ── Goal 5: an EMPTY reveal (deep-linked with nothing captured) is a calm INVITE — the agent perceives it and
//    opens the camera. Proves the empty-state redesign (no error-style "Nothing to show yet"). ──
await page.goto(`${base}/?scan=empty`)
await check('the EMPTY reveal renders the calm INVITE, not the old "Nothing to show yet" error copy', async () => {
  await d.waitFor(ids.reveal.primaryAction, { timeoutMs: 8000 })
  const cta = (await d.state(ids.reveal.primaryAction)).text ?? ''
  if (!/open the camera/i.test(cta)) throw new Error('empty CTA should invite to the camera; got ' + JSON.stringify(cta))
  const body = await page.evaluate(() => document.body.innerText)
  if (/nothing to show yet/i.test(body)) throw new Error('the old error-style empty copy is still present')
})
await check('the agent perceives the invite and taps "Open the camera" (real click → /camera nav intent)', async () => {
  const openCamera: Planner = async (_g, obs, history) => {
    if (did(history, 'tap', ids.reveal.primaryAction)) return { kind: 'done', rationale: 'opened camera' }
    if (obs.visibleIds.includes(ids.reveal.primaryAction)) return { kind: 'tap', id: ids.reveal.primaryAction, rationale: 'open the camera' }
    return { kind: 'done', rationale: 'no invite action' }
  }
  await new Agent(d, openCamera).achieve('open the camera from the empty invite', { maxSteps: 3 })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
    if (nav && /camera/.test(nav)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the invite CTA did not fire the /camera nav intent')
})

// ── Goal 6: FLASH GUARD. On a READY reveal, tapping back must NOT repaint the empty branch. The converge mounts
//    ONLY reveal (nav is recorded, not swapped) so reveal never unmounts — a buggy pre-nav reset() would therefore
//    PERSISTENTLY show the empty copy here (not a sub-frame flash). The fix defers+gates the reset, so the READY
//    view stays put while the /camera nav intent still fires. This deterministically catches the flash regression. ──
await page.goto(`${base}/?scan=confident`)
await check('READY → tap back → the empty branch does NOT repaint (title persists; /camera nav fires)', async () => {
  await d.waitFor(ids.reveal.title, { timeoutMs: 8000 })
  const bd = Date.now() + 8000
  while (Date.now() < bd) { if ((await d.state(ids.reveal.howSure)).attrs.band) break; await new Promise((r) => setTimeout(r, 100)) }
  const titleBefore = (await d.state(ids.reveal.title)).text ?? ''
  await d.tap(ids.nav.back)
  await page.waitForTimeout(400) // give a (buggy) synchronous reset time to repaint the empty branch
  const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  if (!nav || !/camera/.test(nav)) throw new Error('back did not fire the /camera nav intent; data-last-nav=' + nav)
  const body = await page.evaluate(() => document.body.innerText)
  if (/nothing to show yet|ready when you are/i.test(body)) throw new Error('tapping back repainted the EMPTY branch — the flash regression')
  const titleAfter = (await d.state(ids.reveal.title)).text ?? ''
  if (!titleAfter || titleAfter !== titleBefore) throw new Error(`the READY title must persist after back; "${titleBefore}" → "${titleAfter}"`)
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC PROOF GREEN — an autonomous agent navigated the real reveal dock by perception (open What → hear it, open Facts → chips, Ask Voxi → nav, open camera from the empty invite), every outcome pinned deterministically'
    : `\nAGENTIC FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
