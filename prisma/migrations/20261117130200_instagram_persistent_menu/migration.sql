-- Instagram Phase 2 (Stage 3): the persistent menu (Instagram › Menu) per
-- Instagram account.
--
--   persistent_menu            the menu Bodhinox last synced to Meta's
--                              messenger_profile: at most 20 items, each
--                              { "type": "postback", "title": text, "flow_id": uuid }
--                              or { "type": "web_url", "title": text, "url": https }.
--                              Null: Bodhinox has never set it, so it must not
--                              overwrite a menu set elsewhere.
--   persistent_menu_synced_at  when it was last written to Meta (the ice
--                              breakers keep profile_synced_at).
-- Writes run as the worker inside withTenant (the app role has no write grant
-- on instagram_accounts). The app role reads through column grants because the
-- token column is hidden from it (20261109100000_instagram_accounts); these two
-- columns are not secret and are added to that grant. RLS is unchanged. The
-- shape check is NOT VALID (every row is null) and validated by
-- 20261117130800_instagram_phase2_validate. Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_accounts ADD COLUMN persistent_menu jsonb;
ALTER TABLE instagram_accounts ADD COLUMN persistent_menu_synced_at timestamptz;
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_persistent_menu_check
  CHECK (persistent_menu IS NULL OR (jsonb_typeof(persistent_menu) = 'array' AND jsonb_array_length(persistent_menu) <= 20
    AND pg_column_size(persistent_menu) <= 16384)) NOT VALID;
GRANT SELECT (persistent_menu, persistent_menu_synced_at) ON instagram_accounts TO bodhinox_app;
