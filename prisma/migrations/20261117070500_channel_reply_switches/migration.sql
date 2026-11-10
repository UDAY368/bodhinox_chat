-- Instagram Phase 1 (Stage 2): separate Instagram switches for the AI
-- auto-reply and the away message.
--
-- The existing ai_configs.auto_reply_enabled and
-- workspace_inbox_settings.away_message_enabled stay the WhatsApp switches,
-- unchanged. The Instagram switches default to off (constant default: no table
-- rewrite), so no workspace starts replying on Instagram until an admin turns
-- it on. The Instagram away message reuses away_message, so turning it on
-- needs that text, as the WhatsApp switch does (check NOT VALID, validated by
-- 20261117070700_instagram_phase1_validate). Grants are table-level and RLS is
-- unchanged (admins write both tables). Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_configs ADD COLUMN instagram_auto_reply_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_inbox_settings ADD COLUMN instagram_away_message_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_inbox_settings ADD CONSTRAINT workspace_inbox_settings_instagram_away_check
  CHECK (NOT instagram_away_message_enabled OR char_length(btrim(COALESCE(away_message, ''))) > 0) NOT VALID;
