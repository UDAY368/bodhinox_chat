-- Instagram Phase 3 (Stage 4): how an Instagram account was connected.
--
--   connection_kind   'instagram_login' (today's connection: Instagram API with
--                     Instagram Login, graph.instagram.com, an Instagram User
--                     token) or 'facebook_page' (optional Facebook Page / Business
--                     Login for agencies, ads and Conversions API: the token in
--                     access_token_enc is then the Page access token and calls go
--                     to graph.facebook.com). Existing rows are instagram_login.
--   facebook_page_id  the Page an account is reached through; required for
--                     facebook_page and null for instagram_login.
-- Neither column is secret; both join the app role's column grant (the token
-- column stays hidden from it). The worker's table grant already covers writes.
-- RLS is unchanged. The checks are NOT VALID (the constant default satisfies
-- them for every existing row) and validated by
-- 20261117190500_instagram_phase3_validate. Additive: a constant default adds
-- the column without a table rewrite.
SET LOCAL lock_timeout = '5s';

ALTER TABLE instagram_accounts ADD COLUMN connection_kind text NOT NULL DEFAULT 'instagram_login';
ALTER TABLE instagram_accounts ADD COLUMN facebook_page_id text;
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_connection_kind_check
  CHECK (connection_kind IN ('instagram_login','facebook_page')) NOT VALID;
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_facebook_page_check
  CHECK ((connection_kind = 'facebook_page' AND COALESCE(facebook_page_id ~ '^\d{1,32}$', false))
    OR (connection_kind = 'instagram_login' AND facebook_page_id IS NULL)) NOT VALID;
GRANT SELECT (connection_kind, facebook_page_id) ON instagram_accounts TO bodhinox_app;
