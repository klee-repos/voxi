/**
 * Request-scoped context + W3C trace-context helpers.
 *
 * An AsyncLocalStorage store carries the current {traceId, spanId, requestId, userId, sessionId} so every
 * log line emitted anywhere inside a request inherits them WITHOUT the call site having to thread them.
 * That is what makes "give me everything for trace X" work across the codebase — the single most useful
 * thing for an RCA.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  requestId?: string
  userId?: string
  sessionId?: string
  [k: string]: string | undefined
}

const als = new AsyncLocalStorage<RequestContext>()

/** The context for the in-flight request, if any. */
export function getContext(): RequestContext | undefined {
  return als.getStore()
}

/** Run `fn` (and everything it awaits) with `ctx` as the ambient request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn)
}

/**
 * Merge fields into the ACTIVE context in place, so later logs/spans in the same request inherit them.
 * Typical use: a route handler learns the userId after auth and calls `bindContext({ userId })`.
 */
export function bindContext(fields: Partial<RequestContext>): void {
  const cur = als.getStore()
  if (cur) Object.assign(cur, fields)
}

// ── W3C trace context (https://www.w3.org/TR/trace-context/) ──────────────────────────────────────────

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += b.toString(16).padStart(2, '0')
  return s
}

/** A 16-byte (32 hex char) trace id. */
export const newTraceId = (): string => randomHex(16)
/** An 8-byte (16 hex char) span id. */
export const newSpanId = (): string => randomHex(8)

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i
const ZERO_TRACE = '0'.repeat(32)
const ZERO_SPAN = '0'.repeat(16)

/** Parse an incoming `traceparent` header, or null if absent/invalid/all-zero. */
export function parseTraceparent(
  header: string | null | undefined,
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!header) return null
  const m = TRACEPARENT.exec(header.trim())
  if (!m) return null
  const traceId = m[1]!.toLowerCase()
  const spanId = m[2]!.toLowerCase()
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null
  return { traceId, spanId, sampled: (parseInt(m[3]!, 16) & 1) === 1 }
}

/** Format a `traceparent` header value. */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`
}
