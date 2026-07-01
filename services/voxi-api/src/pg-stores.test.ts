/**
 * Durability + correctness proof for the file-backed BFF stores (COLLECTION-PERSISTENCE-PLAN §7.1).
 *
 * Every assertion here is REAL SQL on a REAL file-backed PGlite. The load-bearing durability proof is
 * close() → reopen the SAME dataDir → the photo bytes, the reveal (events + narration), the podcast, and the
 * conversation are all STILL THERE — i.e. they survive a process restart, which is the entire point of the fix.
 * Also pins the adversarial-review traps: A6 (partial-index ON CONFLICT does not throw on a NULL/dup append),
 * A11 ({id,duplicate}), A15 (refund fires once), A16 (bytea byte-equality), A14 (purge cascade).
 */
import { test, expect, describe, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPgStores } from './pg-stores'
import type { StreamEvent } from '../../../packages/shared/src/events'

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'voxi-pgstores-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]) // JPEG magic
const EVENTS: StreamEvent[] = [
  { type: 'token', index: 0, text: 'A 1976 Canon AE-1.' },
  { type: 'confidence_band', index: 1, band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: [] },
  { type: 'done', index: 2, sessionId: 'sess_A_1' },
]

describe('pg-stores durable collection', () => {
  test('photo bytea round-trips byte-equal (A16)', async () => {
    const s = await createPgStores(freshDir())
    await s.photos.put({ threadId: 't1', ownerUserId: 'A', mime: 'image/jpeg', bytes: PHOTO })
    const got = await s.photos.get('t1')
    expect(got).not.toBeNull()
    expect(got!.mime).toBe('image/jpeg')
    expect(got!.ownerUserId).toBe('A')
    expect(Array.from(got!.bytes)).toEqual(Array.from(PHOTO))
    expect(await s.photos.has('t1')).toBe(true)
    expect(await s.photos.has('nope')).toBe(false)
    await s.close()
  })

  test('reveal put is first-write-wins (inserted flag) and reads events/candidates already-parsed (A16)', async () => {
    const s = await createPgStores(freshDir())
    const first = await s.reveals.put({ threadId: 't1', ownerUserId: 'A', band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: ['a', 'b'], events: EVENTS, narration: 'A camera.', createdAt: 1 })
    expect(first.inserted).toBe(true)
    const second = await s.reveals.put({ threadId: 't1', ownerUserId: 'A', band: 'PROBABLE', title: 'different', candidates: [], events: [], narration: 'x', createdAt: 2 })
    expect(second.inserted).toBe(false) // ON CONFLICT DO NOTHING → the first drain is pinned
    const got = await s.reveals.get('t1')
    expect(got!.title).toBe('1976 Canon AE-1')
    expect(got!.candidates).toEqual(['a', 'b'])
    expect(got!.events).toHaveLength(3)
    expect(got!.events[1]).toMatchObject({ type: 'confidence_band', band: 'CONFIDENT' })
    expect(got!.narration).toBe('A camera.')
    await s.close()
  })

  test('messages append is idempotent on (thread,clientKey) and does NOT throw on a NULL key (A6/A11)', async () => {
    const s = await createPgStores(freshDir())
    // NULL client_key must insert (partial index does not cover it) — this is the append that 500'd with the naive form.
    const nullKey = await s.messages.append({ threadId: 't1', userId: 'A', role: 'user', text: 'hello', source: 'voice', clientKey: null })
    expect(nullKey.duplicate).toBe(false)
    const a = await s.messages.append({ threadId: 't1', userId: 'A', role: 'user', text: 'what is this?', clientKey: 'k1' })
    expect(a.duplicate).toBe(false)
    const dup = await s.messages.append({ threadId: 't1', userId: 'A', role: 'user', text: 'what is this? (retry)', clientKey: 'k1' })
    expect(dup.duplicate).toBe(true)
    expect(dup.id).toBe(a.id) // canonical id recovered on the dup path (A11)
    const list = await s.messages.listByThread('t1')
    expect(list).toHaveLength(2) // the retry did NOT create a second row
    expect(list.map((m) => m.text)).toContain('hello')
    expect(list.map((m) => m.text)).toContain('what is this?')
    await s.close()
  })

  test('podcast asset upsert is owner-scoped; cross-user reads are null (A9)', async () => {
    const s = await createPgStores(freshDir())
    await s.podcasts.upsert({ token: 'gen_1', userId: 'A', catalogItemId: 't1', version: 1, status: 'composing', createdAt: 1, updatedAt: 1 })
    await s.podcasts.upsert({ token: 'gen_1', userId: 'A', catalogItemId: 't1', version: 1, status: 'ready', audioUrl: 'g/ep.m4a', transcript: [{ speaker: 'ARLO', text: 'Hi' }], createdAt: 1, updatedAt: 2 })
    expect((await s.podcasts.getByToken('gen_1', 'A'))!.status).toBe('ready')
    expect((await s.podcasts.getByItem('t1', 1, 'A'))!.audioUrl).toBe('g/ep.m4a')
    expect((await s.podcasts.getByItem('t1', 1, 'A'))!.transcript).toEqual([{ speaker: 'ARLO', text: 'Hi' }])
    // cross-tenant: B cannot read A's episode
    expect(await s.podcasts.getByToken('gen_1', 'B')).toBeNull()
    expect(await s.podcasts.getByItem('t1', 1, 'B')).toBeNull()
    await s.close()
  })

  test('refund guard fires exactly once, even across restart (A15)', async () => {
    const dir = freshDir()
    const s = await createPgStores(dir)
    expect(await s.refunds.markRefunded('t1')).toBe(true) // first → proceed with the credit
    expect(await s.refunds.markRefunded('t1')).toBe(false) // second → no double refund
    await s.close()
    const s2 = await createPgStores(dir) // simulated restart
    expect(await s2.refunds.markRefunded('t1')).toBe(false) // STILL refunded after restart
    await s2.close()
  })

  test('applyReveal sets reveal_title + band but NEVER overwrites the auto-title (A8)', async () => {
    const s = await createPgStores(freshDir())
    await s.threads.put({ threadId: 't1', ownerUserId: 'A', title: 'Capture · confident', createdAt: 1, continuationToken: 'ct' })
    await s.threads.markPhoto!('t1', 'image/jpeg')
    await s.threads.applyReveal!('t1', { revealTitle: '2008 Cannondale SuperSix EVO', band: 'CONFIDENT' })
    const got = await s.threads.get('t1')
    expect(got!.title).toBe('Capture · confident') // auto-title UNTOUCHED
    expect(got!.revealTitle).toBe('2008 Cannondale SuperSix EVO')
    expect(got!.band).toBe('CONFIDENT')
    expect(got!.photoMime).toBe('image/jpeg')
    await s.close()
  })

  test('DURABILITY: photo + reveal + podcast + conversation all survive close → reopen the same dataDir', async () => {
    const dir = freshDir()
    const s = await createPgStores(dir)
    await s.threads.put({ threadId: 't1', ownerUserId: 'A', title: 'Untitled capture', createdAt: 1, continuationToken: 'ct' })
    await s.photos.put({ threadId: 't1', ownerUserId: 'A', mime: 'image/jpeg', bytes: PHOTO })
    await s.threads.markPhoto!('t1', 'image/jpeg')
    await s.reveals.put({ threadId: 't1', ownerUserId: 'A', band: 'CONFIDENT', title: '1976 Canon AE-1', candidates: [], events: EVENTS, narration: 'A camera.', createdAt: 1 })
    await s.threads.applyReveal!('t1', { revealTitle: '1976 Canon AE-1', band: 'CONFIDENT' })
    await s.podcasts.upsert({ token: 'gen_1', userId: 'A', catalogItemId: 't1', version: 1, status: 'ready', audioUrl: 'g/ep.m4a', transcript: [{ speaker: 'MAVE', text: 'A fine camera.' }], createdAt: 1, updatedAt: 1 })
    await s.messages.append({ threadId: 't1', userId: 'A', role: 'user', text: 'is it rare?', clientKey: 'k1' })
    await s.messages.append({ threadId: 't1', userId: 'A', role: 'guide', text: 'Not especially.', clientKey: 'k2' })
    await s.close()

    // --- restart ---
    const s2 = await createPgStores(dir)
    expect(Array.from((await s2.photos.get('t1'))!.bytes)).toEqual(Array.from(PHOTO))
    const rv = await s2.reveals.get('t1')
    expect(rv!.events).toHaveLength(3)
    expect(rv!.narration).toBe('A camera.')
    const th = await s2.threads.get('t1')
    expect(th!.revealTitle).toBe('1976 Canon AE-1')
    expect(th!.photoMime).toBe('image/jpeg')
    expect((await s2.podcasts.getByItem('t1', 1, 'A'))!.audioUrl).toBe('g/ep.m4a')
    expect(await s2.messages.listByThread('t1')).toHaveLength(2)
    await s2.close()
  })

  test('purgeUser cascades across every table and is owner-scoped (A14)', async () => {
    const s = await createPgStores(freshDir())
    for (const u of ['A', 'B']) {
      await s.threads.put({ threadId: `${u}-t1`, ownerUserId: u, title: 'x', createdAt: 1, continuationToken: 'ct' })
      await s.photos.put({ threadId: `${u}-t1`, ownerUserId: u, mime: 'image/jpeg', bytes: PHOTO })
      await s.reveals.put({ threadId: `${u}-t1`, ownerUserId: u, band: 'CONFIDENT', title: 'x', candidates: [], events: EVENTS, narration: 'x', createdAt: 1 })
      await s.podcasts.upsert({ token: `gen_${u}`, userId: u, catalogItemId: `${u}-t1`, version: 1, status: 'composing', createdAt: 1, updatedAt: 1 })
      await s.messages.append({ threadId: `${u}-t1`, userId: u, role: 'user', text: 'hi', clientKey: 'k1' })
      await s.refunds.markRefunded(`${u}-t1`)
    }
    const counts = await s.purgeUser('A')
    expect(counts).toMatchObject({ threads: 1, photos: 1, reveals: 1, podcasts: 1, messages: 1 })
    // A is gone…
    expect(await s.photos.get('A-t1')).toBeNull()
    expect(await s.reveals.get('A-t1')).toBeNull()
    expect(await s.messages.listByThread('A-t1')).toHaveLength(0)
    // …B is untouched.
    expect(await s.photos.get('B-t1')).not.toBeNull()
    expect(await s.reveals.get('B-t1')).not.toBeNull()
    expect(await s.messages.listByThread('B-t1')).toHaveLength(1)
    await s.close()
  })
})
