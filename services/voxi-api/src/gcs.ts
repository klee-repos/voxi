/**
 * Minimal GCS delete helper for the BFF's deletion cascade. The rendered podcast audio (public bucket) + render
 * state (private bucket) live in GCS; the SQL row delete alone would orphan them, violating "audio must be
 * purgeable". Raw fetch + Bearer gcloudToken (same auth model as gcp-vision.ts — no client lib). Purges every
 * object under an item's prefix from BOTH buckets, across all versions.
 */
import { gcloudToken } from '../../eve-agent/agent/lib/gcp-vision'

const API = 'https://storage.googleapis.com'

async function listPrefix(bucket: string, prefix: string, token: string, f: typeof fetch): Promise<string[]> {
  const keys: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o`)
    url.searchParams.set('prefix', prefix)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const r = await f(url.toString(), { headers: { authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`gcs list ${bucket}/${prefix} → ${r.status}`)
    const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string }
    for (const it of j.items ?? []) keys.push(it.name)
    pageToken = j.nextPageToken
  } while (pageToken)
  return keys
}

async function deleteObject(bucket: string, key: string, token: string, f: typeof fetch): Promise<void> {
  const r = await f(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!r.ok && r.status !== 404) throw new Error(`gcs del ${bucket}/${key} → ${r.status}`)
}

/**
 * Build `deletePodcastAudio(catalogItemId)` — purges `podcasts/<catalogItemId>/` from both buckets. The trailing
 * slash makes the prefix item-exact (so `.../itemX/` never matches `.../itemXY/...`), i.e. it cannot delete a
 * different item's objects. Token + fetch are injectable for unit tests.
 */
export function createPodcastAudioDeleter(opts: {
  audioBucket: string
  stateBucket: string
  token?: () => string
  fetchImpl?: typeof fetch
}): (catalogItemId: string) => Promise<void> {
  const token = opts.token ?? gcloudToken
  const f = opts.fetchImpl ?? fetch
  return async (catalogItemId: string) => {
    const prefix = `podcasts/${catalogItemId}/`
    for (const bucket of [opts.audioBucket, opts.stateBucket]) {
      const t = token()
      for (const key of await listPrefix(bucket, prefix, t, f)) await deleteObject(bucket, key, t, f)
    }
  }
}
