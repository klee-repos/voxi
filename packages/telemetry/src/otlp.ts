/**
 * A minimal, dependency-free OTLP/HTTP (protobuf-JSON) exporter for logs + spans.
 *
 * It speaks the OTLP/HTTP JSON encoding directly over `fetch`, so we ship to any OTLP endpoint — an OTel
 * Collector sidecar (which forwards to Cloud Trace via the `googlecloud` exporter) or the local dev stack —
 * with NO `@opentelemetry/*` SDK. Configuration is the two standard env vars every backend documents:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   base URL, e.g. http://localhost:4318 (collector sidecar)
 *   OTEL_EXPORTER_OTLP_HEADERS    comma list, e.g. Authorization=Bearer <token>,x-goog-user-project=<proj>
 *
 * When the endpoint is unset the exporter is never constructed — logs stay on stdout only. Export failures
 * are best-effort and NEVER throw into the app: a down collector must not take a request with it.
 */

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }

interface KeyValue {
  key: string
  value: AnyValue
}

export interface OtlpResource {
  serviceName: string
  serviceNamespace: string
  environment: string
  serviceVersion?: string
  role?: string
}

export interface OtlpLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: string
  attributes: Record<string, unknown>
  traceId?: string
  spanId?: string
}

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startUnixNano: string
  endUnixNano: string
  attributes: Record<string, unknown>
  statusCode: 0 | 1 | 2
  statusMessage?: string
}

function anyValue(v: unknown): AnyValue {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } }
  return { stringValue: v === undefined || v === null ? '' : JSON.stringify(v) }
}

function attrs(o: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = []
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue
    out.push({ key: k, value: anyValue(v) })
  }
  return out
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=')
    if (i === -1) continue
    const k = pair.slice(0, i).trim()
    if (k) out[k] = pair.slice(i + 1).trim()
  }
  return out
}

export class OtlpExporter {
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly resourceAttrs: KeyValue[]
  private logQueue: OtlpLogRecord[] = []
  private spanQueue: OtlpSpan[] = []
  private failures = 0
  private flushing = false
  private readonly maxQueue = 10_000
  private readonly batchSize = 200

  constructor(endpoint: string, headers: Record<string, string>, resource: OtlpResource) {
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.headers = { 'content-type': 'application/json', ...headers }
    this.resourceAttrs = attrs({
      'service.name': resource.serviceName,
      'service.namespace': resource.serviceNamespace,
      'deployment.environment': resource.environment,
      'service.version': resource.serviceVersion,
      'voxi.role': resource.role,
    })
    // Periodic flush; unref'd so telemetry never keeps the process alive on its own.
    const timer = setInterval(() => void this.flush(), 3000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  enqueueLog(r: OtlpLogRecord): void {
    if (this.logQueue.length >= this.maxQueue) this.logQueue.shift()
    this.logQueue.push(r)
    if (this.logQueue.length >= this.batchSize) void this.flush()
  }

  enqueueSpan(s: OtlpSpan): void {
    if (this.spanQueue.length >= this.maxQueue) this.spanQueue.shift()
    this.spanQueue.push(s)
    if (this.spanQueue.length >= this.batchSize) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      const logs = this.logQueue.splice(0, this.logQueue.length)
      const spans = this.spanQueue.splice(0, this.spanQueue.length)
      const jobs: Promise<void>[] = []
      if (logs.length) jobs.push(this.send('/v1/logs', this.logsPayload(logs)))
      if (spans.length) jobs.push(this.send('/v1/traces', this.spansPayload(spans)))
      await Promise.all(jobs)
    } finally {
      this.flushing = false
    }
  }

  private async send(path: string, payload: unknown): Promise<void> {
    try {
      const res = await fetch(this.endpoint + path, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
      })
      if (!res.ok) this.note(`OTLP ${path} → HTTP ${res.status}`)
    } catch (e) {
      this.note(`OTLP ${path} failed: ${(e as Error).message}`)
    }
  }

  private note(msg: string): void {
    this.failures++
    // Surface the first failure and then only occasionally, so a down endpoint doesn't spam the log stream.
    if (this.failures === 1 || this.failures % 100 === 0) {
      process.stderr.write(`[telemetry] ${msg} (failure #${this.failures})\n`)
    }
  }

  private logsPayload(records: OtlpLogRecord[]) {
    return {
      resourceLogs: [
        {
          resource: { attributes: this.resourceAttrs },
          scopeLogs: [
            {
              scope: { name: 'voxi.telemetry' },
              logRecords: records.map((r) => ({
                timeUnixNano: r.timeUnixNano,
                severityNumber: r.severityNumber,
                severityText: r.severityText,
                body: { stringValue: r.body },
                attributes: attrs(r.attributes),
                ...(r.traceId ? { traceId: r.traceId } : {}),
                ...(r.spanId ? { spanId: r.spanId } : {}),
              })),
            },
          ],
        },
      ],
    }
  }

  private spansPayload(spans: OtlpSpan[]) {
    return {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttrs },
          scopeSpans: [
            {
              scope: { name: 'voxi.telemetry' },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startUnixNano,
                endTimeUnixNano: s.endUnixNano,
                attributes: attrs(s.attributes),
                status: { code: s.statusCode, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
              })),
            },
          ],
        },
      ],
    }
  }
}

/** Build an exporter from the standard OTEL_* env vars, or null when no endpoint is configured. */
export function exporterFromEnv(resource: OtlpResource): OtlpExporter | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint) return null
  return new OtlpExporter(endpoint, parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS), resource)
}
