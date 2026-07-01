/**
 * Tests for the agentic loop + the selector lint. `bun test`.
 * Proves the agent reaches a goal, respects maxSteps, and CANNOT act on an off-screen (hallucinated) testId.
 */
import { test, expect, describe } from 'bun:test'
import { Agent, type Planner, type PlannedAction } from './agent'
import { lintSelectors } from './lint-selectors'
import type { Driver, A11yNode, ElementState } from './driver'

/** A scripted fake Driver: a tiny screen state machine. Tapping an id transitions the visible id set. */
function fakeDriver(): Driver & { taps: string[] } {
  const screens: Record<string, string[]> = {
    welcome: ['welcome.emailInput', 'welcome.continueBtn'],
    camera: ['camera.screen', 'camera.shutter'],
  }
  let current = 'welcome'
  const taps: string[] = []
  const tree = (): A11yNode => ({
    role: 'screen',
    attrs: {},
    children: screens[current].map((id) => ({ id, role: 'button', attrs: {}, children: [] })),
  })
  return {
    surface: 'web',
    mode: 'replay',
    taps,
    async tap(id) {
      taps.push(id)
      if (id === 'welcome.continueBtn') current = 'camera'
    },
    async type() {},
    async hold() {},
    async scrollTo() {},
    async speak() {},
    async state(): Promise<ElementState> {
      return { visible: true, attrs: {} }
    },
    async waitFor() {},
    async a11yTree() {
      return tree()
    },
    async screenshot() {
      return Buffer.from('')
    },
    async setNetwork() {},
    async grantPermission() {},
    async dispose() {},
  }
}

describe('agentic loop', () => {
  test('reaches the goal by tapping only on-screen ids', async () => {
    const d = fakeDriver()
    const planner: Planner = async (_goal, obs) => {
      if (obs.visibleIds.includes('camera.screen')) return { kind: 'done', rationale: 'on camera' }
      return { kind: 'tap', id: 'welcome.continueBtn', rationale: 'advance' }
    }
    await new Agent(d, planner).achieve('get to the camera')
    expect(d.taps).toEqual(['welcome.continueBtn'])
  })

  test('throws if the planner hallucinates an off-screen testId', async () => {
    const d = fakeDriver()
    const planner: Planner = async () => ({ kind: 'tap', id: 'reveal.generateStory', rationale: 'not here' })
    await expect(new Agent(d, planner).achieve('do impossible thing')).rejects.toThrow(/off-screen\/empty testId/)
  })

  test('respects maxSteps (no infinite loop)', async () => {
    const d = fakeDriver()
    const spin: Planner = async () => ({ kind: 'tap', id: 'welcome.emailInput', rationale: 'spin' }) // never advances
    await expect(new Agent(d, spin).achieve('never', { maxSteps: 3 })).rejects.toThrow(/within 3 steps/)
  })
})

describe('selector lint', () => {
  test('the committed scenarios use only registry ids (no coordinate/CSS/XPath taps)', async () => {
    const { ok, violations } = await lintSelectors(`${import.meta.dir}/../scenarios`)
    expect(violations).toEqual([])
    expect(ok).toBe(true)
  })
})
