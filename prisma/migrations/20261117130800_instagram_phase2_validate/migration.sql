-- Instagram Phase 2 (Stage 3): validate the checks that 20261117130200 to
-- 20261117130400 added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue during the scans. Every existing row
-- holds a null or the column default, which pass. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_accounts VALIDATE CONSTRAINT instagram_accounts_persistent_menu_check;
ALTER TABLE contact_channel_identities VALIDATE CONSTRAINT contact_channel_identities_last_ref_check;
ALTER TABLE ai_configs VALIDATE CONSTRAINT ai_configs_instagram_ai_comments_daily_cap_check;
