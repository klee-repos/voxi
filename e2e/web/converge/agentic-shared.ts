/**
 * agentic-shared.ts — the perception-driven navigation the agentic runners share, so every agentic test drives
 * the REAL screens the SAME way: an Agent reads the live testID/a11y tree and decides each tap (never a hardcoded
 * coordinate, never an app-internal poke), exactly as a person finds their way. Outcomes are always pinned by the
 * deterministic layer afterwards — the planners here only NAVIGATE (the two hard rules live in framework/agent.ts).
 *
 * Keeping these here (rather than copy-pasted per runner) is the coherence fix: one sign-in, one drawer-nav, used
 * identically across agentic-auth / agentic-collection / agentic-sweep.
 */
import type { Planner, PlannedAction } from '../../framework/agent'
import { ids } from '../../framework/testids'
import type { TestId } from '../../framework/testids'

/** Has the agent already performed this exact (kind,id) action? Used to sequence multi-field forms deterministically. */
export const did = (h: PlannedAction[], kind: PlannedAction['kind'], id: string): boolean =>
  h.some((a) => a.kind === kind && a.id === id)

/** The seeded email whose FakeAuth userId (`test:converge`) matches the default harness seed key `converge`. */
export const CONVERGE_EMAIL = 'converge@voxi.dev'

/**
 * Drive the REAL new-user journey the way a person does — the LANDING ("Get started") → /sign-up (email →
 * Continue → 6-digit code → Verify, NO consent checkboxes) → the REAL first-run onboarding (meet → allow camera →
 * allow mic → finish) — landing on the REAL camera. The agent perceives one screen at a time and taps what it
 * sees; the code `000000` is the FakeAuth seam's accepted value. `achieve()` ends when the camera is perceived.
 */
export function makeSignInPlanner(email: string): Planner {
  return async (_goal, obs, history) => {
    const v = (id: TestId) => obs.visibleIds.includes(id)
    const tap = (id: TestId, rationale: string): PlannedAction => ({ kind: 'tap', id, rationale })
    const type = (id: TestId, text: string, rationale: string): PlannedAction => ({ kind: 'type', id, text, rationale })

    // reached the camera → journey complete.
    if (v(ids.camera.screen)) return { kind: 'done', rationale: 'arrived at the camera' }

    // first-run onboarding steps — each renders one at a time; tap the one on screen.
    if (v(ids.firstRun.privacyAck)) return tap(ids.firstRun.privacyAck, 'finish onboarding → camera')
    if (v(ids.firstRun.micPrimeAllow)) return tap(ids.firstRun.micPrimeAllow, 'allow microphone')
    if (v(ids.firstRun.cameraPrimeAllow)) return tap(ids.firstRun.cameraPrimeAllow, 'allow camera')
    if (v(ids.firstRun.meetVoxiNext)) return tap(ids.firstRun.meetVoxiNext, 'past the hello')

    // sign-up — CODE phase (the field is present after Continue sends the code). Verify may need a second tap:
    // the FakeAuth token becomes live only on the render after verifyCode, so the first api.me() can 401 — exactly
    // as a real user re-taps. The loop re-issues the tap until it navigates off; Agent.achieve's settleMs paces it.
    if (v(ids.auth.codeInput)) {
      if (!did(history, 'type', ids.auth.codeInput)) return type(ids.auth.codeInput, '000000', 'enter the code')
      return tap(ids.auth.continue, 'verify and enter')
    }

    // sign-up — EMAIL phase: fill email, then Continue (no checkboxes — agreement is implicit on the tap).
    if (v(ids.auth.emailInput)) {
      if (!did(history, 'type', ids.auth.emailInput)) return type(ids.auth.emailInput, email, 'enter email')
      return tap(ids.auth.continue, 'send the code')
    }

    // landing — start account creation.
    if (v(ids.welcome.getStarted)) return tap(ids.welcome.getStarted, 'get started → create account')

    return { kind: 'done', rationale: 'no sign-in affordance on screen' }
  }
}

/**
 * Open a destination screen through the REAL left drawer, by perception. The drawer lives on the camera shell, so
 * from a pushed screen (e.g. the reveal) the agent first taps the back chevron to climb back to the camera, then
 * opens the hamburger and takes the drawer row — exactly the path a user walks. `destId` is the screen we expect to
 * land on (so the loop terminates once it is perceived). Used for the Collection and Settings hops in every sweep.
 */
export function makeDrawerNavPlanner(rowId: TestId, destId: TestId): Planner {
  return async (_goal, obs) => {
    const v = (id: TestId) => obs.visibleIds.includes(id)
    if (v(destId)) return { kind: 'done', rationale: 'arrived at the destination' }
    if (v(ids.drawer.screen) && v(rowId)) return { kind: 'tap', id: rowId, rationale: 'take the drawer row' }
    if (v(ids.nav.menuButton)) return { kind: 'tap', id: ids.nav.menuButton, rationale: 'open the drawer' }
    if (v(ids.nav.back)) return { kind: 'tap', id: ids.nav.back, rationale: 'back to the camera shell (drawer lives there)' }
    return { kind: 'done', rationale: 'no drawer affordance on screen' }
  }
}

/** Capture: tap the real shutter once (stops once tapped — processing/reveal are awaited deterministically after). */
export const capturePlanner: Planner = async (_goal, obs, history) => {
  if (did(history, 'tap', ids.camera.shutter)) return { kind: 'done', rationale: 'captured — the Guide is analysing' }
  if (obs.visibleIds.includes(ids.camera.shutter)) return { kind: 'tap', id: ids.camera.shutter, rationale: 'photograph the object' }
  return { kind: 'done', rationale: 'no shutter on screen' }
}
