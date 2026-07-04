/**
 * Minimal GCS REST client — no `@google-cloud/storage` lib, just `fetch` + a Bearer token (the same auth model
 * as gcp-vision.ts: a metadata-server SA token on Cloud Run). Objects are addressed by (bucket, key).
 *
 * The load-bearing capability is GENERATION-PRECONDITION writes (`ifGenerationMatch`): the podcast asset store
 * compare-and-sets the render lease atomically across scale-to-zero instances by conditionally PUTting the status
 * object — `ifGenerationMatch=0` = create-only (exactly one racer wins), `ifGenerationMatch=<gen>` = update-only.
 * A 412 (precondition failed) is the "you lost the race" signal, surfaced as `{ ok: false }`, never thrown.
 */
export type TokenFn = () => string

export interface GcsClient {
  /** Conditional media upload. `ifGenerationMatch` 0 = create-if-absent; N = update-if-current-gen-N. 412 → {ok:false}. */
  put(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    contentType: string,
    opts?: { ifGenerationMatch?: number },
  ): Promise<{ ok: boolean; status: number; generation?: number }>
  /** Object content + its current generation, or null on 404. */
  get(bucket: string, key: string): Promise<{ text: string; generation: number } | null>
  /** Every object key under a prefix (paginated). Requires storage.objects.list (the SA has it; allUsers must NOT). */
  list(bucket: string, prefix: string): Promise<string[]>
  /** Best-effort delete; a 404 is success (already gone). */
  del(bucket: string, key: string): Promise<void>
}

const API = 'https://storage.googleapis.com'

export function createGcsClient(token: TokenFn, fetchImpl: typeof fetch = fetch): GcsClient {
  const auth = () => ({ authorization: `Bearer ${token()}` })
  return {
    async put(bucket, key, body, contentType, opts) {
      const url = new URL(`${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`)
      url.searchParams.set('uploadType', 'media')
      url.searchParams.set('name', key)
      // A generation precondition makes the write a compare-and-set. 0 = "must not exist yet".
      if (opts?.ifGenerationMatch !== undefined) url.searchParams.set('ifGenerationMatch', String(opts.ifGenerationMatch))
      const r = await fetchImpl(url.toString(), { method: 'POST', headers: { ...auth(), 'content-type': contentType }, body })
      if (r.status === 412) return { ok: false, status: 412 } // lost the CAS race — the caller retries/bails
      if (!r.ok) throw new Error(`gcs put ${key} → ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const j = (await r.json().catch(() => ({}))) as { generation?: string }
      return { ok: true, status: r.status, generation: j.generation ? Number(j.generation) : undefined }
    },
    async get(bucket, key) {
      const url = `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`
      const r = await fetchImpl(url, { headers: auth() })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`gcs get ${key} → ${r.status}`)
      return { text: await r.text(), generation: Number(r.headers.get('x-goog-generation') ?? '0') }
    },
    async list(bucket, prefix) {
      const keys: string[] = []
      let pageToken: string | undefined
      do {
        const url = new URL(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o`)
        url.searchParams.set('prefix', prefix)
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const r = await fetchImpl(url.toString(), { headers: auth() })
        if (!r.ok) throw new Error(`gcs list ${prefix} → ${r.status}`)
        const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string }
        for (const it of j.items ?? []) keys.push(it.name)
        pageToken = j.nextPageToken
      } while (pageToken)
      return keys
    },
    async del(bucket, key) {
      const url = `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`
      const r = await fetchImpl(url, { method: 'DELETE', headers: auth() })
      if (!r.ok && r.status !== 404) throw new Error(`gcs del ${key} → ${r.status}`)
    },
  }
}
