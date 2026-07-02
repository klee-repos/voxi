/**
 * reveal-rnw.web.ts — CONVERGENCE PROOF for the ANALYSIS-UX reveal redesign (docs/ANALYSIS-UX-REDESIGN-PLAN.md).
 *
 * Renders the REAL Expo screen `app/app/reveal.tsx` (unmodified app source, real child components, real Zustand
 * store, real shared confidence register, real ApiClient → real voxi-api BFF) under react-native-web in a real
 * Chromium via Playwright, driven by the SAME testIDs. It proves the redesigned reveal DOCK:
 *   1. The four research bucket icons render and carry `bucket.state` (loading→active/empty), plus a blue Ask-Voxi
 *      icon; the identification (title + chip + description preview) is visible on the dock FACE.
 *   2. Tapping an active bucket MORPHS it into `reveal.bucketCard`; the per-bucket audio round-trips through the
 *      REAL `/speech[/:bucket]` route (a `data:audio/mpeg` source) and plays; nothing plays on the FACE at load.
 *   3. The `maker` bucket that never grounds RESOLVES to `empty` on `done` (never a perpetual spinner).
 *   4. The facts card shows ≥3 verified chips + a tappable source proof.
 *   5. The Ask-Voxi icon fires the /conversation navigation intent.
 *   Negative control: speech seam UNconfigured → /speech 503 → the card shows "unavailable — retry", no audio.
 *
 * Run: `bun e2e/web/converge/reveal-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const SEED = { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } }
const { check, fails } = makeChecker()

const rig = await standUp('client.tsx', SEED)
const { driver: d, page, errors, base } = rig

// Model the REAL browser/iOS autoplay policy in-page: play() is BLOCKED until a real DOM gesture, then succeeds.
// So autoplay on card-open only fires because the bucket TAP is itself the gesture (faithful to the device).
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

async function audioState(): Promise<{ src: string; paused: boolean; currentTime: number } | null> {
  return page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLAudioElement | null
    return el ? { src: el.getAttribute('src') || '', paused: el.paused, currentTime: el.currentTime } : null
  }, ids.reveal.narrationAudio)
}
function fmt(st: Awaited<ReturnType<typeof audioState>>): string {
  if (!st) return 'null'
  const kind = /^data:audio\/mpeg/.test(st.src) ? 'mpeg' : st.src ? 'other' : 'none'
  return `{src:${kind} paused:${st.paused} t:${st.currentTime.toFixed(2)}}`
}
async function stateOf(id: string): Promise<string> {
  return (await d.state(id)).attrs.state ?? ''
}
async function pollState(id: string, want: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  let last = ''
  while (Date.now() < deadline) {
    last = await stateOf(id)
    if (last === want) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${id} data-state never became "${want}"; last="${last}"`)
}

// ── Rig 1a: PROBABLE — the dock + identification contract + the blue conversation lane. ──
console.log('\nconverge: REAL reveal.tsx dock under RNW + real BFF (PROBABLE):')
await page.goto(`${base}/?scan=probable`)
await check('real reveal card renders', () => d.waitFor(ids.reveal.card, { timeoutMs: 8000 }))
await check('no uncaught errors while mounting the real dock component tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})
await check('the name carries the settled band=PROBABLE (no visible pill; band rides reveal.howSure as data)', async () => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await d.state(ids.reveal.howSure)).attrs.band === 'PROBABLE') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('band did not settle to PROBABLE')
})
await check('there is NO visible confidence pill on the reveal (removed by request)', async () => {
  if ((await page.locator(`[data-testid="${ids.reveal.confidenceChip}"]`).count()) !== 0) throw new Error('confidence chip should not render on the reveal')
})
await check('the item NAME is on the floating card FACE (no tray; the description lives in the What card)', async () => {
  await d.waitFor(ids.reveal.title, { timeoutMs: 3000 })
  // the full description is NOT on the resting face — it opens inside the What bucket card.
  if ((await page.locator(`[data-testid="${ids.reveal.whatItIs}"]`).count()) !== 0) throw new Error('whatItIs should not be on the resting face — it belongs in the What card')
})
await check('the bucket DOCK renders with the four research icons + the conversation icon', async () => {
  await d.waitFor(ids.reveal.buckets, { timeoutMs: 3000 })
  for (const b of [ids.reveal.bucketWhat, ids.reveal.bucketPurpose, ids.reveal.bucketWho, ids.reveal.bucketFacts, ids.reveal.conversationIcon]) {
    await d.waitFor(b, { timeoutMs: 3000 })
  }
})
await check('what bucket is ACTIVE on band-settle; purpose grounds to active; maker (class scope) is EMPTY', async () => {
  await pollState(ids.reveal.bucketWhat, 'active')
  await pollState(ids.reveal.bucketPurpose, 'active')
  await pollState(ids.reveal.bucketWho, 'empty') // maker is never named at class scope → honest empty
})
await check('the resting face has NO details panel; tapping the chip (howSure) reveals candidates + toggles back', async () => {
  // minimal resting view — no evidence tray by default (the user asked for just name + icons).
  if ((await page.locator(`[data-testid="${ids.reveal.evidencePanel}"]`).count()) !== 0) throw new Error('evidence panel should be hidden until the chip is tapped')
  await d.tap(ids.reveal.howSure) // the confidence chip is the details trigger
  await d.waitFor(ids.reveal.evidencePanel, { timeoutMs: 2000 })
  if ((await page.locator(`[data-testid="${ids.reveal.candidateOption}"]`).count()) < 1) throw new Error('expected >=1 candidate after opening details')
  await d.tap(ids.reveal.howSure)
  await d.waitFor(ids.reveal.evidencePanel, { timeoutMs: 2000, visible: false })
})
await check('the blue Ask-Voxi icon fires the /conversation navigation intent (expo-router seam)', async () => {
  await d.tap(ids.reveal.conversationIcon)
  const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  if (!nav || !/conversation/.test(nav)) throw new Error('data-last-nav=' + nav)
})

// ── Rig 1b: CONFIDENT — morph card + per-bucket spoken reveal + the never-perpetual regression + facts. ──
console.log('\nconverge: SPOKEN REVEAL — bucket card → real /speech → narrationAudio (CONFIDENT):')
await page.goto(`${base}/?scan=confident`)
await check('CONFIDENT reveal renders + settles the band', async () => {
  await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await d.state(ids.reveal.howSure)).attrs.band === 'CONFIDENT') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('band did not settle to CONFIDENT')
})
await check('nothing plays on the reveal FACE at load — no audio element until a card is opened', async () => {
  await page.waitForTimeout(600)
  if ((await page.locator(`[data-testid="${ids.reveal.narrationAudio}"]`).count()) !== 0) throw new Error('audio mounted on the face before any card was opened')
})
await check('every research bucket RESOLVES (none stuck loading): what+purpose+maker+facts all reach active on CONFIDENT', async () => {
  await pollState(ids.reveal.bucketWhat, 'active')
  await pollState(ids.reveal.bucketPurpose, 'active')
  await pollState(ids.reveal.bucketWho, 'active') // maker is SPECIFIC + grounded at CONFIDENT (not generic, not empty)
  await pollState(ids.reveal.bucketFacts, 'active')
})
// Deterministic proof of the REDESIGN's two visual asks (docs/REVEAL-DOCK-GLASS-PLAN.md) — computed style, not eyeball.
await check('ALIGNMENT: the dock is a full-width 5-slot space-between row (icons flush to the title edges, not centered)', async () => {
  const dock = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
    return el ? { justify: getComputedStyle(el).justifyContent, children: el.children.length } : null
  }, ids.reveal.buckets)
  if (!dock) throw new Error('dock not found')
  if (dock.justify !== 'space-between') throw new Error('dock justify-content=' + dock.justify + ' (want space-between)')
  if (dock.children !== 5) throw new Error('dock should have 5 fixed slots (4 research + Ask); got ' + dock.children)
})
await check('LIQUID GLASS: the dock renders a BLURRED, TRANSLUCENT material (not the old flat white fill)', async () => {
  const g = await page.evaluate((cardTid) => {
    const card = document.querySelector(`[data-testid="${cardTid}"]`)
    if (!card) return { found: false, bg: '' }
    for (const el of [card, ...Array.from(card.querySelectorAll('*'))]) {
      const cs = getComputedStyle(el as Element)
      const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || ''
      if (bf.includes('blur(')) return { found: true, bg: cs.backgroundColor }
    }
    return { found: false, bg: '' }
  }, ids.reveal.card)
  if (!g.found) throw new Error('no element with a backdrop-filter blur in the reveal card — the glass material did not render')
  const m = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+))?\s*\)/.exec(g.bg)
  const alpha = m && m[1] != null ? Number(m[1]) : 1
  if (!(alpha > 0 && alpha < 1)) throw new Error('glass material is not translucent; backgroundColor=' + g.bg)
})
await check('tapping the What bucket MORPHS into reveal.bucketCard (data-bucket=what)', async () => {
  await pollState(ids.reveal.bucketWhat, 'active')
  await d.tap(ids.reveal.bucketWhat)
  await d.waitFor(ids.reveal.bucketCard, { timeoutMs: 3000 })
  const bucket = (await d.state(ids.reveal.bucketCard)).attrs.bucket
  if (bucket !== 'what') throw new Error('card data-bucket=' + bucket)
})
await check('the card audio round-trips through the REAL /speech route (a data:audio/mpeg source) and plays', async () => {
  // The bucket TAP was a real gesture, so the gated autoplay (speakAloud default ON) is allowed to start.
  const deadline = Date.now() + 9000
  let tapped = false
  while (Date.now() < deadline) {
    const st = await audioState()
    if (st && /^data:audio\/mpeg/.test(st.src) && !st.paused && st.currentTime > 0) return
    if (st && /^data:audio\/mpeg/.test(st.src) && st.paused && !tapped) { tapped = true; await d.tap(ids.reveal.playNarration) } // fallback if autoplay didn't fire
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('bucket audio never played from /speech: ' + fmt(await audioState()))
})
await check('the Curious-facts card: ≥3 fact rows, each with its OWN source link showing a title (never a raw URL)', async () => {
  await d.tap(ids.nav.close) // close the What card
  await pollState(ids.reveal.bucketFacts, 'active')
  await d.tap(ids.reveal.bucketFacts)
  await d.waitFor(ids.reveal.facts, { timeoutMs: 3000 })
  const deadline = Date.now() + 6000
  let n = 0
  while (Date.now() < deadline) {
    n = await page.locator(`[data-testid="${ids.reveal.fact}"]`).count()
    if (n >= 3) break
    await new Promise((r) => setTimeout(r, 150))
  }
  if (n < 3) throw new Error('expected ≥3 fact rows, got ' + n)
  // The source sits UNDER each fact (not grouped/deduped) and shows the webpage TITLE — a prettified site name when
  // the page has no title — never a raw URL.
  const srcTexts = await page.locator(`[data-testid="${ids.reveal.factSource}"]`).evaluateAll((els) => els.map((e) => (e.textContent || '').trim()))
  if (srcTexts.length < n) throw new Error(`each fact needs its own source link; ${srcTexts.length} links for ${n} facts`)
  if (!srcTexts.some((t) => t.includes('Cannondale SuperSix EVO'))) throw new Error('real page title not shown: ' + JSON.stringify(srcTexts)) // title branch
  if (!srcTexts.some((t) => t === 'Cannondale')) throw new Error('hostname-fallback title not shown: ' + JSON.stringify(srcTexts)) // empty-title → site name
  if (srcTexts.some((t) => /https?:\/\//.test(t))) throw new Error('a raw URL leaked into a source link (D3 regression): ' + JSON.stringify(srcTexts))
})

await rig.stop()

// ── Rig 2: speech UNCONFIGURED — the per-bucket negative control (the route fails LOUD, the card says so). ──
console.log('\nconverge: NEGATIVE CONTROL — speech seam absent → /speech 503, the bucket card shows "unavailable":')
const rig2 = await standUp('client.tsx', { ...SEED, speech: false })
await rig2.page.goto(`${rig2.base}/?scan=confident`)
await check('with no speech seam, POST /v1/threads/:id/speech 503s (loud, not a fake success)', async () => {
  const status = await rig2.page.evaluate(async () => {
    const h = { authorization: 'Bearer test:converge', 'content-type': 'application/json' }
    const tr = await fetch('/api/v1/threads', { method: 'POST', headers: h, body: JSON.stringify({ photoUrl: 'obj:confident' }) })
    const { threadId } = (await tr.json()) as { threadId: string }
    const sp = await fetch(`/api/v1/threads/${threadId}/speech`, { method: 'POST', headers: { authorization: 'Bearer test:converge' } })
    return sp.status
  })
  if (status !== 503) throw new Error('expected 503 when speech unconfigured, got ' + status)
})
await check('opening a bucket card with no speech seam → NO audio element, control reads "unavailable" (no fake play)', async () => {
  await rig2.driver.waitFor(ids.reveal.card, { timeoutMs: 8000 })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await rig2.driver.state(ids.reveal.bucketWhat)).attrs.state === 'active') break
    await new Promise((r) => setTimeout(r, 100))
  }
  await rig2.driver.tap(ids.reveal.bucketWhat)
  await rig2.driver.waitFor(ids.reveal.bucketCard, { timeoutMs: 3000 })
  // speakNarration polls (~6×700ms) before surfacing failure — wait for the control to settle to "unavailable".
  const labelDeadline = Date.now() + 8000
  let label = ''
  while (Date.now() < labelDeadline) {
    label = await rig2.page.evaluate((tid) => document.querySelector(`[data-testid="${tid}"]`)?.getAttribute('aria-label') || '', ids.reveal.playNarration)
    if (/unavailable/i.test(label)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const audioCount = await rig2.page.locator(`[data-testid="${ids.reveal.narrationAudio}"]`).count()
  if (audioCount !== 0) throw new Error('expected NO audio element when speech is off; found ' + audioCount)
  if (!/unavailable/i.test(label)) throw new Error('control should read "unavailable"; got ' + JSON.stringify(label))
})
await rig2.stop()

console.log(
  fails() === 0
    ? '\nCONVERGE PROOF GREEN — the reveal dock renders, buckets flip loading→active/empty (maker never perpetual), per-bucket audio round-trips through the real /speech route, the conversation icon navigates, and the negative control fails loud'
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
