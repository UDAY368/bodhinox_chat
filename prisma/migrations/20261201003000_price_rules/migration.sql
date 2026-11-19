SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 4: price rules, free gifts, store credit and loyalty points. Additive; a store with
-- none of these set prices every cart exactly as before.
--
-- One stacking order, worked out by the pricing engine (src/lib/commerce/pricing.ts) for the shop quote, the
-- WhatsApp cart, manual orders and the stored order alike:
--   1. unit price: the catalogue price, or the wholesale price list of the buyer (never above the catalogue price)
--   2. discount rules on the line (product, category or customer group; percent or an amount per unit)
--   3. order-level automatic discounts, then the coupon
--   4. shipping, cash-on-delivery fee and tax, as before; a free gift line is added at 0
--   5. loyalty points, then store credit, pay part of the total (they are payments, not discounts: tax is unchanged)
-- A customer group (shop_customer_groups / shop_customer_group_members) is its own list of contacts that only
--   admins change: a price list names one group, a discount rule may name one. Contact tags play no part, so
--   tagging a contact never changes a price.
--
-- shop_price_lists / shop_price_list_prices: wholesale prices per variant with a minimum quantity (tiers).
-- shop_discount_rules: combinable=false means the rule never combines; pricing uses it only when the cart is
--   cheaper for the buyer that way, and its line then takes no other discount.
-- shop_gift_rules: spend at least X, or buy product Y, and variant Z is added free (stock held like any line).
-- shop_credit_ledger / shop_points_ledger: append-only (no UPDATE or DELETE grant). The balance is the sum and a
--   trigger refuses an entry that would take it below zero, under a per-contact advisory lock, so two checkouts
--   cannot overspend. dedupe_key makes every write replay-safe.
-- shop_loyalty_settings: one row per workspace (off until an admin switches it on).
-- orders.store_credit_minor / points_redeemed / points_value_minor: what the order was placed with (frozen once
--   priced); the same amount is counted in amount_paid_minor, so what is due is total minus paid as before.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201003000_price_rules.

-- ================================================================ customer groups
CREATE TABLE shop_customer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]<>]'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX shop_customer_groups_name_idx ON shop_customer_groups (account_id, lower(name));

CREATE TABLE shop_customer_group_members (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, group_id, contact_id),
  FOREIGN KEY (account_id, group_id) REFERENCES shop_customer_groups(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_customer_group_members_contact_idx ON shop_customer_group_members (account_id, contact_id);

-- ================================================================ price lists
CREATE TABLE shop_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]<>]'),
  group_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, group_id) REFERENCES shop_customer_groups(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_price_lists_group_idx ON shop_price_lists (account_id, group_id);

CREATE TABLE shop_price_list_prices (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  min_qty integer NOT NULL DEFAULT 1 CHECK (min_qty BETWEEN 1 AND 99),
  price_minor bigint NOT NULL CHECK (price_minor >= 0 AND price_minor <= 100000000000),
  PRIMARY KEY (account_id, price_list_id, variant_id, min_qty),
  FOREIGN KEY (account_id, price_list_id) REFERENCES shop_price_lists(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_price_list_prices_variant_idx ON shop_price_list_prices (account_id, variant_id);

-- ================================================================ discount rules
CREATE TABLE shop_discount_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]<>]'),
  -- What it applies to: one product, one category (with its sub-categories), or everything (both null).
  product_id uuid,
  category_id uuid,
  -- Who gets it: contacts in this customer group, or everyone (null).
  group_id uuid,
  kind text NOT NULL CHECK (kind IN ('percent','fixed')),
  -- percent: basis points (1..10000). fixed: minor units off each unit.
  value bigint NOT NULL,
  combinable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (product_id IS NULL OR category_id IS NULL),
  CHECK (product_id IS NOT NULL OR category_id IS NOT NULL OR group_id IS NOT NULL),
  CHECK ((kind = 'percent' AND value BETWEEN 1 AND 10000) OR (kind = 'fixed' AND value BETWEEN 1 AND 100000000000)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, category_id) REFERENCES shop_categories(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, group_id) REFERENCES shop_customer_groups(account_id, id) ON DELETE CASCADE
);

