/**
 * AppiumDriver — the iOS AGENTIC implementation of the framework Driver.
 *
 * Maestro (drivers/maestro.ts + the committed flows) is the deterministic iOS backbone. Appium is the
 * complement: a full WebDriver/XCUITest session that exposes the live accessibility tree with stable
 * attributes, which is what the agentic explorer (`Agent.achieve`) needs to perceive the app and plan
 * navigation. It is also how we read STRUCTURED attributes Maestro YAML cannot assert on — e.g. the
 * `voice.id` on a Voxi turn (conv-03), `chip.band` on a reveal chip, or `orb.state` on the orb.
 *
 * Locates ONLY by accessibilityIdentifier (== our testId) — never by coordinates — so the same Scenarios
 * run unchanged here, on Maestro, and on web (Playwright). Outcomes still bottom out in deterministic
 * testId assertions; the agent navigates by perception but never decides pass/fail.
 *
 * Toolchain-gated: needs an Appium server + XCUITest + a booted iOS simulator/device (a Mac w/ Xcode).
 * In this sandbox the WebDriver session is unset and any call throws an honest error instead of faking green.
 */
import type { Driver, A11yNode, ElementState, Surface, RunMode } from '../driver'
import type { TestId } from '../testids'

/**
 * The slice of a WebdriverIO/Appium remote `browser` we depend on. Kept as a structural interface so this
 * file has no hard dependency that the sandbox can't install — the real session is injected on a Mac.
 */
export interface AppiumSession {
  /** Find by iOS accessibility id (predicate string `name == "<id>"`). */
  $(selector: string): Promise<AppiumElement>
  $$(selector: string): Promise<AppiumElement[]>
  getPageSource(): Promise<string>
  saveScreenshot?(path: string): Promise<Buffer>
  takeScreenshot(): Promise<string> // base64 PNG
  setNetworkConnection?(bitmask: number): Promise<void>
  execute(script: string, ...args: unknown[]): Promise<unknown>
}

export interface AppiumElement {
  isDisplayed(): Promise<boolean>
  getText(): Promise<string>
  /** Read an arbitrary accessibility attribute (e.g. 'voice.id', 'chip.band', 'orb.state'). */
  getAttribute(name: string): Promise<string | null>
  click(): Promise<void>
  addValue(text: string): Promise<void>
  touchAction?(action: unknown): Promise<void>
  isExisting(): Promise<boolean>
}

/** iOS predicate that matches our accessibilityIdentifier exactly. */
const byId = (id: TestId) => `-ios predicate string:name == "${id}"`

export class AppiumDriver implements Driver {
  readonly surface: Surface = 'ios'
  readonly mode: RunMode

  constructor(
    private session: AppiumSession | null,
    mode: RunMode = 'replay',
  ) {
    this.mode = mode
  }

  private require(): AppiumSession {
    if (!this.session)
      throw new Error(
        'AppiumDriver: no XCUITest session bound. iOS agentic runs need Appium + a booted simulator on a ' +
          'Mac w/ Xcode (see docs/IOS-TESTING.md). This sandbox has Command Line Tools only.',
      )
    return this.session
  }

  // ---- actions ----
  async tap(id: TestId) {
    await (await this.require().$(byId(id))).click()
  }
  async type(id: TestId, text: string) {
    const el = await this.require().$(byId(id))
    await el.click()
    await el.addValue(text)
  }
  async hold(id: TestId, ms: number) {
    // Push-to-talk: a long-press (press → wait → release) on the mic button.
    const s = this.require()
    const el = await s.$(byId(id))
    await s.execute('mobile: touchAndHold', { elementId: (el as unknown as { elementId?: string }).elementId, duration: ms / 1000 })
  }
  async scrollTo(id: TestId) {
    const s = this.require()
    await s.execute('mobile: scroll', { predicateString: `name == "${id}"`, toVisible: true })
  }
  async speak(fixtureName: string) {
    // Deterministic voice fixture: in VOXI_TEST_MODE the app reads `voxiVoiceFixture`; this nudges it to play.
    await this.require().execute('mobile: launchApp', { bundleId: 'com.voxi.app', arguments: ['--voxiSpeak', fixtureName] })
  }

  // ---- observation ----
  async state(id: TestId): Promise<ElementState> {
    const s = this.require()
    const el = await s.$(byId(id))
    if (!(await el.isExisting())) return { visible: false, attrs: {} }
    const visible = await el.isDisplayed()
    const text = (await el.getText()) || undefined
    // Read the structured attributes the registry documents as carried on the element.
    const attrs: Record<string, string> = {}
    for (const key of ['chip.band', 'orb.state', 'voice.id', 'speaker']) {
      const v = await el.getAttribute(key)
      if (v != null) attrs[key] = v
    }
    return { visible, text: text?.trim(), attrs }
  }
  async waitFor(id: TestId, opts?: { timeoutMs?: number; visible?: boolean }) {
    const s = this.require()
    const deadline = Date.now() + (opts?.timeoutMs ?? 5000)
    const wantVisible = opts?.visible !== false
    for (;;) {
      const el = await s.$(byId(id))
      const shown = (await el.isExisting()) && (await el.isDisplayed())
      if (shown === wantVisible) return
      if (Date.now() > deadline) throw new Error(`waitFor(${id}, visible=${wantVisible}) timed out`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  async a11yTree(): Promise<A11yNode> {
    const xml = await this.require().getPageSource()
    return { role: 'screen', attrs: { source: xml.slice(0, 0) }, children: parseSource(xml) }
  }
  async screenshot(_name: string): Promise<Buffer> {
    const b64 = await this.require().takeScreenshot()
    return Buffer.from(b64, 'base64')
  }

  // ---- environment controls (only honored in VOXI_TEST_MODE) ----
  async setNetwork(state: 'online' | 'offline') {
    // Appium networkConnection bitmask: 1 = airplane, 6 = wifi+data.
    await this.require().setNetworkConnection?.(state === 'offline' ? 1 : 6)
  }
  async grantPermission(p: 'camera' | 'mic' | 'notifications', granted: boolean) {
    const map = { camera: 'camera', mic: 'microphone', notifications: 'notifications' } as const
    await this.require().execute('mobile: setPermission', {
      bundleId: 'com.voxi.app',
      access: { [map[p]]: granted ? 'yes' : 'no' },
    })
  }

  async dispose() {
    /* session lifecycle owned by the runner / Appium server */
  }
}

/** Extract testId-bearing nodes from the XCUITest page source (every interactive node has its identifier). */
function parseSource(xml: string): A11yNode[] {
  const out: A11yNode[] = []
  for (const m of xml.matchAll(/<XCUIElementType(\w+)[^>]*\bname="([^"]+)"[^>]*>/g)) {
    out.push({ id: m[2], role: m[1].toLowerCase(), attrs: {}, children: [] })
  }
  return out
}
