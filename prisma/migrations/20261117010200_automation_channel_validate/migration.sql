-- Channel separation (Stage 1): validate the CHECK that
-- 20261117010100_automation_channel added NOT VALID. VALIDATE CONSTRAINT holds
-- SHARE UPDATE EXCLUSIVE, so automation reads and writes continue during the
-- scan. Every existing row is 'whatsapp' (the column default). Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE automations VALIDATE CONSTRAINT automations_channel_check;
