-- Data retention: the hourly retention sweep deletes processed webhook receipts older
-- than 30 days in batches; this partial index serves that filter.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- webhook_receipts_processed_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261116100300_webhook_receipts_processed_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY webhook_receipts_processed_idx
  ON webhook_receipts (created_at) WHERE status = 'processed';
