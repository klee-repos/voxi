/**
 * reveal-deepdive.web.ts — E2E over the "Deep Dive" affordance on the REAL screens (react-native-web, converge):
 * real testID taps, every outcome pinned deterministically.
 *
 * PROOF A — the reveal DOCK (single-screen reveal client; nav is recorded, not swapped, like reveal-menu):
 *   A0 the dock is THREE icons — Explore (Deep Dive) FIRST, Details, Ask; what/purpose/maker are NOT dock icons
 *      (collapsed under Details); A1 they're in order with clear GAPS between them; A2 the Ask icon is visible;
 *      A3 tapping Explore records push:/podcast.
 *   D0 — the Deep Dive AUTO-STARTS on identification: the icon leaves 'active' and reaches 'ready' with NO tap and
 *      NO test-seed (the reveal effect fires the real generatePodcast → the harness podcast feed drives composing→ready).
 *      Staying 'active' would mean the effect never fired — a regression. This is the no-fake-green auto-start proof.
 * PROOF B — the Deep Dive PLAYER (its own entry mounts the REAL app/app/podcast.tsx with a REAL owned thread; the
 *   reveal auto-start does NOT fire here — no reveal.tsx — so this exercises the player's idle-fallback path):
 *   B1 opens in IDLE with an explicit Generate CTA; B2 never says "podcast"/"episode"; B3 tapping Generate starts composing.
 *   C0 composing shows the LARGE progress hero + a live elapsed "how long" indicator; C1 it reaches READY with the
 *   Spotify transport (scrubber + ±15 + play); C2 the karaoke transcript renders; C3 the karaoke COUPLES to the
 *   playhead — the active-word index STRICTLY ADVANCES as currentTime advances (the no-fake-green proof that the
 *   highlight isn't hardcoded); C4 the ±15 transport moves the highlight.
 *
 * Run: `bun e2e/web/converge/reveal-deepdive.web.ts`  (exit 0 = GREEN).
 */
import { standUp, makeChecker } from './harness'
import { ids } from '../../framework/testids'

const { check, fails } = makeChecker()

