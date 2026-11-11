-- Channel separation (Stage 1): the automation engine looks up active
-- automations by workspace, channel and trigger.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- idx_automations_account_channel_active_trigger) and mark the migration rolled
-- back (prisma migrate resolve --rolled-back
-- 20261117010300_automations_account_channel_idx) before re-running.
CREATE INDEX CONCURRENTLY idx_automations_account_channel_active_trigger
  ON automations (account_id, channel, trigger_type) WHERE is_active;
