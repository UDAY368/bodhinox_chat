SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 2: store pickup and local delivery, stock locations with transfers,
-- purchase orders that receive into stock. Additive; no existing stock number is touched.
--
-- shop_delivery_options: one row per workspace. Pickup (address, instructions) and local delivery
--   (a fee in the store currency and the postal prefixes it reaches). Admins write it; pricing reads it.
-- storefront_sessions.delivery_method / orders.delivery_method: 'ship' (a shipping rate, the default and
--   every existing row), 'pickup' or 'local'. The session's choice is priced on the server; the order keeps it.
--
-- stock_locations / stock_location_levels: inventory_levels.on_hand stays the one sellable total that
--   checkout reserves against. Every workspace has one default location (made on first use) that holds
--   whatever is not counted elsewhere: default quantity = on_hand - sum(stock_location_levels). Only the
--   other locations have rows, so the locations always sum to on_hand and nothing is backfilled.
--   Two triggers keep that true whoever writes:
--     stock_location_levels_guard  a location row may not push the sum above on_hand (it locks the level row),
--       and the default location never has a row.
--     inventory_levels_locations_absorb  when on_hand falls below the sum (a sale, a write-off), the shortfall
--       is taken from the other locations in position order. Stock leaves the default location first.
-- stock_transfers: append-only record of a move between two locations; (account_id, client_key) makes a
--   retried request a no-op.
-- purchase_orders / purchase_order_lines / purchase_order_receipts: draft -> ordered -> partially_received
--   -> received -> closed, or cancelled. A receipt is one receive request; (account_id, request_key) makes
--   a retry a no-op. qty_received can never pass qty_ordered (CHECK).
-- All stock tables are written only by the worker role (lib/commerce/stock.ts and stock-locations.ts,
--   purchase-orders.ts), after the app checked the member's role and the commerce.inventory permission.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201001000_stock_locations_fulfilment.

-- ================================================================ delivery options
CREATE TABLE shop_delivery_options (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  pickup_enabled boolean NOT NULL DEFAULT false,
  pickup_address text CHECK (pickup_address IS NULL OR char_length(pickup_address) BETWEEN 1 AND 500),
  pickup_instructions text CHECK (pickup_instructions IS NULL OR char_length(pickup_instructions) BETWEEN 1 AND 500),
  local_enabled boolean NOT NULL DEFAULT false,
  local_fee_minor bigint NOT NULL DEFAULT 0 CHECK (local_fee_minor BETWEEN 0 AND 9007199254740991),
  local_postal_prefixes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(local_postal_prefixes) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT pickup_enabled OR pickup_address IS NOT NULL),
  CHECK (NOT local_enabled OR cardinality(local_postal_prefixes) >= 1)
);
ALTER TABLE shop_delivery_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_delivery_options FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_delivery_options FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_delivery_options FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON shop_delivery_options TO bodhinox_worker;
GRANT SELECT, INSERT ON shop_delivery_options TO bodhinox_app;
GRANT UPDATE (pickup_enabled, pickup_address, pickup_instructions, local_enabled, local_fee_minor, local_postal_prefixes, updated_at)
  ON shop_delivery_options TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_delivery_options FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE storefront_sessions ADD COLUMN delivery_method text NOT NULL DEFAULT 'ship';
ALTER TABLE storefront_sessions ADD CONSTRAINT storefront_sessions_delivery_method_check
  CHECK (delivery_method IN ('ship','pickup','local')) NOT VALID;
ALTER TABLE storefront_sessions VALIDATE CONSTRAINT storefront_sessions_delivery_method_check;
ALTER TABLE orders ADD COLUMN delivery_method text NOT NULL DEFAULT 'ship';
ALTER TABLE orders ADD CONSTRAINT orders_delivery_method_check CHECK (delivery_method IN ('ship','pickup','local')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_delivery_method_check;

-- Once priced, the delivery method is frozen like the other money (its fee is shipping_minor, already frozen).
-- Everything 20261128000000_shop_auto_discounts guarded is kept. CREATE OR REPLACE FUNCTION takes no table
-- lock; the existing trigger calls the new body.
CREATE OR REPLACE FUNCTION orders_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (
      NEW.priced_at IS DISTINCT FROM OLD.priced_at OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.tax_inclusive IS DISTINCT FROM OLD.tax_inclusive
      OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.cod_fee_minor IS DISTINCT FROM OLD.cod_fee_minor
      OR NEW.auto_discount_minor IS DISTINCT FROM OLD.auto_discount_minor
      OR NEW.discount_details IS DISTINCT FROM OLD.discount_details
      OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ stock locations
CREATE TABLE stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (NOT is_default OR active)
);
CREATE UNIQUE INDEX stock_locations_default_idx ON stock_locations (account_id) WHERE is_default;
CREATE UNIQUE INDEX stock_locations_name_idx ON stock_locations (account_id, lower(name));

CREATE TABLE stock_location_levels (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, variant_id, location_id),
  FOREIGN KEY (account_id, location_id) REFERENCES stock_locations(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, variant_id) REFERENCES inventory_levels(account_id, variant_id) ON DELETE CASCADE
);
CREATE INDEX stock_location_levels_location_idx ON stock_location_levels (account_id, location_id);

CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  client_key text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, client_key),
  CHECK (from_location_id <> to_location_id),
  FOREIGN KEY (account_id, from_location_id) REFERENCES stock_locations(account_id, id),
  FOREIGN KEY (account_id, to_location_id) REFERENCES stock_locations(account_id, id),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);
CREATE INDEX stock_transfers_created_idx ON stock_transfers (account_id, created_at DESC);

-- A location row may never push the per-location sum above the sellable total, and the default
-- location holds the remainder, so it has no row of its own.
CREATE FUNCTION stock_location_levels_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; placed bigint;
BEGIN
  -- Taking stock out of a location can only lower the sum (the absorb trigger does this row by row).
  IF TG_OP = 'UPDATE' AND NEW.quantity <= OLD.quantity AND NEW.location_id = OLD.location_id AND NEW.variant_id = OLD.variant_id THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_locations WHERE account_id=NEW.account_id AND id=NEW.location_id AND is_default) THEN
    RAISE EXCEPTION 'stock_location_default_row' USING ERRCODE = 'check_violation';
  END IF;
  SELECT on_hand INTO total FROM inventory_levels WHERE account_id=NEW.account_id AND variant_id=NEW.variant_id FOR UPDATE;
  SELECT COALESCE(sum(quantity),0) INTO placed FROM stock_location_levels WHERE account_id=NEW.account_id AND variant_id=NEW.variant_id;
  IF total IS NULL OR placed > total THEN
    RAISE EXCEPTION 'stock_location_overflow' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER stock_location_levels_guard AFTER INSERT OR UPDATE OF quantity, location_id, variant_id ON stock_location_levels
  FOR EACH ROW EXECUTE FUNCTION stock_location_levels_guard();

-- on_hand fell (sale, write-off, negative adjustment): what the default location cannot cover leaves
-- the other locations, lowest position first.
CREATE FUNCTION inventory_levels_locations_absorb() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE excess bigint; r record; take integer;
BEGIN
  SELECT COALESCE(sum(quantity),0) - NEW.on_hand INTO excess FROM stock_location_levels
    WHERE account_id=NEW.account_id AND variant_id=NEW.variant_id;
  IF excess <= 0 THEN RETURN NULL; END IF;
  FOR r IN SELECT l.location_id, l.quantity FROM stock_location_levels l
      JOIN stock_locations s ON s.account_id=l.account_id AND s.id=l.location_id
      WHERE l.account_id=NEW.account_id AND l.variant_id=NEW.variant_id AND l.quantity > 0
      ORDER BY s.position, s.created_at, s.id FOR UPDATE OF l
  LOOP
    take := LEAST(r.quantity, excess)::integer;
    UPDATE stock_location_levels SET quantity = quantity - take
      WHERE account_id=NEW.account_id AND variant_id=NEW.variant_id AND location_id=r.location_id;
    excess := excess - take;
    EXIT WHEN excess <= 0;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER inventory_levels_locations_absorb AFTER UPDATE OF on_hand ON inventory_levels
  FOR EACH ROW WHEN (NEW.on_hand < OLD.on_hand) EXECUTE FUNCTION inventory_levels_locations_absorb(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); runs only when on_hand falls, one indexed read, never rewrites rows

-- ================================================================ purchase orders
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  supplier_name text NOT NULL CHECK (char_length(supplier_name) BETWEEN 1 AND 120),
  reference text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 60),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ordered','partially_received','received','closed','cancelled')),
  ordered_at timestamptz,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE INDEX purchase_orders_created_idx ON purchase_orders (account_id, created_at DESC);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty_ordered integer NOT NULL CHECK (qty_ordered BETWEEN 1 AND 1000000),
  qty_received integer NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_minor bigint NOT NULL DEFAULT 0 CHECK (unit_cost_minor BETWEEN 0 AND 9007199254740991),
  UNIQUE (account_id, id),
  UNIQUE (account_id, purchase_order_id, variant_id),
  CHECK (qty_received <= qty_ordered),
  FOREIGN KEY (account_id, purchase_order_id) REFERENCES purchase_orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id)
);

CREATE TABLE purchase_order_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL,
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  location_id uuid NOT NULL,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND pg_column_size(lines) <= 32768),
  received_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_key),
  FOREIGN KEY (account_id, purchase_order_id) REFERENCES purchase_orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, location_id) REFERENCES stock_locations(account_id, id)
);
CREATE INDEX purchase_order_receipts_po_idx ON purchase_order_receipts (account_id, purchase_order_id, created_at);

-- ================================================================ RLS: the app role reads, only the worker writes
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stock_locations','stock_location_levels','stock_transfers','purchase_orders','purchase_order_lines','purchase_order_receipts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker
      USING (account_id=app_account_id() AND app_write_allowed(''agent''))', t);
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker
      USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON stock_locations, stock_location_levels, purchase_orders, purchase_order_lines TO bodhinox_worker;
GRANT DELETE ON purchase_order_lines TO bodhinox_worker;
GRANT SELECT, INSERT ON stock_transfers, purchase_order_receipts TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_locations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_location_levels FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
