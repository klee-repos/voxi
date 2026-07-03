/**
 * reveal-rnw.web.ts — CONVERGENCE PROOF for the ANALYSIS-UX reveal redesign (docs/ANALYSIS-UX-REDESIGN-PLAN.md).
 *
 * Renders the REAL Expo screen `app/app/reveal.tsx` (unmodified app source, real child components, real Zustand
 * store, real shared confidence register, real ApiClient → real voxi-api BFF) under react-native-web in a real
 * Chromium via Playwright, driven by the SAME testIDs. It proves the redesigned reveal DOCK:
 *   1. The dock research icons (What/Purpose/Maker — Facts is hidden from the dock to keep a single flush row)
 *      render and carry `bucket.state` (loading→active/empty), plus a blue Ask-Voxi icon; the identification
 *      (title + chip + description preview) is visible on the dock FACE.
 *   2. Tapping an active bucket MORPHS it into `reveal.bucketCard`; the per-bucket audio round-trips through the
 *      REAL `/speech[/:bucket]` route (a `data:audio/mpeg` source) and plays; nothing plays on the FACE at load.
 *   3. The dock research buckets RESOLVE on `done` (never a perpetual spinner).
 *   4. The facts card (reached via its morph-card TAB, since Facts has no dock icon) shows ≥3 verified chips + a
 *      tappable source proof.
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
await check('the header title renders in the SAME row as the controls (name only, tappable via reveal.howSure)', async () => {
  await d.waitFor(ids.reveal.title, { timeoutMs: 3000 })
  const t = (await d.state(ids.reveal.title)).text ?? ''
  if (!t) throw new Error('reveal.title is empty')
})
await check('the item NAME is on the floating card FACE (no tray; the description lives in the What card)', async () => {
  await d.waitFor(ids.reveal.title, { timeoutMs: 3000 })
  // the full description is NOT on the resting face — it opens inside the What bucket card.
  if ((await page.locator(`[data-testid="${ids.reveal.whatItIs}"]`).count()) !== 0) throw new Error('whatItIs should not be on the resting face — it belongs in the What card')
})
await check('the bucket DOCK renders What/Purpose/Maker + conversation; Facts is HIDDEN from the dock (single flush row)', async () => {
  await d.waitFor(ids.reveal.buckets, { timeoutMs: 3000 })
  for (const b of [ids.reveal.bucketWhat, ids.reveal.bucketPurpose, ids.reveal.bucketWho, ids.reveal.conversationIcon]) {
    await d.waitFor(b, { timeoutMs: 3000 })
  }
  // Facts ("Curious facts") is intentionally omitted so the dock is one flush row — it is NOT a dock icon.
  if ((await page.locator(`[data-testid="${ids.reveal.bucketFacts}"]`).count()) !== 0) throw new Error('the Facts (bucketFacts) icon should be hidden from the dock')
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
await check('every DOCK research bucket RESOLVES (none stuck loading): what+purpose+maker reach active on CONFIDENT', async () => {
  await pollState(ids.reveal.bucketWhat, 'active')
  await pollState(ids.reveal.bucketPurpose, 'active')
  await pollState(ids.reveal.bucketWho, 'active') // maker is SPECIFIC + grounded at CONFIDENT (not generic, not empty)
})
// Deterministic proof of the dock's visual ask (full-width, flush to the edges, NOT centered) — computed style +
// geometry, not eyeball. The dock is now a plain flex row of EQUAL `flex:1` icon slots (the redesign replaced the
// old space-between ScrollView), so the even distribution is proven by every icon slot carrying flex-grow:1 and the
// first/last slots hugging the row edges — the same "flush, not bunched" property, its new mechanism.
await check('ALIGNMENT: the dock is a full-width row of equal flex:1 icon slots (flush to the edges, not centered)', async () => {
  const dock = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null
    if (!el) return null
    const box = el.getBoundingClientRect()
    // Icon slots = the tappable Pressables (role=button); the thin hairline divider is the one non-button child.
    const slots = (Array.from(el.children) as HTMLElement[]).filter((k) => k.getAttribute('role') === 'button')
    const first = slots[0]?.getBoundingClientRect()
    const last = slots[slots.length - 1]?.getBoundingClientRect()
    return {
      slotCount: slots.length,
      allGrow1: slots.length > 0 && slots.every((s) => getComputedStyle(s).flexGrow === '1'),
      flushLeft: first ? Math.round(first.left - box.left) : 999,
      flushRight: last ? Math.round(box.right - last.right) : 999,
    }
  }, ids.reveal.buckets)
  if (!dock) throw new Error('dock not found')
  if (!dock.allGrow1) throw new Error('dock icon slots are not equal flex:1 (even distribution); ' + JSON.stringify(dock))
  if (dock.slotCount < 5) throw new Error('dock should have ≥5 icon slots (research + Deep Dive + Ask); got ' + dock.slotCount)
  if (dock.flushLeft > 4) throw new Error('leftmost icon slot not flush to the dock left edge; inset=' + dock.flushLeft)
  if (dock.flushRight > 4) throw new Error('rightmost icon slot not flush to the dock right edge; inset=' + dock.flushRight)
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
await check('the section-title tab bar switches sections IN PLACE (tap "What it\'s for" → card.bucket=purpose, no reopen)', async () => {
  // The What card is still open. The header is now a row of SECTION-TITLE tabs (the redesign) — tapping one must
  // switch the card's section without a close→reopen. All four buckets already polled active above.
  const tabCount = await page.locator(`[data-testid="${ids.reveal.cardTab}"]`).count()
  if (tabCount < 2) throw new Error('expected ≥2 section-title tabs on a CONFIDENT reveal, got ' + tabCount)
  await page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="purpose"]`).click()
  const deadline = Date.now() + 3000
  let seen = ''
  while (Date.now() < deadline) {
    seen = (await d.state(ids.reveal.bucketCard)).attrs.bucket
    if (seen === 'purpose') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('tab switch did not change the card to purpose in place; card.bucket=' + seen)
})
await check('the Maker card renders the grounded "when it was made" line beside the maker prose (reveal.whenMade), a muted date — no dock slot, no separate tab', async () => {
  // Switch to the maker section IN PLACE, then assert the date line is present with the grounded date text. This is
  // the deterministic render/nav proof for the new `made` bucket: the value is pinned by testID, the LLM decides nothing.
  const makerTab = page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="maker"]`)
  const tabDeadline = Date.now() + 8000
  while (Date.now() < tabDeadline && (await makerTab.count()) === 0) await new Promise((r) => setTimeout(r, 150))
  if ((await makerTab.count()) === 0) throw new Error('the maker card tab never appeared (maker did not ground to active)')
  await makerTab.first().click()
  // `made` is NOT a tab and NOT a dock slot — it must render only INSIDE the maker card.
  if ((await page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="made"]`).count()) !== 0) throw new Error('`made` must not be a card tab')
  await d.waitFor(ids.reveal.whenMade, { timeoutMs: 3000 })
  const dateText = (await d.state(ids.reveal.whenMade)).text ?? ''
  if (!/2008|2011/.test(dateText)) throw new Error('reveal.whenMade did not render the grounded date; text="' + dateText + '"')
})
await check('the Curious-facts card (reached via its card TAB — Facts is hidden from the dock): ≥3 fact rows, each with its OWN source link showing a title (never a raw URL)', async () => {
  // A card is open (Purpose) from the tab-switch test above. Facts has no dock icon (single flush row) — switch to
  // its TAB in place; it appears once facts grounds to active (CONFIDENT).
  const factsTab = page.locator(`[data-testid="${ids.reveal.cardTab}"][data-bucket="facts"]`)
  const tabDeadline = Date.now() + 8000
  while (Date.now() < tabDeadline && (await factsTab.count()) === 0) await new Promise((r) => setTimeout(r, 150))
  if ((await factsTab.count()) === 0) throw new Error('the facts card tab never appeared (facts did not ground to active)')
  await factsTab.first().click()
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

// ── NO-REMOUNT identity (LOADING-EXPERIENCE-PLAN §5, D1): the full-bleed photo is ONE element hoisted above the
//    band branch, so the loading overlay dissolving into the dock must NOT remount it (a silent flash regression).
//    The 'slow' fixture stalls the stream, so we read the photo element's identity DURING loading, then again
//    after settle, and assert it is the SAME element (stable data-mounted = same pager cell key). ──
console.log('\nconverge: NO-REMOUNT — the photo survives the loading→dock dissolve (D1, no flash):')
await page.goto(`${base}/?scan=slow`)
await check('the loading overlay (migrated processing.loadingLine) shows OVER the photo before the band settles', async () => {
  await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
  await d.waitFor(ids.reveal.photoThumb, { timeoutMs: 8000 })
  await d.waitFor(ids.processing.loadingLine, { timeoutMs: 8000 }) // the loader lives on the reveal surface now, not a /processing route
})
const mountedDuringLoad = (await d.state(ids.reveal.photoThumb)).attrs.mounted ?? ''
await check('the SAME photo element survives the settle dissolve — no remount, no flash (data-mounted stable)', async () => {
  if (!mountedDuringLoad) throw new Error('photoThumb had no data-mounted identity during loading')
  await d.waitFor(ids.reveal.title, { timeoutMs: 15000 }) // the dock name appears once the band settles
  const mountedAfter = (await d.state(ids.reveal.photoThumb)).attrs.mounted ?? ''
  if (!mountedAfter) throw new Error('photoThumb missing after settle (it remounted away)')
  if (mountedAfter !== mountedDuringLoad) throw new Error(`photo REMOUNTED across settle: was "${mountedDuringLoad}", now "${mountedAfter}"`)
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
