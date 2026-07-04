/**
 * Durable, stateless-worker PodcastAssetStore backed by GCS (the production replacement for memoryAssetStore, which
 * only survived because the worker was a single always-on instance). Render status + the finished asset live in the
 * PRIVATE state bucket; the audio MP3 (uploaded by the muxer) lives in the PUBLIC audio bucket. Keying is purely
 * (catalogItemId, version) — no per-instance memory — so the worker scales to zero and runs multi-instance safely.
 *
 * The compare-and-set lease rides GCS generation preconditions (see gcs.ts). The `rendering` status carries a lease
 * TIMESTAMP (`rendering:<epochMs>`) so a lease left by an instance killed mid-render can be reclaimed once stale —
 * the self-heal the in-memory store got for free from process death, which durability removes.
 */
import type { GcsClient } from './gcs'
import type { PodcastAsset, PodcastAssetStore, PodcastStatus } from './render'

const statusKey = (item: string, version: number) => `podcasts/${item}/v${version}/status`
const assetKey = (item: string, version: number) => `podcasts/${item}/v${version}/asset.json`

/** The `rendering` status is stored as `rendering:<epochMs>`; every other status is its plain string. */
function parseStatus(text: string): PodcastStatus {
  return text.startsWith('rendering') ? 'rendering' : (text as PodcastStatus)
}
function renderingLeaseMs(text: string): number | null {
  if (!text.startsWith('rendering:')) return null
  const ms = Number(text.slice('rendering:'.length))
  return Number.isFinite(ms) ? ms : null
}

export function gcsAssetStore(
  gcs: GcsClient,
  opts: { stateBucket: string; now?: () => number },
): PodcastAssetStore {
  const now = opts.now ?? (() => Date.now())
  const B = opts.stateBucket
  const contentFor = (to: PodcastStatus) => (to === 'rendering' ? `rendering:${now()}` : to)

  return {
    async getStatus(item, version) {
      const o = await gcs.get(B, statusKey(item, version))
      return o ? parseStatus(o.text.trim()) : null
    },

    async compareAndSetStatus(item, version, from, to) {
      const key = statusKey(item, version)
      const cur = await gcs.get(B, key)
      if (!cur) {
        // An unseen key is implicitly `queued` (mirrors memoryAssetStore's `?? 'queued'`). Only a queued→X caller
        // may create it, and create-if-absent (ifGenerationMatch=0) makes two racers resolve to exactly one winner.
        if (from !== 'queued') return false
        const r = await gcs.put(B, key, contentFor(to), 'text/plain', { ifGenerationMatch: 0 })
        return r.ok
      }
      if (parseStatus(cur.text.trim()) !== from) return false
      // Conditional update on the exact generation we read — a concurrent writer bumps the generation → our 412.
      const r = await gcs.put(B, key, contentFor(to), 'text/plain', { ifGenerationMatch: cur.generation })
      return r.ok
    },

    async reclaimStaleRendering(item, version, maxAgeMs) {
      const key = statusKey(item, version)
      const cur = await gcs.get(B, key)
      if (!cur) return false
      const leaseMs = renderingLeaseMs(cur.text.trim())
      if (leaseMs === null || now() - leaseMs <= maxAgeMs) return false // not rendering, or a FRESH in-flight lease
      // Steal it, conditional on the stale generation so exactly one reclaimer wins and refreshes the lease clock.
      const r = await gcs.put(B, key, `rendering:${now()}`, 'text/plain', { ifGenerationMatch: cur.generation })
      return r.ok
    },

    async putAsset(asset) {
      await gcs.put(B, assetKey(asset.catalogItemId, asset.version), JSON.stringify(asset), 'application/json')
    },

    async getAsset(item, version) {
      const o = await gcs.get(B, assetKey(item, version))
      return o ? (JSON.parse(o.text) as PodcastAsset) : null
    },
  }
}
