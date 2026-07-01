-- 0001_init.sql — the REAL production DDL for Voxi (PLAN §5.3, §7.2/§7.4, §11, §13, §15).
--
-- ONE Postgres database (Cloud SQL / AlloyDB, var.db_name) holds BOTH:
--   * schema `app`      — the catalog, threads, entitlements, moderation, interviews, messages/turns
--                         (owned by the BFF's db user, voxi_app);
--   * schema `workflow` — the eve durable-agent world (@workflow/world-postgres: graphile-worker +
--                         LISTEN/NOTIFY). eve's own `workflow-postgres-setup` migrates the internals of
--                         `workflow`; here we only CREATE the schema + grant it so eve can populate it.
--
-- Everything here is idempotent (IF NOT EXISTS / DO-guards) so the runner can re-apply safely and a
-- re-deploy is a no-op. The `vector(1408)` columns + HNSW indexes are the real pgvector definitions the
-- code (packages/db/catalog.ts) and terraform (infra/terraform/cloudsql.tf) reference.
--
-- Embedding dim 1408 = Vertex multimodalembedding@001 (D8). The catalog column is the production
-- `vector(1408)`; catalog.ts runs the identical ACL/partition SQL on PGlite with `double precision[]`,
-- swapping only the distance operator (`<=>`) — see that file's header.

-- ============================================================================================
-- Extensions + schemas
-- ============================================================================================

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: vector(1408) columns + HNSW indexes
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid() for surrogate ids

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS workflow;       -- eve's @workflow/world-postgres world lives here (it migrates its own internals)

SET search_path = app, public;

-- ============================================================================================
-- app.catalog_items — the crowd-sourced catalog of specific objects (PLAN §5.3, §7.4, §11).
--
-- The security-critical invariant is the VISIBILITY ACL, enforced in SQL on every read: a user may see
-- `global` entries OR their own `private` entries; `pending_global` is held for moderation and is NEVER
-- matchable/generation-eligible until promoted (§7.4). The §11 partition (global set vs per-user private
-- set, merged by distance) is preserved by the two partial HNSW indexes below.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.catalog_items (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text         NOT NULL,
  category        text         NOT NULL DEFAULT 'unknown',
  owner_user_id   text,                                   -- NULL for global; the private owner otherwise
  visibility      text         NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('global', 'pending_global', 'private')),
  -- Structured fields ONLY on a promoted global record (never private notes/transcripts, §7.4).
  structured      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  embedding       vector(1408),                           -- Vertex multimodalembedding@001 (D8)
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  -- A private entry MUST name its owner; a global/pending_global one must not (the ACL depends on it).
  CONSTRAINT catalog_private_has_owner
    CHECK ((visibility = 'private') = (owner_user_id IS NOT NULL))
);

-- The §11 partition, as two PARTIAL HNSW indexes (cosine). The global index is read by everyone; the
-- private index is read only for `owner_user_id = $me` — so a private-set ANN never scans other users'
-- rows. This is the pgvector analogue of catalog.ts's searchPartitioned().
CREATE INDEX IF NOT EXISTS catalog_hnsw_global
  ON app.catalog_items USING hnsw (embedding vector_cosine_ops)
  WHERE visibility = 'global';

CREATE INDEX IF NOT EXISTS catalog_hnsw_private
  ON app.catalog_items USING hnsw (embedding vector_cosine_ops)
  WHERE visibility = 'private';

-- Owner-scoped btree for the private-set pre-filter + the /me collection reads.
CREATE INDEX IF NOT EXISTS catalog_private_owner
  ON app.catalog_items (owner_user_id)
  WHERE visibility = 'private';

CREATE INDEX IF NOT EXISTS catalog_category
  ON app.catalog_items (category);

