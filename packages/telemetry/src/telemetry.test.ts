import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { logger } from './logger'
import { redact } from './redact'
import { parseTraceparent, formatTraceparent, newTraceId, newSpanId, runWithContext } from './context'
import { OtlpExporter } from './otlp'

// Capture stdout so we can assert the exact NDJSON the logger emits.
let lines: string[] = []
const realWrite = process.stdout.write.bind(process.stdout)

beforeEach(() => {
  lines = []
  ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(String(s))
    return true
  }
})
afterEach(() => {
  ;(process.stdout as unknown as { write: typeof realWrite }).write = realWrite
})

const parsed = () => lines.map((l) => JSON.parse(l))

describe('logger', () => {
  test('emits one NDJSON line with level/service/msg', () => {
    logger.info('hello', { a: 1 })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith('\n')).toBe(true)
    const rec = parsed()[0]
    expect(rec.level).toBe('info')
    expect(rec.msg).toBe('hello')
    expect(rec.a).toBe(1)
    expect(typeof rec.service).toBe('string')
    expect(typeof rec.time).toBe('string')
  })

  test('error(msg, Error) captures message + stack', () => {
    logger.error('boom', new Error('kaboom'))
    const rec = parsed()[0]
    expect(rec.level).toBe('error')
    expect(rec.err.message).toBe('kaboom')
    expect(typeof rec.err.stack).toBe('string')
  })

  test('child() binds fields onto every line', () => {
    logger.child({ component: 'cascade' }).warn('slow', { ms: 42 })
    const rec = parsed()[0]
    expect(rec.component).toBe('cascade')
    expect(rec.ms).toBe(42)
    expect(rec.level).toBe('warn')
  })

  test('inherits traceId/userId from the ambient request context', () => {
    runWithContext({ traceId: 'a'.repeat(32), userId: 'user_1' }, () => {
      logger.info('in-request')
    })
    const rec = parsed()[0]
    expect(rec.traceId).toBe('a'.repeat(32))
    expect(rec.userId).toBe('user_1')
  })

  test('redacts sensitive fields and photo data-URIs', () => {
    logger.info('req', { authorization: 'Bearer secret', photo: 'data:image/jpeg;base64,' + 'A'.repeat(5000) })
    const rec = parsed()[0]
    expect(rec.authorization).toBe('[redacted]')
    expect(rec.photo).toMatch(/^\[data-uri \d+b\]$/)
  })
})

describe('redact', () => {
  test('strips nested tokens and long strings', () => {
    const out = redact({ nested: { token: 'abc', ok: 'fine' }, big: 'x'.repeat(4000) }) as {
      nested: { token: string; ok: string }
      big: string
    }
    expect(out.nested.token).toBe('[redacted]')
    expect(out.nested.ok).toBe('fine')
    expect(out.big.length).toBeLessThan(4000)
  })
})

describe('trace context', () => {
  test('newTraceId / newSpanId are the right hex widths', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })

  test('parseTraceparent round-trips a formatted header', () => {
    const traceId = newTraceId()
    const spanId = newSpanId()
    const p = parseTraceparent(formatTraceparent(traceId, spanId, true))
    expect(p).toEqual({ traceId, spanId, sampled: true })
  })

  test('rejects malformed / all-zero traceparent', () => {
    expect(parseTraceparent('garbage')).toBeNull()
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeNull()
    expect(parseTraceparent(null)).toBeNull()
  })
})

describe('OtlpExporter', () => {
  test('POSTs OTLP JSON to /v1/logs with configured headers, best-effort', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body), headers: init.headers as Record<string, string> })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const exp = new OtlpExporter('https://otlp.example/otlp/', { Authorization: 'Basic xyz' }, {
        serviceName: 'voxi-api',
        serviceNamespace: 'voxi',
        environment: 'test',
      })
      exp.enqueueLog({
        timeUnixNano: '1700000000000000000',
        severityNumber: 9,
        severityText: 'INFO',
        body: 'hello',
        attributes: { userId: 'u1' },
        traceId: 'a'.repeat(32),
      })
      await exp.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe('https://otlp.example/otlp/v1/logs')
      expect(calls[0]!.headers.Authorization).toBe('Basic xyz')
      const payload = JSON.parse(calls[0]!.body)
      const rl = payload.resourceLogs[0]
      expect(rl.scopeLogs[0].logRecords[0].body.stringValue).toBe('hello')
      expect(rl.scopeLogs[0].logRecords[0].traceId).toBe('a'.repeat(32))
      // resource carries service.name so the backend attributes it correctly
      const svc = rl.resource.attributes.find((a: { key: string }) => a.key === 'service.name')
      expect(svc.value.stringValue).toBe('voxi-api')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('never throws when the endpoint is down', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    try {
      const exp = new OtlpExporter('http://127.0.0.1:1/otlp', {}, {
        serviceName: 's',
        serviceNamespace: 'voxi',
        environment: 'test',
      })
      exp.enqueueLog({ timeUnixNano: '1', severityNumber: 9, severityText: 'INFO', body: 'x', attributes: {} })
      await exp.flush() // must resolve, not reject
      expect(true).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
