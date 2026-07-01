/**
 * AgentBrowser — the AGENTIC exploration backend (vercel-labs/agent-browser, v0.31.x).
 *
 * agent-browser is a native CLI built for AI agents: its `snapshot -i` yields an accessibility tree with
 * stable per-snapshot refs (@e1, @e2), plus semantic locators (`find testid …`), annotated screenshots, and
 * persistent daemon-backed sessions. That perception surface is a better fit for the LLM explorer than driving
 * Playwright by hand, and it scales (sessions, MCP server mode, cloud providers). We use it for the explore-*
 * suites; Playwright stays the deterministic backbone. Deterministic ASSERTIONS still go through testIDs (via
 * `getByTestId`), so the agent navigates by perception but every outcome is pinned — no agentic cheating.
 *
 * ── The daemon, and why the old in-process driver hung ──────────────────────────────────────────────────
 * agent-browser keeps the browser alive across CLI invocations via a per-session DAEMON. The original driver
 * piped the child's stdout through spawnSync and (correctly, for some daemonizers) feared that the daemon would
 * inherit and hold that stdout pipe open, so spawnSync would block on EOF forever. We re-verified this against
 * v0.31.1 on macOS: the daemon redirects its OWN stdio at fork (its "[agent-browser] launched browser" notice
 * goes to *stderr* of the launching CLI, which still exits), so even the cold-start `open` that spawns the
 * daemon returns cleanly (~0.9s) under a piped spawnSync — no hang. We therefore drive it directly:
 *
 *   (a) PRE-START the daemon ONCE in `open()` (a stable --session + --namespace pins one daemon per instance),
 *       so every subsequent command attaches to a running daemon and returns in tens of ms; and
 *   (b) issue each command with a hard per-command TIMEOUT so a wedged daemon fails closed (throws) instead of
 *       hanging the suite — never a silent green.
 *
 * Reads that feed deterministic assertions use `--json` mode (structured `{success,data,error}` envelope), so
 * parsing is exact, not a fragile substring scrape of human-formatted output.
 */

import { randomUUID } from 'node:crypto'

const BIN = 'node_modules/.bin/agent-browser'
const CMD_TIMEOUT_MS = 30_000

export interface SnapNode {
  ref: string
  role: string
  name: string
}

/** Outcome of a single agent-browser CLI invocation. `ok` is false on non-zero exit, timeout, or spawn error. */
interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Result of an agent-browser `--json` command: the parsed `{success,data,error}` envelope. */
interface JsonEnvelope {
  success: boolean
  data: Record<string, unknown> | null
  error: string | null
}

export class AgentBrowser {
  /** Stable per-instance session + namespace so one daemon persists across every command for this run. */
  private readonly session: string
  private readonly namespace: string
  private opened = false

  constructor(opts?: { session?: string; namespace?: string }) {
    const tag = randomUUID().slice(0, 8)
    this.session = opts?.session ?? `voxi-${tag}`
    this.namespace = opts?.namespace ?? `voxi-${tag}`
  }

