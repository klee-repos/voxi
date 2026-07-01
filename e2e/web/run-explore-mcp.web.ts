/**
 * explore-01 (agentic) over the agent-browser BACKEND — perceive → navigate → deterministic testid assertions.
 *
 * This is the agent-browser sibling of run-agent-pw.web.ts. Where that runner exercises the agentic loop over
 * the PlaywrightDriver, THIS runner exercises the SAME perceive-then-navigate discipline over the native
 * agent-browser CLI/daemon — the backend the PLAN earmarks for agentic scale (sessions, MCP, cloud providers).
 *
 * The agent NAVIGATES by perception: each step it reads agent-browser's `snapshot -i` (the accessibility tree
 * with @eN refs), decides the next ref to click/fill from what it actually sees, and acts. It NEVER asserts on
 * its own perception. Every OUTCOME is pinned by a deterministic `getByTestId` read (data-testid + data-band),
 * against the real BFF + web shell — so the agent finds its way like a user, but the pass/fail is exact.
 *
 * explore-01 sweep (TEST-PLAN §"explore-01": goal-driven sweep of the screens × {empty, error, offline}):
 *   round A — sign-in by perception → camera                       (auth, perception-driven)
 *   round B — capture seed `probable` → PROBABLE reveal            (id, real NDJSON, band pinned)
 *   round C — capture seed `confident` → CONFIDENT reveal          (band variation)
 *   round D — capture seed `pill` → safety refusal (not a chip)    (safety state, distinct surface)
 *   round E — direct-route the threads EMPTY state                 (empty state)
 *   round F — direct-route settings; assert the no-face-recognition privacy line  (privacy state)
 *
 * The harness server runs in a SEPARATE process (explore-harness-server.ts): agent-browser's persistent
 * daemon inherits the spawning process's open fds, so if this process held an in-process Bun.serve listening
 * socket the daemon would inherit + hold it and the launching spawnSync would hang (the documented failure).
 * Driving agent-browser from a process that holds no listening socket makes every command return in tens of ms.
 *
 * If agent-browser cannot be driven here (no CLI, or no Chrome/Chromium for its daemon), the runner SKIPS
 * cleanly (exit 0, a 'skipped' result) rather than hang — run-agent-pw.web.ts already delivers the agentic
 * coverage deterministically in CI. We NEVER force a green.
 *
 * Run: `bun e2e/web/run-explore-mcp.web.ts`
 */
import { AgentBrowser } from '../framework/drivers/agent-browser'
import { ids } from '../framework/testids'

const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}

async function finish(code: number) {
  await Bun.write('e2e/web/.explore-mcp-result.txt', out.join('\n') + '\n')
  process.exitCode = code
}

