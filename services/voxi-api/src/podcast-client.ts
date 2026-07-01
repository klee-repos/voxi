/**
 * BFF ↔ podcast-worker bridge. The BFF gates the credit (metering) then hands the render to the worker over
 * HTTP; on poll it proxies the worker's honest status (composing → ready+audioUrl → failed). Owner-scoped: a
 * generation token's status is only readable by the user it was minted for (recorded at enqueue). No fabricated
 * "ready" — the state comes straight from the worker, which only reports ready once a real MP3 exists.
 */
import type { PodcastStatusService } from './app'

export interface PodcastBridge {
  enqueue(args: { token: string; catalogItemId: string; version: number; subject: string; userId: string }): Promise<void>
  status: PodcastStatusService
}

export function createPodcastBridge(opts: { workerUrl: string; secret: string; fetchImpl?: typeof fetch }): PodcastBridge {
  const f = opts.fetchImpl ?? fetch
  const base = opts.workerUrl.replace(/\/$/, '')
  const headers = { 'x-worker-secret': opts.secret, 'content-type': 'application/json' }
  const owner = new Map<string, string>() // generation token → owning userId (ACL)

  return {
    async enqueue({ token, catalogItemId, version, subject, userId }) {
      owner.set(token, userId)
      const r = await f(`${base}/render`, { method: 'POST', headers, body: JSON.stringify({ token, catalogItemId, version, subject }) })
      if (!r.ok && r.status !== 202) throw new Error(`worker /render → ${r.status}`)
    },
    status: {
      async status(token, userId) {
        // Owner-scoped: if we know who owns this token, only they may read it.
        if (owner.has(token) && owner.get(token) !== userId) return null
        const r = await f(`${base}/status?token=${encodeURIComponent(token)}`, { headers }).catch(() => null)
        if (!r) return { state: 'failed' } // worker unreachable → honest failure, never a fake ready
        if (r.status === 404) return null
        if (!r.ok) return { state: 'failed' }
        return (await r.json()) as { state: 'composing' | 'ready' | 'failed'; audioUrl?: string; transcript?: { speaker: 'ARLO' | 'MAVE'; text: string }[] }
      },
    },
  }
}
