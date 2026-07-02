/**
 * DURABLE, file-backed persistence for the voxi-api BFF (task #20 / PLAN §6.4 / COLLECTION-PERSISTENCE-PLAN).
 *
 * Replaces the in-memory Maps in local-collaborators.ts with a real Postgres-in-WASM (PGlite) opened on a
 * file-backed `dataDir`, so a user's collection survives a process restart. Everything a collection item
 * produces is durable here: the thread row, the CAPTURED PHOTO (bytea), the generated REVEAL (the ordered
 * NDJSON events for deterministic replay + the identified label/band/narration), the PODCAST episode, the
 * CONVERSATION, and a once-ever refund guard. Nothing fakes success: state is written through real SQL to disk
 * and restart-survival is proven by closing the DB and reopening the SAME dataDir.
 *
 * The atomic metering contract from metering.ts is preserved: tryDecrement is a single row-atomic
 * `UPDATE … WHERE meter >= n RETURNING`.
 *
 * Adversarial-review notes baked in: A6 (partial-index ON CONFLICT repeats the WHERE predicate), A11
 * ({id,duplicate} via affectedRows + a follow-up SELECT), A16 (jsonb comes back already-parsed — never
 * JSON.parse on read; bytea round-trips as a byte-equal Uint8Array).
 */
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import type { Store, Meter, Entitlements } from './metering'
import type {
  ThreadStore,
  ThreadRecord,
  PhotoStore,
  RevealStore,
  RevealRecord,
  PodcastAssetStore,
  PodcastAssetRecord,
  MessageStore,
  MessageRecord,
  RefundStore,
} from './app'
import type { StreamEvent } from '../../../packages/shared/src/events'

/** Generous demo grants — a real user gets these lazily on first touch. Mirrors local-collaborators.ts. */
const DEMO_ENTITLEMENTS: Entitlements = { scan: 100_000, podcast: 1_000, voiceMin: 100_000 }

/**
 * Safe whitelist mapping from the public Meter names to fixed column names. NEVER interpolate a raw meter
 * name into SQL — validate it is a known Meter and look up its fixed column here. voiceMin → voice_min.
 */
const METER_COLUMN: Record<Meter, 'scan' | 'podcast' | 'voice_min'> = {
  scan: 'scan',
  podcast: 'podcast',
  voiceMin: 'voice_min',
}

function meterColumn(meter: Meter): 'scan' | 'podcast' | 'voice_min' {
  const col = METER_COLUMN[meter]
  if (!col) throw new Error(`unknown meter: ${String(meter)}`)
  return col
}

export interface PgStores {
  store: Store
  threads: ThreadStore
  photos: PhotoStore
  reveals: RevealStore
  podcasts: PodcastAssetStore
  messages: MessageStore
  refunds: RefundStore
  /** Deletion cascade: purge every durable row for a user across all tables. Returns the counts. */
  purgeUser(userId: string): Promise<{
    threads: number
    tokens: number
    entitlements: number
    photos: number
    reveals: number
    podcasts: number
    messages: number
  }>
  /** Close the underlying PGlite (flushes to disk). Reopening createPgStores on the same dir resumes state. */
  close(): Promise<void>
}

/** The minimal Postgres surface these stores need — satisfied by PGlite (local/dev, file-backed) AND by the
 *  thin `pg` adapter in cloudsql-stores.ts (Cloud Run → Cloud SQL). All SQL + store logic lives ONCE below. */
export interface PgLike {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>
  exec(sql: string): Promise<unknown>
  close(): Promise<void>
}

/**
 * Build the durable stores over any PgLike. Tables are created if absent (bootstraps a fresh DB) and missing
 * columns are added idempotently (resumes/upgrades an existing one), so a pre-existing store gains the new
 * columns/tables on boot. The SQL is standard Postgres — identical against PGlite and Cloud SQL.
 */
