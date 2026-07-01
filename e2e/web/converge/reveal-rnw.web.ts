/**
 * reveal-rnw.web.ts — CONVERGENCE PROOF (PLAN §9 Expo client ↔ §14 web E2E; docs/CONVERGENCE.md).
 *
 * Renders the REAL Expo screen `app/app/reveal.tsx` (unmodified app source, real child components, real Zustand
 * store, real shared confidence register, real ApiClient → real voxi-api BFF) under react-native-web in a real
 * Chromium via Playwright, driven through the framework PlaywrightDriver by the SAME testIDs the harness shell
 * uses. Built on the shared `standUp` rig (e2e/web/converge/harness.ts) so the ApiProvider + FakeAuth deps the
 * real reveal now pulls in (it fetches the spoken narration) resolve exactly as on `expo start --web`.
 *
 * Two proofs here:
 *   1. The reveal contract (PROBABLE band/chip/askVoxi/evidence panel + navigation intent) on the real screen.
 *   2. The SPOKEN REVEAL (ANALYSIS-VOICE-PLAN B): a CONFIDENT reveal → tap the real `reveal.playNarration` orb →
 *      the real ApiClient hits the real `/v1/threads/:id/speech` route → the real `reveal.narrationAudio` element
 *      is bound to the real synth output (a `data:audio/mpeg` source) and plays. Negative control: a rig with the
 *      speech seam UNconfigured → the route 503s and no audio is produced (fail-closed, never stubbed-to-green).
 *
 * Run: `bun e2e/web/converge/reveal-rnw.web.ts`  (exit 0 = converge proof GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const SEED = { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } }
const { check, fails } = makeChecker()

// ── Rig 1: speech CONFIGURED — the full reveal contract + the spoken-reveal happy path. ──
const rig = await standUp('client.tsx', SEED)
const { driver: d, page, errors, base } = rig

// Headless Chromium ignores the autoplay policy (it happily autoplays) AND Playwright keeps `navigator.
// userActivation.isActive` permanently true, so neither reproduces the reported bug ("it loads but says
// nothing"). We faithfully model the REAL browser/iOS policy in-page: play() is BLOCKED until a real DOM gesture
// (click/pointerdown) has occurred on the page; after a tap it succeeds. So the reveal's gesture-less autoplay
// fails exactly as it does for the user, and the test proves a SINGLE tap then plays it.
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

/** Read the live <audio> element state straight from the DOM (the real element the app rendered). */
async function audioState(): Promise<{ src: string; paused: boolean; currentTime: number; readyState: number; ended: boolean } | null> {
  return page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLAudioElement | null
    return el ? { src: el.getAttribute('src') || '', paused: el.paused, currentTime: el.currentTime, readyState: el.readyState, ended: el.ended } : null
  }, ids.reveal.narrationAudio)
}
/** Compact, log-friendly state (the mpeg src is a huge base64 blob — never dump it). */
function fmt(st: Awaited<ReturnType<typeof audioState>>): string {
  if (!st) return 'null'
  const kind = /^data:audio\/mpeg/.test(st.src) ? 'mpeg' : /^data:audio\/wav/.test(st.src) ? 'wav' : st.src ? 'other' : 'none'
  return `{src:${kind} paused:${st.paused} t:${st.currentTime.toFixed(2)} ended:${st.ended} ready:${st.readyState}}`
}

console.log('\nconverge: REAL app/app/reveal.tsx under react-native-web + real BFF (PROBABLE/id-03):')
await page.goto(`${base}/?scan=probable`)

