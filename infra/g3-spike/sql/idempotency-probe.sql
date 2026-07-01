-- C1 probe — after a poller kill + resume, prove side effects ran EXACTLY ONCE (no duplicate-on-replay).
--
-- When a poller is killed mid-turn and a fresh poller resumes from the last durable checkpoint, any step that
-- had already produced a side effect must NOT re-fire it. eve tools enqueue_podcast / embed_image /
-- catalog_upsert are idempotent (§4.6) and write a single idempotency key per logical effect.
-- Placeholders to be bound to the real ledger (the services workflow owns the DDL).

\echo '== duplicate side-effects after resume (must be EMPTY for C1 PASS) =='
SELECT idempotency_key, tool_name, count(*) AS executions
FROM   app.tool_side_effect_log     -- PLACEHOLDER ledger
GROUP  BY idempotency_key, tool_name
HAVING count(*) > 1;

\echo '== the resumed session reached a terminal turn (one done per turn) =='
SELECT session_id, turn_index, count(*) FILTER (WHERE event = 'done') AS done_events
FROM   app.stream_event_log          -- PLACEHOLDER: NDJSON event mirror (token|tool_*|done, §4.3)
GROUP  BY session_id, turn_index
HAVING count(*) FILTER (WHERE event = 'done') <> 1;  -- 0 = never finished; >1 = double-finished
