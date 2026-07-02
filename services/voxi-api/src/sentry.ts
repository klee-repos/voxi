/**
 * Sentry error monitoring for the BFF.
 *
 * Wired as an INJECTED collaborator: @voxi/telemetry stays zero-dep and merely exposes `onError()`; we subscribe
 * here from the entrypoint. Design constraints (see the Sentry plan):
 *   - OPTIONAL + FAIL-SOFT — no DSN → disabled; a bad init must never 500 the BFF (unlike a required secret).
 *   - The redactor gates EVERYTHING — every event is deep value-scrubbed in beforeSend, and the default
 *     integrations that attach request bodies / cookies / source lines / URL breadcrumbs are removed (each is a
 *     photo-data-URI / token / signed-URL / DB-password leak vector).
 *   - No self-DoS — a per-process rate-limit + dedupe stops a 5xx storm from torching the free quota / alert channels.
 *   - No trace double-ship — capture is errors-only (tracesSampleRate 0); Cloud Trace stays the tracing backbone.
 */
import * as Sentry from '@sentry/bun'
import { logger, onError, redactDeep, type ErrorLogEvent } from '../../../packages/telemetry/src/index'

// Default integrations that attach request bodies, cookies/headers, source-context lines, or URL breadcrumbs.
// We capture via the logger hook (which already carries redacted fields + trace context) instead.
const LEAKY_INTEGRATIONS = new Set(['ContextLines', 'RequestData', 'Console', 'Http', 'NodeFetch', 'BunServer'])

type InitOverrides = Partial<Parameters<typeof Sentry.init>[0]>

let unregister: (() => void) | null = null

/**
 * Initialise Sentry from SENTRY_DSN. `overrides` is a test seam (inject an in-memory transport). Returns whether
 * Sentry ended up enabled. Never throws.
 */
export function initSentry(overrides: InitOverrides = {}): boolean {
  const dsn = overrides.dsn ?? process.env.SENTRY_DSN
  if (!dsn) {
    logger.warn('sentry_disabled', { reason: 'SENTRY_DSN not set' })
    return false
  }
  try {
    Sentry.init({
      dsn,
      environment: process.env.VOXI_ENV || 'production',
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      // Don't let Sentry commandeer the global OpenTelemetry tracer/context manager alongside @voxi/telemetry.
      skipOpenTelemetrySetup: true,
      registerEsmLoaderHooks: false,
      integrations: (defaults) => defaults.filter((i) => !LEAKY_INTEGRATIONS.has(i.name)),
      // Belt-and-suspenders: deep value-aware scrub of the WHOLE event (message, exception frames, contexts). If
      // scrubbing itself throws, DROP the event rather than risk shipping an unredacted one.
      beforeSend(event) {
        try {
          return redactDeep(event)
        } catch {
          return null
        }
      },
      ...overrides,
    })
    if (!unregister) unregister = onError(sentryHook)
    logger.info('sentry_initialized', { environment: process.env.VOXI_ENV || 'production' })
    return true
  } catch (e) {
    logger.warn('sentry_init_failed', { err: String(e) })
    return false
  }
}

/** Flush queued events before a deliberate exit (Cloud Run SIGTERM). Best-effort. */
export async function flushSentry(ms = 2000): Promise<void> {
  try {
    await Sentry.flush(ms)
  } catch {
    /* best effort */
  }
}

/** Tear down (tests). */
export async function closeSentry(): Promise<void> {
  unregister?.()
  unregister = null
  try {
    await Sentry.close()
  } catch {
    /* ignore */
  }
}

// ── capture policy ───────────────────────────────────────────────────────────
// Skip expected business outcomes; capture genuine anomalies. Mirrors the client-side policy.
const EXPECTED_CODES = new Set(['payment_required', 'safety_refusal', 'hard_failure'])
export function shouldCaptureServer(codeOrStatus: string | number | undefined): boolean {
  if (codeOrStatus === undefined) return true
  if (typeof codeOrStatus === 'number') return codeOrStatus >= 500
  return !EXPECTED_CODES.has(codeOrStatus)
}

// ── rate limit + dedupe ──────────────────────────────────────────────────────
// An upstream outage makes every request 5xx → every 5xx logs.error → a hook call. Without a cap that torches the
// 5k/mo free quota and floods email+Slack in minutes. Keep the FIRST of each {error, msg} fingerprint per window
// and a hard global ceiling; drop the rest. (Sentry's own client-side limit only kicks in AFTER the server 429s,
// i.e. after quota burn.)
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30
const seen = new Map<string, number>()
let windowStart = 0
let windowCount = 0

function allow(fingerprint: string, now: number): boolean {
  if (now - windowStart > WINDOW_MS) {
    windowStart = now
    windowCount = 0
    seen.clear()
  }
  const last = seen.get(fingerprint)
  if (last !== undefined) return false // repeat within the window
  if (windowCount >= MAX_PER_WINDOW) return false // global ceiling
  seen.set(fingerprint, now)
  windowCount++
  return true
}

/** Reset the limiter — tests only. */
export function __resetRateLimitForTest(): void {
  seen.clear()
  windowStart = 0
  windowCount = 0
}

// ── the hook ─────────────────────────────────────────────────────────────────
function sentryHook(e: ErrorLogEvent): void {
  const errName = e.err instanceof Error ? e.err.name : 'Error'
  if (!allow(`${errName}:${e.msg}`, Date.now())) return
  Sentry.withScope((scope) => {
    if (e.userId) scope.setUser({ id: e.userId })
    if (e.traceId) scope.setTag('trace_id', e.traceId)
    scope.setContext('voxi', { message: e.msg, ...(e.fields ?? {}) })
    scope.setLevel(e.level === 'fatal' ? 'fatal' : 'error')
    // A returned-5xx (http.ts logs status>=500 with no Error) has nothing to captureException — send a message.
    if (e.err instanceof Error) Sentry.captureException(e.err)
    else Sentry.captureMessage(e.msg, e.level === 'fatal' ? 'fatal' : 'error')
  })
}
