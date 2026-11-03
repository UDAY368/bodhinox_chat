-- Phase 8: the sellable catalogue Bodhinox owns (products, variants, images,
-- categories), store settings and stock. Additive. The Meta `products` mirror
-- is unchanged and stays read-only for selling; a variant matches a mirrored
-- product by products.retailer_id = shop_variants.sku.
--
-- Money is integer minor units (bigint) in commerce_settings.currency. Stock
-- is written only by the worker through lib/commerce/stock.ts; the app role
-- reads it. Every table: composite tenant FKs, FORCE RLS, viewers read nothing.

-- ================================================================ store settings
CREATE TABLE commerce_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  prices_include_tax boolean NOT NULL DEFAULT true,
  -- NULL = not configured: a line that needs it refuses with tax_not_configured. 0 is an explicit zero rate.
  default_tax_rate_bps integer CHECK (default_tax_rate_bps IS NULL OR default_tax_rate_bps BETWEEN 0 AND 10000),
  reservation_minutes integer NOT NULL DEFAULT 15 CHECK (reservation_minutes BETWEEN 15 AND 60),
  checkout_enabled boolean NOT NULL DEFAULT false,
  low_stock_default integer NOT NULL DEFAULT 5 CHECK (low_stock_default BETWEEN 0 AND 100000),
  -- Seller snapshot printed on receipts.
  legal_name text CHECK (legal_name IS NULL OR char_length(legal_name) <= 200),
  gstin text CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$'),
  address text CHECK (address IS NULL OR char_length(address) <= 500),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9A-Z]{2}$'),
  document_prefix text NOT NULL DEFAULT 'RCPT' CHECK (document_prefix ~ '^[A-Z0-9]{1,8}$'),
  storefront_title text CHECK (storefront_title IS NULL OR char_length(storefront_title) <= 120),
  return_window_days integer NOT NULL DEFAULT 7 CHECK (return_window_days BETWEEN 0 AND 90),
  -- Template for the WhatsApp-cart checkout link outside the 24-hour window.
  checkout_template_name text CHECK (checkout_template_name IS NULL OR char_length(checkout_template_name) BETWEEN 1 AND 512),
  checkout_template_language text CHECK (checkout_template_language IS NULL OR char_length(checkout_template_language) BETWEEN 1 AND 15),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ categories
CREATE TABLE shop_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- Depth at most 2 (checked by the service).
  parent_id uuid,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (account_id, parent_id) REFERENCES shop_categories(account_id, id) ON DELETE SET NULL (parent_id)
);
CREATE INDEX shop_categories_parent_idx ON shop_categories (account_id, parent_id);

-- ================================================================ products
CREATE TABLE shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 5000),
  -- Regulatory or usage disclosure shown with the product (e.g. Ayurvedic product notes).
  disclosure text CHECK (disclosure IS NULL OR char_length(disclosure) <= 2000),
  category_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  content_reviewed_by uuid,
  content_reviewed_at timestamptz,
  follow_up_template text CHECK (follow_up_template IS NULL OR char_length(follow_up_template) BETWEEN 1 AND 512),
  follow_up_template_language text CHECK (follow_up_template_language IS NULL OR char_length(follow_up_template_language) BETWEEN 1 AND 15),
  follow_up_after_days integer CHECK (follow_up_after_days IS NULL OR follow_up_after_days BETWEEN 1 AND 365),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- Nothing is published without a recorded content review.
  CHECK (status <> 'published' OR content_reviewed_at IS NOT NULL),
  FOREIGN KEY (account_id, category_id) REFERENCES shop_categories(account_id, id) ON DELETE SET NULL (category_id)
);
CREATE INDEX shop_products_status_idx ON shop_products (account_id, status, updated_at DESC);
CREATE INDEX shop_products_category_idx ON shop_products (account_id, category_id) WHERE category_id IS NOT NULL;

-- Up to ten images: a library media object (counted in the storage quota) or an https URL.
CREATE TABLE shop_product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  media_id uuid,
  url text CHECK (url IS NULL OR (url ~ '^https://' AND char_length(url) <= 2048)),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 9),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, product_id, position),
  CHECK ((media_id IS NULL) <> (url IS NULL)),
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, media_id) REFERENCES media_objects(account_id, id) ON DELETE CASCADE
);

