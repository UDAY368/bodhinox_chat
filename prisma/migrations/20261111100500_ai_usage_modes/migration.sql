-- Phase 13: usage accounting for the AI business assistant.
--
-- ai_usage_log.mode gains the four assistant features. usage_counters gains
-- the 'ai_tokens' metric (every provider call adds its total tokens). Both
-- CHECKs are re-added NOT VALID, so only new rows are checked at once and no
-- table scan runs under the ACCESS EXCLUSIVE lock; the next migration
-- validates them under a weaker lock (same pattern as
-- 20261109101400_conversation_channel_validate). The old values stay allowed.
--
-- The plan limit ai_tokens_monthly is seeded UNLIMITED (JSON null) on every
-- plan until an operator sets real values, so no workspace is refused at
-- deploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply','draft','summary','suggest','assess','insights')) NOT VALID;

ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_metric_check;
ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('ai_messages','monthly_active_contacts','storage_bytes','ai_tokens')) NOT VALID;

UPDATE plans SET limits = limits || '{"ai_tokens_monthly":null}'::jsonb
  WHERE id IN ('free','basic','pro','enterprise');
