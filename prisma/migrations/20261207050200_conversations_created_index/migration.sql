-- Batch 7: conversations opened per day (daily rollup and the live today figures) read one workspace's
-- rows for a time range through this index instead of every row of the workspace.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- conversations_account_created_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207050200_conversations_created_index)
-- before re-running.
CREATE INDEX CONCURRENTLY conversations_account_created_idx
  ON conversations (account_id, created_at);
