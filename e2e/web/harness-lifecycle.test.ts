/**
 * Harness-level lifecycle test — drives the SAME `createWebHarness` (real voxi-api `createApp` + in-memory fakes)
 * that BOTH the web/Playwright tier AND the native Maestro `test-bff.ts` run against, exercising the new
 * DELETE + regenerate routes end-to-end over `harness.fetch`. This is the deterministic gate the adversarial review
 * asked for: it proves the harness store fakes ACTUALLY remove rows (no silent no-op → no false-green Maestro flow)
 * and that regenerate's `primeSession` recovers a COLD (post-"restart") session so the re-run re-settles instead of
 * degrading to "session expired". Runs under `bun test` with zero simulator/vendor dependency.
 */
import { test, expect, describe } from 'bun:test'
import { createWebHarness } from './server'

process.env.VOXI_TEST_MODE = '1'
const base = 'http://localhost/api'
const auth = (u: string) => ({ authorization: `Bearer test:${u}`, 'content-type': 'application/json' })

describe('web/maestro harness — delete + regenerate lifecycle', () => {
  const mk = () => createWebHarness({ seed: { A: { scan: 25, podcast: 5, voiceMin: 30 }, B: { scan: 25, podcast: 5, voiceMin: 30 } } })
  type H = ReturnType<typeof mk>
  const createThread = async (h: H, u: string, seed = 'confident') => {
    const r = await h.fetch(new Request(`${base}/v1/threads`, { method: 'POST', headers: { ...auth(u), 'x-voxi-test-seed': seed }, body: JSON.stringify({ photoUrl: 'data:image/jpeg;base64,AAAA' }) }))
    return (await r.json()).threadId as string
  }
  const drain = (h: H, id: string, u: string) => h.fetch(new Request(`${base}/v1/threads/${id}/stream`, { headers: auth(u) })).then((r) => r.text())
  const status = (h: H, path: string, u: string, init?: RequestInit) => h.fetch(new Request(`${base}${path}`, { ...init, headers: auth(u) })).then((r) => r.status)

  test('delete removes the item from the harness (204 → GET 404 → excluded from the collection); non-owner → 403', async () => {
    const h = mk()
    const id = await createThread(h, 'A')
    await drain(h, id, 'A') // pin the durable reveal
    expect(await status(h, `/v1/threads/${id}`, 'A')).toBe(200)
    expect(await status(h, `/v1/threads/${id}`, 'B', { method: 'DELETE' })).toBe(403) // same-process non-owner → 403
    expect(await status(h, `/v1/threads/${id}`, 'A', { method: 'DELETE' })).toBe(204)
    expect(await status(h, `/v1/threads/${id}`, 'A')).toBe(404) // gone
    const list = await (await h.fetch(new Request(`${base}/v1/threads`, { headers: auth('A') }))).json()
    expect(list.threads.find((t: { threadId: string }) => t.threadId === id)).toBeUndefined()
  })

  test('regenerate clears the reveal so the next stream RE-RUNS and re-settles — even after a "restart" evicts the session', async () => {
    const h = mk()
    const id = await createThread(h, 'A')
    const first = await drain(h, id, 'A')
    expect(first).toContain('confidence_band') // pinned a CONFIDENT reveal

    h.evict(id) // model a BFF restart: the in-memory live session/photo is gone (only the durable reveal remains)
    expect(await status(h, `/v1/threads/${id}/regenerate`, 'A', { method: 'POST' })).toBe(200)

    const second = await drain(h, id, 'A')
    expect(second).toContain('confidence_band') // re-ran + re-settled (primeSession recovered the cold session)
    expect(second).not.toContain('session expired') // NOT the cold-session degradation
  })
})
