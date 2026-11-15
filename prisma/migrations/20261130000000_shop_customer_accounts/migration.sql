SET LOCAL lock_timeout = '5s';

-- Store plan Phase 5: customer accounts on the public shop (/s/<handle>/account). Additive.
-- shop_otp_challenges.purpose: 'checkout' (the cart's code, as before) or
-- 'sign_in' (the account page's code). Each verify reads only its own purpose,
-- so a sign-in code never opens checkout and a checkout code never signs in.
-- A sign-in challenge has no cart, so the cart check allows an empty array for it.
-- shop_customer_sessions: a signed-in buyer on one shop. Only sha256 of the
-- cookie token is stored. 30 days; sign-out sets revoked_at.
-- shop_customer_addresses: a buyer's saved addresses (at most 5 per contact,
-- enforced by the server), the same fixed fields as the checkout address.
-- Both tables are read and written only by the worker (the public pages).

ALTER TABLE shop_otp_challenges
  ADD COLUMN purpose text NOT NULL DEFAULT 'checkout' CHECK (purpose IN ('checkout','sign_in'));
ALTER TABLE shop_otp_challenges DROP CONSTRAINT shop_otp_challenges_cart_check; -- additive-exception: replaced at once by a looser check below (sign-in codes have no cart); shop_otp_challenges holds only short-lived rows
ALTER TABLE shop_otp_challenges ADD CONSTRAINT shop_otp_challenges_cart_check
  CHECK (jsonb_typeof(cart) = 'array' AND jsonb_array_length(cart) <= 50 AND pg_column_size(cart) <= 16384
    AND (jsonb_array_length(cart) >= 1 OR purpose = 'sign_in'));  -- additive-exception: shop_otp_challenges holds only short-lived code rows, so the check scan is instant

CREATE TABLE shop_customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_customer_sessions_contact_idx ON shop_customer_sessions (account_id, contact_id);

CREATE TABLE shop_customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9]{6,15}$'),
  line1 text NOT NULL CHECK (char_length(line1) BETWEEN 1 AND 200),
  line2 text CHECK (line2 IS NULL OR char_length(line2) BETWEEN 1 AND 200),
  city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  state text CHECK (state IS NULL OR char_length(state) BETWEEN 1 AND 100),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9A-Z]{2}$'),
  postal_code text NOT NULL CHECK (postal_code ~ '^[0-9A-Z][0-9A-Z -]{1,10}$'),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  instructions text CHECK (instructions IS NULL OR char_length(instructions) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_customer_addresses_contact_idx ON shop_customer_addresses (account_id, contact_id, created_at);

-- ================================================================ RLS
ALTER TABLE shop_customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_customer_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_write ON shop_customer_sessions FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT ON shop_customer_sessions TO bodhinox_worker;
GRANT UPDATE (last_seen_at, revoked_at) ON shop_customer_sessions TO bodhinox_worker;

ALTER TABLE shop_customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_customer_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_write ON shop_customer_addresses FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT, DELETE ON shop_customer_addresses TO bodhinox_worker;
GRANT UPDATE (name, phone, line1, line2, city, state, state_code, postal_code, country, instructions, updated_at)
  ON shop_customer_addresses TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_customer_addresses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
