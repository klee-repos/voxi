/**
 * Agentic navigation layer (PLAN testing brief: "balance deterministic and agentic").
 *
 * The Agent wraps a Driver and drives the app toward a natural-language GOAL by observing the screen
 * (a11y tree + screenshot) and planning the next tap/type — like a human finding their way. Two hard rules
 * keep it from "cheating":
 *   1. Anti-hallucination: a planned action may only reference a testId actually present on the current
 *      screen. A planner that invents a selector throws — it cannot pretend to tap something that isn't there.
 *   2. No pass/fail authority: `achieve()` only NAVIGATES. Every value that matters is asserted by the
 *      deterministic `expect` layer afterwards. The LLM never decides whether the test passed.
 *
 * The Planner is injected (an LLM in real runs; a scripted function in unit tests), so the loop logic is
 * itself deterministically testable.
 */
import type { Driver, A11yNode } from './driver'

export interface Observation {
  tree: A11yNode
  visibleIds: string[]
  screenshotName: string
}

export interface PlannedAction {
  kind: 'tap' | 'type' | 'done'
  id?: string
  text?: string
  rationale: string
}

export type Planner = (goal: string, obs: Observation, history: PlannedAction[]) => Promise<PlannedAction>

export function collectIds(node: A11yNode): string[] {
  const out: string[] = []
  const walk = (n: A11yNode) => {
    if (n.id) out.push(n.id)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

export class Agent {
  constructor(
    private driver: Driver,
    private planner: Planner,
  ) {}

  async achieve(goal: string, opts?: { maxSteps?: number }): Promise<void> {
    const maxSteps = opts?.maxSteps ?? 12
    const history: PlannedAction[] = []

    for (let step = 0; step < maxSteps; step++) {
      const tree = await this.driver.a11yTree()
      const visibleIds = collectIds(tree)
      // screenshots are best-effort observability artifacts — never fail a run on capture issues.
      await this.driver.screenshot(`agent-${step}`).catch(() => {})
      const action = await this.planner(goal, { tree, visibleIds, screenshotName: `agent-${step}` }, history)

      if (action.kind === 'done') return

      // Anti-hallucination guard: cannot act on a selector that isn't on screen.
      if (!action.id || !visibleIds.includes(action.id)) {
        throw new Error(`agent planner chose an off-screen/empty testId "${action.id}" for goal "${goal}"`)
      }

      if (action.kind === 'tap') await this.driver.tap(action.id)
      else if (action.kind === 'type') await this.driver.type(action.id, action.text ?? '')
      history.push(action)
    }

    throw new Error(`agent did not reach goal "${goal}" within ${maxSteps} steps`)
  }
}
