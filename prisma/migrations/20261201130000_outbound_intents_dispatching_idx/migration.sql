-- Batch 1: crm_ops_stuck_dispatching() (next migration) counts sends left in 'dispatching'
-- for more than 10 minutes, every 60 s from the worker alert hook and on each deep health
-- check. outbound_intents is never pruned, so this partial index keeps that count small.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- outbound_intents_dispatching_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261201130000_outbound_intents_dispatching_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY outbound_intents_dispatching_idx
  ON outbound_intents (updated_at) WHERE status = 'dispatching';
