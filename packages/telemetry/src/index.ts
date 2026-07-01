/**
 * @voxi/telemetry — structured logging + OTLP export, stdout-first and Grafana-Cloud-ready, zero deps.
 *
 * Boot a service:
 *   import { initTelemetry, logger, withRequestTelemetry } from '@voxi/telemetry' // (repo uses relative paths)
 *   initTelemetry({ service: 'voxi-api', role: 'bff' })
 *   Bun.serve({ fetch: withRequestTelemetry(handler, { role: 'bff' }) })
 *
 * Everything works with no env set (logs → stdout). Set OTEL_EXPORTER_OTLP_ENDPOINT (+ _HEADERS) to ship.
 */
export {
  logger,
  initTelemetry,
  shutdownTelemetry,
  getExporter,
  type Logger,
  type Level,
} from './logger'
export { withRequestTelemetry, outboundHeaders, routePattern, type RequestTelemetryOptions } from './http'
export {
  getContext,
  runWithContext,
  bindContext,
  newTraceId,
  newSpanId,
  parseTraceparent,
  formatTraceparent,
  type RequestContext,
} from './context'
export { redact } from './redact'
export { OtlpExporter, exporterFromEnv, parseHeaders, type OtlpResource } from './otlp'
