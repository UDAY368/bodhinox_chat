-- Batch 5: the hourly retention sweep (src/lib/jobs/data-retention.ts) deletes each
-- workspace's send records in a final state ('accepted', 'failed') older than 30 days, a
-- batch at a time. This partial index finds them without walking the workspace's recent
-- and uncertain ('dispatching', 'unknown') sends.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- outbound_intents_final_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261205002000_outbound_intents_final_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY outbound_intents_final_idx
  ON outbound_intents (account_id, updated_at) WHERE status IN ('accepted', 'failed');
