-- Phase 13: validate the two CHECKs 20261111100500_ai_usage_modes re-added
-- NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE, so usage
-- logging and counters keep writing during the scan. Every existing row
-- already satisfies the wider lists. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE ai_usage_log VALIDATE CONSTRAINT ai_usage_log_mode_check;
ALTER TABLE usage_counters VALIDATE CONSTRAINT usage_counters_metric_check;
