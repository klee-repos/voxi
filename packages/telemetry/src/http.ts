/**
 * HTTP request instrumentation for the Bun `fetch`-handler services (voxi-api, eve front, podcast worker).
 *
 * `withRequestTelemetry(handler)` wraps a `(req) => Response` handler so every request:
 *   1. inherits or starts a W3C trace (traceparent header in → same traceId out),
 *   2. runs inside an AsyncLocalStorage context so all logs beneath it carry that traceId,
 *   3. emits one structured access-log line, and
 *   4. emits one SERVER span to Tempo (when OTLP export is on) — enough for a cross-service RCA waterfall.
 *
 * Per-hop spans only (no DB/downstream child spans) — the correlated-logs-plus-trace layer, zero deps.
 */
import {
  runWithContext,
  getContext,
  newTraceId,
  newSpanId,
  parseTraceparent,
  formatTraceparent,
} from './context'
import { logger, getExporter } from './logger'

const SPAN_KIND_SERVER = 2

/** Collapse high-cardinality id segments so span names / route labels stay groupable. */
export function routePattern(pathname: string): string {
  return pathname.replace(/\/(sess_[^/]+|thr_[^/]+|ct_[^/]+|[0-9a-f-]{16,}|\d+)(?=\/|$)/gi, '/:id')
}

export interface RequestTelemetryOptions {
  /** Coarse role label for the span (e.g. 'bff', 'eve-front', 'podcast'). */
  role?: string
  /** Override the route label; defaults to routePattern(pathname). */
  route?: (req: Request, url: URL) => string
}

export function withRequestTelemetry(
  handler: (req: Request) => Response | Promise<Response>,
  opts: RequestTelemetryOptions = {},
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const incoming = parseTraceparent(req.headers.get('traceparent'))
    const traceId = incoming?.traceId ?? newTraceId()
    const spanId = newSpanId()
    const parentSpanId = incoming?.spanId
    const requestId = req.headers.get('x-request-id') ?? spanId

    const start = Date.now()
    const t0 = performance.now()

    return runWithContext({ traceId, spanId, parentSpanId, requestId }, async () => {
      let res: Response
      let threw: unknown
      try {
        res = await handler(req)
      } catch (e) {
        threw = e
        res = new Response('internal error', { status: 500 })
      }
      const ms = Math.round((performance.now() - t0) * 10) / 10
      const status = res.status
      const routeLabel = opts.route ? opts.route(req, url) : routePattern(url.pathname)
      const ctx = getContext() ?? {} // may have been enriched (userId/sessionId) by the handler
      const len = req.headers.get('content-length')

      const line: Record<string, unknown> = {
        method: req.method,
        path: url.pathname + url.search,
        status,
        ms,
        ...(len ? { reqKB: Math.round(Number(len) / 1024) } : {}),
      }
      if (threw) logger.error(`${req.method} ${url.pathname} → 500`, threw as Error, line)
      else if (status >= 500) logger.error(`${req.method} ${url.pathname} → ${status}`, line)
      else logger.info(`${req.method} ${url.pathname} → ${status}`, line)

      getExporter()?.enqueueSpan({
        traceId,
        spanId,
        parentSpanId,
        name: `${req.method} ${routeLabel}`,
        kind: SPAN_KIND_SERVER,
        startUnixNano: `${start}000000`,
        endUnixNano: `${start + Math.round(ms)}000000`,
        attributes: {
          'http.request.method': req.method,
          'http.route': routeLabel,
          'url.path': url.pathname,
          'http.response.status_code': status,
          ...(ctx.userId ? { 'enduser.id': ctx.userId } : {}),
          ...(ctx.sessionId ? { 'voxi.session_id': ctx.sessionId } : {}),
          ...(opts.role ? { 'voxi.role': opts.role } : {}),
        },
        statusCode: threw || status >= 500 ? 2 : 1,
        statusMessage: threw ? (threw as Error).message : undefined,
      })

      return res
    })
  }
}

/**
 * Headers that propagate the current trace to a downstream service (BFF → eve, voice-bot → BFF), so the
 * whole hop chain lands under one traceId. Merge into an outbound fetch's headers.
 */
export function outboundHeaders(extra?: Record<string, string>): Record<string, string> {
  const ctx = getContext()
  const h: Record<string, string> = { ...extra }
  if (ctx?.traceId) {
    h.traceparent = formatTraceparent(ctx.traceId, ctx.spanId ?? newSpanId(), true)
    if (ctx.requestId) h['x-request-id'] = ctx.requestId
  }
  return h
}
