/**
 * Backend Sentry integration — verified against the REAL @sentry/bun SDK with an in-memory transport (no network,
 * no cheating). Proves: capture fires off logged errors, secrets are deep-redacted before they leave the process,
 * the leaky default integrations are removed, the rate-limit dedupes a storm, and init is fail-soft.
 */
import { test, expect, describe, beforeEach, afterAll } from 'bun:test'
import * as Sentry from '@sentry/bun'
import { logger } from '../../../packages/telemetry/src/index'
import { initSentry, shouldCaptureServer, closeSentry, __resetRateLimitForTest } from './sentry'

// Records every serialized envelope the SDK would send.
const envelopes: string[] = []
const memoryTransport = () => ({
  send: (envelope: unknown) => {
    envelopes.push(JSON.stringify(envelope))
    return Promise.resolve({ statusCode: 200 })
  },
  flush: () => Promise.resolve(true),
})
const localDsn = 'https://publickey@localhost/1'

describe('backend sentry', () => {
  beforeEach(() => {
    envelopes.length = 0
    __resetRateLimitForTest()
  })
  afterAll(async () => {
    await closeSentry()
  })

  test('shouldCaptureServer skips expected outcomes, captures anomalies', () => {
    expect(shouldCaptureServer('hard_failure')).toBe(false)
    expect(shouldCaptureServer('safety_refusal')).toBe(false)
    expect(shouldCaptureServer('payment_required')).toBe(false)
    expect(shouldCaptureServer(500)).toBe(true)
    expect(shouldCaptureServer(502)).toBe(true)
    expect(shouldCaptureServer(404)).toBe(false)
    expect(shouldCaptureServer(undefined)).toBe(true)
  })

  test('init is fail-soft: no DSN disables, malformed DSN never throws', () => {
    const prev = process.env.SENTRY_DSN
    delete process.env.SENTRY_DSN
    expect(initSentry()).toBe(false)
    expect(() => initSentry({ dsn: '::::not-a-dsn::::' })).not.toThrow()
    if (prev) process.env.SENTRY_DSN = prev
  })

  test('captures a logged error and DEEP-redacts secrets before the transport; leaky integrations removed', async () => {
    expect(initSentry({ dsn: localDsn, transport: memoryTransport })).toBe(true)
    // the request-body / source-line / cookie vectors are gone
    expect(Sentry.getClient()?.getIntegrationByName('RequestData')).toBeUndefined()
    expect(Sentry.getClient()?.getIntegrationByName('ContextLines')).toBeUndefined()
    // a kept integration is still present
    expect(Sentry.getClient()?.getIntegrationByName('FunctionToString')).toBeDefined()

    logger.error(
      'db down',
      new Error('connect failed postgresql://voxi_app:S3cr3tPw@/voxi rejected sk_live_ABC123DEF456'),
      { userId: 'u_1' },
    )
    await Sentry.flush(2000)

    expect(envelopes.length).toBeGreaterThanOrEqual(1)
    const blob = envelopes.join('\n')
    expect(blob).toContain('db down') // the log message rides along as context
    expect(blob).toContain('connect failed') // non-secret text preserved for debugging
    expect(blob).not.toContain('S3cr3tPw') // DB password scrubbed (URL userinfo)
    expect(blob).not.toContain('sk_live_ABC123DEF456') // vendor key scrubbed
  })

  test('rate-limit keeps the first of a repeated fingerprint and drops the rest', async () => {
    initSentry({ dsn: localDsn, transport: memoryTransport })
    for (let i = 0; i < 6; i++) logger.error('flood', new Error('same-cause'))
    await Sentry.flush(2000)
    expect(envelopes.length).toBe(1)
  })

  test('info/warn never capture', async () => {
    initSentry({ dsn: localDsn, transport: memoryTransport })
    logger.info('fine', { a: 1 })
    logger.warn('meh')
    await Sentry.flush(2000)
    expect(envelopes.length).toBe(0)
  })
})
