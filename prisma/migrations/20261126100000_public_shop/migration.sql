SET LOCAL lock_timeout = '5s';

-- Store plan Phase 1: a public shop per workspace at /s/<handle>. Additive.
-- shop_storefronts: one row per workspace. The handle is the public address
-- (globally unique); `theme` holds fixed brand settings (colors, a font
-- choice, logo and banner as https URLs or media library ids, short texts),
-- validated by the server; templates are our own React components, never
-- customer code. Admins write it through the app role; the public pages read
-- it through the worker after resolve_public_shop.
-- shop_otp_challenges: a WhatsApp one-time code a buyer asked for to place an
-- order from the public cart. Only an HMAC of the code is stored.
-- shop_cart_codes: an "Order on WhatsApp" cart, claimed when the buyer sends
-- "ORDER <CODE>" to the shop's number. Both lead to an ordinary
-- storefront_sessions row, so pricing, stock, coupons, COD and Razorpay are
-- unchanged. Both are written only by the worker.

CREATE TABLE shop_storefronts (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  published boolean NOT NULL DEFAULT false,
  template text NOT NULL DEFAULT 'wellness'
    CHECK (template IN ('wellness','fashion','beauty','food','grocery','electronics')),
  theme jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(theme) = 'object' AND pg_column_size(theme) <= 8192),
  -- The number buyers message ("Order on WhatsApp") and the one-time codes are sent from.
  whatsapp_config_id uuid,
  -- Digits only, shown in the wa.me link.
  whatsapp_phone text CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^[1-9][0-9]{7,14}$'),
  -- An approved authentication template on that number's WABA; null turns the code path off.
  otp_template_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id) ON DELETE SET NULL (whatsapp_config_id),
  FOREIGN KEY (account_id, otp_template_id) REFERENCES message_templates(account_id, id) ON DELETE SET NULL (otp_template_id)
);

CREATE TABLE shop_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  -- E.164 with the leading +.
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  cart jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'array' AND jsonb_array_length(cart) BETWEEN 1 AND 50
    AND pg_column_size(cart) <= 16384),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, session_id) REFERENCES storefront_sessions(account_id, id) ON DELETE SET NULL (session_id)
);
CREATE INDEX shop_otp_challenges_phone_idx ON shop_otp_challenges (account_id, phone, created_at DESC);

CREATE TABLE shop_cart_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  cart jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'array' AND jsonb_array_length(cart) BETWEEN 1 AND 50
    AND pg_column_size(cart) <= 16384),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  contact_id uuid,
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, code),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, session_id) REFERENCES storefront_sessions(account_id, id) ON DELETE SET NULL (session_id)
);
CREATE INDEX shop_cart_codes_expiry_idx ON shop_cart_codes (expires_at) WHERE claimed_at IS NULL;

-- ================================================================ RLS
ALTER TABLE shop_storefronts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_storefronts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_storefronts FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_storefronts FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON shop_storefronts TO bodhinox_worker;
GRANT SELECT, INSERT ON shop_storefronts TO bodhinox_app;
GRANT UPDATE (handle, published, template, theme, whatsapp_config_id, whatsapp_phone, otp_template_id, version, updated_at)
  ON shop_storefronts TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_storefronts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE shop_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_otp_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_write ON shop_otp_challenges FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT, UPDATE ON shop_otp_challenges TO bodhinox_worker;

ALTER TABLE shop_cart_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_cart_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_cart_codes FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON shop_cart_codes FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shop_cart_codes TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_cart_codes TO bodhinox_worker;

-- ================================================================ public lookup
-- The only cross-tenant lookup the public shop needs: a published handle to its workspace.
CREATE FUNCTION resolve_public_shop(p_handle text)
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM shop_storefronts s WHERE s.handle = p_handle AND s.published
$$;
REVOKE ALL ON FUNCTION resolve_public_shop(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_public_shop(text) TO bodhinox_worker;
-- FORCE RLS applies to the definer's owner too (pattern 20261107102500_commerce_wiring).
CREATE POLICY public_shop_migration_owner ON shop_storefronts FOR SELECT TO CURRENT_USER USING (true);
