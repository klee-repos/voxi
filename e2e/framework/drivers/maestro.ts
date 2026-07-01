/**
 * MaestroDriver — the iOS DETERMINISTIC implementation of the framework Driver.
 *
 * Maestro is "Playwright for mobile": resilient id-based selectors, low flake, fast to author. It is a
 * YAML-first runner, so the deterministic iOS backbone is the committed flows under `e2e/flows/*.yaml`
 * (one per TEST-PLAN I-surface row). Those flows are the source of truth and run via the `maestro` CLI on a
 * Mac w/ Xcode — they do NOT need this class to execute.
 *
 * This driver exists so the SAME `Scenario` objects authored against `Driver` (driver.ts) can ALSO be
 * compiled to Maestro YAML / driven via Maestro's JSON API, keeping the "author once, three surfaces"
 * contract. Every primitive below emits the exact Maestro command the committed flows already use, and
 * locates ONLY by testId (the iOS app exposes the same `accessibilityIdentifier`s) — never by coordinates.
 *
 * It is intentionally toolchain-gated: instantiating/running it requires the `maestro` CLI + a booted iOS
 * simulator/device, which this sandbox lacks (Command Line Tools only). On a Mac w/ Xcode it is live.
 */
import type { Driver, A11yNode, ElementState, Surface, RunMode, Scenario } from '../driver'
import type { TestId } from '../testids'

/** One Maestro command, as it appears in a flow YAML (the wire format the CLI consumes). */
export interface MaestroCommand {
  [op: string]: unknown
}

/**
 * Minimal transport: how a MaestroCommand reaches a running device. On a Mac this is wired to the Maestro
 * driver process (e.g. via `maestro` JSON commands or by appending to a generated flow). In the sandbox it
 * is unset and any action throws a clear, honest error rather than pretending to pass.
 */
export interface MaestroTransport {
  send(cmd: MaestroCommand): Promise<void>
  query(id: TestId): Promise<ElementState>
  tree(): Promise<A11yNode>
  shot(name: string): Promise<Buffer>
  appId: string
}

export class MaestroDriver implements Driver {
  readonly surface: Surface = 'ios'
  readonly mode: RunMode

  /** Records every emitted command so a Scenario can be serialized to a Maestro flow for `maestro test`. */
  readonly emitted: MaestroCommand[] = []

  /**
   * In `record` mode the driver does NOT need a device: every action is appended to `emitted` (and never
   * sent), so a Scenario can be COMPILED to a Maestro YAML flow offline (this sandbox). Observation calls
   * resolve to benign placeholders during a compile (a Scenario's deterministic assertions become emitted
   * `assertVisible`/`extendedWaitUntil` commands — they are not evaluated against a live tree at compile time).
   */
  constructor(
    private transport: MaestroTransport | null,
    mode: RunMode = 'replay',
    private record = false,
  ) {
    this.mode = mode
  }

  private async emit(cmd: MaestroCommand) {
    this.emitted.push(cmd)
    if (this.record) return // compile-only: record the command, do not drive a device
    if (!this.transport) {
      throw new Error(
        'MaestroDriver: no transport bound. iOS-native flows run via the `maestro` CLI on a Mac w/ Xcode ' +
          '(see e2e/flows/*.yaml and docs/IOS-TESTING.md). This sandbox has Command Line Tools only.',
      )
    }
    await this.transport.send(cmd)
  }

  // ---- actions: each maps 1:1 to the Maestro command used in the committed flows ----
  async tap(id: TestId) {
    await this.emit({ tapOn: { id } })
  }
  async type(id: TestId, text: string) {
    // Matches the flows: tap the field by id, then inputText.
    await this.emit({ tapOn: { id } })
    await this.emit({ inputText: text })
  }
  async hold(id: TestId, ms: number) {
    // Push-to-talk: Maestro's longPressOn holds the element (see conv-01/conv-03 flows).
    await this.emit({ longPressOn: { id }, _holdMs: ms })
  }
  async scrollTo(id: TestId) {
    await this.emit({ scrollUntilVisible: { element: { id } } })
  }
  async speak(fixtureName: string) {
    // Deterministic voice fixture is injected at launch (voxiVoiceFixture arg) and triggered by the
    // push-to-talk hold; this records the intent for the flow compiler.
    await this.emit({ _speak: { fixtureName } })
  }