-- ================================================================ variants
CREATE TABLE shop_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- {"Size": "M", "Colour": "Blue"}: at most 4 pairs (checked by the service), 1 KB.
  option_values jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(option_values) = 'object' AND pg_column_size(option_values) <= 1024),
  -- NULL = not priced yet: refused at checkout with price_not_configured.
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  compare_at_minor bigint CHECK (compare_at_minor IS NULL OR compare_at_minor >= 0),
  -- NULL = use commerce_settings.default_tax_rate_bps.
  tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000),
  hsn_code text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  -- false = made to order: never reserved or counted.
  track_inventory boolean NOT NULL DEFAULT true,
  weight_grams integer CHECK (weight_grams IS NULL OR weight_grams BETWEEN 0 AND 1000000),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, sku),
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_variants_product_idx ON shop_variants (account_id, product_id, position);

-- ================================================================ stock
-- One row per tracked variant. A variant without a row has 0 available.
-- The CHECK is the oversell backstop under the conditional reserve UPDATE.
CREATE TABLE inventory_levels (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  on_hand integer NOT NULL DEFAULT 0,
  reserved integer NOT NULL DEFAULT 0,
  low_stock_threshold integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold BETWEEN 0 AND 100000),
  low_notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, variant_id),
  CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);

-- Append-only ledger of every stock change (no UPDATE or DELETE grant to anyone).
CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('adjustment','receipt','reserve','release','sale','return_restock','write_off','refund_restock')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  on_hand_after integer NOT NULL CHECK (on_hand_after >= 0),
  reserved_after integer NOT NULL CHECK (reserved_after >= 0),
  order_id uuid,
  -- FK to order_returns is added by 20261107101500_order_lifecycle.
  return_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200),
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX inventory_movements_variant_idx ON inventory_movements (account_id, variant_id, created_at DESC);
CREATE INDEX inventory_movements_order_idx ON inventory_movements (account_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX inventory_movements_created_idx ON inventory_movements (account_id, created_at DESC);

-- ================================================================ RLS
-- Configuration: agents and above read; admins write through the app role; the worker reads and writes.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_settings','shop_categories','shop_products','shop_product_images','shop_variants']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;

-- The service refuses a currency change once any variant is priced.
GRANT SELECT, INSERT ON commerce_settings TO bodhinox_app;
GRANT UPDATE (currency, prices_include_tax, default_tax_rate_bps, reservation_minutes, checkout_enabled, low_stock_default,
  legal_name, gstin, address, state_code, document_prefix, storefront_title, return_window_days,
  checkout_template_name, checkout_template_language, updated_at) ON commerce_settings TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON shop_categories TO bodhinox_app;
GRANT UPDATE (name, parent_id, position, archived_at, updated_at) ON shop_categories TO bodhinox_app;

-- Products and variants are archived, never deleted (orders keep their line snapshots).
GRANT SELECT, INSERT ON shop_products TO bodhinox_app;
GRANT UPDATE (name, description, disclosure, category_id, status, content_reviewed_by, content_reviewed_at,
  follow_up_template, follow_up_template_language, follow_up_after_days, version, updated_at) ON shop_products TO bodhinox_app;

GRANT SELECT, INSERT, DELETE ON shop_product_images TO bodhinox_app;
GRANT UPDATE (position) ON shop_product_images TO bodhinox_app;
GRANT DELETE ON shop_product_images TO bodhinox_worker;

GRANT SELECT, INSERT ON shop_variants TO bodhinox_app;
GRANT UPDATE (sku, option_values, price_minor, compare_at_minor, tax_rate_bps, hsn_code, track_inventory, weight_grams,
  position, archived_at, updated_at) ON shop_variants TO bodhinox_app;

-- Stock: the app role reads; only the worker writes (lib/commerce/stock.ts).
ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON inventory_levels FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON inventory_levels FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON inventory_levels TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON inventory_levels TO bodhinox_worker;

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON inventory_movements FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_insert ON inventory_movements FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON inventory_movements TO bodhinox_app;
GRANT SELECT, INSERT ON inventory_movements TO bodhinox_worker;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_settings','shop_categories','shop_products','shop_variants','inventory_levels']
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', t);
  END LOOP;
END $$;
