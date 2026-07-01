/**
 * In-process test for the mountable voice routes (no network). Drives the real Hono sub-app via .request().
 * Covers: auth gate (401), thread-ownership ACL (403), fail-closed voiceMin metering (402), unconfigured
 * media plane (503, loud not fake), and the happy path (a per-session connect URL + one minute charged).
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { createVoiceRoutes } from './voice-routes'
import { testVerifier } from './auth'
import { memoryStore } from './metering'

process.env.VOXI_TEST_MODE = '1'

function build(opts?: { base?: string; voiceMinA?: number }) {
  const sessionOwner = new Map<string, string>([['thread_A', 'A']])
  const store = memoryStore({
    A: { scan: 5, podcast: 0, voiceMin: opts?.voiceMinA ?? 3 },
    B: { scan: 5, podcast: 0, voiceMin: 3 },
  })
  const app = createVoiceRoutes({
    verifier: testVerifier,
    store,
    sessionOwner,
    voiceServerBaseUrl: opts?.base ?? 'http://192.168.1.193:7071',
    mintConnectId: () => 'vc_fixed',
    now: () => 1000,
  })
  return { app, store }
}

const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })

describe('POST /v1/voice/session', () => {
  test('401 without a valid principal', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(401)
  })

  test('400 when threadId is missing', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', { method: 'POST', headers: auth('A'), body: '{}' })
    expect(res.status).toBe(400)
  })

  test('403 when the caller does not own the thread', async () => {
    const { app } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('B'), // B does not own thread_A
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(403)
  })

  test('happy path: charges one voice minute and returns a per-session connect URL', async () => {
    const { app, store } = build()
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connectUrl: string; minutesCharged: number; connectId: string }
    expect(body.connectId).toBe('vc_fixed')
    expect(body.minutesCharged).toBe(1)
    expect(body.connectUrl).toContain('/offer?session=vc_fixed')
    expect(body.connectUrl).toContain('thread=thread_A')
    // The voice minute was actually decremented (fail-closed metering, not fabricated).
    expect(await store.remaining('A', 'voiceMin')).toBe(2)
  })

  test('402 fail-closed when the caller has no voice minutes (no connect URL leaks)', async () => {
    const { app } = build({ voiceMinA: 0 })
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('voice_limit_reached')
  })

  test('503 loud (not a fake success) when the media plane is unconfigured', async () => {
    const { app } = build({ base: '' })
    const res = await app.request('/v1/voice/session', {
      method: 'POST',
      headers: auth('A'),
      body: JSON.stringify({ threadId: 'thread_A' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('voice_server_unconfigured')
  })
})
