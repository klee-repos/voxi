/**
 * AgentBrowserDriver — the agent-browser backend behind the SAME `Driver` interface the PlaywrightDriver
 * implements, so the identical `Agent` + `Planner` perception loop (framework/agent.ts) runs on either backend
 * unchanged. This is the coherence the README's driver table promises: agent-browser is a Driver, not a bespoke
 * hand-rolled loop. The agent navigates by perceiving `a11yTree()` (visible, unoccluded testIDs — exactly what a
 * user sees) and acts via `tap`/`type`; outcomes are pinned by `state()`/`waitFor()` reads through data-testids.
 *
 * agent-browser's CLI is synchronous (spawnSync); each method wraps a call and resolves a Promise, so the async
 * Driver contract holds. Only the primitives the agentic web flows need are implemented; iOS-only affordances
 * (hold/speak) and env toggles throw / no-op with a clear reason rather than pretend.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Driver, A11yNode, ElementState } from '../driver'
import type { TestId } from '../testids'
import { AgentBrowser } from './agent-browser'

/** Best-effort screenshots land here (gitignored `e2e/artifacts/`) so agentic runs never litter the repo root. */
const SCREENSHOT_DIR = 'e2e/artifacts'

/** The page-side collector: visible AND unoccluded [data-testid] elements — mirrors PlaywrightDriver.a11yTree so
 *  the agent perceives the same screen on either backend (a closed drawer behind the active screen is excluded). */
const A11Y_JS = `(()=>{
  const inViewport=el=>{const r=el.getBoundingClientRect();if(r.width===0||r.height===0)return false;return r.bottom>0&&r.right>0&&r.top<window.innerHeight&&r.left<window.innerWidth;};
  const unoccluded=el=>{const r=el.getBoundingClientRect();const cx=Math.min(Math.max(r.left+r.width/2,1),window.innerWidth-1);const cy=Math.min(Math.max(r.top+r.height/2,1),window.innerHeight-1);const t=document.elementFromPoint(cx,cy);return !!t&&(el.contains(t)||t.contains(el));};
  const vis=el=>{const cv=typeof el.checkVisibility==='function'?el.checkVisibility():el.getClientRects().length>0;return cv&&inViewport(el)&&unoccluded(el);};
  return JSON.stringify(Array.from(document.querySelectorAll('[data-testid]')).filter(vis).map(el=>({id:el.getAttribute('data-testid'),role:el.getAttribute('role')||el.tagName.toLowerCase(),label:(el.textContent||'').trim().slice(0,60),attrs:Object.fromEntries(Array.from(el.attributes).filter(a=>a.name.startsWith('data-')&&a.name!=='data-testid').map(a=>[a.name.replace('data-',''),a.value]))})));
})()`

export class AgentBrowserDriver implements Driver {
  readonly surface = 'web' as const
  readonly mode: 'replay' | 'live'

  constructor(private ab: AgentBrowser, mode: 'replay' | 'live' = 'replay') {
    this.mode = mode
  }

  async tap(id: TestId): Promise<void> {
    this.ab.clickTestId(id)
  }
  async type(id: TestId, text: string): Promise<void> {
    this.ab.fillTestId(id, text)
  }
  async hold(_id: TestId, _ms: number): Promise<void> {
    throw new Error('AgentBrowserDriver.hold is not implemented (push-to-talk is exercised on the iOS surface)')
  }
  async scrollTo(_id: TestId): Promise<void> {
    /* agent-browser scrolls into view implicitly on click; no standalone scroll primitive needed here. */
  }
  async speak(_fixtureName: string): Promise<void> {
    /* voice input is an iOS-surface concern; no-op on web, like PlaywrightDriver. */
  }

  async state(id: TestId): Promise<ElementState> {
    const s = this.ab.getByTestId(id)
    return { visible: s.visible, text: s.text || undefined, attrs: s.attrs }
  }

  async waitFor(id: TestId, opts?: { timeoutMs?: number; visible?: boolean }): Promise<void> {
    const timeout = opts?.timeoutMs ?? 5000
    if (opts?.visible === false) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (!this.ab.getByTestId(id).visible) return
      }
      throw new Error(`AgentBrowserDriver.waitFor: ${id} still visible after ${timeout}ms`)
    }
    if (!this.ab.waitForTestId(id, timeout)) throw new Error(`AgentBrowserDriver.waitFor: ${id} not visible within ${timeout}ms`)
  }

  async a11yTree(): Promise<A11yNode> {
    const raw = this.ab.evalJs(A11Y_JS)
    let nodes: { id: string; role: string; label: string; attrs: Record<string, string> }[] = []
    try {
      nodes = raw ? (JSON.parse(raw) as typeof nodes) : []
    } catch {
      nodes = []
    }
    return {
      role: 'screen',
      attrs: {},
      children: nodes.map((n) => ({ id: n.id as TestId, role: n.role, label: n.label, attrs: n.attrs, children: [] })),
    }
  }

  async screenshot(name: string): Promise<Buffer> {
    // best-effort observability artifact — never fail a run on capture.
    try {
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      this.ab.annotatedScreenshot(join(SCREENSHOT_DIR, `${name}.png`))
    } catch {
      /* ignore */
    }
    return Buffer.alloc(0)
  }

  async setNetwork(_state: 'online' | 'offline'): Promise<void> {
    /* not modelled on the agent-browser backend; the offline flows run on PlaywrightDriver. */
  }
  async grantPermission(_p: 'camera' | 'mic' | 'notifications', _granted: boolean): Promise<void> {
    /* web camera/mic permission is env-pinned in the harness; nothing to toggle here. */
  }
  async dispose(): Promise<void> {
    this.ab.close()
  }
}
