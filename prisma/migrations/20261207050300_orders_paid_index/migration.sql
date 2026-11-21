-- Batch 7: paid orders and revenue per day (daily rollup and the home revenue card) read one workspace's
-- rows for a time range through this index instead of every row of the workspace.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- orders_account_paid_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207050300_orders_paid_index)
-- before re-running.
CREATE INDEX CONCURRENTLY orders_account_paid_idx
  ON orders (account_id, paid_at) WHERE paid_at IS NOT NULL;
