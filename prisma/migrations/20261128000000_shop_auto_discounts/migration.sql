SET LOCAL lock_timeout = '5s';

-- Store plan Phase 3, package 1: automatic discounts. Additive.
-- shop_auto_discounts: a workspace's rules that apply at checkout with no
-- code: money or percent off over a subtotal, free shipping over a subtotal,
-- buy X get Y, and money off for paying online ("prepaid"). Each kind carries
-- exactly its own fields. Admins write through the app role; the checkout
-- worker only reads. The server prices with them (lib/commerce/auto-discounts.ts);
-- at most 20 rows per workspace, enforced by the server under a lock.
-- orders.auto_discount_minor: the automatic part of discount_minor (which
-- stays the whole merchandise discount, so receipts and credit notes are
-- unchanged). orders.discount_details: the names and savings shown to the
-- customer. Both are written by the worker and frozen once the order is priced.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261128000000_shop_auto_discounts.

CREATE TABLE shop_auto_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]<>]'),
  kind text NOT NULL CHECK (kind IN ('amount_off_over','percent_off_over','free_shipping_over','buy_x_get_y','prepaid')),
  min_subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0 AND min_subtotal_minor <= 100000000000),
  amount_minor bigint CHECK (amount_minor IS NULL OR (amount_minor > 0 AND amount_minor <= 100000000000)),
  percent_bps integer CHECK (percent_bps IS NULL OR percent_bps BETWEEN 1 AND 10000),
  buy_qty integer CHECK (buy_qty IS NULL OR buy_qty BETWEEN 1 AND 20),
  get_qty integer CHECK (get_qty IS NULL OR get_qty BETWEEN 1 AND 20),
  -- buy_x_get_y only: the products that count; empty means every product.
  product_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(product_ids) <= 50),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  -- Each kind has exactly its fields.
  CONSTRAINT shop_auto_discounts_kind_fields CHECK (CASE kind
    WHEN 'amount_off_over' THEN amount_minor IS NOT NULL AND percent_bps IS NULL AND buy_qty IS NULL AND get_qty IS NULL
      AND cardinality(product_ids) = 0
    WHEN 'percent_off_over' THEN percent_bps IS NOT NULL AND amount_minor IS NULL AND buy_qty IS NULL AND get_qty IS NULL
      AND cardinality(product_ids) = 0
    WHEN 'free_shipping_over' THEN amount_minor IS NULL AND percent_bps IS NULL AND buy_qty IS NULL AND get_qty IS NULL
      AND cardinality(product_ids) = 0
    WHEN 'buy_x_get_y' THEN buy_qty IS NOT NULL AND get_qty IS NOT NULL AND amount_minor IS NULL AND percent_bps IS NULL
    WHEN 'prepaid' THEN ((amount_minor IS NOT NULL) <> (percent_bps IS NOT NULL)) AND buy_qty IS NULL AND get_qty IS NULL
      AND cardinality(product_ids) = 0
    ELSE false END)
);

ALTER TABLE shop_auto_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_auto_discounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_auto_discounts FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_auto_discounts FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON shop_auto_discounts TO bodhinox_worker;
GRANT SELECT, INSERT, DELETE ON shop_auto_discounts TO bodhinox_app;
GRANT UPDATE (name, kind, min_subtotal_minor, amount_minor, percent_bps, buy_qty, get_qty, product_ids, active, starts_at, ends_at,
  version, updated_at) ON shop_auto_discounts TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_auto_discounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ orders
-- Metadata-only ADD COLUMN. The CHECKs are added NOT VALID and validated right after: every existing
-- row has 0 and NULL, so the validation scan passes.
ALTER TABLE orders ADD COLUMN auto_discount_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_details jsonb;
ALTER TABLE orders ADD CONSTRAINT orders_auto_discount_check
  CHECK (auto_discount_minor >= 0 AND auto_discount_minor <= discount_minor) NOT VALID;
ALTER TABLE orders ADD CONSTRAINT orders_discount_details_check
  CHECK (discount_details IS NULL OR (jsonb_typeof(discount_details) = 'array' AND jsonb_array_length(discount_details) <= 8
    AND octet_length(discount_details::text) <= 4096)) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_auto_discount_check;
ALTER TABLE orders VALIDATE CONSTRAINT orders_discount_details_check;

-- Once priced, the automatic discount and its details are frozen like the other money.
-- CREATE OR REPLACE FUNCTION takes no table lock; the existing trigger calls the new body.
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
      OR NEW.discount_details IS DISTINCT FROM OLD.discount_details) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
