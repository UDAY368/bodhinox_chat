-- Instagram Phase 1 (Stage 2): conversation starters (ice breakers) per
-- Instagram account.
--
--   ice_breakers       the starters Bodhinox last synced to Meta's
--                      messenger_profile: [{ "question": text, "flow_id": uuid }],
--                      at most 4. Null: Bodhinox has never set them, so it
--                      must not overwrite starters set elsewhere.
--   profile_synced_at  when they were last written to Meta.
-- Writes run as the worker inside withTenant (the app role has no write grant
-- on instagram_accounts). The app role reads through column grants because the
-- token column is hidden from it (20261109100000_instagram_accounts); these two
-- columns are not secret and are added to that grant. RLS is unchanged. The
-- shape check is NOT VALID (every row is null) and validated by
-- 20261117070700_instagram_phase1_validate. Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_accounts ADD COLUMN ice_breakers jsonb;
ALTER TABLE instagram_accounts ADD COLUMN profile_synced_at timestamptz;
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_ice_breakers_check
  CHECK (ice_breakers IS NULL OR (jsonb_typeof(ice_breakers) = 'array' AND jsonb_array_length(ice_breakers) <= 4
    AND pg_column_size(ice_breakers) <= 4096)) NOT VALID;
GRANT SELECT (ice_breakers, profile_synced_at) ON instagram_accounts TO bodhinox_app;