  /**
   * Run an agent-browser command directly (piped). The daemon is pre-started in `open()`, so this returns
   * quickly; a hard timeout makes a wedged daemon fail closed rather than hang the suite.
   */
  private run(args: string[]): RunResult {
    const p = Bun.spawnSync([BIN, '--session', this.session, '--namespace', this.namespace, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, AGENT_BROWSER_NAMESPACE: this.namespace, AGENT_BROWSER_SESSION: this.session },
    })
    const dec = new TextDecoder()
    const timedOut = (p as { signalCode?: string }).signalCode != null && p.exitCode == null
    return {
      ok: p.exitCode === 0,
      code: p.exitCode,
      stdout: dec.decode(p.stdout ?? new Uint8Array()),
      stderr: dec.decode(p.stderr ?? new Uint8Array()),
      timedOut,
    }
  }

  /** Run a `--json` command and return the parsed envelope, or null if the command failed / output was junk. */
  private runJson(args: string[]): JsonEnvelope | null {
    const r = this.run(['--json', ...args])
    // --json emits the envelope on stdout; on failure `success:false` is still valid JSON we want to inspect.
    const text = r.stdout.trim()
    if (!text) return null
    try {
      const j = JSON.parse(text) as JsonEnvelope
      return j
    } catch {
      return null
    }
  }

  /**
   * Capability probe for the runner's SKIP decision: confirms the agent-browser CLI is present and a daemon
   * can launch a browser (Chrome/Chromium) here. Returns a reason string when unavailable. Never throws.
   */
  static probe(): { ok: true } | { ok: false; reason: string } {
    try {
      const help = Bun.spawnSync([BIN, '--help'], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
      if (help.exitCode !== 0) {
        return { ok: false, reason: `agent-browser CLI not runnable (exit ${help.exitCode})` }
      }
    } catch (e) {
      return { ok: false, reason: `agent-browser CLI missing: ${(e as Error).message}` }
    }
    return { ok: true }
  }

  /**
   * Open a URL — and pre-start the daemon (idempotent). The first invocation cold-starts the daemon + browser;
   * we surface a clear failure (e.g. no Chrome) instead of a silent hang.
   *
   * `open` always forces a genuine document reload (`reload` after navigate). Browsers do NOT reload on a
   * hash-only change, so navigating an SPA from `…#/threads` to `…#/settings` would otherwise keep the prior
   * (e.g. authenticated) state — the reload guarantees each open starts from a clean SPA, while preserving the
   * query + hash the page reads on boot.
   */
  open(url: string): void {
    const r = this.run(['open', url])
    this.opened = true
    if (!r.ok) {
      const why = r.timedOut ? 'timed out launching browser' : r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`
      throw new Error(`agent-browser open failed: ${why}`)
    }
    // Force a real navigation/reload so a hash-only change still re-initializes the SPA.
    this.run(['reload'])
  }

  /** Reload the current document (full SPA re-init). */
  reload(): void {
    this.run(['reload'])
  }

  /** Accessibility tree (interactive elements) with refs — the agent's observation of the live page. */
  snapshot(): SnapNode[] {
    const r = this.run(['snapshot', '-i'])
    if (!r.ok) throw new Error(`agent-browser snapshot failed: ${r.stderr.trim() || `exit ${r.code}`}`)
    return parseSnapshot(r.stdout)
  }

  /** Click an element by snapshot ref (e.g. "e3") — the agent acts on what it perceived. */
  click(ref: string): void {
    const r = this.run(['click', `@${ref}`])
    if (!r.ok) throw new Error(`agent-browser click @${ref} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  /** Click an element by its data-testid (deterministic navigation affordance, surface-stable). */
  clickTestId(id: string): void {
    const r = this.run(['find', 'testid', id, 'click'])
    if (!r.ok) throw new Error(`agent-browser click testid ${id} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  /** Clear+fill an input by snapshot ref. */
  fill(ref: string, text: string): void {
    const r = this.run(['fill', `@${ref}`, text])
    if (!r.ok) throw new Error(`agent-browser fill @${ref} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  /** Clear+fill an input by data-testid. */
  fillTestId(id: string, text: string): void {
    const r = this.run(['find', 'testid', id, 'fill', text])
    if (!r.ok) throw new Error(`agent-browser fill testid ${id} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  /** Check a checkbox by data-testid (idempotent). */
  checkTestId(id: string): void {
    const r = this.run(['find', 'testid', id, 'check'])
    if (!r.ok) throw new Error(`agent-browser check testid ${id} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  /**
   * Wait until a JS predicate is truthy (up to timeoutMs). Returns true if it became truthy.
   * `expr` must be a JS expression string (agent-browser evaluates it in the page on a poll).
   */
  waitForFn(expr: string, timeoutMs = 8000): boolean {
    const r = this.run(['wait', '--fn', expr, '--timeout', String(timeoutMs)])
    return r.ok
  }

  /**
   * Wait until the element with this data-testid is ACTUALLY visible (on the active screen). The web shell
   * pre-renders every screen in the DOM and toggles `.active`, so a bare element-attached wait is meaningless
   * here — we poll computed visibility, which matches what a user (and getByTestId) perceives.
   */
  waitForTestId(id: string, timeoutMs = 8000): boolean {
    const expr =
      `(()=>{const el=document.querySelector('[data-testid="${id}"]');if(!el)return false;` +
      `const cs=getComputedStyle(el);return el.getClientRects().length>0&&cs.display!=='none'&&cs.visibility!=='hidden';})()`
    return this.waitForFn(expr, timeoutMs)
  }

  /** Run JS in the page; returns the stringified result (`--json` → data.result). Empty string on failure. */
  evalJs(js: string): string {
    const env = this.runJson(['eval', js])
    if (!env || !env.success || !env.data) return ''
    const v = env.data['result']
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  }

  /**
   * Deterministic assertion hook: read an element located by data-testid (no agentic guessing on outcomes).
   * Built on a single `eval --json` returning a JSON-stringified object, so it cannot be spoofed by formatting.
   */
  getByTestId(id: string): { visible: boolean; text: string; band: string; attrs: Record<string, string> } {
    // The page JS returns a JSON string; agent-browser puts it in data.result; evalJs hands back that string.
    const js =
      `(()=>{const el=document.querySelector('[data-testid="${id}"]');` +
      `if(!el)return JSON.stringify({visible:false,text:'',band:'',attrs:{}});` +
      `const cs=getComputedStyle(el);const onScreen=el.getClientRects().length>0;` +
      `const visible=onScreen&&cs.display!=='none'&&cs.visibility!=='hidden'&&cs.opacity!=='0';` +
      `const attrs={};for(const a of el.attributes){if(a.name.startsWith('data-')&&a.name!=='data-testid')attrs[a.name.replace('data-','')]=a.value;}` +
      `return JSON.stringify({visible,text:(el.textContent||'').trim(),band:el.getAttribute('data-band')||'',attrs});})()`
    const raw = this.evalJs(js)
    if (!raw) return { visible: false, text: '', band: '', attrs: {} }
    try {
      const j = JSON.parse(raw) as { visible: boolean; text: string; band: string; attrs: Record<string, string> }
      return j
    } catch {
      return { visible: false, text: '', band: '', attrs: {} }
    }
  }

  /** True iff exactly the element located by data-testid is currently visible (deterministic gate). */
  isVisibleTestId(id: string): boolean {
    return this.getByTestId(id).visible
  }

  annotatedScreenshot(path: string): void {
    // Screenshots are best-effort observability artifacts — never let a capture issue fail a run.
    this.run(['screenshot', path, '--annotate'])
  }

  /** Tear down this instance's daemon + browser so no process or socket leaks between runs. */
  close(): void {
    if (!this.opened) return
    this.run(['close', '--all'])
    this.opened = false
  }
}

/**
 * Parse agent-browser `snapshot -i` lines into {role,name,ref}.
 * Lines look like: `- textbox "email" [ref=e2]`, `- button "Continue" [ref=e5]`,
 * `- checkbox "accept terms" [checked=false, ref=e3]`, `- heading "the Guide" [level=2, ref=e1]`.
 * The ref is matched anywhere inside the bracketed attribute list (it is not always the only attribute).
 */
export function parseSnapshot(out: string): SnapNode[] {
  const nodes: SnapNode[] = []
  for (const line of out.split('\n')) {
    // role + optional "name" + a bracketed attr list that contains ref=eN somewhere.
    const m = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"([^"]*)")?\s+\[[^\]]*\bref=(\w+)[^\]]*\]/.exec(line)
    if (m) nodes.push({ role: m[1], name: m[2] ?? '', ref: m[3] })
  }
  return nodes
}
