-- Phase 15: crm_ops_health().unprocessed_webhooks_15m runs every 60 s (worker alert hook) and on
-- each deep health check under a 2 s statement timeout. webhook_receipts is never pruned,
-- so without this partial index the count scans the whole table. The predicate
-- matches the function's filter, so the planner uses it with no function change.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- webhook_receipts_unprocessed_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261113090600_webhook_receipts_unprocessed_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY webhook_receipts_unprocessed_idx
  ON webhook_receipts (created_at) WHERE status <> 'processed';
