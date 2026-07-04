import { describe, expect, it } from 'bun:test'
import type { GcsClient } from './gcs'
import { gcsAssetStore } from './gcs-asset-store'
import type { PodcastAsset } from './render'

/**
 * In-memory GcsClient that faithfully models GCS generation preconditions — the whole point of the store is that
 * compare-and-set rides `ifGenerationMatch`, so the fake MUST honor it (0 = create-if-absent, N = update-if-gen-N,
 * mismatch → 412 → {ok:false}). A globally-increasing `seq` stands in for GCS's per-write unique generation.
 */
function fakeGcs() {
  const store = new Map<string, { content: string; generation: number }>()
  let seq = 0
  const k = (b: string, key: string) => `${b}//${key}`
  const client: GcsClient = {
    async put(bucket, key, body, _ct, opts) {
      const kk = k(bucket, key)
      const has = store.get(kk)?.generation ?? 0 // absent object == generation 0
      if (opts?.ifGenerationMatch !== undefined && opts.ifGenerationMatch !== has) return { ok: false, status: 412 }
      const generation = ++seq
      store.set(kk, { content: typeof body === 'string' ? body : new TextDecoder().decode(body), generation })
      return { ok: true, status: 200, generation }
    },
    async get(bucket, key) {
      const cur = store.get(k(bucket, key))
      return cur ? { text: cur.content, generation: cur.generation } : null
    },
    async list(bucket, prefix) {
      const p = k(bucket, prefix)
      return [...store.keys()].filter((kk) => kk.startsWith(p)).map((kk) => kk.slice(`${bucket}//`.length))
    },
    async del(bucket, key) {
      store.delete(k(bucket, key))
    },
  }
  return { client, store }
}

const BUCKET = 'voxi-podcast-state'
const asset: PodcastAsset = { catalogItemId: 'itemA', version: 1, playlistKey: 'podcasts/itemA/v1/episode.mp3', segmentKeys: [], durationSec: 120, transcript: [{ speaker: 'ARLO', text: 'hi' }] }

describe('gcsAssetStore CAS + lease', () => {
  it('unseen key behaves as queued: queued→rendering succeeds via create-if-absent', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1000 })
    expect(await s.getStatus('itemA', 1)).toBeNull()
    expect(await s.compareAndSetStatus('itemA', 1, 'queued', 'rendering')).toBe(true)
    expect(await s.getStatus('itemA', 1)).toBe('rendering')
  })

  it('a non-queued transition on an unseen key is rejected', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1000 })
    expect(await s.compareAndSetStatus('itemA', 1, 'failed', 'rendering')).toBe(false)
    expect(await s.compareAndSetStatus('itemA', 1, 'rendering', 'ready')).toBe(false)
  })

  it('two concurrent create-if-absent racers → exactly one wins', async () => {
    const { client } = fakeGcs()
    const a = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1000 })
    const b = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1000 })
    const [wonA, wonB] = await Promise.all([
      a.compareAndSetStatus('itemA', 1, 'queued', 'rendering'),
      b.compareAndSetStatus('itemA', 1, 'queued', 'rendering'),
    ])
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1)
  })

  it('failed→rendering re-claim succeeds on the live generation; a stale generation 412s', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1000 })
    await s.compareAndSetStatus('itemA', 1, 'queued', 'rendering')
    await s.compareAndSetStatus('itemA', 1, 'rendering', 'failed')
    expect(await s.getStatus('itemA', 1)).toBe('failed')
    // A stale reader that PUTs on an old generation loses. Simulate: two readers both see 'failed' gen G; one writes.
    const g1 = await client.get(BUCKET, 'podcasts/itemA/v1/status')
    const g2 = await client.get(BUCKET, 'podcasts/itemA/v1/status')
    expect(g1!.generation).toBe(g2!.generation)
    expect((await client.put(BUCKET, 'podcasts/itemA/v1/status', 'rendering:1000', 'text/plain', { ifGenerationMatch: g1!.generation })).ok).toBe(true)
    expect((await client.put(BUCKET, 'podcasts/itemA/v1/status', 'rendering:1000', 'text/plain', { ifGenerationMatch: g2!.generation })).ok).toBe(false)
  })

  it('reclaimStaleRendering steals a stale lease but NEVER a fresh one', async () => {
    const { client } = fakeGcs()
    let t = 1_000_000
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => t })
    await s.compareAndSetStatus('itemA', 1, 'queued', 'rendering') // lease stamped at t=1_000_000
    // Fresh lease: reclaim refuses.
    t = 1_000_000 + 60_000 // +1 min
    expect(await s.reclaimStaleRendering!('itemA', 1, 600_000)).toBe(false)
    expect(await s.getStatus('itemA', 1)).toBe('rendering')
    // Stale lease: reclaim steals it and refreshes the clock.
    t = 1_000_000 + 700_000 // +~11.6 min > 10 min bound
    expect(await s.reclaimStaleRendering!('itemA', 1, 600_000)).toBe(true)
    // After the steal the lease is fresh again → a second reclaim refuses.
    expect(await s.reclaimStaleRendering!('itemA', 1, 600_000)).toBe(false)
  })

  it('reclaimStaleRendering returns false when the status is not rendering', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 5000 })
    await s.compareAndSetStatus('itemA', 1, 'queued', 'rendering')
    await s.compareAndSetStatus('itemA', 1, 'rendering', 'ready')
    expect(await s.reclaimStaleRendering!('itemA', 1, 1)).toBe(false)
  })

  it('putAsset/getAsset roundtrip preserves the transcript', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1 })
    expect(await s.getAsset('itemA', 1)).toBeNull()
    await s.putAsset(asset)
    expect(await s.getAsset('itemA', 1)).toEqual(asset)
  })

  it('ready replay: status ready + asset present', async () => {
    const { client } = fakeGcs()
    const s = gcsAssetStore(client, { stateBucket: BUCKET, now: () => 1 })
    await s.compareAndSetStatus('itemA', 1, 'queued', 'rendering')
    await s.putAsset(asset)
    expect(await s.compareAndSetStatus('itemA', 1, 'rendering', 'ready')).toBe(true)
    expect(await s.getStatus('itemA', 1)).toBe('ready')
    expect((await s.getAsset('itemA', 1))?.durationSec).toBe(120)
  })
})