  // ---- observation ----
  async state(id: TestId): Promise<ElementState> {
    if (this.record) return { visible: true, attrs: {} } // compile-only placeholder
    if (!this.transport) throw new Error('MaestroDriver.state: no transport bound (run on a Mac w/ Xcode).')
    return this.transport.query(id)
  }
  async waitFor(id: TestId, opts?: { timeoutMs?: number; visible?: boolean }) {
    const timeout = opts?.timeoutMs ?? 5000
    if (opts?.visible === false) await this.emit({ assertNotVisible: { id } })
    else await this.emit({ extendedWaitUntil: { visible: { id }, timeout } })
  }
  async a11yTree(): Promise<A11yNode> {
    if (this.record) return { role: 'screen', attrs: {}, children: [] } // compile-only placeholder
    if (!this.transport) throw new Error('MaestroDriver.a11yTree: no transport bound (run on a Mac w/ Xcode).')
    return this.transport.tree()
  }
  async screenshot(name: string): Promise<Buffer> {
    if (this.record) {
      await this.emit({ takeScreenshot: name })
      return Buffer.alloc(0)
    }
    if (!this.transport) throw new Error('MaestroDriver.screenshot: no transport bound (run on a Mac w/ Xcode).')
    return this.transport.shot(name)
  }

  // ---- environment controls (only honored in VOXI_TEST_MODE) ----
  async setNetwork(state: 'online' | 'offline') {
    // Maestro toggles connectivity via setAirplaneMode (offline = airplane on).
    await this.emit({ setAirplaneMode: state === 'offline' ? 'enable' : 'disable' })
  }
  async grantPermission(p: 'camera' | 'mic' | 'notifications', granted: boolean) {
    // Permissions are set on launchApp in the flows; this records a per-permission override for the compiler.
    const key = p === 'mic' ? 'microphone' : p
    await this.emit({ _permission: { [key]: granted ? 'allow' : 'deny' } })
  }

