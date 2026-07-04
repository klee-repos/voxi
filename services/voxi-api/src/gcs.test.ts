import { describe, expect, it } from 'bun:test'
import { createPodcastAudioDeleter } from './gcs'

/** A fake GCS JSON-API fetch: list returns keys under `prefix`; delete records the (bucket,key) pair. */
function fakeGcsFetch(objects: Record<string, string[]>) {
  const deleted: string[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const m = /\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname)!
    const bucket = decodeURIComponent(m[1]!)
    if (init?.method === 'DELETE') {
      deleted.push(`${bucket}/${decodeURIComponent(m[2]!)}`)
      return new Response(null, { status: 204 })
    }
    const prefix = url.searchParams.get('prefix') ?? ''
    const items = (objects[bucket] ?? []).filter((k) => k.startsWith(prefix)).map((name) => ({ name }))
    return new Response(JSON.stringify({ items }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, deleted }
}

describe('createPodcastAudioDeleter', () => {
  it('purges an item prefix from BOTH buckets and is item-exact (no sibling-item deletion)', async () => {
    const { f, deleted } = fakeGcsFetch({
      'voxi-podcast-audio': ['podcasts/itemX/v1/episode.mp3', 'podcasts/itemX/v2/episode.mp3', 'podcasts/itemXY/v1/episode.mp3'],
      'voxi-podcast-state': ['podcasts/itemX/v1/status', 'podcasts/itemX/v1/asset.json', 'podcasts/itemXY/v1/status'],
    })
    const del = createPodcastAudioDeleter({ audioBucket: 'voxi-podcast-audio', stateBucket: 'voxi-podcast-state', token: () => 'tok', fetchImpl: f })
    await del('itemX')
    expect(deleted.sort()).toEqual(
      [
        'voxi-podcast-audio/podcasts/itemX/v1/episode.mp3',
        'voxi-podcast-audio/podcasts/itemX/v2/episode.mp3',
        'voxi-podcast-state/podcasts/itemX/v1/asset.json',
        'voxi-podcast-state/podcasts/itemX/v1/status',
      ].sort(),
    )
    // A prefix-sibling item is NEVER touched (the trailing slash makes the prefix item-exact).
    expect(deleted.some((k) => k.includes('itemXY'))).toBe(false)
  })
})
