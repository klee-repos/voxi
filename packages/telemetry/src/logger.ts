/**
 * The Voxi structured logger.
 *
 * Every call writes ONE line of NDJSON to stdout — the always-on capture that needs no infrastructure
 * (`docker logs`, a terminal pane, or a file redirect all just work, and Cloud Run forwards stdout straight
 * into Cloud Logging, parsed to a structured `jsonPayload`, for free). When telemetry is initialised with an
 * OTLP endpoint the same record is ALSO shipped to that collector (for trace export to Cloud Trace). Trace
 * correlation is automatic: whatever traceId/spanId/userId/sessionId is in the ambient request context (see
 * context.ts) is stamped on the line.
 *
 * API is intentionally tiny:
 *   logger.info('msg', { field: 1 })
 *   logger.error('msg', err)                 // Error as 2nd arg
 *   logger.error('msg', err, { field: 1 })   // Error + fields
 *   const log = logger.child({ component: 'cascade' })   // bound fields
 */
import { getContext } from './context'
import { redact } from './redact'
import { exporterFromEnv, type OtlpExporter } from './otlp'

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 }
// OTel severity numbers (logs data model).
const SEVERITY: Record<Level, number> = { debug: 5, info: 9, warn: 13, error: 17, fatal: 21 }

interface Config {
  service: string
  role?: string
  env: string
  version?: string
  minRank: number
  exporter: OtlpExporter | null
}

function levelFromEnv(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase()
  return raw && raw in RANK ? RANK[raw as Level] : RANK.info
}

let cfg: Config = {
  service: process.env.OTEL_SERVICE_NAME ?? 'voxi',
  role: process.env.WORKFLOW_ROLE,
  env: process.env.VOXI_ENV ?? process.env.NODE_ENV ?? 'development',
  version: process.env.VOXI_VERSION,
  minRank: levelFromEnv(),
  exporter: null, // stays null until initTelemetry() — logs are stdout-only before then
}

const CTX_KEYS = ['traceId', 'spanId', 'requestId', 'userId', 'sessionId'] as const

/**
 * A subscriber to error/fatal log events. This is the seam an error-monitoring backend (Sentry) hooks into
 * WITHOUT this package taking a dependency on it — the entrypoint registers the hook, keeping @voxi/telemetry
 * zero-dep. `fields` are already redacted; `err` is the original throwable (so a hook can capture a real stack).
 */
export interface ErrorLogEvent {
  level: 'error' | 'fatal'
  msg: string
  err: unknown
  fields?: Record<string, unknown>
  traceId?: string
  spanId?: string
  requestId?: string
  userId?: string
  sessionId?: string
}
export type ErrorHook = (event: ErrorLogEvent) => void

const errorHooks: ErrorHook[] = []

/** Register a hook invoked on every error/fatal log. Returns an unsubscribe fn. A throwing hook never escapes. */
export function onError(hook: ErrorHook): () => void {
  errorHooks.push(hook)
  return () => {
    const i = errorHooks.indexOf(hook)
    if (i >= 0) errorHooks.splice(i, 1)
  }
}

