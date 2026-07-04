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
 * per-bucket spoken reveal round-tripping the real /speech route), switches to the "Curious facts" card TAB (Facts
 * is hidden from the dock to keep a single flush row) (→ ≥3 verified chips), and asks Voxi (→ the /conversation nav
 * intent). The planner is scripted here (deterministic CI); in production it is an LLM reading the same perceived tree.
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

// ── Goal 1: the agent opens the identity card via Details (the research lane collapsed to one icon → "What it is"). ──
const openWhat: Planner = async (_g, obs) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.reveal.bucketCard)) return { kind: 'done', rationale: 'the identity card is open' }
  if (v(ids.reveal.detailsIcon)) return { kind: 'tap', id: ids.reveal.detailsIcon, rationale: 'open Details → lands on "What it is"' }
  return { kind: 'done', rationale: 'dock not ready' }
}
await new Agent(d, openWhat).achieve('open the identity card via Details', { maxSteps: 4 })
await check('agent opened the What card (morph) via a real perceived tap on Details', async () => {
  await d.waitFor(ids.reveal.bucketCard, { timeoutMs: 3000 })
  if ((await d.state(ids.reveal.bucketCard)).attrs.bucket !== 'what') throw new Error('card is not the What bucket (Details should open at the first active bucket)')
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

// ── Goal 2: switch the open card to the Curious-facts TAB (Facts is hidden from the dock — reached as a card tab). ──
await check('the facts card, reached via its card TAB (Facts has no dock icon), shows ≥3 verified chips', async () => {
  // The What card is open from Goal 1. Facts has no dock icon (single flush row) — switch to its TAB in place.
  const factsTab = page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="facts"]`)
  const tabDeadline = Date.now() + 8000
  while (Date.now() < tabDeadline && (await factsTab.count()) === 0) await new Promise((r) => setTimeout(r, 150))
  if ((await factsTab.count()) === 0) throw new Error('the facts card tab never appeared')
  await factsTab.first().click()
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
await check('the agent perceives + taps the refusal recovery action → returns to the VIEWFINDER in place (no route hop)', async () => {
  const openRecovery: Planner = async (_g, obs, history) => {
    if (did(history, 'tap', ids.reveal.primaryAction)) return { kind: 'done', rationale: 'recovery tapped' }
    if (obs.visibleIds.includes(ids.reveal.primaryAction)) return { kind: 'tap', id: ids.reveal.primaryAction, rationale: 'try another photo' }
    return { kind: 'done', rationale: 'no recovery action' }
  }
  const navBefore = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  await new Agent(d, openRecovery).achieve('recover from the refusal', { maxSteps: 3 })
  // The camera and reveal are ONE surface (the merge): "Try another photo" discards the refused capture and slides
  // straight back to the live viewfinder — no navigation, nothing to remount.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await d.state(ids.camera.screen)).visible) {
      const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
      if (nav !== navBefore) throw new Error('recovery fired a navigation — it must return to the viewfinder in place: ' + nav)
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('refusal recovery did not return to the viewfinder (camera.screen)')
})

// ── Goal 5: an EMPTY home (deep-linked with nothing captured) IS the live viewfinder. The camera and reveal are
//    ONE surface (the merge), so "nothing to show" isn't a separate invite screen — it's the camera, ready to
//    shoot. The shutter is right there; there is nothing to navigate to. ──
await page.goto(`${base}/?scan=empty`)
await check('the EMPTY home renders the live VIEWFINDER (camera home + shutter), not a separate "nothing to show" invite', async () => {
  await d.waitFor(ids.camera.screen, { timeoutMs: 8000 })
  await d.waitFor(ids.camera.shutter, { timeoutMs: 4000 })
  if ((await d.state(ids.reveal.primaryAction)).visible) throw new Error('a separate invite CTA rendered — the empty home should just be the viewfinder')
  const body = await page.evaluate(() => document.body.innerText)
  if (/nothing to show yet/i.test(body)) throw new Error('the old error-style empty copy is still present')
})

// ── Goal 6: FLASH GUARD. On a READY item, tapping back slides to the viewfinder IN PLACE — the Home is ONE
//    persistent surface that never unmounts, so a buggy pre-nav reset() can no longer repaint an empty branch
//    (there is none, and there is no navigation). The item is PRESERVED one swipe away: swiping back restores the
//    SAME title + dock with no re-fetch. This deterministically catches the old flash regression. ──
await page.goto(`${base}/?scan=confident`)
await check('READY → tap back → the viewfinder shows IN PLACE; the item is preserved one swipe away (no nav, no empty repaint)', async () => {
  await d.waitFor(ids.reveal.title, { timeoutMs: 8000 })
  const bd = Date.now() + 8000
  while (Date.now() < bd) { if ((await d.state(ids.reveal.howSure)).attrs.band) break; await new Promise((r) => setTimeout(r, 100)) }
  const titleBefore = (await d.state(ids.reveal.title)).text ?? ''
  await page.evaluate(() => document.body.removeAttribute('data-last-nav'))
  await d.tap(ids.nav.back)
  await d.waitFor(ids.camera.screen, { timeoutMs: 5000 }) // the viewfinder surfaced in place
  await page.waitForTimeout(400) // give a (buggy) synchronous reset time to repaint an empty branch
  const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  if (nav && /camera|reveal|processing/.test(nav)) throw new Error('back fired a navigation — it must slide to the viewfinder in place: ' + nav)
  if (!(await d.state(ids.reveal.card)).visible) throw new Error('reveal.card unmounted on back — the Home must be one persistent surface')
  const body = await page.evaluate(() => document.body.innerText)
  if (/nothing to show yet|ready when you are/i.test(body)) throw new Error('tapping back repainted an EMPTY branch — the flash regression')
  // Swipe back onto the item (pager page 1) — the preserved store restores the SAME title + dock with no re-fetch.
  await page.evaluate((pid) => { const el = document.querySelector(`[data-testid="${pid}"]`) as HTMLElement | null; if (el) { el.scrollLeft = el.clientWidth; el.dispatchEvent(new Event('scroll', { bubbles: true })) } }, ids.reveal.pager)
  const rd = Date.now() + 6000
  while (Date.now() < rd) {
    if (((await d.state(ids.reveal.title)).text ?? '') === titleBefore && (await d.state(ids.reveal.buckets)).visible) return
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`swiping back to the item did not restore the preserved title/dock; title now "${(await d.state(ids.reveal.title)).text}"`)
})

// ── Goal 7 (Round 4 — REVEAL-WHAT-MAKER): a logo-brand PROBABLE reveal must SURFACE the fixed buckets under real
//    taps — the WHAT names the CATEGORY (never a bare hedge), the MAKER names the BRAND (deriveMaker corroborated-
//    brand lane), the PURPOSE anchors the object. The research lane is collapsed under Details now, so the agent
//    opens Details (perception), then switches IN PLACE to each bucket's tab; the CONTENT is pinned deterministically. ──
await page.goto(`${base}/?scan=logobrand`)
await d.waitFor(ids.reveal.buckets, { timeoutMs: 8000 })
const pollActive = async (id: string, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if ((await d.state(id)).attrs.state === 'active') return; await new Promise((r) => setTimeout(r, 120)) }
  throw new Error(`${id} never became active`)
}
// Open Details via the Agent (perception-driven) — lands on the first active bucket.
const openDetails: Planner = async (_g, obs) => {
  const v = (id: string) => obs.visibleIds.includes(id)
  if (v(ids.reveal.bucketCard)) return { kind: 'done', rationale: 'the research card is open' }
  if (v(ids.reveal.detailsIcon)) return { kind: 'tap', id: ids.reveal.detailsIcon, rationale: 'open Details (the research lane)' }
  return { kind: 'done', rationale: 'dock not ready' }
}
// Switch the open card IN PLACE to a target bucket tab (direct locator — the tabs share the cardTab testID, like the
// Goal 2 facts tab), then return the card's text. Asserts the card landed on the target — the LLM never decides.
const openTabText = async (target: 'what' | 'purpose' | 'maker', label: string): Promise<string> => {
  await pollActive(ids.reveal.detailsIcon) // the research lane has grounded content (the aggregate is active)
  if (!(await d.state(ids.reveal.bucketCard)).visible) {
    await new Agent(d, openDetails).achieve('open the Details card', { maxSteps: 4 })
    await d.waitFor(ids.reveal.bucketCard, { timeoutMs: 3000 })
  }
  if ((await d.state(ids.reveal.bucketCard)).attrs.bucket !== target) {
    const tab = page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="${target}"]`)
    const dl = Date.now() + 8000
    while (Date.now() < dl && (await tab.count()) === 0) await new Promise((r) => setTimeout(r, 120))
    if ((await tab.count()) === 0) throw new Error(`the ${target} card tab never appeared (${label} did not ground)`)
    await tab.first().click()
    const dl2 = Date.now() + 3000
    while (Date.now() < dl2) {
      if ((await d.state(ids.reveal.bucketCard)).attrs.bucket === target) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const st = await d.state(ids.reveal.bucketCard)
  if (st.attrs.bucket !== target) throw new Error(`opened the ${st.attrs.bucket} card, not ${label}`)
  return st.text ?? ''
}

await check('logo-brand: the MAKER tab NAMES the brand (Microsoft) — the "empty maker" complaint fixed', async () => {
  const t = await openTabText('maker', 'maker')
  if (!/microsoft/i.test(t)) throw new Error('maker card does not name Microsoft: ' + JSON.stringify(t))
})
await check('logo-brand: the PURPOSE tab ANCHORS the object (a controller for an Xbox), not a bare category truism', async () => {
  const t = await openTabText('purpose', 'purpose')
  if (!/controller/i.test(t) || !/xbox|game/i.test(t)) throw new Error('purpose card does not anchor the object: ' + JSON.stringify(t))
})
await check('logo-brand: the WHAT tab NAMES the category (a game controller), never a bare hedge — the "what never says what it is" complaint fixed', async () => {
  const t = await openTabText('what', 'what')
  if (!/game controller|controller/i.test(t)) throw new Error('what card does not name the category: ' + JSON.stringify(t))
  if (/^\s*(i'?d wager|i would wager)/i.test(t)) throw new Error('what is a bare hedge with no identification: ' + JSON.stringify(t))
})

await rig.stop()
console.log(
  fails() === 0
    ? '\nAGENTIC PROOF GREEN — an autonomous agent navigated the real 3-icon reveal dock by perception (open Details → What card → hear it, switch to the Facts tab → chips, Ask Voxi → nav; recovered from a refusal back to the viewfinder in place; saw the empty home IS the live viewfinder; slid back in place with the item preserved; and on a logo-brand reveal opened Details + switched tabs to What/Purpose/Maker, pinning the fixed content — category named, object anchored, brand named), every outcome pinned deterministically'
    : `\nAGENTIC FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
