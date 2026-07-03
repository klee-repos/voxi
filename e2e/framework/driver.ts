/**
 * Surface-agnostic driver interface + Scenario types.
 *
 * A Scenario is authored ONCE against this interface. The runner binds it to a concrete driver per
 * `--surface`: PlaywrightDriver (web, runs in CI now), MaestroDriver (iOS deterministic, compiles to YAML),
 * or AppiumDriver (iOS agentic). Same scenario, three surfaces — this is what keeps authoring cheap.
 *
 * The split that enforces the deterministic↔agentic balance:
 *  - `Driver` exposes ONLY deterministic primitives (locate by testId, tap, type, read state, assert).
 *  - `Agent` (agent.ts) wraps a Driver and adds `achieve(goal)` — LLM-planned navigation. An agentic step
 *    may navigate, but it returns control to deterministic assertions for anything that matters. The LLM
 *    never decides pass/fail.
 */
import type { TestId } from './testids'

export type Surface = 'web' | 'ios'
export type RunMode = 'replay' | 'live' // replay = vendor tapes (deterministic CI); live = real APIs (creds)

export interface ElementState {
  visible: boolean
  text?: string
  /** structured attributes the app exposes on the element, e.g. { 'chip.band': 'PROBABLE', 'orb.state': 'speaking' } */
  attrs: Record<string, string>
}

/** Deterministic primitives. Every committed assertion bottoms out here — never in app internals. */
export interface Driver {
  readonly surface: Surface
  readonly mode: RunMode

  // ---- actions (simulate a real user) ----
  tap(id: TestId): Promise<void>
  type(id: TestId, text: string): Promise<void>
  /** hold a button (push-to-talk); resolves when released after `ms` or when `until` matches. */
  hold(id: TestId, ms: number): Promise<void>
  scrollTo(id: TestId): Promise<void>
  /** play a recorded utterance into the mic input (deterministic voice fixture). */
  speak(fixtureName: string): Promise<void>

  // ---- observation ----
  state(id: TestId): Promise<ElementState>
  waitFor(id: TestId, opts?: { timeoutMs?: number; visible?: boolean }): Promise<void>
  /** the full accessibility tree of the current screen (drives the agentic planner). */
  a11yTree(): Promise<A11yNode>
  screenshot(name: string): Promise<Buffer>

  // ---- environment controls (only honored in VOXI_TEST_MODE) ----
  setNetwork(state: 'online' | 'offline'): Promise<void>
  grantPermission(p: 'camera' | 'mic' | 'notifications', granted: boolean): Promise<void>

  dispose(): Promise<void>
}

export interface A11yNode {
  id?: TestId
  role: string
  label?: string
  value?: string
  attrs: Record<string, string>
  children: A11yNode[]
}

// ---- Scenario authoring surface ----
export interface Ctx {
  driver: Driver
  /** present only when an agentic step is allowed; throws if used in a `pure: 'deterministic'` scenario. */
  agent: { achieve(goal: string, opts?: { maxSteps?: number }): Promise<void> }
  /** deterministic assertions (assertions.ts); they throw on failure with a screenshot + a11y dump. */
  expect: Assertions
  /** the seeded world (db rows, entitlements) for setup/teardown. */
  world: World
}

export interface Assertions {
  visible(id: TestId): Promise<void>
  notVisible(id: TestId): Promise<void>
  text(id: TestId, matcher: string | RegExp): Promise<void>
  attr(id: TestId, key: string, value: string | RegExp): Promise<void>
  /** chip band must equal exactly (CONFIDENT|PROBABLE|UNKNOWN). */
  chipBand(id: TestId, band: 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN'): Promise<void>
  /** audio element is actually advancing (currentTime increases) — proves playback, not just a play icon. */
  playing(id: TestId): Promise<void>
  /** the global safety refusal is shown AND is visually distinct from the confidence chip. */
  safetyRefusal(): Promise<void>
  /** asserts a server-side invariant via the BFF test API (e.g. stored photo is redacted, entitlement decremented). */
  server(predicate: ServerPredicate): Promise<void>
  oneOf(id: TestId, matchers: (string | RegExp)[]): Promise<void>
}

export type ServerPredicate =
  | { kind: 'photoRedacted'; threadId: string }
  | { kind: 'entitlementDecremented'; userId: string; meter: 'scan' | 'podcast' | 'voiceMin' }
  | { kind: 'sessionResumes'; sessionId: string }
  | { kind: 'noUnverifiedClaim'; threadId: string }
  | { kind: 'crossTenantReadDenied'; objectKey: string; asUserId: string }
  | { kind: 'catalogCorrectionWritten'; threadId: string }

export interface World {
  reset(seed?: string): Promise<void>
  asUser(opts: { plan: 'free' | 'explorer' | 'voyager'; trustLevel?: number }): Promise<{ userId: string; token: string }>
  seedCatalogItem(item: { name: string; visibility: 'global' | 'private'; imageFixture: string }): Promise<string>
  killEvePoller(): Promise<void> // for infra-01 durability falsifier
}

export interface Scenario {
  id: string
  title: string
  /** 'deterministic' forbids agentic steps (CI backbone); 'hybrid' allows agent.achieve for navigation only. */
  pure: 'deterministic' | 'hybrid'
  surfaces: Surface[]
  /** 'replay' scenarios run in CI; 'live' scenarios re-record tapes / validate real vendor behavior. */
  modes: RunMode[]
  tags?: string[]
  run(ctx: Ctx): Promise<void>
}

export function scenario(s: Scenario): Scenario {
  return s
}
