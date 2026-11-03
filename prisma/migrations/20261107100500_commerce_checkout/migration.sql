-- Phase 8: checkout. Shipping rates, coupons, storefront sessions (one
-- contact-bound secure link each), stock reservations, and the additive order
-- columns for server-priced orders. All additive: every redefined CHECK keeps
-- every existing value.
--
-- Server price is authoritative: once orders.priced_at is set, the order's
-- money columns and its line snapshots are frozen for every role. Only the
-- worker can move an order to paid, payment_review or expired (trigger
-- orders_status_guard), so a browser can never mark an order paid.

-- ================================================================ shipping
CREATE TABLE shipping_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  -- Empty = the whole country. Each prefix 1-6 upper-case letters or digits.
  postal_prefixes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(postal_prefixes) <= 200
    AND array_to_string(postal_prefixes, ',') ~ '^([0-9A-Z]{1,6}(,[0-9A-Z]{1,6})*)?$'),
  min_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0),
  max_subtotal_minor bigint CHECK (max_subtotal_minor IS NULL OR max_subtotal_minor >= min_subtotal_minor),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  -- NULL = use commerce_settings.default_tax_rate_bps.
  tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX shipping_rates_country_idx ON shipping_rates (account_id, country) WHERE active;

-- ================================================================ coupons
CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind text NOT NULL CHECK (kind IN ('percent','fixed')),
  -- percent: basis points 1..10000; fixed: minor units > 0.
  value bigint NOT NULL,
  min_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0),
  max_discount_minor bigint CHECK (max_discount_minor IS NULL OR max_discount_minor > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  per_contact_limit integer CHECK (per_contact_limit IS NULL OR per_contact_limit > 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, code),
  CHECK ((kind = 'percent' AND value BETWEEN 1 AND 10000) OR (kind = 'fixed' AND value > 0)),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

-- ================================================================ storefront sessions
-- A secure link bound to one contact. Only sha256(token) is stored; the token is
-- derived (HMAC of session id and epoch) so the server can rebuild the URL.
CREATE TABLE storefront_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_epoch integer NOT NULL DEFAULT 1 CHECK (token_epoch > 0),
  contact_id uuid NOT NULL,
  conversation_id uuid,
  whatsapp_config_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('shop','order','status')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  order_id uuid,
  -- [{"variant_id": "...", "qty": 1..99}], at most 50 lines.
  cart jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cart) = 'array' AND jsonb_array_length(cart) <= 50
    AND pg_column_size(cart) <= 16384),
  -- name, phone, line1, line2, city, state, state_code, postal_code, country, instructions.
  address jsonb CHECK (address IS NULL OR (jsonb_typeof(address) = 'object' AND pg_column_size(address) <= 2048)),
  coupon_code text CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9_-]{3,32}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id) ON DELETE SET NULL (whatsapp_config_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id)
);
CREATE UNIQUE INDEX storefront_sessions_order_key ON storefront_sessions (account_id, order_id)
  WHERE purpose <> 'status' AND order_id IS NOT NULL;
CREATE INDEX storefront_sessions_contact_idx ON storefront_sessions (account_id, contact_id) WHERE revoked_at IS NULL;

-- ================================================================ orders (additive)
ALTER TABLE orders
  ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  ADD COLUMN shipping_minor bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  ADD COLUMN tax_inclusive boolean,
  ADD COLUMN priced_at timestamptz,
  ADD COLUMN coupon_code text CHECK (coupon_code IS NULL OR coupon_code ~ '^[A-Z0-9_-]{3,32}$'),
  ADD COLUMN shipping_address jsonb CHECK (shipping_address IS NULL OR (jsonb_typeof(shipping_address) = 'object'
    AND pg_column_size(shipping_address) <= 2048)),
  ADD COLUMN storefront_session_id uuid,
  ADD COLUMN reservation_expires_at timestamptz,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN amount_paid_minor bigint NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  ADD COLUMN amount_refunded_minor bigint NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0),
  ADD COLUMN refund_state text NOT NULL DEFAULT 'none' CHECK (refund_state IN ('none','partial','full')),
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN fulfilment_recorded_by uuid,
  ADD COLUMN tracking_note text CHECK (tracking_note IS NULL OR char_length(tracking_note) <= 200),
  ADD COLUMN feedback_score smallint CHECK (feedback_score IS NULL OR feedback_score BETWEEN 1 AND 5),
  ADD COLUMN checkout_attempt integer NOT NULL DEFAULT 0 CHECK (checkout_attempt >= 0);

ALTER TABLE orders ADD CONSTRAINT orders_storefront_session_key UNIQUE (account_id, storefront_session_id);
ALTER TABLE orders ADD CONSTRAINT orders_storefront_session_fkey FOREIGN KEY (account_id, storefront_session_id)
  REFERENCES storefront_sessions(account_id, id) ON DELETE SET NULL (storefront_session_id);

-- Superset of 20261102110000_commerce.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('new','confirmed','awaiting_payment','payment_review','paid','dispatched','fulfilled','expired','cancelled'));
ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('whatsapp','shopify','woocommerce','manual','storefront'));

-- A priced order's total is exactly its parts (design E4).
ALTER TABLE orders ADD CONSTRAINT orders_priced_total_check CHECK (priced_at IS NULL OR (
  tax_inclusive IS NOT NULL AND total_minor IS NOT NULL AND discount_minor <= subtotal_minor AND
  total_minor = subtotal_minor - discount_minor + shipping_minor + CASE WHEN tax_inclusive THEN 0 ELSE tax_minor END));

