SET LOCAL lock_timeout = '5s';

-- Shop password hash moved out of reach of the app role (store plan Phase 8, fix to 20261201002000_selling_options).
-- shop_storefronts.access_password_hash was readable by bodhinox_app (table-level SELECT), and the app role must never
-- read a password hash. The hash now lives in shop_access_secrets: worker role only, forced RLS, no app grant.
-- Staff set the password through the worker connection after the admin check; visitors are checked by the worker.

CREATE TABLE shop_access_secrets (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep any password already set (copied before row security is switched on for the new table).
INSERT INTO shop_access_secrets (account_id, password_hash)
  SELECT account_id, access_password_hash FROM shop_storefronts WHERE access_password_hash IS NOT NULL;

ALTER TABLE shop_access_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_access_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_write ON shop_access_secrets FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT, UPDATE ON shop_access_secrets TO bodhinox_worker;

-- The old column goes, and with it the app role's UPDATE grant on it and the check that referenced it.
ALTER TABLE shop_storefronts DROP COLUMN access_password_hash; -- additive-exception: added in the unreleased Phase 8 migration 20261201002000, never read by a released build

-- Same check as before, minus the hash clause (password mode needs a hash row: enforced in shop-access.ts, and a shop in
-- password mode without one stays locked).
ALTER TABLE shop_storefronts ADD CONSTRAINT shop_storefronts_access_mode_check
  CHECK (access_mode IN ('open','password','coming_soon') AND (coming_soon_message IS NULL OR char_length(coming_soon_message) <= 500)) NOT VALID;
ALTER TABLE shop_storefronts VALIDATE CONSTRAINT shop_storefronts_access_mode_check;