export async function buildPgStores(db: PgLike): Promise<PgStores> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id   text PRIMARY KEY,
      scan      integer NOT NULL,
      podcast   integer NOT NULL,
      voice_min integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gen_tokens (
      key   text PRIMARY KEY,
      token text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      thread_id          text PRIMARY KEY,
      owner_user_id      text NOT NULL,
      title              text NOT NULL,
      created_at         bigint NOT NULL,
      continuation_token text NOT NULL
    );
    -- additive columns (idempotent) so an existing pre-feature dir upgrades cleanly.
    ALTER TABLE threads ADD COLUMN IF NOT EXISTS band         text;
    ALTER TABLE threads ADD COLUMN IF NOT EXISTS reveal_title text;
    ALTER TABLE threads ADD COLUMN IF NOT EXISTS photo_mime   text;
    CREATE INDEX IF NOT EXISTS threads_owner_created ON threads (owner_user_id, created_at DESC);

    -- captured photo bytes (bytea; the local stand-in for GCS behind app.threads.photo_url).
    CREATE TABLE IF NOT EXISTS thread_photos (
      thread_id     text PRIMARY KEY,
      owner_user_id text   NOT NULL,
      mime          text   NOT NULL,
      bytes         bytea  NOT NULL,
      created_at    bigint NOT NULL
    );

    -- the durable reveal projection (== app.turns). events jsonb is the source of truth for deterministic replay.
    CREATE TABLE IF NOT EXISTS reveals (
      thread_id     text PRIMARY KEY,
      owner_user_id text   NOT NULL,
      band          text,
      title         text,
      candidates    jsonb  NOT NULL DEFAULT '[]',
      events        jsonb  NOT NULL DEFAULT '[]',
      narration     text,
      created_at    bigint NOT NULL
    );

    -- the item's durable podcast episode (== app.podcast_assets). Owner-scoped keyspace (adversarial A9).
    CREATE TABLE IF NOT EXISTS podcast_assets (
      token           text PRIMARY KEY,
      user_id         text    NOT NULL,
      catalog_item_id text    NOT NULL,
      version         integer NOT NULL DEFAULT 1,
      status          text    NOT NULL DEFAULT 'composing'
                      CHECK (status IN ('composing','ready','failed')),
      audio_url       text,
      transcript      jsonb,
      created_at      bigint  NOT NULL,
      updated_at      bigint  NOT NULL,
      -- fail-closed parity with prod (A17): a 'ready' asset must carry its audio.
      CONSTRAINT podcast_ready_has_audio CHECK ((status <> 'ready') OR (audio_url IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS podcast_user_item_version
      ON podcast_assets (user_id, catalog_item_id, version);

    -- durable conversation (== app.messages). Idempotent single-writer via the PARTIAL unique index (A6).
    CREATE TABLE IF NOT EXISTS messages (
      id         text PRIMARY KEY,
      thread_id  text   NOT NULL,
      user_id    text   NOT NULL,
      role       text   NOT NULL CHECK (role IN ('user','guide')),
      text       text   NOT NULL,
      source     text   NOT NULL DEFAULT 'text' CHECK (source IN ('text','voice')),
      client_key text,
      created_at bigint NOT NULL,
      -- durable send order for the conversation. created_at is a wall clock (ms): it ties on rapid appends and can
      -- even step backward, so it must NOT decide order. seq is a single monotonic sequence — the true send order.
      seq        bigint GENERATED ALWAYS AS IDENTITY
    );
    -- upgrade a pre-seq DB: IDENTITY backfills seq in heap order, which for this append-only table is insertion order.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_key
      ON messages (thread_id, client_key) WHERE client_key IS NOT NULL;

    -- once-ever refund guard (A15): a refused/failed scan credits back exactly once, across restarts.
    CREATE TABLE IF NOT EXISTS refunds (
      thread_id  text PRIMARY KEY,
      created_at bigint NOT NULL
    );
  `)

  /** Lazily insert the user's generous demo row if they have none yet (ON CONFLICT → first write wins). */
  async function ensureEntitlements(userId: string): Promise<void> {
    await db.query(
      `INSERT INTO entitlements (user_id, scan, podcast, voice_min)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, DEMO_ENTITLEMENTS.scan, DEMO_ENTITLEMENTS.podcast, DEMO_ENTITLEMENTS.voiceMin],
    )
  }

  const store: Store = {
    async tryDecrement(userId, meter, n) {
      const col = meterColumn(meter)
      await ensureEntitlements(userId)
      // Row-atomic check+decrement: the row is only touched (and returned) when it still has >= n left.
      const res = await db.query<{ remaining: number }>(
        `UPDATE entitlements SET ${col} = ${col} - $2
         WHERE user_id = $1 AND ${col} >= $2
         RETURNING ${col} AS remaining`,
        [userId, n],
      )
      return res.rows.length > 0
    },

    async getToken(key) {
      const res = await db.query<{ token: string }>(`SELECT token FROM gen_tokens WHERE key = $1`, [key])
      return res.rows[0]?.token ?? null
    },

    async putToken(key, token) {
      // Idempotent: the first token minted for a key wins; a later attempt is a no-op.
      await db.query(`INSERT INTO gen_tokens (key, token) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, token])
    },

    async remaining(userId, meter) {
      const col = meterColumn(meter)
      const res = await db.query<{ remaining: number }>(
        `SELECT ${col} AS remaining FROM entitlements WHERE user_id = $1`,
        [userId],
      )
      return res.rows[0]?.remaining ?? 0
    },

    async credit(userId, meter, n) {
      const col = meterColumn(meter)
      await ensureEntitlements(userId)
      await db.query(`UPDATE entitlements SET ${col} = ${col} + $2 WHERE user_id = $1`, [userId, n])
    },
  }

  const threads: ThreadStore = {
    async put(rec) {
      await db.query(
        `INSERT INTO threads (thread_id, owner_user_id, title, created_at, continuation_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (thread_id) DO UPDATE SET
           owner_user_id      = EXCLUDED.owner_user_id,
           title              = EXCLUDED.title,
           created_at         = EXCLUDED.created_at,
           continuation_token = EXCLUDED.continuation_token`,
        [rec.threadId, rec.ownerUserId, rec.title, rec.createdAt, rec.continuationToken],
      )
    },

    async listByOwner(userId) {
      const res = await db.query<ThreadRow>(
        `SELECT thread_id, owner_user_id, title, created_at, continuation_token, band, reveal_title, photo_mime
         FROM threads WHERE owner_user_id = $1 ORDER BY created_at DESC`,
        [userId],
      )
      return res.rows.map(rowToThread)
    },

    async get(threadId) {
      const res = await db.query<ThreadRow>(
        `SELECT thread_id, owner_user_id, title, created_at, continuation_token, band, reveal_title, photo_mime
         FROM threads WHERE thread_id = $1`,
        [threadId],
      )
      const row = res.rows[0]
      return row ? rowToThread(row) : null
    },

    // A8: sets the identified label + band on a SEPARATE column — NEVER overwrites `title` (the auto-title).
    async applyReveal(threadId, r) {
      await db.query(`UPDATE threads SET reveal_title = $2, band = $3 WHERE thread_id = $1`, [threadId, r.revealTitle, r.band])
    },

    async markPhoto(threadId, mime) {
      await db.query(`UPDATE threads SET photo_mime = $2 WHERE thread_id = $1`, [threadId, mime])
    },
  }

  const photos: PhotoStore = {
    async put(rec) {
      await db.query(
        `INSERT INTO thread_photos (thread_id, owner_user_id, mime, bytes, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (thread_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
        [rec.threadId, rec.ownerUserId, rec.mime, rec.bytes, Date.now()],
      )
    },
    async get(threadId) {
      const res = await db.query<{ owner_user_id: string; mime: string; bytes: Uint8Array }>(
        `SELECT owner_user_id, mime, bytes FROM thread_photos WHERE thread_id = $1`,
        [threadId],
      )
      const row = res.rows[0]
      // bytea comes back as a byte-equal Uint8Array (verified A16); no decoding needed.
      return row ? { ownerUserId: row.owner_user_id, mime: row.mime, bytes: row.bytes } : null
    },
    async has(threadId) {
      const res = await db.query<{ one: number }>(`SELECT 1 AS one FROM thread_photos WHERE thread_id = $1`, [threadId])
      return res.rows.length > 0
    },
  }

  const reveals: RevealStore = {
    async put(rec) {
      // First successful drain wins (A12 gates the CALLER on startIndex===0). RETURNING tells us if we wrote.
      const res = await db.query<{ thread_id: string }>(
        `INSERT INTO reveals (thread_id, owner_user_id, band, title, candidates, events, narration, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (thread_id) DO NOTHING
         RETURNING thread_id`,
        [
          rec.threadId,
          rec.ownerUserId,
          rec.band,
          rec.title,
          JSON.stringify(rec.candidates ?? []),
          JSON.stringify(rec.events ?? []),
          rec.narration,
          rec.createdAt,
        ],
      )
      return { inserted: res.rows.length > 0 }
    },
    async get(threadId) {
      const res = await db.query<{
        thread_id: string
        owner_user_id: string
        band: string
        title: string
        candidates: unknown
        events: unknown
        narration: string | null
      }>(
        `SELECT thread_id, owner_user_id, band, title, candidates, events, narration FROM reveals WHERE thread_id = $1`,
        [threadId],
      )
      const row = res.rows[0]
      if (!row) return null
      // A16: jsonb comes back already parsed — do NOT JSON.parse.
      return {
        threadId: row.thread_id,
        ownerUserId: row.owner_user_id,
        band: row.band as RevealRecord['band'],
        title: row.title,
        candidates: (row.candidates as string[]) ?? [],
        events: (row.events as StreamEvent[]) ?? [],
        narration: row.narration ?? '',
        createdAt: 0,
      }
    },
  }

  const podcasts: PodcastAssetStore = {
    async upsert(rec) {
      await db.query(
        `INSERT INTO podcast_assets (token, user_id, catalog_item_id, version, status, audio_url, transcript, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (token) DO UPDATE SET
           status     = EXCLUDED.status,
           audio_url  = EXCLUDED.audio_url,
           transcript = EXCLUDED.transcript,
           updated_at = EXCLUDED.updated_at`,
        [
          rec.token,
          rec.userId,
          rec.catalogItemId,
          rec.version,
          rec.status,
          rec.audioUrl ?? null,
          rec.transcript ? JSON.stringify(rec.transcript) : null,
          Date.now(),
        ],
      )
    },
    async getByToken(token, userId) {
      const res = await db.query<PodcastRow>(
        `SELECT token, user_id, catalog_item_id, version, status, audio_url, transcript FROM podcast_assets WHERE token = $1 AND user_id = $2`,
        [token, userId],
      )
      return res.rows[0] ? rowToPodcast(res.rows[0]) : null
    },
    async getByItem(catalogItemId, version, userId) {
      const res = await db.query<PodcastRow>(
        `SELECT token, user_id, catalog_item_id, version, status, audio_url, transcript
         FROM podcast_assets WHERE catalog_item_id = $1 AND version = $2 AND user_id = $3`,
        [catalogItemId, version, userId],
      )
      return res.rows[0] ? rowToPodcast(res.rows[0]) : null
    },
  }

  const messages: MessageStore = {
    async append(rec) {
      const id = randomUUID()
      const clientKey = rec.clientKey ?? null
      // A6: the ON CONFLICT arbiter MUST repeat the partial index predicate, else PGlite throws on every append.
      const res = await db.query<{ id: string }>(
        `INSERT INTO messages (id, thread_id, user_id, role, text, source, client_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (thread_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [id, rec.threadId, rec.userId, rec.role, rec.text, rec.source ?? 'text', clientKey, Date.now()],
      )
      // A11: DO NOTHING returns no row on a duplicate; recover the canonical id via a follow-up SELECT.
      if (res.rows.length > 0) return { id, duplicate: false }
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM messages WHERE thread_id = $1 AND client_key = $2`,
        [rec.threadId, clientKey],
      )
      return { id: existing.rows[0]?.id ?? id, duplicate: true }
    },
    async listByThread(threadId) {
      const res = await db.query<MessageRow>(
        `SELECT id, thread_id, user_id, role, text, source, client_key, created_at
         FROM messages WHERE thread_id = $1 ORDER BY seq`,
        [threadId],
      )
      return res.rows.map(rowToMessage)
    },
  }

  const refunds: RefundStore = {
    async markRefunded(threadId) {
      const res = await db.query<{ thread_id: string }>(
        `INSERT INTO refunds (thread_id, created_at) VALUES ($1, $2) ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id`,
        [threadId, Date.now()],
      )
      return res.rows.length > 0 // true only the FIRST time → the caller proceeds with the credit
    },
  }

  return {
    store,
    threads,
    photos,
    reveals,
    podcasts,
    messages,
    refunds,
    async purgeUser(userId) {
      // Refunds are keyed only by thread_id → delete them via the owning threads BEFORE the threads go.
      await db.query(`DELETE FROM refunds WHERE thread_id IN (SELECT thread_id FROM threads WHERE owner_user_id = $1)`, [userId])
      const ph = await db.query(`DELETE FROM thread_photos WHERE owner_user_id = $1`, [userId])
      const rv = await db.query(`DELETE FROM reveals WHERE owner_user_id = $1`, [userId])
      const pc = await db.query(`DELETE FROM podcast_assets WHERE user_id = $1`, [userId])
      const ms = await db.query(`DELETE FROM messages WHERE user_id = $1`, [userId])
      const t = await db.query(`DELETE FROM threads WHERE owner_user_id = $1`, [userId])
      // starts_with (not LIKE) so an underscore in a Clerk userId isn't treated as a wildcard. Token keys are
      // `${userId}:${catalogItemId}:v${version}` (metering.genKey), so the `${userId}:` prefix is exact.
      const tk = await db.query(`DELETE FROM gen_tokens WHERE starts_with(key, $1)`, [userId + ':'])
      const e = await db.query(`DELETE FROM entitlements WHERE user_id = $1`, [userId])
      return {
        threads: t.affectedRows ?? 0,
        tokens: tk.affectedRows ?? 0,
        entitlements: e.affectedRows ?? 0,
        photos: ph.affectedRows ?? 0,
        reveals: rv.affectedRows ?? 0,
        podcasts: pc.affectedRows ?? 0,
        messages: ms.affectedRows ?? 0,
      }
    },
    async close() {
      await db.close()
    },
  }
}

/** Local/dev: a file-backed PGlite at `dataDir` (durable across restarts). Cloud Run uses createCloudSqlStores. */
export async function createPgStores(dataDir: string): Promise<PgStores> {
  return buildPgStores(await PGlite.create(dataDir))
}

interface ThreadRow {
  thread_id: string
  owner_user_id: string
  title: string
  created_at: string | number
  continuation_token: string
  band: string | null
  reveal_title: string | null
  photo_mime: string | null
}

/** bigint columns come back as JS numbers in this PGlite version (verified A16); the string branch is defensive. */
function rowToThread(row: ThreadRow): ThreadRecord {
  return {
    threadId: row.thread_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    createdAt: typeof row.created_at === 'string' ? Number(row.created_at) : row.created_at,
    continuationToken: row.continuation_token,
    band: row.band,
    revealTitle: row.reveal_title,
    photoMime: row.photo_mime,
  }
}

interface PodcastRow {
  token: string
  user_id: string
  catalog_item_id: string
  version: number
  status: string
  audio_url: string | null
  transcript: unknown
}
function rowToPodcast(row: PodcastRow): PodcastAssetRecord {
  return {
    token: row.token,
    userId: row.user_id,
    catalogItemId: row.catalog_item_id,
    version: row.version,
    status: row.status as PodcastAssetRecord['status'],
    audioUrl: row.audio_url,
    transcript: (row.transcript as PodcastAssetRecord['transcript']) ?? null,
    createdAt: 0,
    updatedAt: 0,
  }
}

interface MessageRow {
  id: string
  thread_id: string
  user_id: string
  role: string
  text: string
  source: string
  client_key: string | null
  created_at: string | number
}
function rowToMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    userId: row.user_id,
    role: row.role as 'user' | 'guide',
    text: row.text,
    source: row.source as 'text' | 'voice',
    clientKey: row.client_key,
    createdAt: typeof row.created_at === 'string' ? Number(row.created_at) : row.created_at,
  }
}
