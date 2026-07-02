/**
 * Cloud SQL (Postgres) backing for the durable BFF stores — the production analogue of pg-stores.ts's PGlite.
 *
 * On Cloud Run the collection MUST live in a shared, durable database (the container filesystem is ephemeral
 * and per-instance, so PGlite-on-disk split-brains across autoscaled instances). This module opens a real
 * Postgres connection pool and reuses `buildPgStores` verbatim through a thin `PgLike` adapter — the SAME SQL
 * and store logic proven by pg-stores.test.ts, only the driver differs. Nothing is faked: an absent/unreachable
 * DATABASE_URL fails loudly at boot rather than silently degrading.
 *
 * Connection: `DATABASE_URL` is a standard Postgres DSN. On Cloud Run we use the native Cloud SQL unix-socket
 * integration, e.g. `postgresql://voxi_app:<pw>@/voxi?host=/cloudsql/<PROJECT>:<REGION>:<INSTANCE>`.
 */
import { Pool } from 'pg'
import { buildPgStores, type PgStores, type PgLike } from './pg-stores'

/** bytea params must be Buffers for node-postgres; pass a JPEG Uint8Array straight through as one. */
function toParam(p: unknown): unknown {
  return p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p
}

/**
 * Open a Cloud SQL-backed durable store set. `max` bounds the pool (Cloud Run concurrency × instances must stay
 * under the instance's max_connections). The stores' idempotent DDL bootstraps the tables on first boot.
 */
export async function createCloudSqlStores(databaseUrl: string, opts?: { max?: number }): Promise<PgStores> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts?.max ?? Number(process.env.PGPOOL_MAX ?? 5),
    // Fail a checkout fast if the DB is unreachable rather than hanging a request.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })

  const db: PgLike = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, (params ?? []).map(toParam))
      return { rows: res.rows as T[], affectedRows: res.rowCount ?? 0 }
    },
    async exec(sql: string) {
      // No params → simple-query protocol, which runs the multi-statement DDL block in one round-trip.
      await pool.query(sql)
    },
    async close() {
      await pool.end()
    },
  }

  // Prove the connection at boot (fail loud, not on the first user request).
  await pool.query('select 1')
  return buildPgStores(db)
}