-- ================================================================ gift rules
CREATE TABLE shop_gift_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]<>]'),
  -- Exactly one condition: spend at least this much (after discounts), or have this product in the cart.
  min_subtotal_minor bigint CHECK (min_subtotal_minor IS NULL OR (min_subtotal_minor > 0 AND min_subtotal_minor <= 100000000000)),
  trigger_product_id uuid,
  gift_variant_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((min_subtotal_minor IS NULL) <> (trigger_product_id IS NULL)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (account_id, trigger_product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, gift_variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);

-- ================================================================ loyalty settings
CREATE TABLE shop_loyalty_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- Earn: earn_points for every earn_spend_minor paid (rounded down).
  earn_points integer NOT NULL DEFAULT 1 CHECK (earn_points BETWEEN 1 AND 1000),
  earn_spend_minor bigint NOT NULL DEFAULT 10000 CHECK (earn_spend_minor BETWEEN 1 AND 100000000000),
  -- Redeem: one point pays redeem_value_minor, up to redeem_max_bps of the total of an order.
  redeem_value_minor bigint NOT NULL DEFAULT 100 CHECK (redeem_value_minor BETWEEN 1 AND 100000000),
  redeem_max_bps integer NOT NULL DEFAULT 2000 CHECK (redeem_max_bps BETWEEN 1 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ ledgers
CREATE TABLE shop_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  -- Signed minor units: positive adds credit, negative spends it.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND amount_minor BETWEEN -100000000000 AND 100000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind text NOT NULL CHECK (kind IN ('refund','spend','spend_reversal','adjust')),
  order_id uuid,
  refund_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dedupe_key),
  CHECK (kind <> 'adjust' OR (reason IS NOT NULL AND created_by IS NOT NULL)),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX shop_credit_ledger_contact_idx ON shop_credit_ledger (account_id, contact_id, created_at DESC);
CREATE INDEX shop_credit_ledger_order_idx ON shop_credit_ledger (account_id, order_id) WHERE order_id IS NOT NULL;

CREATE TABLE shop_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  points integer NOT NULL CHECK (points <> 0 AND points BETWEEN -100000000 AND 100000000),
  kind text NOT NULL CHECK (kind IN ('earn','earn_reversal','redeem','redeem_reversal','adjust')),
  order_id uuid,
  refund_id uuid,
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dedupe_key),
  CHECK (kind <> 'adjust' OR (reason IS NOT NULL AND created_by IS NOT NULL)),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX shop_points_ledger_contact_idx ON shop_points_ledger (account_id, contact_id, created_at DESC);
CREATE INDEX shop_points_ledger_order_idx ON shop_points_ledger (account_id, order_id) WHERE order_id IS NOT NULL;

-- The balance never goes below zero. Every writer of the ledgers of one contact takes the same advisory lock, so
-- the sum each one reads already holds every committed entry of the others.
CREATE FUNCTION shop_credit_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('shop-ledger:' || NEW.account_id::text || ':' || NEW.contact_id::text, 0));
  IF NEW.amount_minor < 0 THEN
    SELECT COALESCE(sum(amount_minor), 0) INTO balance FROM shop_credit_ledger
      WHERE account_id=NEW.account_id AND contact_id=NEW.contact_id AND currency=NEW.currency;
    IF balance + NEW.amount_minor < 0 THEN
      RAISE EXCEPTION 'store_credit_insufficient' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_credit_ledger_guard BEFORE INSERT ON shop_credit_ledger FOR EACH ROW EXECUTE FUNCTION shop_credit_ledger_guard();