// ── PROOF A + D — the dock, on the real reveal screen ────────────────────────────────────────────────────────
{
  const rig = await standUp('client.tsx', { seed: { converge: { scan: 5, podcast: 1, voiceMin: 10 } } })
  const { driver: d, page, base } = rig
  const lastNav = (): Promise<string | null> => page.evaluate(() => document.body.getAttribute('data-last-nav'))
  const box = async (id: string): Promise<{ x: number; width: number }> => {
    const b = await page.locator(`[data-testid="${id}"]`).first().boundingBox()
    if (!b) throw new Error(`${id} is not in the layout`)
    return { x: b.x, width: b.width }
  }
  const iconStateAttr = (): Promise<string | null> =>
    page.locator(`[data-testid="${ids.reveal.deepDiveIcon}"]`).first().getAttribute('data-state')

  await page.goto(`${base}/?scan=confident`)
  await d.waitFor(ids.reveal.buckets, { timeoutMs: 8000 })
  await d.waitFor(ids.reveal.title, { timeoutMs: 6000 })

  await check('A0 · the dock is THREE icons — Explore · Details · Ask (what/purpose/maker are NOT dock icons)', async () => {
    for (const id of [ids.reveal.bucketWhat, ids.reveal.bucketPurpose, ids.reveal.bucketWho] as const) {
      if ((await d.state(id)).visible) throw new Error(`${id} is still rendered as a dock icon — the Details collapse missed it`)
    }
    for (const id of [ids.reveal.deepDiveIcon, ids.reveal.detailsIcon, ids.reveal.conversationIcon] as const) {
      if (!(await d.state(id)).visible) throw new Error(`${id} is missing from the 3-icon dock`)
    }
  })

  await check('A1 · three icons in order (Explore FIRST) with clear GAPS + equal slots between them', async () => {
    await d.waitFor(ids.reveal.deepDiveIcon, { timeoutMs: 5000 })
    await d.waitFor(ids.reveal.detailsIcon, { timeoutMs: 5000 })
    const deep = await box(ids.reveal.deepDiveIcon)
    const details = await box(ids.reveal.detailsIcon)
    const ask = await box(ids.reveal.conversationIcon)
    if (!(deep.x < details.x)) throw new Error(`Explore (${deep.x}) is not FIRST — not left of Details (${details.x})`)
    if (!(details.x < ask.x)) throw new Error(`Details (${details.x}) is not left of Ask (${ask.x})`)
    // Equal flex:1 slots (the three share the row evenly)…
    const widths = [deep.width, details.width, ask.width]
    if (Math.max(...widths) - Math.min(...widths) > 4) throw new Error(`dock slots are not equal flex:1: ${widths}`)
    // …with a real gap between them (the old 5-up row was edge-to-edge; ≥12 proves the spacing shipped).
    const gap1 = details.x - (deep.x + deep.width)
    const gap2 = ask.x - (details.x + details.width)
    if (!(gap1 >= 12 && gap2 >= 12)) throw new Error(`dock gaps too small (${gap1.toFixed(0)}, ${gap2.toFixed(0)}) — need ≥12 between slots`)
  })

  await check('A2 · the Ask (Ask Voxi) icon is visible (the pinned people lane, last in the dock)', async () => {
    if (!(await d.state(ids.reveal.conversationIcon)).visible) throw new Error('the Ask/conversation icon is not visible')
  })

  await check('D0 · the Deep Dive AUTO-STARTS on identification — generating→ready with NO tap and NO test-seed (the reveal effect fired)', async () => {
    await d.waitFor(ids.reveal.deepDiveIcon, { timeoutMs: 5000 })
    // (1) Leaves 'active': the reveal effect calls startDeepDive → launchJob writes 'composing' SYNCHRONOUSLY
    //     before any await, so the icon must leave 'active' on band-settle. We do NOT drive __deepDiveTest here —
    //     that would seed the store and fake-green this proof (it would pass even with the F5 effect deleted).
    //     Staying 'active' = the effect never fired = a regression.
    await page.waitForFunction(
      () => { const el = document.querySelector('[data-testid="reveal.deepDiveIcon"]'); return !!el && el.getAttribute('data-state') !== 'active' },
      { timeout: 8000 },
    )
    // (2) Reaches 'ready' via the REAL harness podcast feed (the same one PROOF B's Generate→ready uses).
    await page.waitForFunction(
      () => { const el = document.querySelector('[data-testid="reveal.deepDiveIcon"]'); return !!el && el.getAttribute('data-state') === 'ready' },
      { timeout: 25000 },
    )
    const st = await iconStateAttr()
    if (st !== 'ready') throw new Error(`expected the auto-started Deep Dive icon to settle 'ready', got ${st}`)
  })

  await check('A3 · tapping Explore navigates to the Deep Dive player (records push:/podcast)', async () => {
    await d.tap(ids.reveal.deepDiveIcon)
    await page.waitForTimeout(200)
    const nav = await lastNav()
    if (nav !== 'push:/podcast') throw new Error(`expected push:/podcast, got ${nav}`)
  })

  await rig.stop()
}

