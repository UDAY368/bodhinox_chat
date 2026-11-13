-- Validates the widened ai_usage_log mode CHECK added NOT VALID by
-- 20261114006100_ai_assistant_features (a SHARE UPDATE EXCLUSIVE lock, so
-- inserts keep flowing while existing rows are checked).
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_log VALIDATE CONSTRAINT ai_usage_log_mode_check;
