-- Instagram Phase 1 (Stage 2): validate the checks and the foreign key that
-- 20261117070200 to 20261117070600 added NOT VALID. VALIDATE CONSTRAINT holds
-- SHARE UPDATE EXCLUSIVE (the foreign key also takes ROW SHARE on flow_runs),
-- so reads and writes continue during the scans. Every existing row holds a
-- null or the column default, which pass. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_comment_events VALIDATE CONSTRAINT instagram_comment_events_public_reply_id_check;
ALTER TABLE instagram_comment_events VALIDATE CONSTRAINT instagram_comment_events_flow_run_fkey;
ALTER TABLE contact_channel_identities VALIDATE CONSTRAINT contact_channel_identities_ig_follower_count_check;
ALTER TABLE instagram_accounts VALIDATE CONSTRAINT instagram_accounts_ice_breakers_check;
ALTER TABLE workspace_inbox_settings VALIDATE CONSTRAINT workspace_inbox_settings_instagram_away_check;
ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_channels_check;
