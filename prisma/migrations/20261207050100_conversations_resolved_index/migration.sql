-- Batch 7: conversations resolved per day (daily rollup, AI handled, resolution reports) read one workspace's
-- rows for a time range through this index instead of every row of the workspace.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- conversations_account_resolved_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207050100_conversations_resolved_index)
-- before re-running.
CREATE INDEX CONCURRENTLY conversations_account_resolved_idx
  ON conversations (account_id, resolved_at) WHERE resolved_at IS NOT NULL;
