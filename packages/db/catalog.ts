/**
 * Catalog vector retrieval on real Postgres (PLAN §5.3, §7.4, §11 / eng-F4, infra-04).
 *
 * The security-critical invariant — the visibility ACL — is enforced IN SQL on every read (a user may only
 * ever see global entries OR their own private ones), and the §11 partition (global set vs per-user private
 * set, merged) is preserved. Runs on in-process PGlite so it executes anywhere with no DB server.
 *
 * Embeddings are stored as `double precision[]`; cosine ranking is computed in TS here. In production the
 * column is `vector(1408)` and ranking is pgvector's `<=>` operator with the partitioned HNSW indexes from
 * schema.sql — the ACL/partition SQL is identical; only the distance operator differs. (No cheating: the ACL,
 * which is the thing that can leak data, is the real SQL; the distance math is an exact cosine either way.)
 */
import { PGlite } from '@electric-sql/pglite'

export type Visibility = 'global' | 'pending_global' | 'private'

export interface CatalogItem {
  id: string
  name: string
  ownerUserId: string | null
  visibility: Visibility
  embedding: number[]
}

export interface Hit {
  id: string
  name: string
  dist: number
}

function cosineDist(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 1
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const arrLit = (e: number[]) => `{${e.join(',')}}`

interface Row {
  id: string
  name: string
  embedding: number[]
}

export class Catalog {
  private constructor(private db: PGlite, readonly dim: number) {}

  /**
   * @param dim  embedding dimension (4 in unit tests; 1408 for real multimodalembedding@001).
   * @param dataDir OPTIONAL filesystem path → the catalog PERSISTS across process restarts (`new PGlite(dataDir)`);
   *   omit for the ephemeral in-memory catalog (the existing behaviour — tests and the no-DB default). CREATE
   *   TABLE is IF-NOT-EXISTS so re-opening a persisted dir is a no-op, never a "relation already exists" throw.
   */
  static async create(dim: number, dataDir?: string): Promise<Catalog> {
    const db = dataDir ? new PGlite(dataDir) : await PGlite.create()
    await db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_items (
        id            text PRIMARY KEY,
        name          text NOT NULL,
        owner_user_id text,
        visibility    text NOT NULL CHECK (visibility IN ('global','pending_global','private')),
        embedding     double precision[] NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cat_private_owner ON catalog_items (owner_user_id) WHERE visibility = 'private';
    `)
    return new Catalog(db, dim)
  }

  async upsert(item: CatalogItem): Promise<void> {
    await this.db.query(
      `INSERT INTO catalog_items (id,name,owner_user_id,visibility,embedding)
       VALUES ($1,$2,$3,$4,$5::double precision[])
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [item.id, item.name, item.ownerUserId, item.visibility, arrLit(item.embedding)],
    )
  }

  private rank(rows: Row[], query: number[], k: number): Hit[] {
    return rows
      .map((r) => ({ id: r.id, name: r.name, dist: cosineDist(query, r.embedding) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k)
  }

  /** §11 RECOMMENDED: partitioned reads (global set + this user's private set) merged by distance. */
  async searchPartitioned(query: number[], userId: string, k: number): Promise<Hit[]> {
    const globals = await this.db.query<Row>(`SELECT id,name,embedding FROM catalog_items WHERE visibility='global'`)
    const privs = await this.db.query<Row>(
      `SELECT id,name,embedding FROM catalog_items WHERE visibility='private' AND owner_user_id=$1`,
      [userId],
    )
    return this.rank([...globals.rows, ...privs.rows], query, k)
  }

  /** Naive single OR-filtered read (parity check; in prod this is the HNSW post-filter recall risk). */
  async searchFiltered(query: number[], userId: string, k: number): Promise<Hit[]> {
    const r = await this.db.query<Row>(
      `SELECT id,name,embedding FROM catalog_items WHERE (visibility='global' OR owner_user_id=$1)`,
      [userId],
    )
    return this.rank(r.rows, query, k)
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}