  async dispose() {
    /* device lifecycle owned by the `maestro` CLI / runner */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario → Maestro YAML compiler
//
// The committed `e2e/flows/*.yaml` files are the source of truth for the iOS deterministic backbone, but a
// Scenario authored ONCE against `driver.ts` can also be compiled to the SAME flow shape, so a new web/iOS
// scenario doesn't have to be hand-ported to YAML. `compileFlow` runs the Scenario against a record-mode
// MaestroDriver (no device needed), collects the emitted commands, folds the recorded permission/launch
// overrides into the `launchApp` header, and serializes header + `---` + commands exactly like the hand-
// written flows (`appId`, `env`, `launchApp.permissions/arguments`, `tapOn`/`inputText`/`longPressOn`/
// `extendedWaitUntil`/`assertNotVisible`). Locates only by testId — coordinate taps are unrepresentable here.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompileOptions {
  appId?: string
  /** env block emitted under the flow header (e.g. VOXI_TEST_MODE, EMAIL, OTP). */
  env?: Record<string, string>
  /** clearState/clearKeychain on launchApp (default: both true — committed flows force a clean first run). */
  clearState?: boolean
  clearKeychain?: boolean
  /** initial permission state passed to launchApp (camera/microphone/notifications: allow|deny|unset). */
  permissions?: Partial<Record<'camera' | 'microphone' | 'notifications', 'allow' | 'deny' | 'unset'>>
}

const DEFAULT_APP_ID = 'com.voxi.app'

/** Record a Scenario's driver calls without a device, then serialize them to a Maestro flow YAML string. */
export async function compileFlow(scenario: Scenario, opts: CompileOptions = {}): Promise<string> {
  if (!scenario.surfaces.includes('ios')) {
    throw new Error(`compileFlow(${scenario.id}): scenario does not target the iOS surface — nothing to compile.`)
  }
  const driver = new MaestroDriver(null, scenario.modes.includes('live') ? 'live' : 'replay', /* record */ true)
  await scenario.run(compileCtx(driver, scenario))
  return renderFlow(scenario, driver.emitted, opts)
}

/** Render an already-recorded command list (e.g. `MaestroDriver.emitted`) into a Maestro flow YAML string. */
export function renderFlow(scenario: Scenario, emitted: MaestroCommand[], opts: CompileOptions = {}): string {
  const appId = opts.appId ?? DEFAULT_APP_ID
  // Fold recorded grantPermission() overrides into the launch permission map (Maestro sets these on launch).
  const permissions: Record<string, string> = { ...(opts.permissions ?? {}) }
  const speakArgs: Record<string, string> = {}
  const commands: MaestroCommand[] = []
  for (const cmd of emitted) {
    if ('_permission' in cmd) {
      Object.assign(permissions, cmd._permission as Record<string, string>)
      continue
    }
    if ('_speak' in cmd) {
      // A deterministic voice fixture is injected at launch (voxiVoiceFixture arg), then triggered by a hold.
      speakArgs.voxiVoiceFixture = (cmd._speak as { fixtureName: string }).fixtureName
      continue
    }
    commands.push(cmd)
  }

  const lines: string[] = []
  lines.push(`# Maestro flow compiled from Scenario "${scenario.id}" — ${scenario.title}`)
  lines.push('# Generated from e2e/framework/driver.ts via drivers/maestro.ts#compileFlow — DO NOT hand-edit;')
  lines.push('# locates only by testId (no coordinate taps). Run on a Mac w/ Xcode: maestro test <this file>.')
  lines.push(`appId: ${appId}`)
  const env = opts.env ?? { VOXI_TEST_MODE: '1' }
  if (Object.keys(env).length) {
    lines.push('env:')
    for (const [k, v] of Object.entries(env)) lines.push(`  ${k}: ${yamlScalar(v)}`)
  }
  lines.push('---')

  // launchApp header (clearState + permissions + the seed/voice arguments).
  lines.push('- launchApp:')
  lines.push(`    clearState: ${opts.clearState ?? true}`)
  lines.push(`    clearKeychain: ${opts.clearKeychain ?? true}`)
  if (Object.keys(permissions).length) {
    lines.push('    permissions:')
    for (const [k, v] of Object.entries(permissions)) lines.push(`      ${k}: ${v}`)
  }
  const args: Record<string, string> = { voxiTestSeed: scenario.id, ...speakArgs }
  lines.push('    arguments:')
  for (const [k, v] of Object.entries(args)) lines.push(`      ${k}: ${yamlScalar(v)}`)

  for (const cmd of commands) lines.push(...renderCommand(cmd))
  return lines.join('\n') + '\n'
}

/** Serialize a single recorded MaestroCommand to its YAML lines. */
function renderCommand(cmd: MaestroCommand): string[] {
  // Agentic navigation cannot be statically unrolled into YAML — surface it as a comment the author resolves.
  if ('_agent' in cmd) {
    const goal = (cmd._agent as { goal: string }).goal
    return [`# AGENTIC STEP (resolve to deterministic taps before committing): ${goal}`]
  }
  // `inputText` is a bare string command; everything else is `- <op>:` with an indented body.
  if ('inputText' in cmd && Object.keys(cmd).length === 1) {
    return [`- inputText: ${yamlScalar(String(cmd.inputText))}`]
  }
  if ('takeScreenshot' in cmd && Object.keys(cmd).length === 1) {
    return [`- takeScreenshot: ${yamlScalar(String(cmd.takeScreenshot))}`]
  }
  if ('setAirplaneMode' in cmd && Object.keys(cmd).length === 1) {
    return [`- setAirplaneMode: ${cmd.setAirplaneMode}`]
  }
  // longPressOn carries an internal _holdMs hint we drop in YAML (Maestro's longPressOn is a fixed hold).
  if ('longPressOn' in cmd) {
    return [`- longPressOn:`, `    id: ${yamlScalar(idOf(cmd.longPressOn))}`]
  }
  const [op, body] = Object.entries(cmd)[0] as [string, unknown]
  const out = [`- ${op}:`]
  out.push(...renderBody(body, '    '))
  return out
}

/** Render the indented body of a command (objects → key: value lines, with id/visible/timeout nesting). */
function renderBody(body: unknown, indent: string): string[] {
  if (body === null || typeof body !== 'object') return [`${indent}${String(body)}`]
  const out: string[] = []
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object') {
      out.push(`${indent}${k}:`)
      out.push(...renderBody(v, indent + '  '))
    } else if (k === 'timeout' && typeof v === 'number') {
      // Maestro expects a bare numeric timeout (matches the hand-written flows: `timeout: 10000`).
      out.push(`${indent}${k}: ${v}`)
    } else {
      out.push(`${indent}${k}: ${yamlScalar(String(v))}`)
    }
  }
  return out
}