// ── PROOF B + C — the Deep Dive player, mounting the real screen with a real thread ──────────────────────────
{
  // podcast:5 (not 1) so the retest REGENERATE (Proof R) has credits after B3's first generate spends one — a
  // regenerate at a fresh version is a NEW gate key, so it decrements again (the honest paid path).
  const rig = await standUp('deepdive-client.tsx', { seed: { converge: { scan: 5, podcast: 5, voiceMin: 10 } } })
  const { driver: d, page, base } = rig
  await page.goto(`${base}/`)

  const boxX = async (id: string): Promise<number> => {
    const b = await page.locator(`[data-testid="${id}"]`).first().boundingBox()
    if (!b) throw new Error(`${id} is not in the layout`)
    return b.x
  }
  const readIdx = async (): Promise<number> => Number((await d.state(ids.podcast.activeWordIndex)).attrs?.idx ?? 'NaN')
  const setTime = (t: number): Promise<void> =>
    page.evaluate((tt) => {
      const a = document.querySelector('[data-testid="podcast.audio"]') as HTMLAudioElement | null
      if (a) a.currentTime = tt
    }, t)

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
    // startDeepDive sets 'composing' synchronously on tap (before the network call), so it must appear at once.
    await d.waitFor(ids.podcast.composingState, { timeoutMs: 8000 })
  })

  await check('C0 · composing shows the LARGE progress hero + a live elapsed "how long" indicator (never looks stuck)', async () => {
    if (!(await d.state(ids.podcast.progressHero)).visible) throw new Error('the composing progress hero is missing')
    if (!(await d.state(ids.podcast.composeElapsed)).visible) throw new Error('the "how long" elapsed indicator is missing while composing')
  })

  await check('C1 · after generating, the player reaches READY with the Spotify transport (scrubber + ±15 + play)', async () => {
    await d.waitFor(ids.podcast.scrubber, { timeoutMs: 25000 }) // the background poll flips composing→ready → the player renders
    for (const id of [ids.podcast.playPause, ids.podcast.skipBack, ids.podcast.skip15, ids.podcast.scrubberElapsed, ids.podcast.scrubberDuration]) {
      if (!(await d.state(id)).visible) throw new Error(`${id} missing from the ready player transport`)
    }
  })

  await check('C2 · the karaoke read-along renders the two-voice transcript', async () => {
    const lines = await page.locator('[data-testid="podcast.transcriptLine"]').count()
    if (lines < 2) throw new Error(`expected the karaoke transcript to render ≥2 lines, got ${lines}`)
  })

  await check('C3 · karaoke COUPLES to the playhead — the active-word index STRICTLY ADVANCES with currentTime (not hardcoded)', async () => {
    // wait for the audio metadata (real duration) so the playhead is seekable across the transcript
    await page.waitForFunction(
      () => { const a = document.querySelector('[data-testid="podcast.audio"]') as HTMLAudioElement | null; return !!a && a.duration > 1 },
      { timeout: 6000 },
    )
    const i0 = await readIdx()
    await setTime(8); await page.waitForTimeout(250)
    const i1 = await readIdx()
    await setTime(22); await page.waitForTimeout(250)
    const i2 = await readIdx()
    if (!(i1 > i0 && i2 > i1)) throw new Error(`the karaoke active-word index did not advance with the playhead: ${i0} → ${i1} → ${i2} (an uncoupled/hardcoded-0 highlight would ship dead)`)
  })

  await check('C4 · the ±15 transport moves the highlight — a −15s skip pulls the active word BACK', async () => {
    const before = await readIdx() // currentTime ~22 from C3
    await d.tap(ids.podcast.skipBack) // seekBy(-15) → ~7s
    await page.waitForTimeout(300)
    const after = await readIdx()
    if (!(after < before)) throw new Error(`skip-back did not move the karaoke highlight: ${before} → ${after}`)
  })

  await check('C5 · play/pause drives the transport state and STICKS (playing is intent, not hardware-mirrored)', async () => {
    const playingNow = async (): Promise<string | undefined> => (await d.state(ids.podcast.playerState)).attrs?.playing
    await d.tap(ids.podcast.playPause)
    await page.waitForTimeout(200)
    if ((await playingNow()) !== 'true') throw new Error('tap play did not set playing=true')
    await d.tap(ids.podcast.playPause)
    await page.waitForTimeout(200)
    if ((await playingNow()) !== 'false') throw new Error('tap pause did not set playing=false (it bounced back — the transport-mirror bug)')
  })

  await check('C6 · dragging the SCRUBBER seeks by POSITION — the client onSeek→seekTo path the device exercises', async () => {
    // The user's bug: scrubber drag does nothing. This drives the REAL Scrubber PanResponder with a positional
    // mouse drag (a center .click()/onPress carries NO locationX on RNW → would fall back to mid-track and prove
    // nothing) and reads the Scrubber's OWN `fraction` anchor — which reflects the post-seek playhead. We NEVER
    // write currentTime here: that would bypass onSeek and fake-green the very path under test.
    const fractionNow = async (): Promise<number> => Number((await d.state(ids.podcast.scrubber)).attrs?.fraction ?? 'NaN')
    const box = await page.locator(`[data-testid="${ids.podcast.scrubber}"]`).first().boundingBox()
    if (!box) throw new Error('the scrubber has no layout box')
    const dragToFraction = async (fx: number): Promise<void> => {
      const x = box.x + box.width * fx
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width * 0.5, y)
      await page.mouse.down()
      await page.mouse.move(x, y, { steps: 6 }) // real move → onPanResponderMove(locationX)
      await page.mouse.up() // onPanResponderRelease(locationX) → onSeek(fraction*duration)
      await page.waitForTimeout(250)
    }
    const before = await fractionNow()
    await dragToFraction(0.72)
    const near = await fractionNow()
    // Must land NEAR 72% — not at ~0.5. A center value would mean the pan never engaged (locationX absent) and the
    // seek fell back to mid-track: that is the "scrubber only jumps to the middle / does nothing" bug, NOT a pass.
    if (!(near > 0.6 && near < 0.85)) {
      throw new Error(
        `dragging the scrubber to ~72% did not seek THERE: fraction ${before} → ${near} ` +
          `(~0.5 = a center fallback = the pan didn't engage / no locationX; unchanged = a dead onSeek)`,
      )
    }
    await dragToFraction(0.1)
    const back = await fractionNow()
    if (!(back < 0.25)) throw new Error(`dragging the scrubber back to ~10% did not pull the playhead down to it: ${near} → ${back}`)
  })

  // ── PROOF R — the retest REGENERATE button (far LEFT side, clear across the bar from the close X → a genuine fresh generation)
  await check('R1 · the ready player shows Regenerate on the LEFT side, with space between it and the close X', async () => {
    if (!(await d.state(ids.podcast.regenerate)).visible) throw new Error('the Regenerate control is missing from the ready player header')
    const regen = await page.locator(`[data-testid="${ids.podcast.regenerate}"]`).first().boundingBox()
    const close = await page.locator(`[data-testid="${ids.nav.close}"]`).first().boundingBox()
    if (!regen || !close) throw new Error('Regenerate or close box missing')
    if (!(regen.x < close.x)) throw new Error(`Regenerate (${regen.x}) is not LEFT of the close X (${close.x})`)
    // The gap between the two controls must exceed the control's own width — proves Regenerate sits on the far
    // left (not crammed immediately next to the close X in the right slot).
    const gap = close.x - (regen.x + regen.width)
    if (!(gap > regen.width)) throw new Error(`Regenerate is crammed next to close (gap ${gap.toFixed(0)} <= control width ${regen.width.toFixed(0)}) — it should sit on the far left with space between`)
  })

  await check('R2 · tapping Regenerate leaves the ready player and re-enters composing (a genuine fresh generation, not a UI reset)', async () => {
    await d.tap(ids.podcast.regenerate)
    // regenerateDeepDive sets composing SYNCHRONOUSLY at a fresh version; the real BFF gate mints a new token → a real compose.
    await d.waitFor(ids.podcast.composingState, { timeoutMs: 8000 })
    if ((await d.state(ids.podcast.scrubber)).visible) throw new Error('the ready-player scrubber is still shown — the regenerate did not re-enter composing')
  })

  await check('R3 · the regenerated deep dive completes back to a READY player (full fresh cycle through the real gate + worker)', async () => {
    await d.waitFor(ids.podcast.scrubber, { timeoutMs: 25000 }) // the fresh token polls composing→ready → the player re-renders
    if (!(await d.state(ids.podcast.regenerate)).visible) throw new Error('the Regenerate control did not return on the re-generated ready player')
  })

  await rig.stop()
}

console.log(
  fails() === 0
    ? '\nDEEP DIVE PROOF GREEN — dock: THREE icons (Explore FIRST · Details · Ask), what/purpose/maker collapsed under Details with clear gaps + equal slots; the Deep Dive AUTO-STARTS on identification (active→generating→ready with no tap, no test-seed — the reveal effect fired); tapping Explore → /podcast; player (idle-fallback path): opens IDLE, never says "podcast/episode", Generate → a large composing hero with a live elapsed indicator → a dark Spotify player whose karaoke highlight COUPLES to the playhead (advances with currentTime, moves on ±15); a Regenerate control sits on the LEFT side (space between it and the close X) and re-runs a genuine fresh generation (ready → composing → ready) through the real gate + worker'
    : `\nDEEP DIVE FAILURES: ${fails()}`,
)
process.exit(fails() === 0 ? 0 : 1)
