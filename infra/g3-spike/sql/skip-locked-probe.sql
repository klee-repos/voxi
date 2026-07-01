-- C2 probe — detect double-processed workflow steps under >=2 concurrent pollers (PLAN.md §4.4).
--
-- The @workflow/world-postgres durable world is advanced by a graphile-worker poller using
-- SELECT ... FOR UPDATE SKIP LOCKED to lease the next runnable step. With >=2 pollers, correctness means:
-- every step row is leased by AT MOST ONE poller at a time, and is marked completed EXACTLY ONCE.
--
-- Table/column names below are PLACEHOLDERS for the world-postgres schema and MUST be reconciled against the
-- actual installed schema at the pinned version (record the real names in out/result.json). graphile-worker's
-- own jobs table is `graphile_worker.jobs` (locked_by / locked_at / attempts); the workflow run/step tables
-- are layered on top. This file is the *shape* of the assertion, to be bound to real columns during the run.

\echo '== 1. steps currently leased by more than one live poller (must be EMPTY) =='
SELECT step_id, count(DISTINCT locked_by) AS distinct_holders
FROM   workflow_step_lease          -- PLACEHOLDER: world-postgres step-lease/locking relation
WHERE  locked_by IS NOT NULL
  AND  locked_at > now() - interval '1 minute'   -- only currently-held leases
GROUP  BY step_id
HAVING count(DISTINCT locked_by) > 1;            -- any row here == SKIP LOCKED violated == C2 FAIL

\echo '== 2. steps marked completed more than once (double execution; must be EMPTY) =='
SELECT step_id, count(*) AS completions
FROM   workflow_step_completion     -- PLACEHOLDER: per-step completion/append-only log
GROUP  BY step_id
HAVING count(*) > 1;                              -- any row here == a step ran twice == C2 FAIL

\echo '== 3. graphile-worker job lock sanity (no job locked by two workers) =='
SELECT id, locked_by, attempts
FROM   graphile_worker.jobs
WHERE  locked_by IS NOT NULL
  AND  locked_at < now() - interval '5 minutes'; -- stale locks => a poller died holding a lease (feeds C1)

\echo '== 4. exactly-once side-effect ledger cross-check (idempotency keys, §4.6) =='
-- Side-effecting tools (enqueue_podcast / embed_image / catalog_upsert) write an idempotency key once.
-- Duplicate keys here would mean a checkpoint replay re-ran a side effect => C1/C2 FAIL.
SELECT idempotency_key, count(*) AS n
FROM   app.tool_side_effect_log     -- PLACEHOLDER: the BFF/agent idempotency ledger (services own the DDL)
GROUP  BY idempotency_key
HAVING count(*) > 1;