CREATE INDEX orders_reservation_idx ON orders (account_id, reservation_expires_at) WHERE status = 'awaiting_payment';
-- Per-contact hold caps at place (a contact's open orders and held units).
CREATE INDEX orders_contact_open_idx ON orders (account_id, contact_id) WHERE status = 'awaiting_payment';
CREATE INDEX orders_status_idx ON orders (account_id, status, created_at DESC);

-- Agents also keep a tracking note; amounts stay worker-only.
GRANT UPDATE (tracking_note) ON orders TO bodhinox_app;

-- ================================================================ order lines (additive)
ALTER TABLE order_items
  ADD COLUMN variant_id uuid,
  ADD COLUMN submitted_unit_price_minor bigint CHECK (submitted_unit_price_minor IS NULL OR submitted_unit_price_minor >= 0),
  ADD COLUMN tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN tax_minor bigint CHECK (tax_minor IS NULL OR tax_minor >= 0),
  ADD COLUMN discount_minor bigint CHECK (discount_minor IS NULL OR discount_minor >= 0),
  ADD COLUMN line_total_minor bigint CHECK (line_total_minor IS NULL OR line_total_minor >= 0),
  ADD COLUMN hsn_code text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  ADD COLUMN sku text CHECK (sku IS NULL OR sku ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE order_items ADD CONSTRAINT order_items_variant_fkey FOREIGN KEY (account_id, variant_id)
  REFERENCES shop_variants(account_id, id) ON DELETE SET NULL (variant_id);
CREATE INDEX order_items_variant_idx ON order_items (account_id, variant_id) WHERE variant_id IS NOT NULL;

-- The worker reprices a WhatsApp cart's lines before the order is priced.
CREATE POLICY worker_update ON order_items FOR UPDATE TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT UPDATE ON order_items TO bodhinox_worker;

-- ================================================================ stock reservations
CREATE TABLE stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','committed','released')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, order_id, variant_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);
CREATE INDEX stock_reservations_held_idx ON stock_reservations (account_id, variant_id) WHERE status = 'held';

CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  coupon_id uuid NOT NULL,
  order_id uuid NOT NULL,
  contact_id uuid,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','committed','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, order_id),
  FOREIGN KEY (account_id, coupon_id) REFERENCES coupons(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (account_id, coupon_id, contact_id) WHERE status <> 'released';

-- ================================================================ RLS
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shipping_rates','coupons']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_worker', t);
  END LOOP;
  -- Written only by the worker inside services that checked role and permission.
  FOREACH t IN ARRAY ARRAY['storefront_sessions','stock_reservations','coupon_redemptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bodhinox_worker', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON shipping_rates TO bodhinox_app;
GRANT UPDATE (name, country, postal_prefixes, min_subtotal_minor, max_subtotal_minor, fee_minor, tax_rate_bps, active,
  position, updated_at) ON shipping_rates TO bodhinox_app;
-- A coupon's code, kind and value never change once created (redemptions refer to them).
GRANT SELECT, INSERT ON coupons TO bodhinox_app;
GRANT UPDATE (min_subtotal_minor, max_discount_minor, starts_at, ends_at, max_redemptions, per_contact_limit, active,
  updated_at) ON coupons TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shipping_rates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ order triggers
-- E10: the app role (a browser session) can never set the worker-only statuses
-- nor leave them; a priced order is dispatched or delivered only after it is
-- paid (every role). Legacy unpriced orders keep confirmed -> fulfilled.
CREATE FUNCTION orders_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'bodhinox_app' AND (NEW.status IN ('paid','payment_review','expired')
      OR OLD.status IN ('payment_review','expired')) THEN
    RAISE EXCEPTION 'order_status_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.priced_at IS NOT NULL AND NEW.status IN ('dispatched','fulfilled') AND OLD.status NOT IN ('paid','dispatched') THEN
    RAISE EXCEPTION 'order_not_paid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_status_guard BEFORE UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION orders_status_guard();

-- Who recorded the dispatch or delivery, and when (staff-recorded, never a courier claim).
CREATE FUNCTION orders_fulfilment_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'dispatched' THEN
    NEW.dispatched_at := now();
    NEW.fulfilment_recorded_by := NULLIF(current_setting('app.user_id', true), '')::uuid;
  ELSIF NEW.status = 'fulfilled' THEN
    NEW.delivered_at := now();
    NEW.fulfilment_recorded_by := NULLIF(current_setting('app.user_id', true), '')::uuid;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_fulfilment_stamp BEFORE UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION orders_fulfilment_stamp();

-- Once priced, the money, address and lines are immutable for every role.
CREATE FUNCTION orders_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (
      NEW.priced_at IS DISTINCT FROM OLD.priced_at OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.tax_inclusive IS DISTINCT FROM OLD.tax_inclusive
      OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_priced_freeze BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_priced_freeze();

CREATE FUNCTION order_items_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders o WHERE o.account_id = OLD.account_id AND o.id = OLD.order_id AND o.priced_at IS NOT NULL)
    AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.retailer_id IS DISTINCT FROM OLD.retailer_id
      OR NEW.name IS DISTINCT FROM OLD.name OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.submitted_unit_price_minor IS DISTINCT FROM OLD.submitted_unit_price_minor
      OR NEW.tax_rate_bps IS DISTINCT FROM OLD.tax_rate_bps OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR NEW.line_total_minor IS DISTINCT FROM OLD.line_total_minor
      OR NEW.hsn_code IS DISTINCT FROM OLD.hsn_code OR NEW.sku IS DISTINCT FROM OLD.sku) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_items_priced_freeze BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_priced_freeze();