function emit(level: Level, msg: string, fields: Record<string, unknown> | undefined, err: unknown): void {
  if (RANK[level] < cfg.minRank) return
  const now = Date.now()
  const ctx = getContext() ?? {}
  const rec: Record<string, unknown> = {
    time: new Date(now).toISOString(),
    level,
    service: cfg.service,
    env: cfg.env,
  }
  if (cfg.role) rec.role = cfg.role
  for (const k of CTX_KEYS) if (ctx[k]) rec[k] = ctx[k]
  rec.msg = msg
  if (err !== undefined) {
    const e = err instanceof Error ? err : new Error(String(err))
    rec.err = { name: e.name, message: e.message, stack: e.stack }
  }
  const attributes = fields ? redact(fields) : undefined
  const line = attributes ? { ...rec, ...attributes } : rec

  process.stdout.write(JSON.stringify(line) + '\n')

  if (cfg.exporter) {
    cfg.exporter.enqueueLog({
      timeUnixNano: `${now}000000`,
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: msg,
      // service/env/role live on the OTLP resource; keep them off the per-record attributes to avoid dup.
      attributes: {
        ...(attributes ?? {}),
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        ...(rec.err ? { err: rec.err } : {}),
      },
      traceId: typeof ctx.traceId === 'string' ? ctx.traceId : undefined,
      spanId: typeof ctx.spanId === 'string' ? ctx.spanId : undefined,
    })
  }

  // Fan out error/fatal to registered hooks (Sentry). Each is best-effort: a throwing or slow hook must never
  // turn a logged error into a crash inside the telemetry layer, so every call is isolated in try/catch.
  if ((level === 'error' || level === 'fatal') && errorHooks.length > 0) {
    const event: ErrorLogEvent = {
      level,
      msg,
      err,
      fields: attributes,
      traceId: typeof ctx.traceId === 'string' ? ctx.traceId : undefined,
      spanId: typeof ctx.spanId === 'string' ? ctx.spanId : undefined,
      requestId: typeof ctx.requestId === 'string' ? ctx.requestId : undefined,
      userId: typeof ctx.userId === 'string' ? ctx.userId : undefined,
      sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
    }
    for (const hook of errorHooks) {
      try {
        hook(event)
      } catch {
        // swallow — a broken error sink must not break logging
      }
    }
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fieldsOrErr?: Record<string, unknown> | Error, fields?: Record<string, unknown>): void
  error(msg: string, fieldsOrErr?: Record<string, unknown> | Error, fields?: Record<string, unknown>): void
  fatal(msg: string, fieldsOrErr?: Record<string, unknown> | Error, fields?: Record<string, unknown>): void
  child(bound: Record<string, unknown>): Logger
}

function normalize(
  a: Record<string, unknown> | Error | undefined,
  b: Record<string, unknown> | undefined,
): { fields?: Record<string, unknown>; err?: unknown } {
  if (a instanceof Error) return { err: a, fields: b }
  if (a && typeof a === 'object' && a.err instanceof Error) {
    const { err, ...rest } = a
    return { err, fields: { ...rest, ...b } }
  }
  return { fields: a ?? b }
}

function build(bound?: Record<string, unknown>): Logger {
  const method =
    (level: Level) =>
    (msg: string, a?: Record<string, unknown> | Error, b?: Record<string, unknown>) => {
      const { fields, err } = normalize(a, b)
      emit(level, msg, bound || fields ? { ...bound, ...fields } : undefined, err)
    }
  return {
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (extra) => build({ ...bound, ...extra }),
  }
}

/** The process-wide logger. Safe to import and use before initTelemetry() (stdout only until then). */
export const logger: Logger = build()

/**
 * Configure the process's telemetry once, at boot, from a service entrypoint. Sets the service name/role
 * stamped on every line and — if OTEL_EXPORTER_OTLP_ENDPOINT is set — wires the OTLP exporter and registers
 * a flush on shutdown so buffered logs/spans aren't lost.
 */
export function initTelemetry(opts: { service: string; role?: string; version?: string }): void {
  const env = process.env.VOXI_ENV ?? process.env.NODE_ENV ?? 'development'
  const role = opts.role ?? process.env.WORKFLOW_ROLE
  const version = opts.version ?? process.env.VOXI_VERSION
  cfg = {
    service: opts.service,
    role,
    env,
    version,
    minRank: levelFromEnv(),
    exporter: exporterFromEnv({
      serviceName: opts.service,
      serviceNamespace: 'voxi',
      environment: env,
      serviceVersion: version,
      role,
    }),
  }
  if (cfg.exporter) {
    const flush = () => void cfg.exporter?.flush()
    process.on('beforeExit', flush)
    process.on('SIGTERM', flush)
    process.on('SIGINT', flush)
    logger.info('telemetry: OTLP export enabled', { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT })
  }
}

/** The active OTLP exporter (null when export is off). Used by the HTTP span emitter. */
export function getExporter(): OtlpExporter | null {
  return cfg.exporter
}

/** Flush any buffered telemetry — call before a deliberate process exit. */
export async function shutdownTelemetry(): Promise<void> {
  await cfg.exporter?.flush()
}
