/**
 * catalog_search — eve tool wrapping the real `packages/db` Catalog (PLAN §4.2, §4.6, §5.3, §7).
 *
 * The agent never touches SQL or the visibility ACL directly; it calls this tool with the current user's id
 * and a query embedding, and gets back ranked, ACL-respecting hits. The ACL (a user sees global entries OR
 * their own private ones) lives in the Catalog's SQL — this wrapper only adapts shapes and applies the §11
 * partitioned read, so a hit avoids the paid web-grounding stage (§5 cascade ordering).
 *
 * The Catalog is INJECTED (constructed by the host from real Postgres/PGlite). No internals are reached into;
 * this is a thin adapter over its public `searchPartitioned` method.
 */
import type { Catalog, Hit } from '../../../../packages/db/catalog'

export interface CatalogSearchInput {
  /** the query image embedding (Vertex multimodalembedding@001 → vector(1408) in prod). */
  embedding: number[]
  /** the requesting user; the ACL filters to global OR this user's private entries. */
  userId: string
  /** top-k to return. */
  k?: number
}

export interface CatalogSearchHit {
  entryId: string
  name: string
  /** cosine SIMILARITY in [0,1] (1 = identical). The Catalog returns cosine DISTANCE; we convert here so the
   *  agent and arbitration see the same `cosine` field shape as `Candidate.cosine`. */
  cosine: number
}

export interface CatalogSearchResult {
  hits: CatalogSearchHit[]
  /** the best (closest) hit, or undefined if the catalog was empty for this user's view. */
  best?: CatalogSearchHit
}

function toSimilarity(h: Hit): CatalogSearchHit {
  // dist is cosine distance (0 = identical, 2 = opposite). similarity = 1 - dist, clamped to [0,1].
  const sim = Math.max(0, Math.min(1, 1 - h.dist))
  return { entryId: h.id, name: h.name, cosine: sim }
}

export async function catalog_search(
  input: CatalogSearchInput,
  catalog: Catalog,
): Promise<CatalogSearchResult> {
  const k = input.k ?? 5
  const hits = (await catalog.searchPartitioned(input.embedding, input.userId, k)).map(toSimilarity)
  return { hits, best: hits[0] }
}
