-- Phase 15: crm_ops_health().unknown_intents runs every 60 s (worker alert hook) and on
-- each deep health check under a 2 s statement timeout. outbound_intents is never pruned,
-- so without this partial index the count scans the whole table. The predicate
-- matches the function's filter, so the planner uses it with no function change.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- outbound_intents_unknown_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261113090500_outbound_intents_unknown_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY outbound_intents_unknown_idx
  ON outbound_intents (status) WHERE status = 'unknown';