-- ============================================================================================
-- app.threads — 1 photo = 1 durable eve session = 1 thread row (PLAN §4.3, §6.4).
--
-- Persists {eve_session_id, continuation_token} so revisiting resumes the SAME durable session. owner_user_id
-- is the ACL key; the BFF + the eve channel both enforce it (defence in depth). This is the persistent
-- backing for the SessionOwnership store in services/eve-agent/agent/channels/eve.ts.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.threads (
  thread_id           text         PRIMARY KEY,           -- == the eve session id (the BFF uses sessionId as threadId)
  owner_user_id       text         NOT NULL,
  title               text         NOT NULL DEFAULT 'Untitled capture',
  photo_url           text,
  eve_session_id      text         NOT NULL,
  continuation_token  text         NOT NULL,
  catalog_item_id     uuid         REFERENCES app.catalog_items (id) ON DELETE SET NULL,
  created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS threads_owner_created
  ON app.threads (owner_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS threads_eve_session
  ON app.threads (eve_session_id);

-- ============================================================================================
-- app.entitlements + app.gen_tokens — metering + idempotent paid generation (PLAN §13).
--
-- The atomic contract (services/voxi-api/src/metering.ts): tryDecrement is a single row-atomic
-- `UPDATE … WHERE meter >= n RETURNING`. gen_tokens makes a paid podcast render idempotent (a retry/double-tap
-- collapses to the same token) — the compare-and-set the BFF podcast route depends on.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.entitlements (
  user_id     text         PRIMARY KEY,
  plan        text         NOT NULL DEFAULT 'free'
              CHECK (plan IN ('free', 'explorer', 'voyager')),
  scan        integer      NOT NULL DEFAULT 0 CHECK (scan >= 0),
  podcast     integer      NOT NULL DEFAULT 0 CHECK (podcast >= 0),
  voice_min   integer      NOT NULL DEFAULT 0 CHECK (voice_min >= 0),
  -- StoreKit 2 server-verified entitlement window (§13; direct, no billing vendor).
  expires_at  timestamptz,
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.gen_tokens (
  -- CAS key: (user_id, catalog_item_id, version) — one paid render per (item,version) per user.
  key             text         PRIMARY KEY,
  user_id         text         NOT NULL,
  catalog_item_id text         NOT NULL,
  version         integer      NOT NULL DEFAULT 1,
  token           text         NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gen_tokens_user ON app.gen_tokens (user_id);

-- ============================================================================================
-- app.podcast_assets — async render status with a compare-and-set state machine (PLAN §6.2/D7).
--
-- The worker is idempotent: it advances status queued → composing → ready|failed under a CAS on `status`
-- (the CHECK + the partial unique index below make double-delivery safe). audio_url/transcript are only set
-- on `ready`. Honesty/defamation-gated upstream (voxi-podcast-worker); this table is the durable record.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.podcast_assets (
  token           text         PRIMARY KEY,               -- the gen_tokens.token that gated this render
  user_id         text         NOT NULL,
  catalog_item_id text         NOT NULL,
  version         integer      NOT NULL DEFAULT 1,
  status          text         NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'composing', 'ready', 'failed')),
  audio_url       text,                                   -- set only on 'ready' (HLS master)
  transcript      jsonb,                                  -- [{speaker: 'ARLO'|'MAVE', text}] set only on 'ready'
  attempts        integer      NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  -- A 'ready' asset must carry its audio; a non-ready one must not (fail-closed against a fabricated "ready").
  CONSTRAINT podcast_ready_has_audio
    CHECK ((status <> 'ready') OR (audio_url IS NOT NULL))
);

-- One cached render per (catalog_item, version) — the pod-01/pod-03 cache key (§6.2).
CREATE UNIQUE INDEX IF NOT EXISTS podcast_item_version
  ON app.podcast_assets (catalog_item_id, version);

-- ============================================================================================
-- app.tips + app.reports — crowd contributions + moderation (PLAN §7 kb-03/kb-04).
--
-- A tip's disposition is driven by the SERVER-side trust level: TL0 → pending_review; TL2+ → live. A report
-- auto-hides its target on the FIRST report pending SLA review (kb-04) — the partial unique index enforces
-- "first report wins" idempotently.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.tips (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text         NOT NULL,
  catalog_item_id uuid         NOT NULL REFERENCES app.catalog_items (id) ON DELETE CASCADE,
  text            text         NOT NULL,
  trust_level     integer      NOT NULL DEFAULT 0,
  status          text         NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review', 'live', 'hidden', 'rejected')),
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tips_item        ON app.tips (catalog_item_id);
CREATE INDEX IF NOT EXISTS tips_user        ON app.tips (user_id);
CREATE INDEX IF NOT EXISTS tips_status_live ON app.tips (catalog_item_id) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS app.reports (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  text         NOT NULL,
  target_id    text         NOT NULL,                     -- a tip id or an episode/asset id
  kind         text         NOT NULL CHECK (kind IN ('tip', 'episode')),
  resolved     boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- First report per target auto-hides it; the unique index makes that idempotent (a duplicate report no-ops).
CREATE UNIQUE INDEX IF NOT EXISTS reports_first_per_target
  ON app.reports (target_id, kind);

-- ============================================================================================
-- app.interviews + app.interview_answers — "first witness" of an unknown item (PLAN §7 kb-02).
--
-- Opening an interview creates a catalog candidate; visibility DEFAULTS to private. A global exemplar needs
-- an explicit toggle + consent. Answers (skip = NULL) feed the structured fields a promotion can mint from.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.interviews (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text         NOT NULL,
  thread_id       text         REFERENCES app.threads (thread_id) ON DELETE CASCADE,
  catalog_item_id uuid         REFERENCES app.catalog_items (id) ON DELETE SET NULL,
  visibility      text         NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('private', 'global')),
  status          text         NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'done', 'abandoned')),
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interviews_user   ON app.interviews (user_id);
CREATE INDEX IF NOT EXISTS interviews_thread ON app.interviews (thread_id);

CREATE TABLE IF NOT EXISTS app.interview_answers (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid         NOT NULL REFERENCES app.interviews (id) ON DELETE CASCADE,
  question_id  text         NOT NULL,
  prompt       text         NOT NULL,
  answer       text,                                       -- NULL = skipped
  created_at   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (interview_id, question_id)
);

-- ============================================================================================
-- app.messages + app.turns — durable conversation history for a thread (PLAN §4.3, §6.3).
--
-- messages = the voice/text conversation (user + Guide replies); turns = the identification/narration turns
-- the eve stream produced (the durable projection of the NDJSON events, for replay + audit). The voice-bot is
-- the single idempotent writer of transcripts back (per-turn UNIQUE guards double-writes).
-- ============================================================================================

CREATE TABLE IF NOT EXISTS app.messages (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    text         NOT NULL REFERENCES app.threads (thread_id) ON DELETE CASCADE,
  user_id      text         NOT NULL,
  role         text         NOT NULL CHECK (role IN ('user', 'guide')),
  text         text         NOT NULL,
  source       text         NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice')),
  -- Idempotency key from the single writer (the voice-bot) so a retried transcript write does not duplicate.
  client_key   text,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_thread ON app.messages (thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_key
  ON app.messages (thread_id, client_key) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.turns (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    text         NOT NULL REFERENCES app.threads (thread_id) ON DELETE CASCADE,
  turn_index   integer      NOT NULL,                      -- monotonic per thread (the stream event index base)
  confidence_band text      CHECK (confidence_band IN ('CONFIDENT', 'PROBABLE', 'UNKNOWN')),
  label        text,
  events       jsonb        NOT NULL DEFAULT '[]'::jsonb,  -- the durable NDJSON events (events.ts taxonomy)
  created_at   timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (thread_id, turn_index)
);

CREATE INDEX IF NOT EXISTS turns_thread ON app.turns (thread_id, turn_index);

-- ============================================================================================
-- Grants — the eve db user owns workflow.*; the app db user owns app.*.
--
-- These run only when the roles exist (a local single-superuser dev cluster has neither, so they are
-- DO-guarded no-ops there). In Cloud SQL the roles are created by terraform (cloudsql.tf).
-- ============================================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxi_eve') THEN
    EXECUTE 'GRANT ALL ON SCHEMA workflow TO voxi_eve';
    EXECUTE 'GRANT USAGE ON SCHEMA app TO voxi_eve';       -- eve reads app.threads for ownership (read-only)
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voxi_app') THEN
    EXECUTE 'GRANT ALL ON SCHEMA app TO voxi_app';
    EXECUTE 'GRANT USAGE ON SCHEMA workflow TO voxi_app';  -- app reads workflow.* status (read-only)
  END IF;
END
$$;