function idOf(v: unknown): string {
  return (v as { id?: string })?.id ?? String(v)
}

/** Quote a scalar only when YAML needs it (the committed flows quote ids/emails/OTP, leave numbers/bools bare). */
function yamlScalar(v: string): string {
  if (v === 'true' || v === 'false' || /^-?\d+$/.test(v)) return `"${v}"` // keep test OTP/seed as strings
  if (/[:#{}\[\],&*?|<>=!%@`"']/.test(v) || v.includes(' ') || v === '') return `"${v.replace(/"/g, '\\"')}"`
  return `"${v}"`
}

/**
 * Minimal Ctx for COMPILING a Scenario (no device, no DB). The `expect` layer emits the matching Maestro
 * assertion command so deterministic assertions become real flow steps; `agent.achieve` records a marker
 * (agentic navigation is a runtime concern — it cannot be statically unrolled into YAML); `world` is a no-op
 * that returns stable placeholders so setup code runs without a backend.
 */
function compileCtx(driver: MaestroDriver, scenario: Scenario) {
  const emit = (cmd: MaestroCommand) => {
    driver.emitted.push(cmd)
  }
  const assertId = (id: string) => emit({ assertVisible: { id } })
  const expect = {
    async visible(id: string) {
      assertId(id)
    },
    async notVisible(id: string) {
      emit({ assertNotVisible: { id } })
    },
    async text(id: string, matcher: string | RegExp) {
      emit({ assertVisible: { id, text: matcher instanceof RegExp ? matcher.source : matcher } })
    },
    async attr(id: string, _key: string, _value: string | RegExp) {
      // Maestro YAML cannot assert arbitrary a11y attributes; presence is the compilable proxy (see IOS-TESTING.md).
      assertId(id)
    },
    async chipBand(id: string, _band: 'CONFIDENT' | 'PROBABLE' | 'UNKNOWN') {
      assertId(id)
    },
    async playing(id: string) {
      assertId(id)
    },
    async safetyRefusal() {
      assertId('global.safetyRefusal')
    },
    async server(_p: unknown) {
      // Server-side invariants are checked by the BFF test API at runtime, not in the YAML flow.
    },
    async oneOf(id: string, _matchers: (string | RegExp)[]) {
      assertId(id)
    },
  }
  const agent = {
    async achieve(goal: string, _opts?: { maxSteps?: number }) {
      emit({ _agent: { goal } }) // marker only — rendered as a comment; not a runnable Maestro step
    },
  }
  const world = {
    async reset(_seed?: string) {},
    async asUser(_o: { plan: 'free' | 'explorer' | 'voyager'; trustLevel?: number }) {
      return { userId: `compile-${scenario.id}`, token: 'compile-token' }
    },
    async seedCatalogItem(_i: { name: string; visibility: 'global' | 'private'; imageFixture: string }) {
      return `compile-item-${scenario.id}`
    },
    async killEvePoller() {},
  }
  // Cast through unknown: this is the compile-time Ctx (driver.ts owns the full runtime Ctx shape).
  return { driver, agent, expect, world } as unknown as Parameters<Scenario['run']>[0]
}
