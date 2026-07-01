/**
 * PlaywrightDriver — the WEB implementation of the framework Driver (runs in CI / this sandbox).
 *
 * Locates elements ONLY by data-testid (matching the testid registry), so the same scenarios run unchanged
 * on web (here) and iOS (Maestro/Appium on a Mac). Drives a real Chromium DOM — real taps, real assertions.
 */
import type { Page } from 'playwright'
import type { Driver, A11yNode, ElementState } from '../driver'
import type { TestId } from '../testids'

export class PlaywrightDriver implements Driver {
  readonly surface = 'web' as const
  readonly mode: 'replay' | 'live'

  constructor(private page: Page, mode: 'replay' | 'live' = 'replay') {
    this.mode = mode
  }

  private loc(id: TestId) {
    return this.page.locator(`[data-testid="${id}"]`)
  }

  async tap(id: TestId) {
    await this.loc(id).first().click()
  }
  async type(id: TestId, text: string) {
    await this.loc(id).first().fill(text)
  }
  async hold(id: TestId, ms: number) {
    const box = await this.loc(id).first().boundingBox()
    if (!box) throw new Error(`hold: ${id} not visible`)
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await this.page.mouse.down()
    await this.page.waitForTimeout(ms)
    await this.page.mouse.up()
  }
  async scrollTo(id: TestId) {
    await this.loc(id).first().scrollIntoViewIfNeeded()
  }
  async speak(_fixtureName: string) {
    // Voice input is exercised on the iOS surface; on web this is a no-op the scenario can branch on.
  }

  async state(id: TestId): Promise<ElementState> {
    const el = this.loc(id).first()
    const count = await el.count()
    if (count === 0) return { visible: false, attrs: {} }
    const visible = await el.isVisible()
    const text = (await el.textContent()) ?? undefined
    const attrs = await el.evaluate((node: Element) => {
      const out: Record<string, string> = {}
      for (const a of Array.from(node.attributes)) {
        if (a.name.startsWith('data-') && a.name !== 'data-testid') out[a.name.replace('data-', '')] = a.value
      }
      return out
    })
    return { visible, text: text?.trim(), attrs }
  }

  async waitFor(id: TestId, opts?: { timeoutMs?: number; visible?: boolean }) {
    await this.loc(id).first().waitFor({
      state: opts?.visible === false ? 'hidden' : 'visible',
      timeout: opts?.timeoutMs ?? 5000,
    })
  }

  async a11yTree(): Promise<A11yNode> {
    const nodes = await this.page.evaluate(() => {
      const isVisible = (el: Element) =>
        // only elements actually rendered on screen — hidden screens (display:none) are excluded,
        // so the agent perceives the same thing a user does.
        typeof (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility === 'function'
          ? (el as HTMLElement & { checkVisibility: () => boolean }).checkVisibility()
          : el.getClientRects().length > 0
      return Array.from(document.querySelectorAll('[data-testid]'))
        .filter(isVisible)
        .map((el) => ({
        id: el.getAttribute('data-testid') as string,
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        label: (el.textContent ?? '').trim().slice(0, 60),
        attrs: Object.fromEntries(
          Array.from(el.attributes)
            .filter((a) => a.name.startsWith('data-') && a.name !== 'data-testid')
            .map((a) => [a.name.replace('data-', ''), a.value]),
        ),
      }))
    })
    return {
      role: 'screen',
      attrs: {},
      children: nodes.map((n) => ({ id: n.id, role: n.role, label: n.label, attrs: n.attrs, children: [] })),
    }
  }

  async screenshot(_name: string): Promise<Buffer> {
    return this.page.screenshot()
  }
  async setNetwork(state: 'online' | 'offline') {
    await this.page.context().setOffline(state === 'offline')
  }
  async grantPermission(p: 'camera' | 'mic' | 'notifications', granted: boolean) {
    const map = { camera: 'camera', mic: 'microphone', notifications: 'notifications' } as const
    if (granted) await this.page.context().grantPermissions([map[p]])
    else await this.page.context().clearPermissions()
  }
  async dispose() {
    /* page lifecycle owned by the runner */
  }
}