// ── SKIP gate: if the agent-browser CLI is not runnable here, skip cleanly (never hang, never fake green). ──
const probe = AgentBrowser.probe()
if (!probe.ok) {
  log('explore-01 (agent-browser backend): SKIPPED')
  log(`  reason: ${probe.reason}`)
  log('  agentic coverage is delivered by run-agent-pw.web.ts (Agent planner over PlaywrightDriver). No green faked.')
  log('AGENTIC (agent-browser) E2E SKIPPED')
  await finish(0)
} else {
  // Start the harness in its OWN process (see header: keeps the daemon from inheriting a listening socket).
  const harness = Bun.spawn(['bun', 'e2e/web/explore-harness-server.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  /** Read the harness's chosen ephemeral port from its first stdout line (fails closed on timeout). */
  async function readHarnessPort(timeoutMs = 10_000): Promise<number> {
    const reader = harness.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value)
        const m = /"port":(\d+)/.exec(buf)
        if (m) return Number(m[1])
      }
    } finally {
      reader.releaseLock()
    }
    throw new Error('harness server did not report a port')
  }

  const ab = new AgentBrowser()
  let fails = 0
  const assert = (name: string, cond: boolean, detail = '') => {
    if (cond) log(`  PASS ${name}`)
    else {
      fails++
      log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
    }
  }

  /**
   * Agentic sign-in: navigate the welcome→camera flow PURELY from the observed snapshot. The agent reads the
   * a11y tree, maps roles/names to refs, and acts — it does not hardcode refs (they are assigned per snapshot).
   * Outcome (camera reached) is asserted deterministically afterward by the caller.
   */
  function signInByPerception(email: string): void {
    // each round re-opens a fresh URL (full reload → welcome); wait for the welcome form before perceiving it.
    if (!ab.waitForTestId(ids.welcome.emailInput, 8000)) throw new Error('welcome screen did not load')
    // step 1: perceive the welcome form, fill email by its accessible name, accept the two consents.
    let snap = ab.snapshot()
    const emailRef = snap.find((n) => n.role === 'textbox' && /email/i.test(n.name))?.ref
    if (!emailRef) throw new Error('perception: no email textbox in snapshot')
    ab.fill(emailRef, email)
    for (const want of [/accept terms/i, /16\+|age/i]) {
      const cb = snap.find((n) => n.role === 'checkbox' && want.test(n.name))?.ref
      if (cb) ab.click(cb)
    }
    // continue → OTP step
    const cont1 = ab.snapshot().find((n) => n.role === 'button' && /continue/i.test(n.name))?.ref
    if (!cont1) throw new Error('perception: no Continue button before OTP')
    ab.click(cont1)
    // step 2: perceive the OTP field, fill it, continue → camera.
    snap = ab.snapshot()
    const otpRef = snap.find((n) => n.role === 'textbox' && /code/i.test(n.name))?.ref
    if (!otpRef) throw new Error('perception: OTP textbox did not appear after first continue')
    ab.fill(otpRef, '424242')
    const cont2 = ab.snapshot().find((n) => n.role === 'button' && /continue/i.test(n.name))?.ref
    if (!cont2) throw new Error('perception: no Continue button at OTP step')
    ab.click(cont2)
  }

  /** Capture by perception: find the shutter in the snapshot, click it, wait for the terminal screen. */
  function captureByPerception(): void {
    const shutter = ab.snapshot().find((n) => n.role === 'button' && /shutter/i.test(n.name))?.ref
    if (!shutter) throw new Error('perception: no shutter on the camera screen')
    ab.click(shutter)
  }

  try {
    log('explore-01 (agentic) over the agent-browser backend (real BFF + web shell):')
    const base = `http://localhost:${await readHarnessPort()}`

    // A distinct seeded user per round → each gets its own entitlements + its own (empty) collection.
    // The web shell keys the user off the email localpart; the harness seeds expa..expf.

    // ── round A: agentic sign-in → camera (seed PROBABLE so the same session can capture next) ──
    ab.open(`${base}/?scan=probable`)
    signInByPerception('expa@voxi.test')
    assert('A · auth-01: navigated welcome → camera by perception', ab.isVisibleTestId(ids.camera.screen))

    // ── round B: capture (seed probable) → PROBABLE reveal; band + hedge + disagreement pinned ──
    captureByPerception()
    // wait for the NDJSON stream to actually settle the band (the card div pre-exists in the DOM).
    ab.waitForFn(`document.querySelector('[data-testid="${ids.reveal.confidenceChip}"]')?.getAttribute('data-band')==='PROBABLE'`, 8000)
    {
      const card = ab.getByTestId(ids.reveal.card)
      assert('B · reveal card appears from the real NDJSON stream', card.visible)
      const chip = ab.getByTestId(ids.reveal.confidenceChip)
      assert('B · id-03: confidence band = PROBABLE', chip.band === 'PROBABLE', `band=${chip.band}`)
      const title = ab.getByTestId(ids.reveal.title)
      assert('B · id-03: title is the "confident maybe" hedge', /confident maybe/i.test(title.text), `title=${title.text}`)
      const cand = ab.getByTestId(ids.reveal.candidateOption)
      assert('B · disagreement surfaced as multiple candidates', Number(cand.attrs['count'] ?? '0') >= 2, `count=${cand.attrs['count']}`)
    }

    // ── round C: re-auth a fresh seed (confident) → CONFIDENT reveal; band variation ──
    ab.open(`${base}/?scan=confident`)
    signInByPerception('expc@voxi.test')
    captureByPerception()
    ab.waitForFn(`document.querySelector('[data-testid="${ids.reveal.confidenceChip}"]')?.getAttribute('data-band')==='CONFIDENT'`, 8000)
    {
      const chip = ab.getByTestId(ids.reveal.confidenceChip)
      assert('C · id: confident object → band = CONFIDENT', chip.band === 'CONFIDENT', `band=${chip.band}`)
      // "How sure?" is suppressed when CONFIDENT — the honesty gate doesn't hedge a settled identification.
      const howSure = ab.getByTestId(ids.reveal.howSure)
      assert('C · How-sure affordance hidden when CONFIDENT', !howSure.visible)
    }

    // ── round D: seed `pill` → safety refusal surface (distinct from the gold confidence chip) ──
    ab.open(`${base}/?scan=pill`)
    signInByPerception('expd@voxi.test')
    captureByPerception()
    ab.waitForTestId(ids.global.safetyRefusal, 8000)
    {
      const refusal = ab.getByTestId(ids.global.safetyRefusal)
      assert('D · safety: regulated object refusal is shown', refusal.visible)
      assert('D · safety: refusal copy stays in-persona (describe, not identify)', /describe|not identify|will not/i.test(refusal.text), `text=${refusal.text}`)
      const chip = ab.getByTestId(ids.reveal.confidenceChip)
      assert('D · safety: NOT rendered as a confidence chip (no band)', !chip.visible || chip.band === '')
    }

    // ── round E: empty-state sweep — direct-route the (zero-capture) collection via hash routing ──
    ab.open(`${base}/?scan=probable#/threads`)
    signInByPerception('expe@voxi.test') // never captures → collection is empty; auth honors the start hash
    ab.waitForTestId(ids.threads.screen, 5000)
    {
      const empty = ab.getByTestId(ids.threads.emptyState)
      assert('E · threads empty-state is shown for a fresh account', empty.visible)
      assert('E · empty-state copy invites a first capture', /0 of|capture|empty/i.test(empty.text), `text=${empty.text}`)
    }

    // ── round F: privacy sweep — settings exposes the no-face-recognition guarantee ──
    ab.open(`${base}/?scan=probable#/settings`)
    signInByPerception('expf@voxi.test')
    ab.waitForTestId(ids.settings.screen, 5000)
    {
      const privacy = ab.getByTestId(ids.settings.privacyNoFaceRecognition)
      assert('F · settings: face-recognition privacy guarantee is present', privacy.visible)
      assert('F · privacy copy states faces/plates are redacted', /face recognition|redact/i.test(privacy.text), `text=${privacy.text}`)
    }

    log(fails === 0 ? 'AGENTIC (agent-browser) E2E GREEN' : `AGENTIC (agent-browser) E2E FAILURES: ${fails}`)
  } catch (e) {
    // Fail closed: an exception (incl. a wedged/timed-out daemon command) is a FAILURE, never a silent pass.
    fails++
    log('  FAIL (exception) ' + (e as Error).message)
    log(`AGENTIC (agent-browser) E2E FAILURES: ${fails}`)
  } finally {
    ab.close()
    harness.kill()
    await harness.exited.catch(() => {})
  }

  await finish(fails === 0 ? 0 : 1)
}
