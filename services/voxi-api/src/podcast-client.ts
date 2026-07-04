/**
 * BFF ↔ podcast-worker bridge. The BFF gates the credit (metering) then hands the render to the worker over HTTP;
 * on poll it proxies the worker's honest status (composing → ready+audioUrl → failed). Owner-scoping is enforced
 * UPSTREAM in app.ts (it resolves (item,version) from a durable `getByToken(token, userId)` before calling this),
 * so the worker + this proxy operate on already-authorized (item,version) and hold NO per-instance ACL memory —
 * which matters because the BFF itself scales to zero / runs multi-instance. No fabricated "ready": the state comes
 * straight from the worker, which only reports ready once a real MP3 exists in GCS.
 */
import type { PodcastStatusService } from './app'
import type { PodcastContext } from '../../../packages/shared/src/podcast'

export interface PodcastBridge {
  enqueue(args: { token: string; catalogItemId: string; version: number; subject: string; userId: string; context?: PodcastContext }): Promise<void>
  status: PodcastStatusService
}

export function createPodcastBridge(opts: { workerUrl: string; secret: string; fetchImpl?: typeof fetch }): PodcastBridge {
  const f = opts.fetchImpl ?? fetch
  const base = opts.workerUrl.replace(/\/$/, '')
  const headers = { 'x-worker-secret': opts.secret, 'content-type': 'application/json' }

  return {
    async enqueue({ catalogItemId, version, subject, context }) {
      // No token sent — the worker keys purely on (item,version) in GCS and the store CAS is the idempotency.
      const r = await f(`${base}/render`, { method: 'POST', headers, body: JSON.stringify({ catalogItemId, version, subject, ...(context ? { context } : {}) }) })
      if (!r.ok && r.status !== 202) throw new Error(`worker /render → ${r.status}`)
    },
    status: {
      async status(catalogItemId, version) {
        const r = await f(`${base}/status?item=${encodeURIComponent(catalogItemId)}&version=${version}`, { headers }).catch(() => null)
        if (!r) return { state: 'failed' } // worker unreachable → honest failure, never a fake ready
        if (r.status === 404) return null
        if (!r.ok) return { state: 'failed' }
        return (await r.json()) as { state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string; endSec?: number }[] }
      },
    },
  }
}