CREATE FUNCTION shop_points_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('shop-ledger:' || NEW.account_id::text || ':' || NEW.contact_id::text, 0));
  IF NEW.points < 0 THEN
    SELECT COALESCE(sum(points), 0) INTO balance FROM shop_points_ledger
      WHERE account_id=NEW.account_id AND contact_id=NEW.contact_id;
    IF balance + NEW.points < 0 THEN
      RAISE EXCEPTION 'loyalty_points_insufficient' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_points_ledger_guard BEFORE INSERT ON shop_points_ledger FOR EACH ROW EXECUTE FUNCTION shop_points_ledger_guard();

-- ================================================================ RLS
-- Groups, rules and settings: agents and above read (the worker prices with them); only admins write.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_customer_groups','shop_customer_group_members','shop_price_lists','shop_price_list_prices','shop_discount_rules','shop_gift_rules','shop_loyalty_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_worker', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO bodhinox_app', t);
  END LOOP;
END $$;
GRANT DELETE ON shop_customer_groups, shop_customer_group_members, shop_price_lists, shop_price_list_prices, shop_discount_rules, shop_gift_rules
  TO bodhinox_app;
GRANT UPDATE (name, updated_at) ON shop_customer_groups TO bodhinox_app;
GRANT UPDATE (name, group_id, active, version, updated_at) ON shop_price_lists TO bodhinox_app;
GRANT UPDATE (name, product_id, category_id, group_id, kind, value, combinable, active, starts_at, ends_at, version, updated_at)
  ON shop_discount_rules TO bodhinox_app;
GRANT UPDATE (name, min_subtotal_minor, trigger_product_id, gift_variant_id, active, starts_at, ends_at, version, updated_at)
  ON shop_gift_rules TO bodhinox_app;
GRANT UPDATE (enabled, earn_points, earn_spend_minor, redeem_value_minor, redeem_max_bps, updated_at) ON shop_loyalty_settings TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_customer_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_price_lists FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_discount_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_gift_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_loyalty_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ledgers: agents and above read; an admin adds an adjustment in their own name; the worker adds everything else.
-- Nobody updates or deletes.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_credit_ledger','shop_points_ledger']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY admin_adjust ON %I FOR INSERT TO bodhinox_app WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L) AND kind=%L)', t, 'admin', 'adjust');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR INSERT TO bodhinox_worker WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO bodhinox_app, bodhinox_worker', t);
  END LOOP;
END $$;

-- ================================================================ orders, lines, sessions, refunds
ALTER TABLE orders ADD COLUMN store_credit_minor bigint NOT NULL DEFAULT 0 CHECK (store_credit_minor >= 0);
ALTER TABLE orders ADD COLUMN points_redeemed integer NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0);
ALTER TABLE orders ADD COLUMN points_value_minor bigint NOT NULL DEFAULT 0 CHECK (points_value_minor >= 0);
-- A free gift line (unit price 0), added by a gift rule.
ALTER TABLE order_items ADD COLUMN is_gift boolean NOT NULL DEFAULT false;
-- The choice of the buyer to pay with store credit and with points; the quote and the place reprice both read it.
ALTER TABLE storefront_sessions ADD COLUMN use_store_credit boolean NOT NULL DEFAULT false;
ALTER TABLE storefront_sessions ADD COLUMN use_points boolean NOT NULL DEFAULT false;
-- A refund paid back as store credit (recorded like a refund made outside the gateway, plus a ledger entry).
ALTER TABLE customer_refunds ADD COLUMN store_credit boolean NOT NULL DEFAULT false;

-- A priced order also keeps what it was placed with in store credit and points.
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
      OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
      OR NEW.store_credit_minor IS DISTINCT FROM OLD.store_credit_minor
      OR NEW.points_redeemed IS DISTINCT FROM OLD.points_redeemed
      OR NEW.points_value_minor IS DISTINCT FROM OLD.points_value_minor) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