await check('real reveal screen renders its card (data-testid from RNW testID)', () =>
  d.waitFor(ids.reveal.card, { timeoutMs: 8000 }),
)
await check('no uncaught errors while mounting the real component tree', async () => {
  if (errors.length) throw new Error(errors.join(' | '))
})
// id-03 contract: the band the REAL ConfidenceChip carries (dataSet → data-band) == PROBABLE from the BFF.
await check('reveal.confidenceChip carries data-band=PROBABLE (real chip + real stream)', async () => {
  const deadline = Date.now() + 8000
  let band = ''
  while (Date.now() < deadline) {
    band = (await d.state(ids.reveal.confidenceChip)).attrs.band ?? ''
    if (band === 'PROBABLE') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('band did not settle to PROBABLE within 8s; last=' + JSON.stringify(band))
})
await check('reveal.confidenceChip text is the real "confident maybe" register', async () => {
  const c = await d.state(ids.reveal.confidenceChip)
  if (!/confident maybe/i.test(c.text ?? '')) throw new Error('chip text=' + c.text)
})
await check('PROBABLE primary action is the real askVoxi affordance', () =>
  d.waitFor(ids.reveal.askVoxi, { timeoutMs: 3000 }),
)
await check('evidence panel auto-elevates in PROBABLE, shows candidates, and the howSure control toggles it', async () => {
  await d.waitFor(ids.reveal.evidencePanel, { timeoutMs: 3000 })
  const n = await page.locator(`[data-testid="${ids.reveal.candidateOption}"]`).count()
  if (n < 1) throw new Error('expected >=1 candidate option, got ' + n)
  await d.tap(ids.reveal.howSure)
  await d.waitFor(ids.reveal.evidencePanel, { timeoutMs: 2000, visible: false })
  await d.tap(ids.reveal.howSure)
  await d.waitFor(ids.reveal.evidencePanel, { timeoutMs: 2000 })
})
await check('real navigation intent fires on primary action (expo-router seam)', async () => {
  await d.tap(ids.reveal.askVoxi)
  const nav = await page.evaluate(() => document.body.getAttribute('data-last-nav'))
  if (!nav || !/conversation/.test(nav)) throw new Error('data-last-nav=' + nav)
})

// ── Spoken reveal (ANALYSIS-VOICE-PLAN B), on a CONFIDENT result. ──
console.log('\nconverge: SPOKEN REVEAL — real reveal.tsx → real /speech → real narrationAudio (CONFIDENT):')
await page.goto(`${base}/?scan=confident`)
await check('CONFIDENT reveal renders + settles the band', async () => {
  await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await d.state(ids.reveal.confidenceChip)).attrs.band === 'CONFIDENT') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('band did not settle to CONFIDENT')
})
await check('the play button + narration audio element render when there IS narration (A14 render-gate)', async () => {
  await d.waitFor(ids.reveal.playNarration, { timeoutMs: 5000 }) // the "Hear it" button is a visible Pressable
  // an <audio> element has no layout box (it's "hidden"), so assert EXISTENCE, not visibility.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await page.locator(`[data-testid="${ids.reveal.narrationAudio}"]`).count()) > 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('reveal.narrationAudio element did not render')
})
await check('reveal.narrationAudio is bound to the REAL /speech synth output (a data:audio/mpeg source)', async () => {
  // The client called the REAL BFF /speech route (server-owned narration → FakeTts → audio/mpeg bytes) and set
  // the element src to that mp3. If the route 503'd/404'd, speakNarration returns null and the src is NOT mpeg —
  // so this assertion is fail-closed on the whole server round-trip, not stubbed-to-green.
  const deadline = Date.now() + 8000
  let st = await audioState()
  while (Date.now() < deadline) {
    st = await audioState()
    if (st && /^data:audio\/mpeg/.test(st.src)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('narrationAudio never got an mpeg src from /speech: ' + fmt(st))
})
await check('autoplay is BLOCKED without a gesture — nothing plays on load (reproduces the report)', async () => {
  // The exact user complaint: "it loads but says nothing." Under a real autoplay policy the reveal must NOT be
  // playing on its own. (The old code left the button showing "playing" here, so a single tap paused it → silence.)
  await page.waitForTimeout(1000) // let the best-effort autoplay attempt fire + reject
  const st = await audioState()
  if (!st) throw new Error('no audio element')
  if (!st.paused || st.currentTime > 0) throw new Error('expected paused-on-load (autoplay blocked); got ' + fmt(st))
})
await check('ONE tap of the "Hear it" button plays the narration (currentTime advances) — no retry loop', async () => {
  // A SINGLE trusted tap must start playback. This is the assertion that catches the reported bug: with the old
  // desynced state, one tap toggled the (wrongly-"playing") button OFF and nothing played. We tap once, then only
  // WAIT for the async play/decode to spin up — we never tap again.
  await d.tap(ids.reveal.playNarration)
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const st = await audioState()
    if (st && /^data:audio\/mpeg/.test(st.src) && !st.paused && st.currentTime > 0) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('a single tap did not start playback: ' + fmt(await audioState()))
})

// ── Progressive facts (PROMPT-QUALITY §3.C): the async research streams VERIFIED facts in as individual chips,
//    each carrying a tappable SOURCE PROOF (the verbatim quote it was grounded on — the "proof if challenged"). ──
await check('async research renders ≥3 individual fact chips (not one tray)', async () => {
  const deadline = Date.now() + 8000
  let n = 0
  while (Date.now() < deadline) {
    n = await page.locator(`[data-testid="${ids.reveal.fact}"]`).count()
    if (n >= 3) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('expected ≥3 fact chips, got ' + n)
})
await check('each fact chip exposes its SOURCE PROOF on tap (the verbatim quote appears)', async () => {
  await page.locator(`[data-testid="${ids.reveal.factSource}"]`).first().click()
  await page.waitForTimeout(250)
  const body = await page.evaluate(() => document.body.textContent || '')
  if (!/Hide source/.test(body)) throw new Error('source proof did not open on tap')
  if (!/[“"]/.test(body)) throw new Error('verbatim quote (the proof) not shown after tap')
})

// ── Known-divergence findings (informational — real-screen behaviour vs the harness shell). ──
const findings: string[] = []
async function finding(name: string, divergesIf: () => Promise<boolean>, note: string) {
  const diverges = await divergesIf().catch(() => true)
  if (diverges) { findings.push(`${name} — ${note}`); console.log('  FINDING', name) }
  else console.log('  (parity)', name)
}
await page.goto(`${base}/?scan=probable`)
await d.waitFor(ids.reveal.card, { timeoutMs: 8000 })
await finding(
  'reveal.title / quip / whatItIs missing on real screen (Title/Body drop tid props)',
  async () => (await page.locator(`[data-testid="${ids.reveal.title}"]`).count()) === 0,
  'app/src/components/ui.tsx Title/Body must spread `...rest` onto <Text> so testID/aria-label reach the DOM',
)
await finding(
  'evidence panel does not auto-elevate on async band settle (only on tap)',
  async () => {
    await page.waitForTimeout(400)
    return (await page.locator(`[data-testid="${ids.reveal.evidencePanel}"]`).count()) === 0
  },
  'app/app/reveal.tsx derives showEvidence from band so PROBABLE/low auto-elevates',
)

await rig.stop()

// ── Rig 2: speech UNCONFIGURED — the negative control (the route must fail LOUD, never fake success). ──
console.log('\nconverge: NEGATIVE CONTROL — speech seam absent → /speech 503, no audio produced:')
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
await check('with no speech seam, NO audio element is mounted (honest — no silent-fake playback)', async () => {
  await rig2.driver.waitFor(ids.reveal.card, { timeoutMs: 8000 })
  await rig2.driver.waitFor(ids.reveal.playNarration, { timeoutMs: 5000 }) // the control still renders (with a retry)
  await rig2.page.waitForTimeout(800) // let speakNarration resolve to its 503 → narrationFailed
  // The reveal must NOT mount a silent placeholder <audio> when there's no real synth output. The control label
  // says "unavailable", and there is no mpeg source anywhere.
  const audioCount = await rig2.page.locator(`[data-testid="${ids.reveal.narrationAudio}"]`).count()
  const label = await rig2.page.evaluate((tid) => document.querySelector(`[data-testid="${tid}"]`)?.getAttribute('aria-label') || '', ids.reveal.playNarration)
  if (audioCount !== 0) throw new Error('expected NO audio element when speech is off; found ' + audioCount)
  if (!/unavailable/i.test(label)) throw new Error('control should read "unavailable"; got ' + JSON.stringify(label))
})
await rig2.stop()

console.log('\n--- convergence findings (real-screen divergences from the harness shell) ---')
if (findings.length === 0) console.log('  none — full parity')
for (const f of findings) console.log('  •', f)

console.log(
  fails() === 0
    ? `\nCONVERGE PROOF GREEN — real reveal.tsx renders, the spoken reveal round-trips through the real /speech route, and the negative control fails loud (${findings.length} divergence(s) recorded)`
    : `\nCONVERGE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
